import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
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
  assert.equal(tikTokOembedEndpoint('https://example.com/video/123'), null);
});
