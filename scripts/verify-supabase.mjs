/**
 * End-to-end verification of the Supabase cloud layer (Milestones 5-7)
 * against a real project, exercising the app's own client and API code.
 *
 * Usage:
 *   EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-or-publishable-key> \
 *   SUPABASE_SECRET_KEY=<service-role-key> \
 *   pnpm verify:supabase
 *
 * Requires: the project's initial migration applied and anonymous sign-ins
 * enabled. Creates throwaway accounts and deletes them again through the Admin
 * API, so SUPABASE_SECRET_KEY is required, not optional.
 */
import { register } from 'node:module';

register('./alias-loader.mjs', import.meta.url);

const { getSupabaseConfigState } = await import('../apps/mobile/src/supabase/config.ts');
const { createSupabaseClient, SupabaseRequestError } = await import(
  '../apps/mobile/src/supabase/client.ts'
);
const { clearSupabaseSession } = await import('../apps/mobile/src/supabase/session-storage.ts');
const { createBookmarkApi } = await import('../apps/mobile/src/api/bookmarks.ts');

let passed = 0;
const cleanups = [];

function ok(name, detail = '') {
  passed += 1;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, error) {
  console.error(`  ✗ ${name}`);
  console.error(`    ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
  throw new VerificationAbort();
}

class VerificationAbort extends Error {}

// Admin API access. Two things need it: creating the confirmed non-anonymous
// verifier (the public sign-up endpoint returns no session while "Confirm email"
// is enabled on the project), and deleting every account this run creates.
// Without the delete path those accounts are permanent — cleanup_anonymous_users
// only reaps a user with zero bookmark, collection, and tag rows, and this script
// leaves collections behind.
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY ?? '';

function adminDeleteUser(client, userId) {
  return client.request(`/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    accessToken: SERVICE_ROLE_KEY,
  });
}

async function expectRejects(name, promise) {
  try {
    await promise;
    fail(name, 'expected the operation to fail, but it succeeded');
  } catch (error) {
    if (error instanceof VerificationAbort) {
      throw error;
    }
    ok(name, error instanceof Error ? error.message : String(error));
  }
}

// When a realtime check fails, the operator's first question is whether Realtime
// itself is unreachable or only this client's join failed. RealtimeClient reports
// neither the transport error nor a close reason, so repeat the handshake with the
// exact URL the client built and say which one it was.
async function probeRealtimeHandshake(endpointUrl, apiKey) {
  const redact = (text) => String(text).split(apiKey).join('<apikey>');
  try {
    return await new Promise((resolve) => {
      const ws = new WebSocket(endpointUrl);
      const timer = setTimeout(() => {
        resolve('handshake produced no open/close event within 5000ms');
        try {
          ws.close();
        } catch {
          // already failed or closing
        }
      }, 5000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve('opened');
        ws.close();
      });
      ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        resolve(`closed (code ${event.code})`);
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        resolve(`error (${redact(event.message || 'non-101 response')})`);
      });
    });
  } catch (error) {
    return `probe threw (${redact(error instanceof Error ? error.message : error)})`;
  }
}

async function testRealtimeChannel(session, userId, expectSuccess) {
  const configState = getSupabaseConfigState();
  if (configState.status !== 'configured') {
    throw new Error('Supabase is not configured');
  }

  const { RealtimeClient } = await import('@supabase/realtime-js');
  const rtUrl = configState.config.url.replace(/^http/, 'ws') + '/realtime/v1';

  return new Promise((resolve, reject) => {
    const rt = new RealtimeClient(rtUrl, {
      params: {
        apikey: configState.config.anonKey,
      },
    });

    rt.setAuth(session.access_token);
    rt.connect();

    const channel = rt.channel(`sync:private:${userId}`, {
      config: {
        private: true,
        broadcast: { self: false },
      },
    });

    // Observed end to end in CI: the private-channel RLS reject took 4.5s to come
    // back, so the original 5s budget failed against a healthy database. On a
    // timeout, the handshake probe below reports whether Realtime is reachable at
    // all, which is the distinction this message used to guess at.
    const JOIN_TIMEOUT_MS = 15000;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rt.disconnect();
      probeRealtimeHandshake(rt.endpointURL(), configState.config.anonKey).then((detail) => {
        reject(
          new Error(
            `realtime join did not settle within ${JOIN_TIMEOUT_MS}ms ` +
              `(${expectSuccess ? 'expected SUBSCRIBED' : 'expected CHANNEL_ERROR'}); ` +
              `raw handshake to the same endpoint: ${detail}`,
          ),
        );
      });
    }, JOIN_TIMEOUT_MS);

    channel.subscribe((status, err) => {
      if (settled) return;
      if (status === 'SUBSCRIBED') {
        if (expectSuccess) {
          channel
            .send({
              type: 'broadcast',
              event: 'sync',
              payload: { test: true },
            })
            .then((sendStatus) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              rt.disconnect();
              if (sendStatus === 'ok') {
                resolve();
              } else {
                reject(new Error(`realtime broadcast send failed (status: ${sendStatus})`));
              }
            })
            .catch((sendErr) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              rt.disconnect();
              reject(new Error(`realtime broadcast send threw error: ${sendErr}`));
            });
        } else {
          settled = true;
          clearTimeout(timeout);
          rt.disconnect();
          reject(new Error('anonymous user successfully joined private channel (expected rejection)'));
        }
      } else if (status === 'CHANNEL_ERROR') {
        settled = true;
        clearTimeout(timeout);
        rt.disconnect();
        if (!expectSuccess) {
          resolve();
        } else {
          reject(new Error(`authenticated user failed to join private channel (status: ${status}, error: ${err})`));
        }
      }
    });
  });
}

function toSession(response) {
  if (
    !response.access_token ||
    !response.refresh_token ||
    !response.token_type ||
    !response.expires_in ||
    !response.user
  ) {
    throw new Error('Supabase auth response did not include a complete session.');
  }

  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token,
    token_type: response.token_type,
    expires_in: response.expires_in,
    expires_at: response.expires_at ?? Math.floor(Date.now() / 1000) + response.expires_in,
    user: response.user,
  };
}

try {
  console.log('Supabase end-to-end verification\n');

  // --- M5: configuration + anonymous auth ---
  const configState = getSupabaseConfigState();
  if (configState.status !== 'configured') {
    fail('configuration', `missing env: ${configState.missing.join(', ')}`);
  }
  ok('configuration', configState.config.url);

  if (!SERVICE_ROLE_KEY) {
    fail(
      'service-role credential',
      'SUPABASE_SECRET_KEY is not set; it is required to create the confirmed verifier user and to delete the accounts this run creates',
    );
  }
  ok('service-role credential');

  const client = createSupabaseClient();
  let session;
  try {
    session = await client.signInAnonymously();
  } catch (error) {
    if (error instanceof SupabaseRequestError && /anonymous/i.test(error.message)) {
      fail(
        'anonymous sign-in',
        'Anonymous sign-ins appear to be disabled. Enable them: Authentication → Sign In / Up.',
      );
    }
    fail('anonymous sign-in', error);
  }
  const anonUserId = session.user.id;
  cleanups.push(() => adminDeleteUser(client, anonUserId));
  ok('anonymous sign-in', `user ${session.user.id}`);

  const refreshed = await client.refreshSession(session.refresh_token);
  if (!refreshed.access_token || refreshed.access_token === session.access_token) {
    fail('token refresh', 'no new access token returned');
  }
  ok('token refresh');
  session = refreshed;

  const restored = await client.restoreSession();
  if (restored.outcome !== 'active' || restored.session.user.id !== session.user.id) {
    fail('session restore', 'restored session missing or for a different user');
  }
  ok('session restore');

  // --- M6: bookmark API against real schema + RLS ---
  const api = createBookmarkApi(session);
  const testUrl = `https://example.com/stash-verify-${Date.now()}`;

  const created = await api.createBookmark({
    url: testUrl, notes: '    verification run\n', notes_format: 'markdown',
  });
  if (created.status !== 'created') {
    fail('createBookmark', `expected status created, got ${created.status}`);
  }
  ok('createBookmark', created.bookmark_id);
  cleanups.push(() => api.deleteBookmark(created.bookmark_id, true));

  const duplicate = await api.createBookmark({ url: testUrl });
  if (duplicate.status !== 'duplicate' || duplicate.bookmark_id !== created.bookmark_id) {
    fail('duplicate save', `expected duplicate of ${created.bookmark_id}, got ${JSON.stringify(duplicate)}`);
  }
  ok('duplicate save reuses bookmark');

  const listed = await api.listBookmarks();
  if (!listed.some((bookmark) => bookmark.id === created.bookmark_id)) {
    fail('listBookmarks', 'created bookmark not in list');
  }
  ok('listBookmarks');
  const createdNote = listed.find((bookmark) => bookmark.id === created.bookmark_id);
  if (createdNote.notes !== '    verification run\n' || createdNote.notes_format !== 'markdown') {
    fail('note format + raw whitespace', 'note source or format did not survive creation');
  }
  ok('note format + raw whitespace');

  await api.updateBookmark(created.bookmark_id, { title: 'Verified title', notes: 'updated' });
  const detailAfterUpdate = await api.getBookmark(created.bookmark_id);
  if (detailAfterUpdate?.bookmark.title !== 'Verified title') {
    fail('updateBookmark', 'title did not persist');
  }
  ok('updateBookmark + getBookmark');

  const memoSource = '# Literal heading\n\n    indented source\n';
  const memo = await api.createBookmark({
    shared_text: memoSource, description_format: 'plain',
    client_id: crypto.randomUUID(), enrichment_policy: 'skip',
  });
  cleanups.push(() => api.deleteBookmark(memo.bookmark_id, true));
  const savedMemo = await api.getBookmark(memo.bookmark_id);
  if (savedMemo?.bookmark.description !== memoSource || savedMemo.bookmark.description_format !== 'plain') {
    fail('plain memo format', 'memo source or format did not survive creation');
  }
  await api.updateBookmark(memo.bookmark_id, { description_format: 'markdown' });
  const formattedMemo = await api.getBookmark(memo.bookmark_id);
  if (formattedMemo?.bookmark.description !== memoSource || formattedMemo.bookmark.description_format !== 'markdown') {
    fail('format-only edit', 'changing format rewrote the memo source or failed to persist');
  }
  ok('plain memo + format-only edit preserves source');

  const tags = await api.addTags({
    bookmark_id: created.bookmark_id,
    tags: ['verify', 'Read Later'],
    source: 'user',
  });
  if (tags.length !== 2) {
    fail('addTags', `expected 2 tags, got ${tags.length}`);
  }
  cleanups.push(async () => {
    for (const tag of tags) {
      await client.request(`/rest/v1/tags?id=eq.${tag.id}`, {
        method: 'DELETE',
        accessToken: session.access_token,
      });
    }
  });
  const detailWithTags = await api.getBookmark(created.bookmark_id);
  if (detailWithTags?.tags.length !== 2) {
    fail('tags on detail', `expected 2, got ${detailWithTags?.tags.length}`);
  }
  ok('addTags + tags on detail');

  await api.removeTags({ bookmark_id: created.bookmark_id, tags: ['verify'] });
  const detailAfterRemove = await api.getBookmark(created.bookmark_id);
  if (detailAfterRemove?.tags.length !== 1) {
    fail('removeTags', `expected 1 tag left, got ${detailAfterRemove?.tags.length}`);
  }
  ok('removeTags');

  const enrichment = await api.updateAIEnrichment({
    bookmark_id: created.bookmark_id,
    summary: 'Verification summary',
    topics: ['testing'],
    suggested_tags: [{ name: 'verified', confidence: 0.99 }],
    status: 'complete',
    model: 'verify-script',
  });
  if (enrichment.summary !== 'Verification summary') {
    fail('updateAIEnrichment', 'summary did not persist');
  }
  const detailWithEnrichment = await api.getBookmark(created.bookmark_id);
  if (detailWithEnrichment?.enrichment?.id !== enrichment.id) {
    fail('enrichment on detail', 'latest enrichment not returned');
  }
  ok('updateAIEnrichment + enrichment on detail');

  await api.applyAISuggestions({ bookmark_id: created.bookmark_id, tag_names: ['verified'] });
  const detailAfterApply = await api.getBookmark(created.bookmark_id);
  if (!detailAfterApply?.tags.some((tag) => tag.slug === 'verified')) {
    fail('applyAISuggestions', 'suggested tag was not promoted');
  }
  cleanups.push(async () => {
    const verifiedTag = detailAfterApply.tags.find((tag) => tag.slug === 'verified');
    if (verifiedTag) {
      await client.request(`/rest/v1/tags?id=eq.${verifiedTag.id}`, {
        method: 'DELETE',
        accessToken: session.access_token,
      });
    }
  });
  ok('applyAISuggestions');

  // --- tags/collections pull + collection creation ---
  const allTags = await api.listTags();
  if (!tags.every((tag) => allTags.some((row) => row.id === tag.id))) {
    fail('listTags', 'created tags missing from full tag list');
  }
  const allLinks = await api.listBookmarkTags();
  if (!allLinks.some((link) => link.bookmark_id === created.bookmark_id)) {
    fail('listBookmarkTags', 'bookmark tag links missing');
  }
  const newCollection = await api.createCollection(`Verify ${Date.now()}`);
  cleanups.push(() =>
    client.request(`/rest/v1/collections?id=eq.${newCollection.id}`, {
      method: 'DELETE',
      accessToken: session.access_token,
    }),
  );
  const allCollections = await api.listCollections();
  if (!allCollections.some((row) => row.id === newCollection.id)) {
    fail('listCollections', 'created collection missing from list');
  }
  ok('tag/collection pull + createCollection');

  // --- M7+ pull queries ---
  const pulledBookmarks = await api.listBookmarksUpdatedSince(null);
  if (!pulledBookmarks.some((bookmark) => bookmark.id === created.bookmark_id)) {
    fail('pull: listBookmarksUpdatedSince', 'created bookmark missing from full pull');
  }
  const pulledIds = await api.listBookmarkIds();
  if (!pulledIds.includes(created.bookmark_id)) {
    fail('pull: listBookmarkIds', 'created bookmark missing from ID list');
  }
  const pulledEnrichments = await api.listEnrichmentsUpdatedSince(null);
  if (!pulledEnrichments.some((row) => row.id === enrichment.id)) {
    fail('pull: listEnrichmentsUpdatedSince', 'enrichment missing from full pull');
  }
  const future = new Date(Date.now() + 60_000).toISOString();
  const noneSinceFuture = await api.listBookmarksUpdatedSince(future);
  if (noneSinceFuture.length !== 0) {
    fail('pull: incremental filter', `expected 0 rows since the future, got ${noneSinceFuture.length}`);
  }
  ok('pull queries (full, IDs, enrichments, incremental filter)');

  // NOTE (review #6): this assert is intentionally archive-by-default, and is
  // correct for the REST surface. The app-side `trashBookmark` performs a
  // move-to-trash (sets `deleted_at`), but the REST `api.deleteBookmark`
  // (apps/mobile/src/api/bookmarks.ts) only sets `is_archived` — it has NO
  // trash/`deleted_at` semantics. So "archive-by-default delete" is the right
  // expectation here; do NOT change it to assert `deleted_at`. Whether the REST
  // API *should* gain move-to-trash semantics to match the app is a product
  // decision flagged for the owner, not changed in this script.
  const archived = await api.deleteBookmark(created.bookmark_id);
  void archived;
  const detailAfterArchive = await api.getBookmark(created.bookmark_id);
  if (detailAfterArchive?.bookmark.is_archived !== true) {
    fail('archive (default delete)', 'bookmark is not archived');
  }
  ok('archive-by-default delete');

  // --- M5/M6: RLS isolation with a second anonymous user ---
  await clearSupabaseSession();
  const sessionB = await client.signInAnonymously();
  if (sessionB.user.id === session.user.id) {
    fail('second anonymous user', 'same user returned twice');
  }
  cleanups.push(() => adminDeleteUser(client, sessionB.user.id));
  const apiB = createBookmarkApi(sessionB);

  const listedB = await apiB.listBookmarks({ is_archived: true });
  if (listedB.some((bookmark) => bookmark.id === created.bookmark_id)) {
    fail('RLS list isolation', "user B can see user A's bookmark");
  }
  ok('RLS: list isolation');

  const foreignDetail = await apiB.getBookmark(created.bookmark_id);
  if (foreignDetail !== null) {
    fail('RLS read isolation', "user B can read user A's bookmark");
  }
  ok('RLS: read isolation');

  await expectRejects(
    'RLS: write isolation (cross-user update rejected)',
    apiB.updateBookmark(created.bookmark_id, { title: 'hijacked' }),
  );

  // --- realtime broadcast policy verification ---
  console.log('\nVerifying realtime broadcast policies...');

  // Test 1: Anonymous user (User A) is denied subscription
  try {
    await testRealtimeChannel(session, session.user.id, false);
    ok('Realtime RLS: anonymous subscription rejected');
  } catch (error) {
    fail('Realtime RLS: anonymous subscription check failed', error);
  }

  // Test 2: Real authenticated user is allowed subscription. The verifier has to be
  // a confirmed, non-anonymous user, so it is created through the Admin API and
  // then signed in through the ordinary password grant — the public sign-up
  // endpoint returns no session while "Confirm email" is enabled on the project.
  // Identity is unique per run because the run deletes the account afterward: a
  // fixed address plus a fixed password would survive a crashed run as a
  // sign-in-able real user.
  const verifierEmail = `realtime-policy-verifier+${Date.now()}@keepory.app`;
  const verifierPassword = crypto.randomUUID();
  let realSession;
  try {
    const verifier = await client.request('/auth/v1/admin/users', {
      method: 'POST',
      accessToken: SERVICE_ROLE_KEY,
      body: { email: verifierEmail, password: verifierPassword, email_confirm: true },
    });
    cleanups.push(() => adminDeleteUser(client, verifier.id));
    const loginResponse = await client.request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: verifierEmail, password: verifierPassword },
    });
    realSession = toSession(loginResponse);
  } catch (error) {
    fail('Realtime RLS: could not create and sign in a confirmed verifier user', error);
  }

  try {
    await testRealtimeChannel(realSession, realSession.user.id, true);
    ok('Realtime RLS: authenticated subscription approved');
  } catch (error) {
    fail('Realtime RLS: authenticated subscription check failed', error);
  }

  // Test 3: Authenticated User A cannot subscribe to User B's channel
  try {
    await testRealtimeChannel(realSession, session.user.id, false);
    ok("Realtime RLS: User A rejected from subscribing to User B's channel");
  } catch (error) {
    fail("Realtime RLS: User A cross-subscription security check failed", error);
  }

  cleanups.push(async () => {
    try {
      await client.request('/auth/v1/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${realSession.access_token}` },
      });
    } catch {
      // ignore logout failure on cleanup
    }
  });

  console.log(`\nAll ${passed} checks passed.`);
} catch (error) {
  if (!(error instanceof VerificationAbort)) {
    console.error('\nUnexpected failure:', error);
    process.exitCode = 1;
  }
  console.error(`\nStopped after ${passed} passing check(s).`);
} finally {
  let cleaned = 0;
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
      cleaned += 1;
    } catch {
      // best-effort cleanup
    }
  }
  if (cleanups.length > 0) {
    console.log(`Cleanup: ${cleaned}/${cleanups.length} steps completed.`);
  }
}

// Realtime sockets/timers can outlive their disconnect() call and keep the
// event loop alive, hanging the process (and the CI job) indefinitely.
process.exit(process.exitCode ?? 0);
