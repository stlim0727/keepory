/**
 * TikTok metadata helpers (STASH-7Q/Issue 954).
 * Recognizes canonical video URLs, shortlinks, and lite shares,
 * filters generic platform shells, and provides oEmbed endpoint resolution.
 */

import { fetchPublicPreview } from './preview-network.ts';
import { previewFetch } from '@/domain/preview-fetch';

const FETCH_TIMEOUT_MS = 8000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function isTikTokUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').replace(/^m\./, '').toLowerCase();
    return (
      host === 'tiktok.com' ||
      host === 'lite.tiktok.com' ||
      host === 'vt.tiktok.com' ||
      host === 'vm.tiktok.com' ||
      host.endsWith('.tiktok.com')
    );
  } catch {
    return false;
  }
}

export function isGenericTikTokTitle(title: string | undefined, url?: string): boolean {
  if (!title) {
    return true;
  }
  if (url && !isTikTokUrl(url)) {
    return false;
  }
  const t = title.trim().toLowerCase();
  return (
    t === 'tiktok' ||
    t === 'tiktok lite' ||
    t === 'tiktok video' ||
    t === 'tiktok lite - watch videos' ||
    t === 'tiktok lite - 동영상 시청' ||
    t.startsWith('tiktok lite -') ||
    t === 'tiktok - make your day' ||
    t === 'tiktok | make your day' ||
    t === 'tiktok - trends start here' ||
    t === 'trending videos on tiktok' ||
    t === 'watch trending videos on tiktok' ||
    t === '틱톡' ||
    t === '틱톡 라이트' ||
    t.startsWith('틱톡 라이트 -')
  );
}

/**
 * Returns true if the URL is a TikTok shortlink (vt.tiktok.com, vm.tiktok.com, or /t/ share).
 */
export function isTikTokShortlink(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '').toLowerCase();
    if (host === 'vt.tiktok.com' || host === 'vm.tiktok.com') {
      return true;
    }
    const segs = parsed.pathname.split('/').filter(Boolean);
    if ((host === 'tiktok.com' || host === 'lite.tiktok.com') && (segs[0] === 't' || segs[0] === 'v')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Normalizes a TikTok video URL into its canonical form without tracking parameters
 * (e.g. https://www.tiktok.com/@user/video/12345).
 */
export function canonicalTikTokVideoUrl(rawUrl: string): string | null {
  if (!isTikTokUrl(rawUrl)) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '').toLowerCase();
    if (host === 'vt.tiktok.com' || host === 'vm.tiktok.com') {
      return null;
    }
    const match = parsed.pathname.match(/^(\/@[^/]+\/video\/\d+|\/video\/\d+)/i);
    if (match) {
      return `https://www.tiktok.com${match[1]}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function tikTokOembedEndpoint(rawUrl: string): string | null {
  if (!isTikTokUrl(rawUrl)) {
    return null;
  }
  try {
    const canonical = canonicalTikTokVideoUrl(rawUrl);
    if (canonical) {
      return `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical)}`;
    }
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '').toLowerCase();
    const segs = parsed.pathname.split('/').filter(Boolean);
    const isVideoOrShare =
      segs.length > 0 &&
      (segs.includes('video') ||
        segs[0] === 'v' ||
        segs[0] === 't' ||
        host === 'vt.tiktok.com' ||
        host === 'vm.tiktok.com');
    if (isVideoOrShare) {
      // Strip tracking query parameters (_r, _t, is_from_webapp, etc.) from the video URL
      // TikTok oEmbed returns 400 Invalid URL when query parameters are present.
      const cleanUrl = `${parsed.origin}${parsed.pathname}`;
      return `https://www.tiktok.com/oembed?url=${encodeURIComponent(cleanUrl)}`;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Follows a TikTok shortlink (vt.tiktok.com, vm.tiktok.com, or /t/ share) to its
 * final landing URL using a HEAD request. Strips tracking parameters (_r, _t)
 * so subsequent oEmbed and metadata fetches resolve cleanly.
 */
export async function resolveTikTokShortlink(
  rawUrl: string,
  fetcher: typeof fetch = previewFetch as typeof fetch,
): Promise<string | null> {
  if (!isTikTokShortlink(rawUrl)) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchPublicPreview(
      rawUrl,
      {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
        },
      },
      fetcher,
    );
    if (!response.ok) {
      return null;
    }
    const finalUrl = response.url;
    if (finalUrl && finalUrl !== rawUrl && isTikTokUrl(finalUrl)) {
      return canonicalTikTokVideoUrl(finalUrl) || finalUrl;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
