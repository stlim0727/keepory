import './helpers/ai-enrichment-harness';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, renderStore, resetEnrichmentHarness } from './helpers/ai-enrichment-harness';
import { makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);

test('an update completion retains a newer edit in both live and durable queues', async () => {
  const id = '7e64cf1e-0000-4000-8000-000000000938';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset([makeStoredBookmark({
    id, url: 'https://example.com/938', title: 'Before',
    metadata_status: 'complete', sync_status: 'pending', ever_synced: true,
  })]);
  await fakeRepo.repository.enqueue({
    local_id: id, remote_id: id, operation: 'update',
    payload: { id, url: 'https://example.com/938', client_id: id },
    sync_status: 'pending', retry_count: 0, last_error: null,
    created_at: now, updated_at: now,
  });
  let release!: () => void;
  const response = new Promise<void>((resolve) => { release = resolve; });
  apiMock.__spies.updateBookmark.mockImplementationOnce(async () => {
    await response;
    return undefined;
  });
  const store = renderStore();
  await waitFor(() => expect(apiMock.__spies.updateBookmark).toHaveBeenCalledTimes(1));
  await act(async () => {
    store.current!.setSyncPaused(true);
    store.current!.updateBookmarkFields(id, { title: 'Edited during update' });
  });
  await waitFor(() => expect(fakeRepo.__queue()[0]?.updated_at).not.toBe(now));
  const newer = fakeRepo.__queue()[0]!;
  await act(async () => { release(); });
  await waitFor(() => expect(store.current!.isSyncing).toBe(false));
  expect(store.current!.queue).toEqual([newer]);
  expect(fakeRepo.__queue()).toEqual([newer]);
});
