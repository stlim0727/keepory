import { hostFromUrl } from '@/domain/item-icon';
import { memoBodyFormat, memoBodyLabel, textForDisplay } from '@/domain/text-format';
import type { Bookmark } from '@/domain/types';

/**
 * The best human label for a bookmark in lists and headers: the user-authored
 * title, then the URL, then — for a URL-less text note (e.g. a KakaoTalk message
 * with no link) — the saved text itself. Returns null when there is genuinely
 * nothing to show so callers can supply a localized "Untitled".
 *
 * Pure and dependency-free so it is unit-testable; the i18n fallback stays in
 * the calling screen.
 */
export function displayTitle(
  bookmark: Pick<Bookmark, 'title' | 'url' | 'description' | 'description_format'>,
): string | null {
  const title = bookmark.title?.trim();
  if (title) {
    return title;
  }
  if (bookmark.url) {
    return bookmark.url;
  }
  return memoBodyLabel(bookmark);
}

/**
 * Whether the label {@link displayTitle} renders is a fallback rather than a
 * real title: either `title_is_derived` was recorded locally (enrichment ran
 * and only found a generated title), or there is no usable title at all and
 * `displayTitle` is rendering the raw URL. Remote-mapped and pre-migration
 * rows never carry `title_is_derived`, so the URL-fallback check catches
 * those too. Callers use this to de-emphasize fallback titles in the UI.
 */
export function isTitleDerived(
  bookmark: Pick<Bookmark, 'title' | 'url' | 'title_is_derived'>,
): boolean {
  if (bookmark.title_is_derived) {
    return true;
  }
  return !bookmark.title?.trim() && Boolean(bookmark.url);
}

/**
 * A screen-reader-friendly label for a bookmark. Unlike {@link displayTitle},
 * which falls back to the raw URL (so VoiceOver spells out the entire link) or
 * the full note body, this prefers a bare hostname for URL bookmarks and a
 * sensibly truncated form otherwise. Returns null when there is nothing to
 * announce so callers can supply a localized "Untitled".
 *
 * Pure and dependency-free (aside from the host parser) so it is unit-testable.
 */
export function accessibilityTitle(
  bookmark: Pick<Bookmark, 'title' | 'url' | 'description' | 'description_format'>,
): string | null {
  const title = bookmark.title?.trim();
  if (title) {
    return truncateForSpeech(title);
  }
  const host = hostFromUrl(bookmark.url);
  if (host) {
    return host;
  }
  if (bookmark.url) {
    return truncateForSpeech(bookmark.url);
  }
  const description = textForDisplay(bookmark.description, memoBodyFormat(bookmark));
  return description ? truncateForSpeech(description) : null;
}

/**
 * A clean display label (domain or site name) for a bookmark, used anywhere a
 * card or row shows the site instead of the raw URL: the human `site_name`,
 * then a parsed hostname with `www.` stripped, then the raw URL if it fails to
 * parse, then `''` if there is no URL at all.
 *
 * Pure and dependency-free (aside from the host parser) so it is unit-testable.
 */
export function siteLabel(bookmark: Pick<Bookmark, 'site_name' | 'url'>): string {
  const trimmedSiteName = bookmark.site_name?.trim();
  if (trimmedSiteName) {
    return trimmedSiteName;
  }
  if (!bookmark.url) {
    return '';
  }
  return hostFromUrl(bookmark.url) ?? bookmark.url;
}

function truncateForSpeech(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 80) {
    return trimmed;
  }
  return `${trimmed.slice(0, 79).trimEnd()}…`;
}

/**
 * A concise relative time string for bookmark headers (e.g. "just now", "5m ago",
 * "2h ago", "yesterday", "3d ago", "2w ago", "3mo ago", "1y ago").
 *
 * Pure and dependency-free so it is unit-testable.
 */
export function formatRelativeTime(
  dateString: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (!dateString) {
    return '';
  }
  const dateMs = new Date(dateString).getTime();
  if (Number.isNaN(dateMs)) {
    return '';
  }
  const diffSec = Math.max(0, Math.floor((nowMs - dateMs) / 1000));
  if (diffSec < 60) {
    return 'just now';
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) {
    return 'yesterday';
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) {
    return `${diffWeeks}w ago`;
  }
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) {
    return `${diffMonths}mo ago`;
  }
  const diffYears = Math.floor(diffDays / 365);
  return `${diffYears}y ago`;
}
