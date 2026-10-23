// Non-billable probes of a deployed ai-enrich handler. No writes or model calls
// are expected. Use dedicated fixture credentials, never a real user's token.
// Required: EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY.
// Optional: AI_VERIFY_USER_TOKEN, AI_VERIFY_FOREIGN_BOOKMARK_ID (owned by a
// different fixture user), AI_VERIFY_EXPIRED_TOKEN (a genuinely signed, expired
// session token). Missing credentials are reported as SKIP, never PASS.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
assert.ok(base && key, 'Configure the Supabase URL and public API key');
const token = process.env.AI_VERIFY_USER_TOKEN;
const foreignId = process.env.AI_VERIFY_FOREIGN_BOOKMARK_ID;
const expired = process.env.AI_VERIFY_EXPIRED_TOKEN;
const missingId = randomUUID();
const endpoint = `${base.replace(/\/$/, '')}/functions/v1/ai-enrich`;

async function probe(name, headers, body, expected) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  // Do not log response bodies or credentials on failure.
  assert.equal(response.status, expected, `${name}: unexpected HTTP status`);
  console.log(`PASS: ${name} (${response.status})`);
}

await probe('no session', {}, { bookmark_id: missingId }, 401);
await probe('malformed JWT', { Authorization: 'Bearer not-a-valid-jwt' }, { bookmark_id: missingId }, 401);
const forged = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: randomUUID(), role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
  Buffer.alloc(32).toString('base64url'),
].join('.');
await probe('forged JWT signature', { Authorization: `Bearer ${forged}` }, { bookmark_id: missingId }, 401);
await probe('wrong trigger secret', { 'x-ai-enrich-secret': randomUUID() }, { bookmark_id: missingId }, 401);
if (token) {
  await probe('valid session reaches RLS-scoped missing-row lookup', { Authorization: `Bearer ${token}` }, { bookmark_id: missingId }, 404);
  await probe('user cannot invoke batch worker', { Authorization: `Bearer ${token}` }, { batch_worker: true }, 401);
  await probe('wrong secret cannot downgrade to valid session', { Authorization: `Bearer ${token}`, 'x-ai-enrich-secret': randomUUID() }, { bookmark_id: missingId }, 401);
  if (foreignId) {
    assert.match(foreignId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    await probe('foreign bookmark is invisible', { Authorization: `Bearer ${token}` }, { bookmark_id: foreignId }, 404);
  } else console.log('SKIP: foreign bookmark (fixture ID not supplied)');
} else console.log('SKIP: valid-session, worker and foreign-owner probes (fixture token not supplied)');
if (expired) {
  await probe('signed expired JWT', { Authorization: `Bearer ${expired}` }, { bookmark_id: missingId }, 401);
} else console.log('SKIP: signed expired JWT (expired fixture token not supplied)');
