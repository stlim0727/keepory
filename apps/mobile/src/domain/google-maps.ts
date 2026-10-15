/** Google Maps shells can advertise the viewer's map, rather than the shared place. */
export function isGoogleMapsUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const googleHost = /^(?:maps\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host);
    return host === 'maps.app.goo.gl' || host === 'goo.gl' && url.pathname.startsWith('/maps/') ||
      googleHost && (host.startsWith('maps.') || /^\/maps(?:\/|$)/.test(url.pathname));
  } catch {
    return false;
  }
}

export function isGenericGoogleMapsTitle(title: string | undefined, url: string): boolean {
  return isGoogleMapsUrl(url) && /^(?:google\s*(?:maps|지도|マップ|地图|地圖|карты|haritalar|แผนที่)|구글 지도|(?:خرائط|מפות|Χάρτες)\s+google)$/i.test(title?.trim() ?? '');
}

/** Named place paths and standard search terms; coordinates and IDs are not names. */
export function googleMapsPlaceName(rawUrl: string): string | null {
  if (!isGoogleMapsUrl(rawUrl)) return null;
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/^\/maps\/place\/([^/]+)/);
    const query = /^\/maps\/search\/?$/.test(url.pathname) && url.searchParams.get('api') === '1'
      ? url.searchParams.get('query') : null;
    if (!match && !query) return null;
    const decoded = match ? decodeURIComponent(match[1]) : query!;
    // Full and shortened Plus Codes identify a location, not a named place.
    if (/^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,3}(?:[+,\s]|$)/i.test(decoded)) return null;
    const name = (match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : decoded).replace(/\s+/g, ' ').trim();
    if (!name || /^[@!]|^0x[\da-f]+:|^place_id:|^[+-]?\d+(?:\.\d+)?(?:\s*,\s*|\s+)[+-]?\d+(?:\.\d+)?$/i.test(name)) return null;
    // Dropped pins also use degree/minute/second or hemisphere coordinate pairs.
    if (/^[\d\s.°'′"″]+[NS]\s*[, ]?\s*[\d\s.°'′"″]+[EW]$/i.test(name)) return null;
    return name;
  } catch {
    return null;
  }
}
