import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import type { Bookmark, MetadataStatus } from "@/domain/types";

const mockEnrichBookmark = jest.fn<
  Promise<{ patch: Partial<Bookmark>; metadata_status: MetadataStatus }>,
  [Bookmark, unknown?]
>(async () => ({ patch: {}, metadata_status: "complete" }));
const SYNCED_ID = "7e64cf1e-0000-4000-8000-000000000001";

jest.mock("@/storage/repository", () =>
  require("./helpers/fake-repository").createFakeRepositoryModule(),
);
let mockAuthStatus = "not_configured";
let mockAuthUserId: string | null = null;

jest.mock("@/supabase/auth-provider", () => ({
  useSupabaseAuth: () => ({
    status: mockAuthStatus,
    session: null,
    userId: mockAuthUserId,
    message: "not configured",
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock("@/domain/enrichment", () => ({
  ...jest.requireActual("@/domain/enrichment"),
  enrichBookmark: (bookmark: Bookmark, fetcher?: unknown) =>
    mockEnrichBookmark(bookmark, fetcher),
}));
import { BookmarksProvider, useBookmarks } from "@/store/bookmarks";
import {
  makeStoredBookmark,
  type FakeRepositoryModule,
} from "./helpers/fake-repository";

const fakeRepo = jest.requireMock(
  "@/storage/repository",
) as FakeRepositoryModule;

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

async function renderStore() {
  const utils = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(utils.result.current.isLoading).toBe(false));
  return utils;
}

beforeEach(() => {
  mockAuthStatus = "not_configured";
  mockAuthUserId = null;
  fakeRepo.__reset();
  mockEnrichBookmark.mockReset();
  mockEnrichBookmark.mockResolvedValue({
    patch: {},
    metadata_status: "complete",
  });
});


test.each([false, true])('STASH-7R: Maps title and address persist together, protecting mid-fetch memo edits=%s', async (editMemo) => {
  let finish!: (value: { patch: Partial<Bookmark>; metadata_status: MetadataStatus }) => void;
  mockEnrichBookmark.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  fakeRepo.__reset([makeStoredBookmark({
    id: SYNCED_ID,
    url: 'https://maps.app.goo.gl/fqLik2TQgUTorsyp8',
    title: 'Restaurant, 23 P. Example',
    title_is_derived: true,
    notes: null,
    metadata_status: 'pending',
  })]);
  const { result } = await renderStore();
  await waitFor(() => expect(mockEnrichBookmark).toHaveBeenCalled());
  if (editMemo) {
    await act(async () => { result.current.updateBookmarkFields(SYNCED_ID, { notes: 'Meet at noon' }); });
  }
  await act(async () => {
    finish({ patch: { title: 'Restaurant', title_is_derived: true, notes: '23 P. Example' }, metadata_status: 'complete' });
  });
  await waitFor(() => expect(fakeRepo.__bookmarks().find((row) => row.id === SYNCED_ID)).toMatchObject({
    title: editMemo ? 'Restaurant, 23 P. Example' : 'Restaurant',
    notes: editMemo ? 'Meet at noon' : '23 P. Example',
    metadata_status: 'complete',
  }));
});
