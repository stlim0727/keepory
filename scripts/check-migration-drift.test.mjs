import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

const script = new URL('./check-migration-drift.mjs', import.meta.url);
const local = readdirSync(new URL('../supabase/migrations/', import.meta.url))
  .filter((name) => name.endsWith('.sql'))
  .map((name) => ({ version: name.split('_', 1)[0], name: name.replace(/^\d+_/, '').replace(/\.sql$/, '') }));
const applied = [...new Map(local.map((row) => [row.name, row])).values()];

function run(body, { token = 'fixture-token', url = 'https://fixture.supabase.co', args = [] } = {}) {
  const fixture = `globalThis.fetch = async () => ({ ok: true, json: async () => (${JSON.stringify(body)}) });`;
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(fixture)}`, script.pathname, ...args,
  ], {
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: token, EXPO_PUBLIC_SUPABASE_URL: url },
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('missing credentials fail instead of claiming a successful check', () => {
  for (const options of [{ token: '' }, { url: '' }, { token: '', url: '' }]) {
    const result = run(applied, options);
    assert.equal(result.status, 1);
    assert.match(result.output, /Migration drift not checked/);
    assert.doesNotMatch(result.output, /No unapplied migrations/);
  }
});

test('malformed ledgers are verification failures, not drift findings', () => {
  for (const body of [null, {}, [{ name: 'missing_version' }], [{ version: '20261024000000', name: null }]]) {
    const result = run(body);
    assert.equal(result.status, 1);
    assert.match(result.output, /malformed migration ledger/);
    assert.doesNotMatch(result.output, /migration\(s\).*NOT applied/);
  }
});

test('applied slugs still match when apply-time versions differ', () => {
  const result = run(applied.map((row, index) => ({ ...row, version: String(20261025000000 + index) })));
  assert.equal(result.status, 0);
  assert.match(result.output, /No unapplied migrations/);
});

test('version report exposes orphan mappings without hiding pending migrations', () => {
  const ledger = applied.filter((row) => row.name !== 'trickle_ai_enrichment');
  ledger.push({ version: '20990101000000', name: 'ai_enrichment_rate_limit' });
  ledger.push({ version: '20990101000001', name: 'unknown_migration' });
  const result = run(ledger, { args: ['--report-versions'] });
  assert.equal(result.status, 1);
  assert.match(result.output, /trickle_ai_enrichment.sql/);
  assert.match(result.output, /20990101000000/);
  assert.match(result.output, /20260620000000_ai_enrichment_rate_limit.sql/);
  assert.match(result.output, /unknown_migration/);
  assert.match(result.output, /"candidates": \[\]/);
});
