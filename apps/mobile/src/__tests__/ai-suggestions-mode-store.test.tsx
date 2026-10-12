import './helpers/ai-suggestions-mode-harness';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AI_SUGGESTIONS_MODE_PREF_KEY } from '@/domain/ai-suggestions-pref';
import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';
import { apiMock, fakeRepo, ID_A, ID_B, ID_C, mockEnvironment, mockEnsureSession, mockReadUser, mockWriteUser, renderStore, resetAiSuggestionsHarness } from './helpers/ai-suggestions-mode-harness';

beforeEach(resetAiSuggestionsHarness);

// --- #573: the 3-tier mode itself ---

test('default mode is confirm, matching today\'s existing behavior with no settings change', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  expect(store.current!.aiSuggestionsMode).toBe('confirm');
});

test("'off' mode skips the automatic deferred trigger, but a manual request still works", async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  // Seed the mode as 'off' before mounting so the store hydrates it directly
  // (avoids racing the deferred-trigger effect's very first run).
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'off');
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ID_A]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.aiSuggestionsMode).toBe('off');

  // Give the deferred-trigger effect every chance to fire — it must not.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
  // The durable "awaiting first attempt" marker is left untouched (not
  // consumed) so switching back to 'confirm'/'auto_accept' later still fires it.
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([ID_A]));

  // A manual "Suggest with AI" tap must still work in 'off' mode.
  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(ID_A); // default source: 'manual'
  });
  expect(error).toBeNull();
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(ID_A, expect.anything(), 'en');
});

test("'off' mode also skips the backoff-scheduled retry check", async () => {
  const now = new Date().toISOString();
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'off');
  await fakeRepo.repository.setMeta(
    'ai_suggestion_retry',
    JSON.stringify({ [ID_A]: { firstAttemptAt: now, lastAttemptAt: now, attemptCount: 1 } }),
  );

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    await Promise.resolve();
  });
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
});

// --- #573: auto_accept applies only high-confidence suggestions, and never
// relocates a bookmark the user (or an earlier accept) already filed ---

test('auto_accept applies a high-confidence tag, skips a low-confidence one, and never touches user-authored fields', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: ID_A,
      metadata_status: 'complete',
      collection_id: null, // unfiled
      notes: 'my own note',
      title: 'My own title',
    }),
  ]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'auto_accept');

  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-auto-accept',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: 'A generated summary.',
    topics: [],
    suggested_tags: [
      { name: 'design', confidence: 0.8 }, // at/above SUGGESTION_MIN_CONFIDENCE (0.6)
      { name: 'noise', confidence: 0.3 }, // below threshold
    ],
    suggested_collection_id: null,
    suggested_collection_name: 'Reading', // no matching existing collection -> "create"
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.aiSuggestionsMode).toBe('auto_accept');

  await act(async () => {
    await store.current!.requestAiEnrichment(ID_A, 'auto');
  });

  // High-confidence tag applied automatically, low-confidence one is not.
  const tagNames = store.current!.getTagsForBookmark(ID_A).map((tag) => tag.name);
  expect(tagNames).toContain('design');
  expect(tagNames).not.toContain('noise');

  // The unfiled bookmark was filed into the newly created suggested folder.
  expect(apiMock.__spies.createCollection).toHaveBeenCalledWith('Reading');
  expect(store.current!.getBookmark(ID_A)?.collection_id).toBe('coll-reading');

  // User-authored fields are completely untouched.
  expect(store.current!.getBookmark(ID_A)?.notes).toBe('my own note');
  expect(store.current!.getBookmark(ID_A)?.title).toBe('My own title');

  // Auto-accept already handled it, so it should not ALSO raise the "new
  // suggestions" review banner for the same tags/folder.
  expect(store.current!.unseenSuggestionIds.has(ID_A)).toBe(false);
});

test('auto_accept never relocates a bookmark that is already filed in a different collection', async () => {
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id: ID_B,
        metadata_status: 'complete',
        collection_id: 'coll-existing',
      }),
    ],
    {
      tags: [],
      bookmarkTags: [],
      collections: [
        {
          id: 'coll-existing',
          user_id: 'user-test',
          name: 'Existing',
          description: null,
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    },
  );
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_B]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'auto_accept');

  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-move-suggestion',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: 'Somewhere Else',
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    await store.current!.requestAiEnrichment(ID_B, 'auto');
  });

  // A folder suggestion that would MOVE an already-filed bookmark is never
  // auto-applied -- only a fill of a still-unfiled bookmark is.
  expect(apiMock.__spies.createCollection).not.toHaveBeenCalled();
  expect(store.current!.getBookmark(ID_B)?.collection_id).toBe('coll-existing');
});

test('a broken auto_accept application (e.g. a failed createCollection call) still keeps the fetched enrichment and does not arm a spurious retry', async () => {
  // Regression: auto-accept used to run BEFORE the enrichment write and
  // inside the same try as the network fetch, so a bug in applying its
  // suggestions (unrelated to whether the fetch itself succeeded) would land
  // in requestAiEnrichment's OWN catch -- discarding a successfully fetched
  // enrichment and arming a retry for a request that actually succeeded.
  fakeRepo.__reset([
    makeStoredBookmark({ id: ID_A, metadata_status: 'complete', collection_id: null }),
  ]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'auto_accept');
  apiMock.__spies.createCollection.mockRejectedValueOnce(new Error('network blip'));

  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-auto-accept-broken',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: 'Reading', // triggers the (failing) createCollection path
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(ID_A, 'auto');
  });

  // The fetch itself succeeded, so requestAiEnrichment must report success...
  expect(error).toBeNull();
  // ...the enrichment is durably recorded regardless of auto-accept's fate...
  expect(store.current!.getEnrichment(ID_A)?.id).toBe('enrichment-auto-accept-broken');
  // ...and no retry is armed for what was actually a successful request. (No
  // retry was ever previously armed here, so clearAiRetry is a no-op and the
  // meta key is simply never written — `null`, not `'{}'`; see clearAiRetry.)
  expect(store.current!.isAiSuggestionPostponed(ID_A)).toBe(false);
  expect(fakeRepo.__meta('ai_suggestion_retry')).toBeNull();
});

// --- STASH-4P: auto_accept must also apply to enrichments this device never
// itself requested -- the background overflow worker's output, delivered
// through the ordinary sync pull. Previously only the direct-dispatch path
// (requestAiEnrichment's own settle handler) ran auto-accept, so a worker-
// completed enrichment landed with real suggested_tags but never got applied
// to bookmark_tags. ---

test('a worker-driven enrichment arriving via sync pull is auto-accepted too (STASH-4P)', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: ID_A, metadata_status: 'complete', collection_id: null }),
  ]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'auto_accept');

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.aiSuggestionsMode).toBe('auto_accept');

  // This device never called requestAiEnrichment for ID_A -- exactly how the
  // background overflow worker's result arrives, via the ordinary sync pull.
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({
      id: 'enrichment-worker-auto-accept',
      bookmark_id: ID_A,
      suggested_tags: [{ name: 'design', confidence: 0.8 }],
    }),
  ]);

  await act(async () => {
    await store.current!.syncNow();
  });

  await waitFor(() => expect(store.current!.getEnrichment(ID_A)).toBeDefined());
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(store.current!.getTagsForBookmark(ID_A).map((tag) => tag.name)).toContain('design'),
  );
});

// --- #574 Phase 1: staggered burst dispatch + completion toast ---

// These two run against REAL timers (not jest fake timers): the drain loop's
// setInterval-driven state update doesn't reliably propagate to a rendered
// hook consumer under this project's jest-expo + fake-timer combination (the
// same friction the pre-existing periodic-retry-check tests sidestep by
// invoking the registered foreground handler directly rather than letting a
// real/fake interval fire it — see `fireForeground` above). The real
// AI_ENRICHMENT_DISPATCH_STAGGER_MS is only 400ms, so real-time waits here
// stay fast and are not flaky: the second/third dispatch genuinely cannot
// fire before their own stagger tick elapses, regardless of machine speed.
test('a burst of auto-triggered bookmarks dispatches staggered (not all at once), and the completion toast fires once it drains', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: ID_A, metadata_status: 'complete' }),
    makeStoredBookmark({ id: ID_B, metadata_status: 'complete' }),
    makeStoredBookmark({ id: ID_C, metadata_status: 'complete' }),
  ]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A, ID_B, ID_C]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ID_A, ID_B, ID_C]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  // Nothing dispatches synchronously on mount — only once the first stagger
  // tick elapses.
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();

  // Well past one stagger tick (400ms) but comfortably short of two (800ms):
  // proves the burst is staggered rather than firing all three at once.
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1), {
    timeout: 700,
  });
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1);

  // The rest drain over the following stagger ticks.
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(3), {
    timeout: 3000,
  });

  // All three ran (staggered) and every one of them settled, so this counts
  // as a burst worth a completion toast.
  await waitFor(() => expect(store.current!.aiEnrichmentBurstToast?.count).toBe(3));
}, 10000);

test('a single, routine auto-trigger completion does not raise the burst toast', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ID_A]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  // Wait for the single dispatch to fully settle, then assert no toast was
  // raised for it — a lone completion is not a "burst".
  await waitFor(() => expect(store.current!.getEnrichment(ID_A)).toBeDefined(), { timeout: 2000 });
  expect(store.current!.aiEnrichmentBurstToast).toBeNull();
}, 10000);


test('first-login preference hydration precedes the pull so its delivered AI tags auto-apply', async () => {
  mockEnvironment.status = 'authenticated';
  mockEnvironment.session.user.is_anonymous = false;
  let resolveUser!: (user: unknown) => void;
  mockReadUser.mockImplementationOnce(() => new Promise((resolve) => { resolveUser = resolve; }));
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({
      id: 'first-login-worker', bookmark_id: ID_A,
      suggested_tags: [{ name: 'design', confidence: 0.9 }],
    }),
  ]);
  const store = renderStore();
  await waitFor(() => expect(resolveUser).toBeDefined());
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  expect(apiMock.__spies.listEnrichmentsUpdatedSince).not.toHaveBeenCalled();
  await act(async () => { resolveUser({ id: 'user-test', user_metadata: {} }); });
  await waitFor(() => expect(store.current?.aiSuggestionsMode).toBe('auto_accept'));
  await waitFor(() => expect(store.current!.getTagsForBookmark(ID_A).map((tag) => tag.name)).toContain('design'));
  expect(apiMock.__spies.listEnrichmentsUpdatedSince).toHaveBeenCalled();
});


test('paused cold launch reveals the owned local library before a stalled preference read finishes', async () => {
  mockEnvironment.status = 'authenticated';
  mockEnvironment.session.user.is_anonymous = false;
  let finish!: (user: unknown) => void;
  mockReadUser.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pref.sync.paused', 'true');
  await fakeRepo.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'user-test', isAnonymous: false }));
  const store = renderStore();
  await waitFor(() => expect(finish).toBeDefined());
  await waitFor(() => expect(store.current?.inbox.map((row) => row.id)).toContain(ID_A));
  expect(apiMock.__spies.listEnrichmentsUpdatedSince).not.toHaveBeenCalled();
  await act(async () => { finish({ id: 'user-test', user_metadata: { ai_suggestions_mode: 'off' } }); });
});

test('offline cold launch restores the local library without asking for a remote preference', async () => {
  mockEnvironment.offline = true;
  mockEnvironment.status = 'authenticated';
  mockEnvironment.session.user.is_anonymous = false;
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'user-test', isAnonymous: false }));
  await fakeRepo.repository.setMeta(`${AI_SUGGESTIONS_MODE_PREF_KEY}.account.user-test`, 'off');
  const store = renderStore();
  await waitFor(() => expect(store.current?.inbox.map((row) => row.id)).toContain(ID_A));
  expect(mockReadUser).not.toHaveBeenCalled();
  expect(apiMock.__spies.listEnrichmentsUpdatedSince).not.toHaveBeenCalled();
});

test.each([null, 'off'])('linking the same guest ID retains staged work across mode loading and %s', async (remoteMode) => {
  jest.useFakeTimers();
  let finish!: (user: unknown) => void;
  try {
    fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
    apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
    await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ID_A]));
    const wrapper = ({ children }: { children: ReactNode }) => <BookmarksProvider>{children}</BookmarksProvider>;
    const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.lastPulledAt).not.toBeNull());
    expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
    mockReadUser.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mockEnvironment.status = 'authenticated';
    mockEnvironment.session.user.is_anonymous = false;
    await rerender(undefined);
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => { jest.advanceTimersByTime(1200); });
    expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
    expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([ID_A]));
    await act(async () => { finish({ id: 'user-test', user_metadata: remoteMode ? { ai_suggestions_mode: remoteMode } : {} }); });
    await waitFor(() => expect(result.current.aiSuggestionsMode).toBe(remoteMode || 'auto_accept'));
    if (remoteMode === 'off') {
      await act(async () => { jest.advanceTimersByTime(400); });
      expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
      await act(() => result.current.setAiSuggestionsMode('auto_accept'));
    }
    await act(async () => { jest.advanceTimersByTime(400); });
    await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(ID_A, expect.anything(), 'en'));
  } finally {
    jest.useRealTimers();
  }
});


test.each(['auto_accept', 'off'])('an in-flight guest result waits for the linked account %s decision', async (mode) => {
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'auto_accept');
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ID_A]));
  let finishAi!: () => void;
  const aiGate = new Promise<void>((resolve) => { finishAi = resolve; });
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (id: string) => {
    await aiGate;
    return makeEnrichment({ bookmark_id: id, suggested_tags: [{ name: 'design', confidence: 0.9 }] });
  });
  const wrapper = ({ children }: { children: ReactNode }) => <BookmarksProvider>{children}</BookmarksProvider>;
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));
  let finishMode!: (user: unknown) => void;
  mockReadUser.mockImplementationOnce(() => new Promise((resolve) => { finishMode = resolve; }));
  mockEnvironment.status = 'authenticated';
  mockEnvironment.session.user.is_anonymous = false;
  await rerender(undefined);
  await waitFor(() => expect(finishMode).toBeDefined());
  await act(async () => { finishAi(); });
  await waitFor(() => expect(result.current.getEnrichment(ID_A)).toBeDefined());
  expect(result.current.getTagsForBookmark(ID_A).map((tag) => tag.name)).not.toContain('design');
  await act(async () => { finishMode({ id: 'user-test', user_metadata: { ai_suggestions_mode: mode } }); });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe(mode));
  if (mode === 'auto_accept') {
    await waitFor(() => expect(result.current.getTagsForBookmark(ID_A).map((tag) => tag.name)).toContain('design'));
  } else {
    expect(result.current.getTagsForBookmark(ID_A).map((tag) => tag.name)).not.toContain('design');
  }
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1);
});

test('sync uses the refreshed bearer policy before a same-account React session commit', async () => {
  mockEnvironment.status = 'authenticated';
  mockEnvironment.session.user.is_anonymous = false;
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  mockReadUser.mockImplementation(async (token: string) => ({
    id: 'user-test', user_metadata: { ai_suggestions_mode: token === 'fresh-sync' ? 'off' : 'auto_accept' },
  }));
  const store = renderStore();
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  await waitFor(() => expect(store.current?.isSyncing).toBe(false));
  expect(store.current!.aiSuggestionsMode).toBe('auto_accept');
  mockEnsureSession.mockResolvedValueOnce({ ...mockEnvironment.session, access_token: 'fresh-sync' });
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({ bookmark_id: ID_A, suggested_tags: [{ name: 'design', confidence: 0.9 }] }),
  ]);
  await act(async () => { await store.current!.syncNow(); });
  expect(mockReadUser).toHaveBeenCalledWith('fresh-sync');
  expect(store.current!.aiSuggestionsMode).toBe('off');
  expect(store.current!.getEnrichment(ID_A)).toBeDefined();
  expect(store.current!.getTagsForBookmark(ID_A).map((tag) => tag.name)).not.toContain('design');
});

test('a worker result pulled after an unknown mode read auto-applies once the safe retry resolves', async () => {
  jest.useFakeTimers();
  try {
    mockEnvironment.status = 'authenticated';
    mockEnvironment.session.user.is_anonymous = false;
    mockReadUser.mockRejectedValueOnce(new Error('transient auth service error'));
    fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
    apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
    apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
      makeEnrichment({ bookmark_id: ID_A, suggested_tags: [{ name: 'design', confidence: 0.9 }] }),
    ]);
    const wrapper = ({ children }: { children: ReactNode }) => <BookmarksProvider>{children}</BookmarksProvider>;
    const { result } = await renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.getEnrichment(ID_A)).toBeDefined());
    expect(result.current.aiSuggestionsMode).toBe('off');
    expect(result.current.getTagsForBookmark(ID_A).map((tag) => tag.name)).not.toContain('design');
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
    await waitFor(() => expect(result.current.getTagsForBookmark(ID_A).map((tag) => tag.name)).toContain('design'));
  } finally { jest.useRealTimers(); }
});

test('a deferred completion after provider unmount cannot repopulate the next cache notification flags', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'auto_accept');
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ID_A]));
  let finishAi!: () => void;
  const aiGate = new Promise<void>((resolve) => { finishAi = resolve; });
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    await aiGate;
    return makeEnrichment({ bookmark_id: ID_A, suggested_tags: [{ name: 'design', confidence: 0.9 }] });
  });
  const wrapper = ({ children }: { children: ReactNode }) => <BookmarksProvider>{children}</BookmarksProvider>;
  const { result, rerender, unmount } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));
  let finishMode!: (user: unknown) => void;
  mockReadUser.mockImplementationOnce(() => new Promise((resolve) => { finishMode = resolve; }));
  mockEnvironment.status = 'authenticated';
  mockEnvironment.session.user.is_anonymous = false;
  await rerender(undefined);
  await waitFor(() => expect(finishMode).toBeDefined());
  await act(async () => { finishAi(); });
  await waitFor(() => expect(result.current.getEnrichment(ID_A)).toBeDefined());
  await unmount();
  await fakeRepo.repository.setMeta('unseen_ai_suggestions', '[]');
  await act(async () => { finishMode({ id: 'user-test', user_metadata: { ai_suggestions_mode: 'auto_accept' } }); });
  expect(fakeRepo.__meta('unseen_ai_suggestions')).toBe('[]');
});


test('an automatic request awaiting account A policy cancels after switching to B', async () => {
  const source = 'auto';
  mockEnvironment.status = 'authenticated';
  mockEnvironment.session.user.is_anonymous = false;
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pref.sync.paused', 'true');
  await fakeRepo.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'user-test', isAnonymous: false }));
  let finishA!: (user: unknown) => void;
  mockReadUser.mockImplementationOnce(() => new Promise((resolve) => { finishA = resolve; }));
  const wrapper = ({ children }: { children: ReactNode }) => <BookmarksProvider>{children}</BookmarksProvider>;
  const { result, rerender, unmount } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.inbox.map((row) => row.id)).toContain(ID_A));
  let request!: Promise<string | null>;
  await act(async () => { request = result.current.requestAiEnrichment(ID_A, source); });
  await waitFor(() => expect(result.current.isEnriching(ID_A)).toBe(true));
  mockEnvironment.session = { ...mockEnvironment.session, access_token: 'token-B', user: { id: 'B', is_anonymous: false } };
  mockReadUser.mockResolvedValue({ id: 'B', user_metadata: { ai_suggestions_mode: 'auto_accept' } });
  await rerender(undefined);
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  await act(async () => { finishA({ id: 'user-test', user_metadata: { ai_suggestions_mode: 'auto_accept' } }); await request; });
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
  expect(result.current.getEnrichment(ID_A)).toBeUndefined();
  expect((await fakeRepo.repository.listEnrichments()).some((row) => row.bookmark_id === ID_A)).toBe(false);
  await unmount();
});

test('when an initial cache-owner read transiently fails, ownership reconciliation and sync resume on recovery', async () => {
  jest.useFakeTimers();
  mockEnvironment.status = 'authenticated';
  mockEnvironment.session.user.is_anonymous = false;
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pref.sync.paused', 'true');
  await fakeRepo.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'user-test', isAnonymous: false }));
  mockReadUser.mockResolvedValue({ id: 'user-test', user_metadata: { ai_suggestions_mode: 'auto_accept' } });
  const getMeta = jest.spyOn(fakeRepo.repository, 'getMeta');
  try {
    getMeta.mockImplementation(async (key: string) => {
      if (key === 'bookmark_cache_owner') {
        getMeta.mockRestore();
        throw new Error('temporary disk read failure');
      }
      return fakeRepo.__meta(key);
    });
    const wrapper = ({ children }: { children: ReactNode }) => <BookmarksProvider>{children}</BookmarksProvider>;
    const { result, unmount } = await renderHook(() => useBookmarks(), { wrapper });
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await waitFor(() => expect(result.current.inbox.map((row) => row.id)).toContain(ID_A));
    expect(result.current.aiSuggestionsMode).toBe('auto_accept');
    await unmount();
  } finally {
    getMeta.mockRestore();
    jest.useRealTimers();
  }
});


test.each(['off', 'auto_accept'])('manual AI completes during account loading and defers application until %s resolves', async (mode) => {
  mockEnvironment.status = 'authenticated';
  mockEnvironment.session.user.is_anonymous = false;
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pref.sync.paused', 'true');
  await fakeRepo.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'user-test', isAnonymous: false }));
  let finish!: (user: unknown) => void;
  mockReadUser.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  apiMock.__spies.requestEnrichment.mockResolvedValueOnce(makeEnrichment({ bookmark_id: ID_A, suggested_tags: [{ name: 'design', confidence: 0.9 }] }));
  const wrapper = ({ children }: { children: ReactNode }) => <BookmarksProvider>{children}</BookmarksProvider>;
  const { result } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.inbox.map((row) => row.id)).toContain(ID_A));
  await act(async () => { expect(await result.current.requestAiEnrichment(ID_A)).toBeNull(); });
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1);
  expect(result.current.getEnrichment(ID_A)).toBeDefined();
  expect(result.current.getTagsForBookmark(ID_A).map((tag) => tag.name)).not.toContain('design');
  await act(async () => { finish({ id: 'user-test', user_metadata: { ai_suggestions_mode: mode } }); });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe(mode));
  if (mode === 'auto_accept') await waitFor(() => expect(result.current.getTagsForBookmark(ID_A).map((tag) => tag.name)).toContain('design'));
  else expect(result.current.getTagsForBookmark(ID_A).map((tag) => tag.name)).not.toContain('design');
});

test('a manual result arriving after account departure is not inserted into the new cache', async () => {
  mockEnvironment.status = 'authenticated';
  mockEnvironment.session.user.is_anonymous = false;
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pref.sync.paused', 'true');
  await fakeRepo.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'user-test', isAnonymous: false }));
  let finishPolicy!: (user: unknown) => void;
  mockReadUser.mockImplementationOnce(() => new Promise((resolve) => { finishPolicy = resolve; }));
  let finishAi!: () => void;
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { finishAi = resolve; });
    return makeEnrichment({ bookmark_id: ID_A });
  });
  const wrapper = ({ children }: { children: ReactNode }) => <BookmarksProvider>{children}</BookmarksProvider>;
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.inbox.map((row) => row.id)).toContain(ID_A));
  let request!: Promise<string | null>;
  await act(async () => { request = result.current.requestAiEnrichment(ID_A); });
  await waitFor(() => expect(finishAi).toBeDefined());
  mockEnvironment.session = { ...mockEnvironment.session, access_token: 'token-B', user: { id: 'B', is_anonymous: false } };
  mockReadUser.mockResolvedValue({ id: 'B', user_metadata: { ai_suggestions_mode: 'auto_accept' } });
  await rerender(undefined);
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  await act(async () => { finishAi(); await request; finishPolicy({ id: 'user-test', user_metadata: {} }); });
  expect(result.current.getEnrichment(ID_A)).toBeUndefined();
  expect((await fakeRepo.repository.listEnrichments()).some((row) => row.bookmark_id === ID_A)).toBe(false);
});
