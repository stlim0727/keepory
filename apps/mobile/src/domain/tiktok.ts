/**
 * TikTok metadata helpers (STASH-7Q/Issue 954).
 * Recognizes canonical video URLs, shortlinks, and lite shares,
 * filters generic platform shells, and provides oEmbed endpoint resolution.
 */

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
    t === 'tiktok - trends start here' ||
    t === 'trending videos on tiktok' ||
    t === 'watch trending videos on tiktok' ||
    t === '틱톡' ||
    t === '틱톡 라이트' ||
    t.startsWith('틱톡 라이트 -')
  );
}

export function tikTokOembedEndpoint(rawUrl: string): string | null {
  if (!isTikTokUrl(rawUrl)) {
    return null;
  }
  try {
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
      return `https://www.tiktok.com/oembed?url=${encodeURIComponent(rawUrl)}`;
    }
  } catch {
    return null;
  }
  return null;
}
