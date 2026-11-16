import './helpers/ai-enrichment-harness';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, renderReady, resetEnrichmentHarness, SYNCED_ID } from './helpers/ai-enrichment-harness';

beforeEach(resetEnrichmentHarness);

test('an acknowledged tag add survives an older folder snapshot and retires on a confirming pull', async () => {
  const store = await renderReady();
  const factory = apiMock.__spies.createBookmarkApi.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let snapshotRead = false;
  let confirmedSnapshot = false;
  const tag = { id: 'tag-design', user_id: 'user-test', name: 'design', slug: 'design', source: 'ai', created_at: '2026-06-13T00:00:00.000Z' };
  apiMock.__spies.createBookmarkApi.mockImplementation((session: unknown) => ({
    ...factory(session),
    listTags: async () => [tag],
    listBookmarkTags: async () => confirmedSnapshot
      ? [{ bookmark_id: SYNCED_ID, tag_id: tag.id, source: 'ai', confidence: 0.8 }] : [],
    listCollections: async () => { snapshotRead = true; await gate; return []; },
  }));
  try {
    let pull!: Promise<boolean>;
    await act(async () => { pull = store.current!.syncNow(); });
    await waitFor(() => expect(snapshotRead).toBe(true));
    await act(async () => {
      await store.current!.acceptSuggestedTags(SYNCED_ID, [{ name: 'design', confidence: 0.8 }]);
    });
    await waitFor(() => expect(store.current!.getTagsForBookmark(SYNCED_ID))
      .toEqual([expect.objectContaining({ id: tag.id })]));
    await act(async () => { release(); await pull; });
    expect(store.current!.getTagsForBookmark(SYNCED_ID).map((item) => item.name)).toContain('design');
    expect(JSON.parse(fakeRepo.__meta('pending_tag_ops') ?? '[]'))
      .toEqual([expect.objectContaining({ op: 'add', confirmed: true })]);
    const uploadCount = apiMock.__spies.bulkAttachTagsAndCollections.mock.calls.length;
    confirmedSnapshot = true;
    await waitFor(() => expect(JSON.parse(fakeRepo.__meta('pending_tag_ops') ?? '[]')).toEqual([]));
    expect(apiMock.__spies.bulkAttachTagsAndCollections).toHaveBeenCalledTimes(uploadCount);
    expect(store.current!.getTagsForBookmark(SYNCED_ID).map((item) => item.name)).toContain('design');
  } finally {
    release();
    apiMock.__spies.createBookmarkApi.mockImplementation(factory);
  }
});
