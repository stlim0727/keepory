import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNaverMapFolderStaticMapUrl,
  fetchNaverMapFolderMetadata,
  isGenericNaverMapTitle,
  isNaverMapUrl,
  naverMapFolderShareId,
} from './naver-map.ts';
import { fetchPageMetadata } from './page-metadata.ts';

function htmlResponse(
  html: string,
  opts: { url?: string; contentType?: string; status?: number } = {},
): Response {
  const body = new TextEncoder().encode(html);
  return {
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    url: opts.url ?? '',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type'
          ? opts.contentType ?? 'text/html; charset=utf-8'
          : null,
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

test('naverMapFolderShareId extracts share id from various Naver Map folder URLs', () => {
  assert.equal(
    naverMapFolderShareId('https://map.naver.com/p/favorite/myPlace/folder/f65cd3df0860436582a34e32555212c9'),
    'f65cd3df0860436582a34e32555212c9',
  );
  assert.equal(
    naverMapFolderShareId('https://map.naver.com/v5/favorite/myPlace/folder/f65cd3df0860436582a34e32555212c9'),
    'f65cd3df0860436582a34e32555212c9',
  );
  assert.equal(
    naverMapFolderShareId('https://map.naver.com/p/favorite/encUserId/folder/f65cd3df0860436582a34e32555212c9?at=123'),
    'f65cd3df0860436582a34e32555212c9',
  );
  assert.equal(
    naverMapFolderShareId('https://pages.map.naver.com/save-pages/pc/detail-list/f65cd3df0860436582a34e32555212c9'),
    'f65cd3df0860436582a34e32555212c9',
  );
  assert.equal(
    naverMapFolderShareId('https://pages.map.naver.com/save-pages/api/maps-bookmark/v3/shares/f65cd3df0860436582a34e32555212c9/bookmarks'),
    'f65cd3df0860436582a34e32555212c9',
  );
  // Non-folder or place URLs return null
  assert.equal(naverMapFolderShareId('https://map.naver.com/p/entry/place/1887843614'), null);
  assert.equal(naverMapFolderShareId('https://blog.naver.com/someblog/12345'), null);
  assert.equal(naverMapFolderShareId('https://example.com/folder/12345'), null);
  assert.equal(naverMapFolderShareId('not a url'), null);
});

test('buildNaverMapFolderStaticMapUrl creates a static map URL with markers', () => {
  const url = buildNaverMapFolderStaticMapUrl('3', [
    { px: 126.86644, py: 33.5288 },
    { px: 129.25129, py: 37.36204 },
  ]);
  assert.ok(url?.startsWith('https://simg.pstatic.net/static.map/v2/map/staticmap.bin?caller=og_map'));
  assert.ok(url?.includes('m_my_folder3@2x.png'));
  assert.ok(url?.includes('pos:126.86644 33.5288'));
  assert.ok(url?.includes('pos:129.25129 37.36204'));

  // Empty or invalid coordinates return null
  assert.equal(buildNaverMapFolderStaticMapUrl('1', []), null);
  assert.equal(buildNaverMapFolderStaticMapUrl('1', [{ px: undefined, py: undefined }]), null);
});

test('isGenericNaverMapTitle recognizes generic fallback titles', () => {
  assert.equal(isGenericNaverMapTitle(undefined), true);
  assert.equal(isGenericNaverMapTitle(''), true);
  assert.equal(isGenericNaverMapTitle('네이버지도 저장'), true);
  assert.equal(isGenericNaverMapTitle('네이버지도'), true);
  assert.equal(isGenericNaverMapTitle('네이버 지도'), true);
  assert.equal(isGenericNaverMapTitle('바다 (AW앤웍) : 네이버 지도'), false);
  assert.equal(isGenericNaverMapTitle('스타벅스'), false);

  // When URL is provided, it only flags generic titles for Naver Map URLs
  assert.equal(
    isGenericNaverMapTitle('네이버 지도', 'https://map.naver.com/p/entry/place/123'),
    true,
  );
  assert.equal(
    isGenericNaverMapTitle('네이버 지도', 'https://naver.me/xyz'),
    true,
  );
  assert.equal(
    isGenericNaverMapTitle('네이버 지도', 'https://blog.naver.com/myblog/123'),
    false,
  );
  assert.equal(
    isGenericNaverMapTitle('Naver Map', 'https://techcrunch.com/article'),
    false,
  );
});

test('isNaverMapUrl distinguishes Naver Map URLs from other domains or Naver services', () => {
  assert.equal(isNaverMapUrl('https://map.naver.com/p/favorite/myPlace/folder/123'), true);
  assert.equal(isNaverMapUrl('https://pages.map.naver.com/save-pages/pc/detail-list/123'), true);
  assert.equal(isNaverMapUrl('https://naver.me/xyz'), true);
  assert.equal(isNaverMapUrl('https://pcmap.place.naver.com/place/123/home'), true);
  assert.equal(isNaverMapUrl('https://place.naver.com/place/123'), true);
  assert.equal(isNaverMapUrl('https://blog.naver.com/post/123'), false);
  assert.equal(isNaverMapUrl('https://news.naver.com/article/123'), false);
  assert.equal(isNaverMapUrl('https://google.com/maps'), false);
  assert.equal(isNaverMapUrl('invalid-url'), false);
});

test('fetchNaverMapFolderMetadata fetches folder details and builds preview metadata', async () => {
  const originalFetch = globalThis.fetch;
  const mockApiData = {
    folder: {
      folderId: 89136234,
      name: '바다',
      memo: '스노쿨링',
      markerColor: '3',
      placeUserProfile: {
        nick: 'AW앤웍',
        imageUrl: 'https://example.com/profile.jpg',
      },
    },
    bookmarkList: [
      { px: 126.86644, py: 33.5288 },
    ],
  };

  globalThis.fetch = (async (input: string) => {
    if (input.includes('/shares/f65cd3df')) {
      return new Response(JSON.stringify(mockApiData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    const meta = await fetchNaverMapFolderMetadata('f65cd3df');
    assert.equal(meta?.title, '바다 (AW앤웍) : 네이버 지도');
    assert.equal(meta?.site_name, '네이버 지도');
    assert.equal(meta?.favicon_url, 'https://ssl.pstatic.net/static/maps/assets/icons/favicon.ico');
    assert.ok(meta?.preview_image_url?.includes('staticmap.bin'));
    assert.ok(meta?.preview_image_url?.includes('m_my_folder3@2x.png'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata recovers a Naver Map folder via the bookmark API (STASH-72)', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  const mockFolderJson = {
    folder: {
      name: '바다',
      markerColor: '3',
      placeUserProfile: {
        nick: 'AW앤웍',
      },
    },
    bookmarkList: [
      { px: 126.86644, py: 33.5288 },
    ],
  };

  globalThis.fetch = (async (target: string) => {
    requested.push(target);
    // Short link naver.me resolves to map.naver.com SPA shell
    if (target.includes('naver.me') || target.includes('map.naver.com/p/favorite/myPlace/folder/f65cd3df')) {
      return htmlResponse('<head><meta charset="utf-8"></head>', {
        url: 'https://map.naver.com/p/favorite/myPlace/folder/f65cd3df',
      });
    }
    // Bookmark API returns the folder data
    if (target.includes('/shares/f65cd3df')) {
      return new Response(JSON.stringify(mockFolderJson), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;

  try {
    const meta = await fetchPageMetadata('https://naver.me/5yhegKdn');
    assert.equal(meta?.title, '바다 (AW앤웍) : 네이버 지도');
    assert.equal(meta?.site_name, '네이버 지도');
    assert.ok(meta?.preview_image_url?.includes('staticmap.bin'));
    assert.ok(
      requested.some((u) => u.includes('/shares/f65cd3df')),
      'expected a fetch to the bookmark folder API',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata recovers Naver Map folder when bot response has generic title (STASH-72)', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  const mockFolderJson = {
    folder: {
      name: '바다',
      markerColor: '3',
      placeUserProfile: {
        nick: 'AW앤웍',
      },
    },
    bookmarkList: [
      { px: 126.86644, py: 33.5288 },
    ],
  };

  globalThis.fetch = (async (target: string) => {
    requested.push(target);
    // Naver Map SPA returns a shell with a generic title
    if (target.includes('map.naver.com/p/favorite/myPlace/folder/f65cd3df')) {
      return htmlResponse(
        '<head><meta charset="utf-8"><title>네이버지도 저장</title><meta property="og:title" content="네이버지도 저장"></head>',
        { url: 'https://map.naver.com/p/favorite/myPlace/folder/f65cd3df' },
      );
    }
    // Bookmark API returns the folder data
    if (target.includes('/shares/f65cd3df')) {
      return new Response(JSON.stringify(mockFolderJson), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;

  try {
    const meta = await fetchPageMetadata('https://map.naver.com/p/favorite/myPlace/folder/f65cd3df');
    assert.equal(meta?.title, '바다 (AW앤웍) : 네이버 지도');
    assert.equal(meta?.site_name, '네이버 지도');
    assert.ok(meta?.preview_image_url?.includes('staticmap.bin'));
    assert.ok(
      requested.some((u) => u.includes('/shares/f65cd3df')),
      'expected folder API fetch despite generic bot title',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchNaverMapFolderMetadata tries bot UA first and falls back to browser UA when refused', async () => {
  const originalFetch = globalThis.fetch;
  const userAgents: string[] = [];
  const mockApiData = {
    folder: {
      name: '단풍길',
      markerColor: '1',
      placeUserProfile: { nick: '산악인' },
    },
    bookmarkList: [{ px: 127.1, py: 37.5 }],
  };

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const ua = (init?.headers as Record<string, string>)?.[
      'User-Agent'
    ];
    if (ua) userAgents.push(ua);
    // Refuse the bot UA (e.g. 403)
    if (ua?.includes('StashBot')) {
      return new Response('Forbidden', { status: 403 });
    }
    // Accept browser UA
    return new Response(JSON.stringify(mockApiData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const meta = await fetchNaverMapFolderMetadata('f65cd3df');
    assert.equal(meta?.title, '단풍길 (산악인) : 네이버 지도');
    assert.equal(userAgents.length, 2);
    assert.ok(userAgents[0]?.includes('StashBot'), 'expected bot UA first');
    assert.ok(userAgents[1]?.includes('Mozilla/5.0'), 'expected browser UA fallback');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
