import type { Bookmark, Collection, Tag } from '@/domain/types';
import type { SortOption } from '@/domain/sort';

export const STARTUP_PREVIEW_LIMIT = 30;
export const STARTUP_PREVIEW_MAX_BYTES = 256_000;

/** Display-only snapshot. Never feed these rows into the store or sync queue. */
export interface InboxStartupPreview {
  version: 1;
  userId: string;
  isAnonymous: boolean;
  sort: SortOption;
  viewMode: 'card' | 'list';
  totalCount: number;
  bookmarks: Bookmark[];
  tags: Record<string, Tag[]>;
  collections: Collection[];
}

export function parseInboxStartupPreview(raw: string | null): InboxStartupPreview | null {
  if (!raw || raw.length > STARTUP_PREVIEW_MAX_BYTES) return null;
  try {
    const value = JSON.parse(raw) as InboxStartupPreview;
    if (!value || value.version !== 1 || typeof value.userId !== 'string' || !value.userId ||
      typeof value.isAnonymous !== 'boolean' || !['card', 'list'].includes(value.viewMode) ||
      !value.sort || !['date', 'accessed', 'name'].includes(value.sort.field) ||
      !['asc', 'desc'].includes(value.sort.dir) ||
      !Number.isSafeInteger(value.totalCount) || value.totalCount < 0 ||
      !Array.isArray(value.bookmarks) || value.bookmarks.length > STARTUP_PREVIEW_LIMIT ||
      value.totalCount < value.bookmarks.length ||
      !value.bookmarks.every((row) => row && typeof row.id === 'string' &&
        typeof row.created_at === 'string' && typeof row.updated_at === 'string' &&
        typeof row.content_type === 'string' && !row.is_archived && row.deleted_at == null &&
        [row.title, row.url, row.description, row.site_name, row.notes].every((field) => field == null || typeof field === 'string')) ||
      !value.tags || typeof value.tags !== 'object' || Array.isArray(value.tags) ||
      !Object.values(value.tags).every((tags) => Array.isArray(tags) && tags.every((tag) =>
        tag && typeof tag.id === 'string' && typeof tag.name === 'string')) ||
      !Array.isArray(value.collections) || !value.collections.every((row) =>
        row && typeof row.id === 'string' && typeof row.name === 'string')) return null;
    return value;
  } catch {
    return null;
  }
}
