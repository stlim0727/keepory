import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { NetworkState } from 'expo-network';

// Exercise the real provider around the bulk checkpoint/dispatch boundary.
jest.mock('@/observability/sentry', () => ({ ...jest.requireActual('@/observability/sentry'), reportSyncQueueHealthEscalation: jest.fn() }));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
let mockNetworkListener: (state: NetworkState) => void;
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }),
  addNetworkStateListener: (listener: typeof mockNetworkListener) => {
    mockNetworkListener = listener;
    return { remove: jest.fn() };
  },
}));

const mockRealSession = {
  access_token: 'real-token',
  refresh_token: 'real-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'real-user', is_anonymous: false, email: 'me@example.com' },
};

jest.mock('@/supabase/auth-provider', () => {
  let state = {
    status: 'authenticated' as string,
    session: null as unknown,
    userId: 'real-user' as string | null,
    message: null as string | null,
    credentialRecoveryVersion: 0,
    ensureAnonymousSession: jest.fn(async (): Promise<unknown> => state.session),
  };
  return {
    __setAuth: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
    },
    useSupabaseAuth: () => state,
    SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
  };
});

jest.mock('@/api/bookmarks', () => {
  const createBookmarks = jest.fn(async () => { throw new Error('bulk request rejected'); });
  const createBookmark = jest.fn(async () => ({
    bookmark_id: '1a2b3c4d-0000-4000-8000-00000000abcd',
  }));
  const listBookmarksUpdatedSince = jest.fn(async () => []);
  const addTags = jest.fn(async (input: { tags: string[] }) =>
    input.tags.map((name) => ({ id: `tag-${name}`, name, slug: name })),
  );
  const removeTags = jest.fn(async () => {});
  const bulkAttachTagsAndCollections = jest.fn(
    async (
      items: Array<{ bookmark_id: string; tags: Array<{ name: string; source: string }> }>,
    ) =>
      items.map((item) => ({
        bookmark_id: item.bookmark_id,
        tags: item.tags.map((tag) => ({
          id: `tag-${tag.name}`,
          user_id: 'real-user',
          name: tag.name,
          slug: tag.name,
          source: tag.source,
          created_at: new Date().toISOString(),
        })),
        collection: null,
        collection_attached: false,
        bookmark_updated_at: null,
      })),
  );
  const resetLibrary = jest.fn(async () => ({ bookmarks: 0 }));
  const empty = async () => [];
  return {
    __createBookmarksMock: createBookmarks,
    __resetLibraryMock: resetLibrary,
    __createBookmarkMock: createBookmark,
    __listBookmarksUpdatedSinceMock: listBookmarksUpdatedSince,
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince,
      listBookmarkIds: async () => [],
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
      createBookmark,
      createBookmarks,
      addTags,
      removeTags,
      bulkAttachTagsAndCollections,
      resetLibrary,
    }),
  };
});

let mockHoldMetadata = false;
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => mockHoldMetadata ? new Promise(() => {}) : ({ patch: {}, metadata_status: 'complete' }),
}));

const mockUpsertSyncStatus = jest.fn(async (..._args: unknown[]) => {});
jest.mock('@/supabase/client', () => {
  const actual = jest.requireActual('@/supabase/client');
  return {
    ...actual,
    createSupabaseClient: () => ({
      upsertSyncStatus: (...args: unknown[]) => mockUpsertSyncStatus(...args),
    }),
  };
});

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

const authMock = jest.requireMock('@/supabase/auth-provider') as {
  __setAuth: (next: Record<string, unknown>) => void;
  useSupabaseAuth: () => { ensureAnonymousSession: jest.Mock };
};
const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __createBookmarksMock: jest.Mock;
  __resetLibraryMock: jest.Mock;
  __createBookmarkMock: jest.Mock;
  __listBookmarksUpdatedSinceMock: jest.Mock;
};

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

beforeEach(() => {
  mockHoldMetadata = false;
  fakeRepo.__reset();
  apiMock.__createBookmarkMock.mockClear();
  apiMock.__listBookmarksUpdatedSinceMock.mockClear();
  mockUpsertSyncStatus.mockClear();
  mockUpsertSyncStatus.mockImplementation(async () => {});
  authMock.__setAuth({ status: 'authenticated', session: mockRealSession, userId: 'real-user', credentialRecoveryVersion: 0 });
});
afterEach(() => jest.useRealTimers());

const healthMock = jest.requireMock('@/observability/sentry').reportSyncQueueHealthEscalation as jest.Mock;
for (const superseded of [true, false]) {
  test(superseded ? 'superseded checkpoint preserves unattempted bulk work' : 'dispatched bulk error counts retries and health escalation', async () => {
    authMock.__setAuth({ status: 'loading', session: null, userId: null });
    const now = '2026-10-14T00:00:00.000Z';
    const rows = ['first', 'second'].map((id) => makeStoredBookmark({ id, client_id: id, user_id: 'real-user', url: `https://example.com/${id}`, metadata_status: 'complete', sync_status: 'pending', ever_synced: false }));
    fakeRepo.__reset(rows);
    fakeRepo.__setMeta('synced_user_id', 'real-user');
    const entries = rows.map((row) => ({ local_id: row.id, remote_id: null, operation: 'create' as const, payload: { id: row.id, client_id: row.id, url: row.url! }, sync_status: 'pending' as const, retry_count: 2, last_error: null, created_at: now, updated_at: now }));
    for (const entry of entries) await fakeRepo.repository.enqueue(entry);
    const originalCheckpoint = fakeRepo.repository.checkpointCreatePayload;
    let checkpoints = 0;
    fakeRepo.repository.checkpointCreatePayload = async (expected, payload) => {
      checkpoints++;
      if (superseded && checkpoints === 2) {
        await fakeRepo.repository.enqueue({ ...expected, operation: 'delete', payload: {}, updated_at: '2026-10-14T00:00:01.000Z' });
        return false;
      }
      await fakeRepo.repository.updateQueueEntry({ ...expected, payload });
      return true;
    };
    apiMock.__createBookmarksMock.mockClear();
    healthMock.mockClear();
    // Hold the pull after upload, then pause before it finishes. This observes
    // one pass without the next automatic pass legitimately uploading fresh work.
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => { releasePull = resolve; });
    apiMock.__listBookmarksUpdatedSinceMock.mockImplementation(async () => { await pullGate; return []; });
    authMock.__setAuth({ status: 'authenticated', session: mockRealSession, userId: 'real-user' });
    const { result, unmount } = await renderHook(() => useBookmarks(), { wrapper });
    try {
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      await waitFor(() => expect(checkpoints).toBe(2));
      await waitFor(() => expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalled());
      await act(async () => { result.current.setSyncPaused(true); releasePull(); });
      await waitFor(() => expect(result.current.isSyncing).toBe(false));
      const queue = fakeRepo.__queue();
      if (superseded) {
        expect(apiMock.__createBookmarksMock).not.toHaveBeenCalled();
        expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
        expect(queue.map(({ retry_count, sync_status }) => ({ retry_count, sync_status }))).toEqual(entries.map(({ retry_count, sync_status }) => ({ retry_count, sync_status })));
        expect(queue.find((entry) => entry.local_id === 'second')?.operation).toBe('delete');
        expect(fakeRepo.__bookmarks().map((row) => row.sync_status)).toEqual(['pending', 'pending']);
        expect(result.current.queue.map((entry) => entry.retry_count)).toEqual([2, 2]);
        expect(healthMock).not.toHaveBeenCalled();
      } else {
        expect(apiMock.__createBookmarksMock).toHaveBeenCalledTimes(1);
        expect(queue.map((entry) => entry.retry_count)).toEqual([3, 3]);
        expect(queue.every((entry) => entry.sync_status === 'failed')).toBe(true);
        expect(fakeRepo.__bookmarks().every((row) => row.sync_status === 'failed')).toBe(true);
        expect(healthMock).toHaveBeenCalledTimes(2);
      }
    } finally {
      releasePull();
      await unmount();
      apiMock.__listBookmarksUpdatedSinceMock.mockImplementation(async () => []);
      fakeRepo.repository.checkpointCreatePayload = originalCheckpoint;
    }
  });
}
