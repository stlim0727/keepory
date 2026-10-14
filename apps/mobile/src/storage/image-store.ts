/** Browser images are inline data persisted with the bookmark by the web repository.
 * This avoids session-scoped object URLs. Storage quota failures remain save failures.
 */

import { imageBlobData, imageDataBytes } from '@/domain/image-data';
import { SupabaseRequestError } from '@/supabase/client';

/** Inline browser image bytes have no separately owned file to remove. */
export async function deleteLibraryImage(_uri: string): Promise<void> {}

export async function copyImageToLibrary(sourceUri: string, _fileName: string): Promise<string> {
  // Inline image data is persisted by repository.insertBookmark, unlike blob URLs
  // whose backing bytes disappear on reload. Storage quota errors propagate there.
  if (typeof localStorage === 'undefined') throw new Error('Browser storage unavailable.');
  if (sourceUri.startsWith('data:')) { imageDataBytes(sourceUri); return sourceUri; }
  if (!sourceUri.startsWith('blob:')) throw new Error('Unsupported browser image source.');
  const response = await fetch(sourceUri);
  if (!response.ok) throw new Error('Could not read pasted image.');
  return imageBlobData(await response.blob());
}

/** Upload the durable binary using the existing authenticated storage target. */
export async function uploadImageFile(
  localUri: string,
  uploadUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const result = await fetch(uploadUrl, {
      method: 'POST', headers, body: new Uint8Array(imageDataBytes(localUri)).buffer, signal: controller.signal,
    });
    if (!result.ok) throw new SupabaseRequestError(`Image upload failed with HTTP ${result.status}`, result.status);
  } finally { clearTimeout(timeout); }
}

/** Size check before attempting storage upload. */
export function localFileSizeBytes(localUri: string): number {
  return imageDataBytes(localUri).byteLength;
}
