import assert from 'node:assert/strict';
import { test } from 'node:test';

const bookmarkId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';

// These are HTTP boundary tests, not a substitute for real JWT/RLS verification.
test('caller authorization and current bookmark state gate all model work', async (t) => {
  let handler: (req: Request) => Promise<Response>;
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://project.test', SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service', AI_ENRICH_TRIGGER_SECRET: 'secret', GEMINI_API_KEY: 'test',
  };
  const previousDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  const previousFetch = globalThis.fetch;
  Object.assign(globalThis, { Deno: {
    env: { get: (key: string) => env[key] },
    serve: (registered: typeof handler) => { handler = registered; },
  } });
  let deletedAt: string | null = null;
  let archived = false;
  let loadStatus = 200;
  let visible = true;
  let claimed = false;
  let providerCalls = 0;
  const calls: Array<{ url: URL; method: string; headers: Headers; body: unknown }> = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const call = { url: parsed, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (parsed.hostname === 'generativelanguage.googleapis.com') {
      providerCalls++;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ topics: [], suggested_tags: [], suggested_collection: null, confidence: 0.9 }) }] } }] });
    }
    if (parsed.pathname.endsWith('/bookmarks')) {
      if (loadStatus !== 200) return Response.json({ message: 'JWT rejected' }, { status: loadStatus });
      return Response.json(visible ? [{ id: bookmarkId, user_id: userId, title: 'Test', url: 'https://example.test', content_type: 'url', deleted_at: deletedAt, is_archived: archived }] : []);
    }
    if (parsed.pathname.endsWith('/claim_pending_ai_enrichment_batch')) {
      return Response.json(claimed ? [{ id: 'queue', bookmark_id: bookmarkId, user_id: userId, attempts: 0, locale: 'en' }] : []);
    }
    if (/request_ai_enrichment_slot|reserve_ai_enrichment_budget/.test(parsed.pathname)) return Response.json({ allowed: true });
    if (parsed.pathname.endsWith('/ai_enrichments') && call.method === 'POST') return Response.json([call.body]);
    return Response.json([]);
  };
  const request = (headers: Record<string, string>, body: Record<string, unknown> = {}) => handler!(new Request('https://project.test/ai-enrich', {
    method: 'POST', headers, body: JSON.stringify({ bookmark_id: bookmarkId, locale: 'en', ...body }),
  }));
  const reset = () => { calls.length = 0; providerCalls = 0; deletedAt = null; archived = false; loadStatus = 200; visible = true; claimed = false; };
  try {
    await import('./index.ts');
    await t.test('missing/bad credentials and user worker requests never reach the database', async () => {
      for (const headers of [{}, { 'x-ai-enrich-secret': 'wrong' }, { 'x-ai-enrich-secret': 'wrong', Authorization: 'Bearer user' }]) {
        reset();
        assert.equal((await request(headers)).status, 401);
        assert.equal(calls.length, 0);
      }
      reset();
      assert.equal((await request({ Authorization: 'Bearer user' }, { batch_worker: true })).status, 401);
      assert.equal(calls.length, 0);
    });
    await t.test('PostgREST rejection and invisible foreign bookmark stop before elevated calls', async () => {
      for (const status of [401, 403, 200]) {
        reset(); loadStatus = status; visible = false;
        assert.equal((await request({ Authorization: 'Bearer rejected-or-foreign' })).status, status === 200 ? 404 : status);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].headers.get('Authorization'), 'Bearer rejected-or-foreign');
        assert.equal(calls[0].headers.get('apikey'), 'anon');
        assert.equal(providerCalls, 0);
      }
    });
    await t.test('late trigger after trash/archive skips before quota, context, model, and writes', async () => {
      for (const state of ['trash', 'archive']) {
        reset(); deletedAt = state === 'trash' ? new Date().toISOString() : null; archived = state === 'archive';
        // Client metadata cannot override the current database state.
        const res = await request({ 'x-ai-enrich-secret': 'secret' }, { metadata: { deleted_at: null, is_archived: false } });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { skipped: state === 'trash' ? 'bookmark_deleted' : 'bookmark_archived' });
        assert.equal(calls.length, 1);
        assert.match(calls[0].url.searchParams.get('select')!, /deleted_at,is_archived/);
        assert.equal(providerCalls, 0);
      }
    });
    await t.test('trash blocks every client source; archives block automatic/preview but preserve manual and legacy refresh', async () => {
      for (const source of ['auto', 'preview', 'manual', undefined]) {
        reset(); deletedAt = new Date().toISOString();
        assert.equal((await request({ Authorization: 'Bearer user' }, { source })).status, 409);
        assert.equal(calls.length, 1);
        reset(); archived = true;
        const res = await request({ Authorization: 'Bearer user' }, { source });
        const manual = source === 'manual' || source === undefined;
        assert.equal(res.status, manual ? 200 : 409);
        assert.equal(providerCalls, manual ? 1 : 0);
        if (!manual) assert.equal(calls.length, 1);
      }
    });
    await t.test('valid app and trigger paths reach the model and write the DB owner, ignoring a forged body owner', async () => {
      for (const headers of [{ Authorization: 'Bearer anonymous' }, { Authorization: 'Bearer registered' }, { 'x-ai-enrich-secret': 'secret' }]) {
        reset();
        const res = await request(headers, { user_id: 'attacker', metadata: { user_id: 'attacker', id: 'attacker' } });
        assert.equal(res.status, 200);
        assert.equal(providerCalls, 1);
        const save = calls.find((call) => call.url.pathname.endsWith('/ai_enrichments') && call.method === 'POST')!;
        assert.equal((save.body as { user_id: string }).user_id, userId);
        assert.equal((save.body as { bookmark_id: string }).bookmark_id, bookmarkId);
        assert.equal(save.headers.get('Authorization'), headers.Authorization ?? 'Bearer service');
      }
    });
    await t.test('trusted worker processes active rows and skips inactive rows without model writes', async () => {
      for (const inactive of [false, true]) {
        reset(); claimed = true; archived = inactive;
        assert.equal((await request({ 'x-ai-enrich-secret': 'secret' }, { batch_worker: true })).status, 200);
        assert.equal(providerCalls, inactive ? 0 : 1);
        assert.equal(calls.filter((call) => call.url.pathname.endsWith('/ai_enrichments') && call.method === 'POST').length, inactive ? 0 : 1);
      }
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDeno) Object.defineProperty(globalThis, 'Deno', previousDeno);
    else Reflect.deleteProperty(globalThis, 'Deno');
  }
});
