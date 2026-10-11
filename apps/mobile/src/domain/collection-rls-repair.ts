import type { Bookmark, LocalPendingBookmark } from '@/domain/types';

export interface RepairedCollectionRlsState {
  repairedEntries: LocalPendingBookmark[];
  repairedBookmarks: Bookmark[];
}

/**
 * Self-heals queue entries and local bookmarks stuck on a PostgreSQL Row-Level
 * Security (RLS) violation (HTTP 403 / last_error_kind: 'permission') caused by an
 * unowned `collection_id` carried over from an account switch (STASH-7M), or
 * any `account_rehome` entry that still carries a stale `collection_id`.
 * Only account-rehomed entries are eligible: a generic permission/RLS error
 * does not prove that an ordinary user's collection assignment is invalid.
 *
 * Background:
 * On public.bookmarks, PostgreSQL RLS requires:
 * `auth.uid() = user_id and (collection_id is null or exists (select 1 from public.collections where collections.id = bookmarks.collection_id and collections.user_id = auth.uid()))`
 * When a bookmark created under an anonymous session carries a `collection_id`
 * into a real account, the new account does not own that collection, causing
 * PostgREST to return HTTP 403 Forbidden ("new row violates row-level security policy").
 * Because 403 is classified as 'permission', automatic retry is blocked and the UI
 * displays "library.permission".
 *
 * This function repairs the stuck state by:
 * 1. Clearing `collection_id` from the queue entry payload and local bookmark.
 * 2. Resetting the queue entry's sync status to 'pending', clearing errors,
 *    and resetting retry_count to 0 so background sync can immediately succeed.
 */
export function repairStalledCollectionRlsEntries(
  bookmarks: Bookmark[],
  queue: LocalPendingBookmark[],
): RepairedCollectionRlsState {
  const bookmarkMap = new Map(bookmarks.map((b) => [b.id, b]));
  const repairedEntries: LocalPendingBookmark[] = [];
  const repairedBookmarks: Bookmark[] = [];

  for (const entry of queue) {
    const isRehome = entry.changes?.some((c) => c.source === 'account_rehome');
    const isPermissionOrRls =
      entry.last_error_kind === 'permission' ||
      Boolean(entry.last_error && entry.last_error.toLowerCase().includes('row-level security'));
    const hasPayloadCollection = Boolean(entry.payload?.collection_id);
    const localBookmark = bookmarkMap.get(entry.local_id);

    // Provenance is required before removing a user's collection assignment.
    // Generic permission/RLS errors also arise from policies unrelated to
    // collection ownership, including ordinary updates of valid collections.
    if (isRehome && (hasPayloadCollection || (isPermissionOrRls && Boolean(localBookmark?.collection_id)))) {
      const nextPayload = { ...entry.payload };
      delete nextPayload.collection_id;

      const nextEntry: LocalPendingBookmark = {
        ...entry,
        payload: nextPayload,
        ...(isPermissionOrRls
          ? {
              sync_status: 'pending',
              last_error: null,
              last_error_kind: null,
              retry_count: 0,
            }
          : {}),
      };
      repairedEntries.push(nextEntry);

      if (
        localBookmark &&
        (localBookmark.collection_id !== null || (isPermissionOrRls && localBookmark.sync_status === 'failed'))
      ) {
        const nextBookmark: Bookmark = {
          ...localBookmark,
          collection_id: null,
          ...(isPermissionOrRls && localBookmark.sync_status === 'failed'
            ? { sync_status: 'pending' }
            : {}),
        };
        repairedBookmarks.push(nextBookmark);
        bookmarkMap.set(entry.local_id, nextBookmark);
      }
    }
  }

  return { repairedEntries, repairedBookmarks };
}
