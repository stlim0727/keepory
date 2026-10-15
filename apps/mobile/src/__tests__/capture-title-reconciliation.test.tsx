import './helpers/ai-enrichment-harness';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, renderStore, resetEnrichmentHarness } from './helpers/ai-enrichment-harness';
import { makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);

test('a title entered on failed duplicate retry reaches a follow-up update after the original create resolves', async () => {
  const row = makeStoredBookmark({ ever_synced: false, sync_status: 'pending', metadata_status: 'complete', title: 'Original title', title_is_derived: false });
  fakeRepo.__reset([row]);
  await fakeRepo.repository.enqueue({ local_id: row.id, remote_id: null, operation: 'create',
    payload: { id: row.id, client_id: row.client_id!, url: row.url!, title: row.title! },
    sync_status: 'pending', retry_count: 0, last_error: null, created_at: row.created_at, updated_at: row.updated_at });
  let finish!: (value: { bookmark_id: string }) => void;
  apiMock.__spies.createBookmark.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  apiMock.__spies.listBookmarkIds.mockResolvedValue([row.id]);
  apiMock.__spies.updateBookmark.mockClear();
  const store = renderStore();
  await waitFor(() => expect(finish).toBeDefined());
  const write = jest.spyOn(fakeRepo.repository, 'updateBookmark').mockRejectedValueOnce(new Error('Timestamp write failed'));
  await act(async () => {
    const first = store.current!.addBookmark({ capture_attempt_id: 'inflight-title', url: row.url! });
    if (first.status === 'invalid') throw new Error(first.error);
    expect(await first.persisted).toBe(false);
  });
  await act(async () => {
    const retry = store.current!.addBookmark({ capture_attempt_id: 'inflight-title', url: row.url!, title: 'Retried user title' });
    if (retry.status === 'invalid') throw new Error(retry.error);
    expect(await retry.persisted).toBe(true);
  });
  await act(async () => { finish({ bookmark_id: row.id }); });
  await waitFor(() => expect(apiMock.__spies.updateBookmark.mock.calls.some((args) => args[1]?.title === 'Retried user title')).toBe(true));
  write.mockRestore();
});
