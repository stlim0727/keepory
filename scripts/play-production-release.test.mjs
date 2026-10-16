import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPromotion, runRelease } from './play-production-release.mjs';

const notes = [{ language: 'en-US', text: 'Improved sync.' }, { language: 'ko-KR', text: '동기화 개선.' }];
const options = { command: 'promote', version: '1.2.8', code: '32', expectedProductionCodes: ['31'], notes, publisherIdle: true };
const original = () => [
  { track: 'production', releases: [{ name: '1.2.7', versionCodes: ['31'], status: 'completed' }] },
  { track: 'internal', releases: [{ name: '1.2.8', versionCodes: ['32'], status: 'completed' }] },
];

function fakePublisher({ fail, mismatchReadback = false } = {}) {
  let tracks = original();
  let pending;
  let editNumber = 0;
  const calls = [];
  return { calls, api: async (path = '', method = 'GET', data) => {
    calls.push([path, method, data]);
    if (fail?.(path, method)) throw new Error('simulated failure');
    if (path === '/edits' && method === 'POST') return { id: String(++editNumber) };
    if (/\/tracks\/(production|internal)\/releases$/.test(path)) return { releases: [] };
    if (path.endsWith('/tracks')) return { tracks: structuredClone(tracks) };
    if (method === 'PUT') { pending = data; return data; }
    if (path.includes(':commit')) {
      if (!mismatchReadback) tracks = [pending, tracks[1]];
      return { id: 'committed' };
    }
    return {};
  } };
}

test('preview preserves distinct locales and never updates or commits a track', async () => {
  const f = fakePublisher();
  const result = await runRelease(f.api, options);
  assert.equal(result.committed, false);
  assert.deepEqual(result.release.releaseNotes, notes);
  assert.equal(f.calls.some(([path, method]) => method === 'PUT' || path.includes(':commit')), false);
  assert.equal(f.calls.every(([, method]) => method === 'GET'), true);
  assert.equal(result.provisional, true);
});

test('commit validates first, publishes once, then verifies production in a new edit', async () => {
  const f = fakePublisher();
  const result = await runRelease(f.api, { ...options, commit: true });
  assert.equal(result.verified, true);
  assert.deepEqual(f.calls.map(([path, method]) => `${method} ${path}`), [
    'POST /edits', 'GET /edits/1/tracks', 'PUT /edits/1/tracks/production', 'POST /edits/1:validate',
    'POST /edits/1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW', 'POST /edits', 'GET /edits/2/tracks', 'DELETE /edits/2',
  ]);
});

test('changed production snapshot refuses overwrite before any track update', async () => {
  const f = fakePublisher();
  await assert.rejects(runRelease(f.api, { ...options, expectedProductionCodes: ['30'], commit: true }), /Production changed/);
  assert.equal(f.calls.some(([, method]) => method === 'PUT'), false);
  assert.equal(f.calls.at(-1)[1], 'DELETE');
});

test('wrong internal code or unfinished upload cannot be promoted', () => {
  const tracks = original();
  tracks[1].releases[0].status = 'draft';
  assert.throws(() => planPromotion(tracks, options), /completed internal/);
  assert.throws(() => planPromotion(original(), { ...options, code: '33' }), /completed internal/);
});

test('does not replace equal/newer production codes', () => {
  const tracks = original();
  tracks[0].releases[0].versionCodes = ['33'];
  assert.throws(() => planPromotion(tracks, { ...options, expectedProductionCodes: ['33'] }), /equal or newer/);
});

test('rejects missing, duplicate, blank, or oversized locales', () => {
  for (const invalid of [[], [notes[0], notes[0]], [notes[0], { language: 'ko-KR', text: ' ' }],
    [notes[0], { language: 'ko-KR', text: '가'.repeat(501) }]]) {
    assert.throws(() => planPromotion(original(), { ...options, notes: invalid }), /Notes must/);
  }
});

test('same completed release and notes is idempotent despite stale expected old code', async () => {
  const release = planPromotion(original(), options).release;
  const calls = [];
  const api = async (path = '', method = 'GET') => {
    calls.push([path, method]);
    return path === '/edits' ? { id: '1' } : path.endsWith('/tracks') ? { tracks: [{ track: 'production', releases: [release] }] } : {};
  };
  assert.equal((await runRelease(api, { ...options, commit: true })).alreadyPublished, true);
  assert.equal(calls.some(([path, method]) => method === 'PUT' || path.includes(':commit')), false);
});

test('validation failure deletes the edit and never commits', async () => {
  const f = fakePublisher({ fail: (path) => path.endsWith(':validate') });
  await assert.rejects(runRelease(f.api, { ...options, commit: true }), /simulated/);
  assert.equal(f.calls.some(([path]) => path.includes(':commit')), false);
  assert.equal(f.calls.at(-1)[1], 'DELETE');
});

test('ambiguous commit failure is not retried automatically', async () => {
  const f = fakePublisher({ fail: (path) => path.includes(':commit') });
  await assert.rejects(runRelease(f.api, { ...options, commit: true }), /simulated/);
  assert.equal(f.calls.filter(([path]) => path.includes(':commit')).length, 1);
});

test('reports mismatched readback without a second publish', async () => {
  const f = fakePublisher({ mismatchReadback: true });
  await assert.rejects(runRelease(f.api, { ...options, commit: true }), /readback differs/);
  assert.equal(f.calls.filter(([, method]) => method === 'PUT').length, 1);
});

test('publisher signs the Google assertion and uses the token without printing credentials', async (t) => {
  const { generateKeyPairSync, verify } = await import('node:crypto');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { publisher } = await import('./play-production-release.mjs');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = await mkdtemp(join(tmpdir(), 'play-publisher-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyPath = join(dir, 'key.json');
  await writeFile(keyPath, JSON.stringify({ type: 'service_account', client_email: 'test@example.invalid',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    requests++;
    if (url === 'https://oauth2.googleapis.com/token') {
      const [header, claims, signature] = request.body.get('assertion').split('.');
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), true);
      assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).scope, 'https://www.googleapis.com/auth/androidpublisher');
      return Response.json({ access_token: 'test-only-token' });
    }
    assert.equal(request.headers.Authorization, 'Bearer test-only-token');
    assert.match(url, /applications\/com\.keepory\.app\/edits$/);
    return Response.json({ id: 'test-edit' });
  });
  assert.deepEqual(await (await publisher(keyPath))('/edits', 'POST', {}), { id: 'test-edit' });
  assert.equal(requests, 2);
});


test('inspection uses only read-only summary endpoints', async () => {
  const f = fakePublisher();
  await runRelease(f.api, { command: 'inspect' });
  assert.deepEqual(f.calls.map(([path, method]) => `${method} ${path}`), [
    'GET /tracks/production/releases', 'GET /tracks/internal/releases',
  ]);
});

test('commit requires an exclusive idle publisher window before creating an edit', async () => {
  const f = fakePublisher();
  await assert.rejects(runRelease(f.api, { ...options, commit: true, publisherIdle: false }), /publisher-idle/);
  assert.equal(f.calls.length, 0);
});

test('refuses staged, halted, draft, and multiple completed production releases', () => {
  for (const status of ['inProgress', 'halted', 'draft']) {
    const tracks = original(); tracks[0].releases[0].status = status;
    assert.throws(() => planPromotion(tracks, options), /separate reviewed rollout/);
  }
  const tracks = original(); tracks[0].releases.push({ status: 'completed', versionCodes: ['30'] });
  assert.throws(() => planPromotion(tracks, { ...options, expectedProductionCodes: ['31', '30'] }), /separate reviewed rollout/);
});
