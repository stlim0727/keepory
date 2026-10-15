import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleMapsPlaceName, isGenericGoogleMapsTitle, isGoogleMapsUrl } from './google-maps.ts';
import { parsePageMetadata, fetchPageMetadata } from './page-metadata.ts';
import { deriveMetadata, enrichBookmark, isRepairableSourceTitle } from './enrichment.ts';
import type { Bookmark } from './types.ts';

const placeUrl = 'https://www.google.com/maps/place/Nem+N%C6%B0%E1%BB%9Bng+Nha+Trang+Qu%E1%BA%BF+Hoa,+23+P.+H%E1%BB%93+Ho%C3%A0n+Ki%E1%BA%BFm/data=!4m2!3m1!1s0x3135:0xd5bb';
const placeName = 'Nem Nướng Nha Trang Quế Hoa, 23 P. Hồ Hoàn Kiếm';
const shell = '<head><meta property="og:title" content="Google Maps"><meta property="og:image" content="https://maps.google.com/maps/api/staticmap?center=22,114"></head>';

test('Google Maps recovers the reported restaurant and address from the expanded URL', () => {
  assert.equal(googleMapsPlaceName(placeUrl), placeName);
  const metadata = parsePageMetadata(shell, placeUrl);
  assert.equal(metadata.title, placeName);
  assert.equal(metadata.title_is_derived, true);
  assert.equal(metadata.site_name, 'Google Maps');
  assert.equal(metadata.preview_image_url, null);
});

test('Maps recovery works offline and short links retain a human fallback', async () => {
  for (const [url, expected] of [[placeUrl, placeName], ['https://maps.app.goo.gl/7JkAdshyX3gR62qr6', 'Google Maps']]) {
    assert.equal(deriveMetadata(url).title, expected);
    const result = await enrichBookmark({ url, title: null } as Bookmark, async () => null);
    assert.equal(result.patch.title, expected);
    assert.equal(result.patch.title_is_derived, true);
  }
});

test('Maps place names preserve encoded plus signs and decode raw separators as spaces', () => {
  const url = 'https://www.google.com/maps/place/C%2B%2B+Coffee/';
  assert.equal(googleMapsPlaceName(url), 'C++ Coffee');
  assert.equal(deriveMetadata(url).title, 'C++ Coffee');
  assert.equal(parsePageMetadata(shell, url).title, 'C++ Coffee');
});

test('Google Maps preserves real place metadata and prefers specific Twitter titles to generic OG', () => {
  const html = shell.replace('</head>', '<meta name="twitter:title" content="Restaurant details"></head>');
  const metadata = parsePageMetadata(html, placeUrl);
  assert.equal(metadata.title, 'Restaurant details');
  assert.notEqual(metadata.title_is_derived, true);
  assert.match(metadata.preview_image_url!, /staticmap/);
});

test('Google Maps does not invent place details from coordinates, IDs, or short codes', () => {
  for (const url of [
    'https://maps.app.goo.gl/7JkAdshyX3gR62qr6',
    'https://www.google.com/maps/place/22.3527,114.1394/',
    'https://www.google.com/maps/place/40.7128+-74.0060/',
    'https://www.google.com/maps/place/40.7128%20-74.0060/',
    'https://www.google.com/maps/place/0x3135:0xd5bb/',
    'https://www.google.com/maps/place/%E0%A4/',
    'https://www.google.com/maps/place/@22,114,8z/',
    'https://www.google.com/maps/place/50%C2%B041\'06.7%22N+1%C2%B014\'44.0%22W/',
    'https://www.google.com/maps/place/50.685N+1.245W/',
    'https://www.google.com/maps/place/849VCWC8%2BR9/',
    'https://www.google.com/maps/place/CWC8+R9+Mountain+View/',
    'https://www.google.com/maps/',
  ]) {
    assert.equal(googleMapsPlaceName(url), null);
    assert.equal(parsePageMetadata(shell, url).title, undefined);
    assert.equal(parsePageMetadata(shell, url).preview_image_url, null);
  }
});

test('localized Maps product titles remain repairable shells across online and offline recovery', () => {
  for (const title of ['Google マップ', 'Google 地图', 'Google 地圖', 'Google Карты', 'خرائط Google']) {
    assert.equal(isGenericGoogleMapsTitle(title, placeUrl), true);
    assert.equal(isRepairableSourceTitle({ url: placeUrl, title }), true);
    const metadata = parsePageMetadata(shell.replace('Google Maps', title), placeUrl);
    assert.equal(metadata.title, placeName);
    assert.equal(metadata.title_is_derived, true);
    assert.equal(metadata.preview_image_url, null);
  }
  assert.equal(isGenericGoogleMapsTitle('Google Maps Coffee', placeUrl), false);
  assert.equal(deriveMetadata('https://www.google.com/maps/place/40.7128+-74.0060/').title, 'Google Maps');
});

test('Google Maps handling stays scoped to recognized map hosts and paths', () => {
  for (const url of ['https://example.com/maps/place/Restaurant/', 'https://google.com.evil.com/maps/place/Restaurant/', 'https://www.google.com/search?q=maps', 'bad url']) {
    assert.equal(isGoogleMapsUrl(url), false);
    assert.equal(googleMapsPlaceName(url), null);
    assert.equal(isGenericGoogleMapsTitle('Google Maps', url), false);
  }
  assert.equal(isGoogleMapsUrl('https://goo.gl/maps/abc'), true);
  assert.equal(isGoogleMapsUrl('https://maps.google.com/'), true);
  for (const host of ['www.google.co.uk', 'www.google.co.kr', 'google.de', 'maps.google.co.uk', 'maps.google.de']) {
    const url = placeUrl.replace('www.google.com', host);
    assert.equal(isGoogleMapsUrl(url), true);
    assert.equal(googleMapsPlaceName(url), placeName);
    assert.equal(deriveMetadata(url).title, placeName);
    assert.equal(parsePageMetadata(shell, url).preview_image_url, null);
    assert.equal(isRepairableSourceTitle({ url, title: 'Google Maps' }), true);
  }
});

test('title-only Maps metadata explicitly clears a stale image during refresh', async () => {
  for (const image of ['', '<meta property="og:image" content="file:///private/image.png">']) {
    const metadata = parsePageMetadata(`<head><title>Restaurant details</title>${image}</head>`, placeUrl);
    assert.equal(metadata.title, 'Restaurant details');
    assert.equal(metadata.preview_image_url, null);
    const result = await enrichBookmark({ url: placeUrl, title: null, preview_image_url: null } as Bookmark,
      async () => metadata);
    assert.equal(result.patch.title, 'Restaurant details');
    assert.equal(result.patch.preview_image_url, null);
  }
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
    assert.equal(result.patch.title_is_derived, title === 'Google Maps' ? true : undefined);
    // Preview refresh clears its generated image before enrichment; explicitly
    // returning null lets it remove a previously saved, unrelated shell map.
    assert.equal(result.patch.preview_image_url, null);
  }
});

test('real page metadata can improve a previously URL-recovered Maps title', async () => {
  const result = await enrichBookmark({ url: placeUrl, title: placeName, title_is_derived: true } as Bookmark,
    async () => ({ title: 'Restaurant details' }));
  assert.equal(result.patch.title, 'Restaurant details');
  assert.equal(result.patch.title_is_derived, false);
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
    assert.equal(urls.length, 3);
    assert.equal(urls[2], placeUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('browser Maps metadata improves URL fallback, while empty or failed retries preserve it', async () => {
  const originalFetch = globalThis.fetch;
  for (const browserHtml of [
    '<head><meta property="og:title" content="Restaurant details"><meta property="og:image" content="https://example.com/place.jpg"></head>',
    '<head></head>',
    '<title>Just a moment...</title>',
    '<title>Before you continue to Google</title>',
    '<title>Google</title>',
    '<title>Localized consent</title>',
    null,
  ]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls > 1 && browserHtml === null) throw new Error('offline');
      const response = new Response(calls === 1 ? shell : browserHtml, { headers: { 'content-type': 'text/html' } });
      const finalUrl = calls > 1 && browserHtml?.includes('Localized consent')
        ? 'https://consent.google.com/m?continue=maps' : placeUrl;
      Object.defineProperty(response, 'url', { value: finalUrl });
      return response;
    }) as typeof fetch;
    try {
      const metadata = await fetchPageMetadata(placeUrl);
      const realTitle = browserHtml?.includes('Restaurant details');
      assert.equal(metadata?.title, realTitle ? 'Restaurant details' : placeName);
      assert.equal(metadata?.preview_image_url, realTitle ? 'https://example.com/place.jpg' : null);
      assert.equal(metadata?.title_is_derived, realTitle ? undefined : true);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});
