import { act, render, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// Mirrors ai-enrichment-store.test.tsx's mocking harness — kept self-contained
// in this file since jest module factories can't be shared across test files.
jest.mock('@/storage/repository', () =>
  require('./fake-repository').createFakeRepositoryModule(),
);

export const mockEnvironment = { status: 'anonymous', offline: false, session: null! as typeof mockInitialSession };
jest.mock('@/ui/use-network-offline', () => ({ useNetworkOffline: () => mockEnvironment.offline }));
export const mockReadUser = jest.fn();
export const mockWriteUser = jest.fn();
jest.mock('@/supabase/client', () => ({
  ...jest.requireActual('@/supabase/client'),
  createSupabaseClient: () => ({ getUser: mockReadUser, updateUserMetadata: mockWriteUser }),
}));

const mockInitialSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-test', is_anonymous: undefined as boolean | undefined },
};
mockEnvironment.session = mockInitialSession;

export const mockEnsureSession = jest.fn(async () => mockEnvironment.session);

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: mockEnvironment.status,
    session: mockEnvironment.session,
    userId: mockEnvironment.session.user.id,
    message: null,
    ensureAnonymousSession: mockEnsureSession,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/storage/sqlite-app-lifecycle', () => ({
  registerForForegroundState: () => () => {},
  registerForBackgroundClose: () => {},
}));

jest.mock('@/api/bookmarks', () => {
  const empty = async () => [];
  const requestEnrichment = jest.fn(async (bookmarkId: string) => ({
    id: `enrichment-${bookmarkId}`,
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));
  const addTags = jest.fn(async ({ tags, source }: { tags: string[]; source: string }) =>
    tags.map((name) => ({
      id: `tag-${name}`,
      user_id: 'user-test',
      name,
      slug: name,
      source,
      created_at: '2026-06-13T00:00:00.000Z',
    })),
  );
  const createCollection = jest.fn(async (name: string) => ({
    id: `coll-${name.toLowerCase()}`,
    user_id: 'user-test',
    name,
    description: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));
  const bulkAttachTagsAndCollections = jest.fn(
    async (
      items: Array<{ bookmark_id: string; tags: Array<{ name: string; source: string }> }>,
    ) =>
      items.map((item) => ({
        bookmark_id: item.bookmark_id,
        tags: item.tags.map((tag) => ({
          id: `tag-${tag.name}`,
          user_id: 'user-test',
          name: tag.name,
          slug: tag.name,
          source: tag.source,
          created_at: '2026-06-13T00:00:00.000Z',
        })),
        collection: null,
        collection_attached: false,
        bookmark_updated_at: null,
      })),
  );
  const listBookmarkIds = jest.fn(async () => [] as string[]);
  const createBookmark = jest.fn(async () => ({
    bookmark_id: '7e64cf1e-0000-4000-8000-0000000000aa',
  }));
  const listEnrichmentsUpdatedSince = jest.fn(async () => [] as unknown[]);
  return {
    __spies: {
      requestEnrichment,
      addTags,
      createCollection,
      bulkAttachTagsAndCollections,
      listBookmarkIds,
      createBookmark,
      listEnrichmentsUpdatedSince,
    },
    createBookmarkApi: () => ({
      requestEnrichment,
      addTags,
      createCollection,
      bulkAttachTagsAndCollections,
      createBookmark,
      listBookmarksUpdatedSince: empty,
      listBookmarkIds,
      listEnrichmentsUpdatedSince,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
    }),
  };
});

import { AI_SUGGESTIONS_MODE_PREF_KEY } from '@/domain/ai-suggestions-pref';
import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './fake-repository';
import { makeEnrichment, makeStoredBookmark } from './fake-repository';

export const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
export const apiMock = jest.requireMock('@/api/bookmarks') as {
  __spies: {
    requestEnrichment: jest.Mock;
    addTags: jest.Mock;
    createCollection: jest.Mock;
    listBookmarkIds: jest.Mock;
    createBookmark: jest.Mock;
    listEnrichmentsUpdatedSince: jest.Mock;
  };
};

export const ID_A = '7e64cf1e-0000-4000-8000-000000000001';
export const ID_B = '7e64cf1e-0000-4000-8000-000000000002';
export const ID_C = '7e64cf1e-0000-4000-8000-000000000003';

type Store = ReturnType<typeof useBookmarks>;

export function renderStore() {
  const ref: { current: Store | null } = { current: null };
  function Probe() {
    ref.current = useBookmarks();
    return null;
  }
  render(
    <BookmarksProvider>
      <Probe />
    </BookmarksProvider>,
  );
  return ref;
}

export function resetAiSuggestionsHarness() {
  mockEnvironment.status = 'anonymous';
  mockEnvironment.session = { ...mockEnvironment.session, access_token: 'token', user: { id: 'user-test', is_anonymous: undefined } };
  mockEnsureSession.mockReset().mockImplementation(async () => mockEnvironment.session);
  mockEnvironment.offline = false;
  mockEnvironment.session.user.is_anonymous = undefined;
  mockReadUser.mockReset().mockResolvedValue({ id: 'user-test', user_metadata: {} });
  mockWriteUser.mockReset().mockResolvedValue({});
  apiMock.__spies.requestEnrichment.mockClear();
  apiMock.__spies.addTags.mockClear();
  apiMock.__spies.createCollection.mockClear();
  apiMock.__spies.listBookmarkIds.mockReset();
  apiMock.__spies.listBookmarkIds.mockResolvedValue([]);
  apiMock.__spies.createBookmark.mockClear();
  apiMock.__spies.listEnrichmentsUpdatedSince.mockReset();
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValue([]);
}
