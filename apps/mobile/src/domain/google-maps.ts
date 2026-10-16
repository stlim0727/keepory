import type { Bookmark } from './types.ts';

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
  return isGoogleMapsUrl(url) && /^(?:google(?:\s*(?:maps|지도|マップ|地图|地圖|карты|haritalar|แผนที่))?|구글 지도|(?:خرائط|מפות|Χάρτες)\s+google)$/i.test(title?.trim() ?? '');
}

/** Named place paths and standard search terms; coordinates and IDs are not names. */
export function googleMapsPlaceName(rawUrl: string): string | null {
  if (!isGoogleMapsUrl(rawUrl)) return null;
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/^\/maps\/(?:place|search)\/([^/]+)/);
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

/** Split only an explicit street-number address; commas also occur in business names. */
export function googleMapsPlaceDetails(url: string, title: string): { title: string; address: string } | null {
  if (!isGoogleMapsUrl(url)) return null;
  const match = title.match(/^(.+),\s*(\d+[A-Za-z]?(?:[-/]\d+)?\s+[^,]+(?:,.*)?)$/u);
  if (!match || !/(?:^|\s)(?:P\.|Đ\.|Phố|Đường|Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Drive|Dr\.?|Boulevard|Blvd\.?|Way|길|로)(?:\s|,|$)/iu.test(match[2].split(',')[0])) return null;
  return { title: match[1].trim(), address: match[2].trim() };
}

/** Keep the address and shortened title together, preserving edits made during fetching. */
export function preserveMapMemoEdit(patch: Partial<Bookmark>, latest: Bookmark): Partial<Bookmark> {
  if (patch.notes === undefined || (!latest.notes?.trim() &&
    (latest.title == null || latest.title_is_derived === true))) return patch;
  const { notes: _notes, title: _title, title_is_derived: _derived, ...rest } = patch;
  return rest;
}
