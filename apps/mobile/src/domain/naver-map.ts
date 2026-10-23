/**
 * Naver Map place and favorite folder metadata helpers (STASH-72).
 * Extracts share IDs, detects generic titles, builds static map preview URLs,
 * and queries Naver's save-pages bookmark API for folder contents.
 */

import { fetchPublicPreview } from './preview-network.ts';
import { previewFetch } from '@/domain/preview-fetch';

const FETCH_TIMEOUT_MS = 8000;
const MAX_JSON_BYTES = 512 * 1024;

const BOT_USER_AGENT =
  'Mozilla/5.0 (compatible; StashBot/1.0; +https://github.com/stlim0727/keepory) link-preview fetcher';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface NaverMapMetadata {
  title?: string;
  description?: string;
  preview_image_url?: string;
  favicon_url?: string;
  site_name?: string;
  title_is_derived?: boolean;
}

/**
 * Detects a Naver Map favorite/bookmark folder (MyPlace list) and returns its
 * share id, or null if the URL is not a Naver Map folder.
 * Matches:
 *  - map.naver.com/p/favorite/myPlace/folder/{shareId}
 *  - map.naver.com/v5/favorite/myPlace/folder/{shareId}
 *  - map.naver.com/p/favorite/{userEncryptId}/folder/{shareId}
 *  - pages.map.naver.com/save-pages/pc/detail-list/{shareId}
 *  - pages.map.naver.com/save-pages/api/maps-bookmark/v3/shares/{shareId}/...
 */
export function naverMapFolderShareId(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const isNaver = host === 'naver.com' || host.endsWith('.naver.com');
  if (!isNaver) {
    return null;
  }
  const match = parsed.pathname.match(/\/(?:folder|detail-list|shares)\/([a-zA-Z0-9]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

/**
 * Builds a Naver Map static map thumbnail URL displaying pins for places in the
 * folder, matching the official Naver Map web client's implementation.
 */
export function buildNaverMapFolderStaticMapUrl(
  markerColor: string | number | undefined,
  bookmarks: Array<{ px?: number; py?: number }>,
): string | null {
  const valid = bookmarks.filter(
    (b) =>
      typeof b.px === 'number' &&
      typeof b.py === 'number' &&
      !Number.isNaN(b.px) &&
      !Number.isNaN(b.py),
  );
  if (valid.length === 0) {
    return null;
  }
  const color = markerColor ? String(markerColor) : '1';
  const icon = `https://map.pstatic.net/resource/api/v2/image/maps/bookmark/m_my_folder${color}@2x.png`;
  // Limit to at most 15 markers to stay well within URL size limits
  const markers = valid
    .slice(0, 15)
    .map((b) => `markers=type:e|icon:${icon}|anchor:center|pos:${b.px} ${b.py}`);
  return `https://simg.pstatic.net/static.map/v2/map/staticmap.bin?caller=og_map&scale=2&w=500&h=300&${markers.join('&')}`;
}

export function isNaverMapUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'naver.me') {
      return true;
    }
    return (
      host === 'map.naver.com' ||
      host === 'pcmap.place.naver.com' ||
      host === 'place.naver.com' ||
      host === 'pages.map.naver.com'
    );
  } catch {
    return false;
  }
}

export function isGenericNaverMapTitle(title: string | undefined, url?: string): boolean {
  if (!title) return true;
  if (url && !isNaverMapUrl(url)) {
    return false;
  }
  const t = title.trim();
  return (
    t === '네이버지도 저장' ||
    t === '네이버지도' ||
    t === '네이버 지도' ||
    t === 'NAVER Map' ||
    t === 'Naver Map'
  );
}

async function readCappedJson<T>(
  response: Response,
  byteLimit = MAX_JSON_BYTES,
): Promise<{ data?: T; tooLarge?: boolean } | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > byteLimit) {
    return { tooLarge: true };
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.length > byteLimit) {
      return { tooLarge: true };
    }
    try {
      const data = JSON.parse(new TextDecoder('utf-8').decode(raw)) as T;
      return { data };
    } catch {
      return null;
    }
  }

  const chunks: Uint8Array[] = [];
  let read = 0;
  let doneReading = false;
  try {
    while (read < byteLimit) {
      const { done, value } = await reader.read();
      if (done) {
        doneReading = true;
        break;
      }
      if (!value || value.length === 0) continue;
      chunks.push(value);
      read += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!doneReading || read > byteLimit) {
    return { tooLarge: true };
  }
  const total = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, total.length - offset);
    if (take <= 0) break;
    total.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  try {
    const data = JSON.parse(new TextDecoder('utf-8').decode(total)) as T;
    return { data };
  } catch {
    return null;
  }
}

/**
 * Fetches structured metadata for a Naver Map folder (MyPlace list) from Naver's
 * save-pages bookmark API. Returns folder title, site name, author attribution,
 * and a static map preview image.
 *
 * Follows the repository's hybrid UA convention: queries using the honest bot UA
 * first, and falls back to impersonating a browser only when the bot is refused or
 * yields an empty response.
 */
export async function fetchNaverMapFolderMetadata(
  shareId: string,
  fetcher: typeof fetch = previewFetch as typeof fetch,
): Promise<NaverMapMetadata | null> {
  const apiUrl = `https://pages.map.naver.com/save-pages/api/maps-bookmark/v3/shares/${encodeURIComponent(shareId)}`;

  type AttemptResult =
    | { status: 'success'; metadata: NaverMapMetadata }
    | { status: 'refused' }
    | { status: 'too_large' }
    | { status: 'failed' };

  interface ApiResponse {
    folder?: {
      name?: string;
      memo?: string;
      markerColor?: string | number;
      bookmarkCount?: number;
      placeUserProfile?: {
        nick?: string;
        imageUrl?: string;
      };
    };
    bookmarkList?: Array<{ px?: number; py?: number }>;
  }

  const fetchAttempt = async (userAgent: string): Promise<AttemptResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchPublicPreview(apiUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
      }, fetcher);
      if (!response.ok) {
        return { status: 'refused' };
      }
      const capped = await readCappedJson<ApiResponse>(response);
      if (!capped) {
        return { status: 'failed' };
      }
      if (capped.tooLarge) {
        return { status: 'too_large' };
      }
      const data = capped.data;
      const folder = data?.folder;
      if (!folder?.name?.trim()) {
        return { status: 'failed' };
      }
      const baseName = folder.name.trim();

      const nick = folder.placeUserProfile?.nick?.trim();
      const titleSuffix = baseName.includes('네이버 지도') ? '' : ' : 네이버 지도';
      const title = nick ? `${baseName} (${nick})${titleSuffix}` : `${baseName}${titleSuffix}`;

      const staticMap = buildNaverMapFolderStaticMapUrl(folder.markerColor, data?.bookmarkList ?? []);
      const previewImage =
        staticMap ||
        folder.placeUserProfile?.imageUrl ||
        'https://ssl.pstatic.net/static/maps/assets/images/og-map-400x200.png';

      return {
        status: 'success',
        metadata: {
          title,
          site_name: '네이버 지도',
          favicon_url: 'https://ssl.pstatic.net/static/maps/assets/icons/favicon.ico',
          preview_image_url: previewImage,
        },
      };
    } catch {
      return { status: 'failed' };
    } finally {
      clearTimeout(timer);
    }
  };

  const bot = await fetchAttempt(BOT_USER_AGENT);
  if (bot.status === 'success') {
    return bot.metadata;
  }
  if (bot.status === 'too_large') {
    return null;
  }
  const browser = await fetchAttempt(BROWSER_USER_AGENT);
  return browser.status === 'success' ? browser.metadata : null;
}
