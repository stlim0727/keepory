import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleMapsPlaceName, isGenericGoogleMapsTitle, isGoogleMapsUrl } from './google-maps.ts';
import { parsePageMetadata, fetchPageMetadata } from './page-metadata.ts';
import { enrichBookmark, isRepairableSourceTitle } from './enrichment.ts';
import type { Bookmark } from './types.ts';

const placeUrl = 'https://www.google.com/maps/place/Nem+N%C6%B0%E1%BB%9Bng+Nha+Trang+Qu%E1%BA%BF+Hoa,+23+P.+H%E1%BB%93+Ho%C3%A0n+Ki%E1%BA%BFm/data=!4m2!3m1!1s0x3135:0xd5bb';
const placeName = 'Nem Nướng Nha Trang Quế Hoa, 23 P. Hồ Hoàn Kiếm';
const shell = '<head><meta property="og:title" content="Google Maps"><meta property="og:image" content="https://maps.google.com/maps/api/staticmap?center=22,114"></head>';

test('Google Maps recovers the reported restaurant and address from the expanded URL', () => {
  assert.equal(googleMapsPlaceName(placeUrl), placeName);
  const metadata = parsePageMetadata(shell, placeUrl);
  assert.equal(metadata.title, placeName);
  assert.equal(metadata.site_name, 'Google Maps');
  assert.equal(metadata.preview_image_url, null);
});

test('Google Maps preserves real place metadata and prefers specific Twitter titles to generic OG', () => {
  const html = shell.replace('</head>', '<meta name="twitter:title" content="Restaurant details"></head>');
  const metadata = parsePageMetadata(html, placeUrl);
  assert.equal(metadata.title, 'Restaurant details');
  assert.match(metadata.preview_image_url!, /staticmap/);
});

test('Google Maps does not invent place details from coordinates, IDs, or short codes', () => {
  for (const url of [
    'https://maps.app.goo.gl/7JkAdshyX3gR62qr6',
    'https://www.google.com/maps/place/22.3527,114.1394/',
    'https://www.google.com/maps/place/0x3135:0xd5bb/',
    'https://www.google.com/maps/place/%E0%A4/',
    'https://www.google.com/maps/place/@22,114,8z/',
    'https://www.google.com/maps/',
  ]) {
    assert.equal(googleMapsPlaceName(url), null);
    assert.equal(parsePageMetadata(shell, url).title, undefined);
    assert.equal(parsePageMetadata(shell, url).preview_image_url, null);
  }
});

test('Google Maps handling stays scoped to recognized map hosts and paths', () => {
  for (const url of ['https://example.com/maps/place/Restaurant/', 'https://google.com.evil.com/maps/place/Restaurant/', 'https://www.google.com/search?q=maps', 'bad url']) {
    assert.equal(isGoogleMapsUrl(url), false);
    assert.equal(googleMapsPlaceName(url), null);
    assert.equal(isGenericGoogleMapsTitle('Google Maps', url), false);
  }
  assert.equal(isGoogleMapsUrl('https://goo.gl/maps/abc'), true);
  assert.equal(isGoogleMapsUrl('https://maps.google.com/'), true);
});

test('Maps preview refresh can repair a generic title while protecting manual edits', async () => {
  const url = 'https://maps.app.goo.gl/7JkAdshyX3gR62qr6';
  assert.equal(isRepairableSourceTitle({ url, title: 'Google Maps' }), true);
  assert.equal(isRepairableSourceTitle({ url, title: 'Google 지도' }), true);
  assert.equal(isRepairableSourceTitle({ url, title: '넴느엉 퀘호아 Google Maps' }), false);
  for (const title of ['Google Maps', '넴느엉 퀘호아 Google Maps']) {
    const result = await enrichBookmark({ url, title, title_is_derived: false } as Bookmark,
      async () => parsePageMetadata(shell, placeUrl));
    assert.equal(result.patch.title, title === 'Google Maps' ? placeName : undefined);
    // Preview refresh clears its generated image before enrichment; explicitly
    // returning null lets it remove a previously saved, unrelated shell map.
    assert.equal(result.patch.preview_image_url, null);
  }
});

test('a short Maps share uses the redirect destination for metadata recovery', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (urls.length === 1) {
      return new Response(null, { status: 302, headers: { location: placeUrl } });
    }
    const response = new Response(shell, { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: placeUrl });
    return response;
  }) as typeof fetch;
  try {
    const metadata = await fetchPageMetadata('https://maps.app.goo.gl/7JkAdshyX3gR62qr6');
    assert.equal(metadata?.title, placeName);
    assert.equal(metadata?.preview_image_url, null);
    assert.equal(urls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
