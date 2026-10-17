import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalTikTokVideoUrl,
  isTikTokShortlink,
  resolveTikTokShortlink,
  isGenericTikTokTitle,
  isTikTokUrl,
  tikTokOembedEndpoint,
} from './tiktok.ts';

test('isTikTokUrl recognizes standard, lite, and mobile shortlinks', () => {
  assert.equal(isTikTokUrl('https://www.tiktok.com/@user/video/123'), true);
  assert.equal(isTikTokUrl('https://tiktok.com/@user/video/123'), true);
  assert.equal(isTikTokUrl('https://lite.tiktok.com/t/ZSJ1234/'), true);
  assert.equal(isTikTokUrl('https://vt.tiktok.com/ZSJ1234/'), true);
  assert.equal(isTikTokUrl('https://vm.tiktok.com/ZSJ1234/'), true);
  assert.equal(isTikTokUrl('https://example.com/tiktok'), false);
  assert.equal(isTikTokUrl('not a url'), false);
});

test('isGenericTikTokTitle identifies generic shells and preserves real titles', () => {
  assert.equal(isGenericTikTokTitle('TikTok', 'https://www.tiktok.com/@user/video/123'), true);
  assert.equal(isGenericTikTokTitle('TikTok Lite', 'https://lite.tiktok.com/t/ZSJ1234/'), true);
  assert.equal(
    isGenericTikTokTitle('TikTok Lite - Watch Videos', 'https://lite.tiktok.com/t/ZSJ1234/'),
    true,
  );
  assert.equal(
    isGenericTikTokTitle('TikTok Lite - 동영상 시청', 'https://lite.tiktok.com/t/ZSJ1234/'),
    true,
  );
  assert.equal(isGenericTikTokTitle('틱톡', 'https://www.tiktok.com/@user/video/123'), true);
  assert.equal(isGenericTikTokTitle('틱톡 라이트', 'https://lite.tiktok.com/t/ZSJ1234/'), true);
  assert.equal(isGenericTikTokTitle('TikTok video', 'https://www.tiktok.com/@user/video/123'), true);
  assert.equal(isGenericTikTokTitle('Trending videos on TikTok', 'https://www.tiktok.com/'), true);
  assert.equal(
    isGenericTikTokTitle('후쿠오카 텐진 라멘 투어 Best 3', 'https://www.tiktok.com/@user/video/123'),
    false,
  );
  assert.equal(isGenericTikTokTitle(undefined), true);
  assert.equal(isGenericTikTokTitle('TikTok', 'https://github.com/trending'), false);
});

test('tikTokOembedEndpoint resolves oEmbed URLs for video and share URLs', () => {
  assert.equal(
    tikTokOembedEndpoint('https://www.tiktok.com/@scout/video/12345'),
    'https://www.tiktok.com/oembed?url=https%3A%2F%2Fwww.tiktok.com%2F%40scout%2Fvideo%2F12345',
  );
  assert.equal(
    tikTokOembedEndpoint('https://lite.tiktok.com/t/ZSJ1234/'),
    'https://www.tiktok.com/oembed?url=https%3A%2F%2Flite.tiktok.com%2Ft%2FZSJ1234%2F',
  );
  assert.equal(
    tikTokOembedEndpoint('https://vt.tiktok.com/ZSJ1234/'),
    'https://www.tiktok.com/oembed?url=https%3A%2F%2Fvt.tiktok.com%2FZSJ1234%2F',
  );
  assert.equal(tikTokOembedEndpoint('https://www.tiktok.com/@scout'), null);
  assert.equal(tikTokOembedEndpoint('https://www.tiktok.com/'), null);
  assert.equal(tikTokOembedEndpoint('https://lite.tiktok.com/'), null);
  assert.equal(tikTokOembedEndpoint('https://lite.tiktok.com/explore'), null);
  assert.equal(tikTokOembedEndpoint('https://vt.tiktok.com/'), null);
  assert.equal(tikTokOembedEndpoint('https://example.com/video/123'), null);
});

test('TikTok oEmbed strips tracking parameters from canonical video URLs', () => {
  const canonical = 'https://www.tiktok.com/@jeonyeogi365/video/7671897897641790740';
  assert.equal(canonicalTikTokVideoUrl(`${canonical}?_r=1&_t=share`), canonical);
  assert.equal(tikTokOembedEndpoint(`${canonical}?_r=1&_t=share`),
    `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical)}`);
});

test('TikTok shortlink recognition excludes unrelated domains and canonical videos', () => {
  for (const url of ['https://vt.tiktok.com/ZSgNw1uD1/', 'https://vm.tiktok.com/code/', 'https://www.tiktok.com/t/code/']) {
    assert.equal(isTikTokShortlink(url), true);
  }
  assert.equal(isTikTokShortlink('https://example.com/t/code/'), false);
  assert.equal(isTikTokShortlink('https://www.tiktok.com/@user/video/123'), false);
  assert.equal(canonicalTikTokVideoUrl('https://example.com/@user/video/123'), null);
});

test('TikTok resolver tolerates unavailable or unrelated redirect destinations', async () => {
  const shortlink = 'https://vt.tiktok.com/ZSgNw1uD1/';
  for (const fetcher of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false, status: 405 } as Response),
    async () => ({ ok: true, url: 'https://example.com/' } as Response),
    async () => ({ ok: true, url: shortlink } as Response),
  ]) {
    assert.equal(await resolveTikTokShortlink(shortlink, fetcher as typeof fetch), null);
  }
});
