import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { parseInboxStartupPreview, STARTUP_PREVIEW_LIMIT, STARTUP_PREVIEW_MAX_BYTES, type InboxStartupPreview } from '@/domain/inbox-startup-preview';
import { sameSort, type SortOption } from '@/domain/sort';
import type { Bookmark, Collection, Tag } from '@/domain/types';
import type { ViewMode } from '@/domain/view-mode';
import { readInboxStartupPreview, writeInboxStartupPreview } from '@/storage/inbox-startup-preview';
import { repository } from '@/storage/repository';

interface Dependencies {
  userId: string | null;
  authStatus: string;
  isLoading: boolean;
  loadError: boolean;
  accountLibraryState: string;
  accountCacheReady: boolean;
  viewOptionsReady: boolean;
  eligible: boolean;
  bookmarks: Bookmark[];
  totalCount: number;
  sort: SortOption;
  viewMode: ViewMode;
  setSort: Dispatch<SetStateAction<SortOption>>;
  setViewMode: Dispatch<SetStateAction<ViewMode>>;
  getTagsForBookmark: (id: string) => Tag[];
  getCollection: (id: string | null) => Collection | undefined;
}

export function useInboxStartupPreview({
  userId, authStatus, isLoading, loadError, accountLibraryState, accountCacheReady, viewOptionsReady,
  eligible, bookmarks, totalCount, sort, viewMode, setSort, setViewMode,
  getTagsForBookmark, getCollection,
}: Dependencies): InboxStartupPreview | null {
  const [cached, setCached] = useState<InboxStartupPreview | null>(null);
  const usableSession = !!userId && (authStatus === 'authenticated' || authStatus === 'anonymous');
  const isAnonymous = authStatus === 'anonymous';
  const waitingForLibrary = isLoading || !accountCacheReady;
  const startup = useRef({ finished: !waitingForLibrary, userId: null as string | null, departed: false });
  // Once hydration settles or the initial session departs, never replay this
  // process's startup snapshot during an account transition or reset.
  if (!waitingForLibrary || loadError || accountLibraryState === 'error') startup.current.finished = true;
  if (usableSession && !startup.current.userId) startup.current.userId = userId;
  if (startup.current.userId && (!usableSession || startup.current.userId !== userId)) startup.current.departed = true;

  useEffect(() => {
    let active = true;
    void readInboxStartupPreview().then((raw) => {
      if (active) setCached(parseInboxStartupPreview(raw));
    });
    return () => { active = false; };
  }, []);

  const canPreview = !startup.current.finished && !startup.current.departed &&
    usableSession && !loadError && eligible && cached?.userId === userId &&
    cached.isAnonymous === isAnonymous && cached.bookmarks.length > 0;
  useEffect(() => {
    if (!canPreview || !cached) return;
    setSort(cached.sort);
    setViewMode(cached.viewMode);
  }, [canPreview, cached, setSort, setViewMode]);

  const snapshot = useMemo(() => {
    if (isLoading || loadError || !usableSession || !accountCacheReady ||
      !viewOptionsReady || !eligible || viewMode === 'folder') return null;
    const rows = bookmarks.slice(0, STARTUP_PREVIEW_LIMIT);
    const collections = new Map<string, Collection>();
    const tags: Record<string, Tag[]> = {};
    for (const row of rows) {
      tags[row.id] = getTagsForBookmark(row.id);
      const collection = getCollection(row.collection_id);
      if (collection) collections.set(collection.id, collection);
    }
    const value: InboxStartupPreview = {
      version: 1, userId: userId!, isAnonymous, sort, viewMode,
      totalCount, bookmarks: rows, tags, collections: [...collections.values()],
    };
    const raw = JSON.stringify(value);
    // Large memo bodies should not turn the fast cache into a second library.
    return raw.length <= STARTUP_PREVIEW_MAX_BYTES ? raw : '';
  }, [isLoading, loadError, usableSession, accountCacheReady, viewOptionsReady,
    eligible, viewMode, bookmarks, sort, totalCount, getTagsForBookmark, getCollection, userId, isAnonymous]);

  useEffect(() => {
    if (authStatus === 'signed_out' || authStatus === 'session_expired' ||
      (usableSession && cached && (cached.userId !== userId || cached.isAnonymous !== isAnonymous))) {
      void writeInboxStartupPreview(null);
    }
  }, [authStatus, usableSession, cached, userId, isAnonymous]);

  useEffect(() => {
    let active = true;
    if (snapshot !== null) {
      // Wait behind already queued durable mutations, which invalidate older
      // previews. Reads at startup never use this repository barrier.
      void repository.getMeta('bookmark_cache_owner').then(() => {
        if (active) void writeInboxStartupPreview(snapshot || null);
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [snapshot]);

  return canPreview && cached && sameSort(sort, cached.sort) && viewMode === cached.viewMode ? cached : null;
}
