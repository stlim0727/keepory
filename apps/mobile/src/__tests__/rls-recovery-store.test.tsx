import './helpers/ai-enrichment-harness';
import type { LocalPendingBookmark } from '@/domain/types';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, renderStore, resetEnrichmentHarness, SYNCED_ID } from './helpers/ai-enrichment-harness';
import { makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);

function stalledEntry(): LocalPendingBookmark {
  return {
    local_id: SYNCED_ID,
    remote_id: null,
    operation: 'create',
    changes: [{ source: 'account_rehome', fields: [], at: '2026-06-12T00:00:00.000Z' }],
    payload: { url: 'https://example.com/stored', collection_id: 'previous-account-folder' },
    sync_status: 'failed',
    retry_count: 8,
    last_error: 'new row violates row-level security policy',
    last_error_kind: 'permission',
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
}

async function seedStalledCapture() {
  await fakeRepo.repository.updateBookmark(makeStoredBookmark({
    id: SYNCED_ID, collection_id: 'previous-account-folder', sync_status: 'failed',
  }));
  await fakeRepo.repository.enqueue(stalledEntry());
}

test('cold hydration durably repairs a stalled collection permission failure while sync is paused', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await seedStalledCapture();
  fakeRepo.__setMeta('pref.sync.paused', 'true');
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(fakeRepo.__queue()[0]).toMatchObject({
    sync_status: 'pending', retry_count: 0, last_error: null, last_error_kind: null,
  }));
  expect(fakeRepo.__queue()[0].payload).not.toHaveProperty('collection_id');
  expect(fakeRepo.__bookmarks()[0]).toMatchObject({ collection_id: null, sync_status: 'pending' });
  expect(store.current?.inbox[0].collection_id).toBeNull();
  expect(apiMock.__spies.createBookmark).not.toHaveBeenCalled();
});

test('sync reload repairs durable stalled work before automatic retry eligibility and upload', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  fakeRepo.__setMeta('pref.sync.paused', 'true');
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await seedStalledCapture();
  apiMock.__spies.createBookmark.mockImplementationOnce(async (input: Record<string, unknown>) => {
    expect(input).not.toHaveProperty('collection_id', 'previous-account-folder');
    expect(fakeRepo.__queue()[0]).toMatchObject({ sync_status: 'pending', retry_count: 0 });
    expect(fakeRepo.__bookmarks()[0].collection_id).toBeNull();
    return { bookmark_id: SYNCED_ID };
  });
  await act(async () => { store.current!.setSyncPaused(false); });
  await waitFor(() => expect(apiMock.__spies.createBookmark).toHaveBeenCalled());
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
});

test('hydration waits for atomic repair and preserves newer rows and captures while loading', async () => {
  const secondId = '22222222-2222-4222-8222-222222222222';
  const captureId = '33333333-3333-4333-8333-333333333333';
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID }), makeStoredBookmark({ id: secondId })]);
  await seedStalledCapture();
  await fakeRepo.repository.updateBookmark(makeStoredBookmark({
    id: secondId, title: 'Original title', collection_id: 'previous-account-folder', sync_status: 'failed',
  }));
  await fakeRepo.repository.enqueue({ ...stalledEntry(), local_id: secondId });
  fakeRepo.__setMeta('pref.sync.paused', 'true');
  const repair = fakeRepo.repository.repairStalledCollectionRlsEntries;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  const spy = jest.spyOn(fakeRepo.repository, 'repairStalledCollectionRlsEntries').mockImplementation(async () => {
    started = true;
    await gate;
    return repair();
  });
  try {
    const store = renderStore();
    await waitFor(() => expect(started).toBe(true));
    expect(store.current?.isLoading).toBe(true);
    await fakeRepo.repository.updateBookmark(makeStoredBookmark({
      id: SYNCED_ID, title: 'First row edited while write waits', collection_id: 'previous-account-folder', sync_status: 'failed',
    }));
    await fakeRepo.repository.updateQueueEntry({
      ...stalledEntry(), payload: { ...stalledEntry().payload, title: 'First row edited while write waits' },
    });
    await fakeRepo.repository.updateBookmark(makeStoredBookmark({
      id: secondId, title: 'Edited during loading', collection_id: 'previous-account-folder', sync_status: 'failed',
    }));
    await fakeRepo.repository.updateQueueEntry({
      ...stalledEntry(), local_id: secondId,
      payload: { ...stalledEntry().payload, title: 'Edited during loading' },
    });
    await fakeRepo.repository.insertBookmark(makeStoredBookmark({ id: captureId, title: 'New capture' }));
    await act(async () => { release(); });
    await waitFor(() => expect(store.current?.isLoading).toBe(false));
    expect(fakeRepo.__bookmarks().find((row) => row.id === secondId)).toMatchObject({
      title: 'Edited during loading', collection_id: null, sync_status: 'pending',
    });
    expect(fakeRepo.__queue().find((entry) => entry.local_id === SYNCED_ID)?.payload.title).toBe('First row edited while write waits');
    expect(fakeRepo.__queue().find((entry) => entry.local_id === secondId)?.payload.title).toBe('Edited during loading');
    expect(store.current?.inbox.find((row) => row.id === SYNCED_ID)?.title).toBe('First row edited while write waits');
    expect(fakeRepo.__bookmarks().find((row) => row.id === SYNCED_ID)?.title).toBe('First row edited while write waits');
    expect(store.current?.inbox.find((row) => row.id === secondId)?.title).toBe('Edited during loading');
    expect(store.current?.inbox.find((row) => row.id === captureId)?.title).toBe('New capture');
    expect(apiMock.__spies.createBookmark).not.toHaveBeenCalled();
  } finally {
    release();
    spy.mockRestore();
  }
});

test('sync repair uploads fresh queue payloads and preserves edits while atomic repair waits', async () => {
  const secondId = '22222222-2222-4222-8222-222222222222';
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID }), makeStoredBookmark({ id: secondId })]);
  fakeRepo.__setMeta('pref.sync.paused', 'true');
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await seedStalledCapture();
  await fakeRepo.repository.updateBookmark(makeStoredBookmark({
    id: secondId, title: 'Original title', collection_id: 'previous-account-folder', sync_status: 'failed',
  }));
  await fakeRepo.repository.enqueue({ ...stalledEntry(), local_id: secondId });
  apiMock.__spies.createBookmarks.mockImplementationOnce(async () => {
    expect(fakeRepo.__queue().find((entry) => entry.local_id === SYNCED_ID)?.payload.title).toBe('First fresh payload');
    expect(fakeRepo.__queue().find((entry) => entry.local_id === secondId)?.payload.title).toBe('Second fresh title');
    return [SYNCED_ID, secondId].map((bookmark_id) => ({
      bookmark_id, status: 'created' as const, metadata_status: 'pending' as const,
    }));
  });
  const repair = fakeRepo.repository.repairStalledCollectionRlsEntries;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  const spy = jest.spyOn(fakeRepo.repository, 'repairStalledCollectionRlsEntries').mockImplementation(async () => {
    started = true;
    await gate;
    return repair();
  });
  try {
    await act(async () => { store.current!.setSyncPaused(false); });
    await waitFor(() => expect(started).toBe(true));
    await fakeRepo.repository.updateBookmark(makeStoredBookmark({
      id: SYNCED_ID, title: 'First fresh payload', collection_id: 'previous-account-folder', sync_status: 'failed',
    }));
    await fakeRepo.repository.updateQueueEntry({
      ...stalledEntry(), payload: { ...stalledEntry().payload, title: 'First fresh payload' },
    });
    await fakeRepo.repository.updateBookmark(makeStoredBookmark({
      id: secondId, title: 'Second fresh title', collection_id: 'previous-account-folder', sync_status: 'failed',
    }));
    await fakeRepo.repository.updateQueueEntry({
      ...stalledEntry(), local_id: secondId,
      payload: { ...stalledEntry().payload, title: 'Second fresh title' },
    });
    expect(apiMock.__spies.createBookmarks).not.toHaveBeenCalled();
    await act(async () => { release(); });
    await waitFor(() => expect(apiMock.__spies.createBookmarks).toHaveBeenCalled());
    const inputs = apiMock.__spies.createBookmarks.mock.calls[0][0];
    expect(inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'First fresh payload' }),
      expect.objectContaining({ title: 'Second fresh title' }),
    ]));
    for (const input of inputs) expect(input).not.toHaveProperty('collection_id', 'previous-account-folder');
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
    expect(fakeRepo.__bookmarks().find((row) => row.id === SYNCED_ID)?.title).toBe('First fresh payload');
    expect(fakeRepo.__bookmarks().find((row) => row.id === secondId)?.title).toBe('Second fresh title');
  } finally {
    release();
    spy.mockRestore();
  }
});

test('hydration does not resurrect rows removed while a zero-repair operation waits', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.enqueue({
    ...stalledEntry(), changes: [{ source: 'capture', fields: [], at: '2026-06-12T00:00:00.000Z' }],
  });
  fakeRepo.__setMeta('pref.sync.paused', 'true');
  const repair = fakeRepo.repository.repairStalledCollectionRlsEntries;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  const spy = jest.spyOn(fakeRepo.repository, 'repairStalledCollectionRlsEntries').mockImplementation(async () => {
    started = true;
    await gate;
    const count = await repair();
    expect(count).toBe(0);
    return count;
  });
  try {
    const store = renderStore();
    await waitFor(() => expect(started).toBe(true));
    expect(store.current?.isLoading).toBe(true);
    await fakeRepo.repository.deleteBookmark(SYNCED_ID);
    await fakeRepo.repository.removeQueueEntry(SYNCED_ID);
    await act(async () => { release(); });
    await waitFor(() => expect(store.current?.isLoading).toBe(false));
    expect(fakeRepo.__bookmarks()).toHaveLength(0);
    expect(fakeRepo.__queue()).toHaveLength(0);
    expect(store.current?.inbox).toHaveLength(0);
    expect(apiMock.__spies.createBookmark).not.toHaveBeenCalled();
  } finally {
    release();
    spy.mockRestore();
  }
});
