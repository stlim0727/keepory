/**
 * Naver Blog metadata helpers (STASH-7K/STASH-7V).
 * Recognizes desktop blog posts, mobile versions, and iframe wrappers.
 * Desktop blog pages load post content inside an iframe (/PostView.naver),
 * carrying no OpenGraph title or image. The mobile sibling (m.blog.naver.com)
 * serves full server-rendered OG metadata (post title, hero image).
 */

export function isNaverBlogUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'blog.naver.com' || host === 'm.blog.naver.com';
  } catch {
    return false;
  }
}

/**
 * Returns true if the URL points to a specific Naver Blog post (has a numeric logNo).
 */
export function isNaverBlogPostUrl(rawUrl: string): boolean {
  if (!isNaverBlogUrl(rawUrl)) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.get('logNo')) {
      return true;
    }
    const segs = parsed.pathname.split('/').filter(Boolean);
    return segs.length === 2 && /^\d+$/.test(segs[1]);
  } catch {
    return false;
  }
}

/**
 * Maps a desktop Naver Blog URL to its mobile sibling (m.blog.naver.com),
 * which provides server-rendered OpenGraph metadata (post title and hero image).
 * Returns null if the URL is not a desktop Naver Blog URL or already mobile.
 */
export function naverBlogPreviewUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'blog.naver.com') {
      return null;
    }

    const blogId = parsed.searchParams.get('blogId');
    const logNo = parsed.searchParams.get('logNo');
    if (blogId && logNo) {
      return `https://m.blog.naver.com/${encodeURIComponent(blogId)}/${encodeURIComponent(logNo)}`;
    }

    const segs = parsed.pathname.split('/').filter(Boolean);
    if (segs.length === 2 && /^\d+$/.test(segs[1])) {
      return `https://m.blog.naver.com/${segs[0]}/${segs[1]}`;
    }
    if (segs.length === 1 && !segs[0].includes('.') && !/^(main|blog|login|admin)/i.test(segs[0])) {
      return `https://m.blog.naver.com/${segs[0]}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts the inner /PostView.naver iframe destination from a desktop Naver Blog HTML shell.
 */
export function extractNaverBlogIframeUrl(html: string, baseUrl: string): string | null {
  try {
    const match =
      html.match(/<iframe[^>]+id=["']mainFrame["'][^>]+src=["']([^"']+)["']/i) ||
      html.match(/<iframe[^>]+src=["']([^"']+)["'][^>]+id=["']mainFrame["']/i);
    if (!match?.[1]) {
      return null;
    }
    const resolved = new URL(match[1], baseUrl).toString();
    return naverBlogPreviewUrl(resolved) || resolved;
  } catch {
    return null;
  }
}

/**
 * Recognizes generic Naver Blog shell titles when on a specific blog post.
 * Desktop blog pages only return "<Blog Title> : 네이버 블로그" instead of the post title.
 */
export function isGenericNaverBlogTitle(title: string | undefined, url?: string): boolean {
  if (!title) {
    return true;
  }
  if (url && !isNaverBlogUrl(url)) {
    return false;
  }
  const t = title.trim();
  if (
    t === '네이버 블로그' ||
    t === 'NAVER Blog' ||
    t === 'Naver Blog' ||
    t === '네이버 블로그 :: 블로그를 만나는 방법'
  ) {
    return true;
  }
  // On a specific post URL, a title that is just "네이버 블로그" or ends with ": 네이버 블로그"
  // but matches the desktop shell pattern without og:title should be treated cautiously.
  return false;
}
