import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalTikTokVideoUrl, isTikTokShortlink, resolveTikTokShortlink, tikTokOembedEndpoint } from './tiktok.ts';

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
