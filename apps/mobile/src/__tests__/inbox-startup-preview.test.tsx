import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import type { Bookmark } from '@/domain/types';
import { DEFAULT_SORT, type SortOption } from '@/domain/sort';
import { DEFAULT_VIEW_MODE, type ViewMode } from '@/domain/view-mode';
import type { InboxStartupPreview } from '@/domain/inbox-startup-preview';
import { useInboxStartupPreview } from '@/features/inbox/use-inbox-startup-preview';

let mockRaw: string | null;
const mockWrite = jest.fn(async (_raw: string | null) => {});
let mockBarrier: () => Promise<string | null>;
jest.mock('@/storage/inbox-startup-preview', () => ({
  readInboxStartupPreview: async () => mockRaw,
  writeInboxStartupPreview: (raw: string | null) => mockWrite(raw),
}));
jest.mock('@/storage/repository', () => ({
  repository: { getMeta: () => mockBarrier() },
}));

const bookmark = {
  id: 'cached-1', user_id: 'user-1', title: 'Last saved bookmark',
  url: 'https://example.com', content_type: 'url', collection_id: null,
  created_at: '2026-10-12', updated_at: '2026-10-12',
  is_archived: false, deleted_at: null,
} as Bookmark;
const cached: InboxStartupPreview = {
  version: 1, userId: 'user-1', isAnonymous: false,
  sort: { field: 'name', dir: 'asc' }, viewMode: 'card',
  totalCount: 100, bookmarks: [bookmark], tags: {}, collections: [],
};
const getTagsForBookmark = () => [];
const getCollection = () => undefined;
const initial = {
  userId: 'user-1' as string | null, authStatus: 'authenticated',
  isLoading: true, loadError: false, accountLibraryState: 'checking',
  accountCacheReady: false,
  viewOptionsReady: false, eligible: true, bookmarks: [] as Bookmark[], totalCount: 0,
};
function usePreview(props: typeof initial) {
  const [sort, setSort] = useState<SortOption>(DEFAULT_SORT);
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_VIEW_MODE);
  const preview = useInboxStartupPreview({
    ...props, sort, viewMode, setSort, setViewMode, getTagsForBookmark, getCollection,
  });
  return { preview, sort, viewMode };
}

beforeEach(() => {
  mockRaw = JSON.stringify(cached);
  mockBarrier = async () => null;
  mockWrite.mockClear();
});

test('restores the same account before hydration and retains preview until local ownership resolves', async () => {
  const screen = await renderHook(usePreview, { initialProps: initial });
  await waitFor(() => expect(screen.result.current.preview).toEqual(cached));
  expect(screen.result.current.sort).toEqual(cached.sort);
  expect(screen.result.current.viewMode).toBe('card');
  expect(mockWrite).not.toHaveBeenCalled();
  await screen.rerender({ ...initial, isLoading: false });
  expect(screen.result.current.preview).toEqual(cached);
  await screen.rerender({ ...initial, isLoading: false, accountCacheReady: true, bookmarks: [bookmark], totalCount: 1 });
  expect(screen.result.current.preview).toBeNull();
  await screen.rerender(initial);
  expect(screen.result.current.preview).toBeNull();
});

test.each(['loading', 'signed_out', 'session_expired', 'error'])('does not show cached data during auth %s', async (authStatus) => {
  const screen = await renderHook(usePreview, { initialProps: { ...initial, authStatus } });
  await act(async () => {});
  expect(screen.result.current.preview).toBeNull();
});

test('waits for restored auth and never replays a preview after an account change', async () => {
  const screen = await renderHook(usePreview, { initialProps: { ...initial, authStatus: 'loading', userId: null } });
  await act(async () => {});
  expect(screen.result.current.preview).toBeNull();
  await screen.rerender(initial);
  await waitFor(() => expect(screen.result.current.preview).toEqual(cached));
  await screen.rerender({ ...initial, userId: 'user-2' });
  expect(screen.result.current.preview).toBeNull();
  await screen.rerender(initial);
  expect(screen.result.current.preview).toBeNull();
});

test.each([
  { ...initial, userId: 'user-2' },
  { ...initial, authStatus: 'anonymous' },
  { ...initial, eligible: false },
  { ...initial, loadError: true },
  { ...initial, accountLibraryState: 'error' },
])('rejects a preview for a different identity, scope, or failure', async (props) => {
  const screen = await renderHook(usePreview, { initialProps: props });
  await act(async () => {});
  expect(screen.result.current.preview).toBeNull();
});

test('missing or corrupt cache falls back without altering sort or view settings', async () => {
  mockRaw = '{invalid';
  const screen = await renderHook(usePreview, { initialProps: initial });
  await act(async () => {});
  expect(screen.result.current).toEqual({ preview: null, sort: DEFAULT_SORT, viewMode: DEFAULT_VIEW_MODE });
});

test('persists at most 30 rows only after ownership and preferences settle, then replaces deleted rows', async () => {
  mockRaw = null;
  const rows = Array.from({ length: 45 }, (_, index) => ({ ...bookmark, id: `bookmark-${index}` }));
  const loaded = { ...initial, isLoading: false, viewOptionsReady: true, bookmarks: rows, totalCount: 45 };
  const screen = await renderHook(usePreview, { initialProps: loaded });
  await act(async () => {});
  expect(mockWrite).not.toHaveBeenCalled();
  await screen.rerender({ ...loaded, accountLibraryState: 'ready', accountCacheReady: true });
  await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
  const saved = JSON.parse(mockWrite.mock.calls[0][0]!);
  expect(saved.bookmarks).toHaveLength(30);
  expect(saved.totalCount).toBe(45);
  await screen.rerender({ ...loaded, accountLibraryState: 'ready', accountCacheReady: true, bookmarks: [], totalCount: 0 });
  await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(2));
  expect(JSON.parse(mockWrite.mock.calls[1][0]!).bookmarks).toEqual([]);
});

test('a delayed persistence barrier cannot publish the previous account snapshot', async () => {
  mockRaw = null;
  let release!: (value: string | null) => void;
  mockBarrier = () => new Promise((resolve) => { release = resolve; });
  const loaded = { ...initial, isLoading: false, viewOptionsReady: true, accountLibraryState: 'ready', accountCacheReady: true, bookmarks: [bookmark], totalCount: 1 };
  const screen = await renderHook(usePreview, { initialProps: loaded });
  await screen.rerender({ ...loaded, userId: 'user-2', accountLibraryState: 'checking', accountCacheReady: false });
  await act(async () => { release(null); });
  expect(mockWrite).not.toHaveBeenCalled();
});

test('local ownership is enough to refresh cache while the cloud pull is still pending', async () => {
  mockRaw = null;
  const screen = await renderHook(usePreview, { initialProps: {
    ...initial, isLoading: false, accountCacheReady: true, accountLibraryState: 'checking',
    viewOptionsReady: true, bookmarks: [bookmark], totalCount: 1,
  } });
  await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
  expect(screen.result.current.preview).toBeNull();
  expect(JSON.parse(mockWrite.mock.calls[0][0]!).bookmarks[0].id).toBe(bookmark.id);
});
