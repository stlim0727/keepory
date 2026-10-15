import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import { imageDataBytes } from '@/domain/image-data';
import type { SharedImage } from '@/domain/image-share';
import { makeUuid } from '@/domain/uuid';

// Only files minted by this reader are eligible for deletion. Incoming shares,
// user files, and durable library copies can never enter this ownership map.
const ownedImages = new Map<SharedImage, File>();
export function releaseOwnedClipboardImage(image: SharedImage | undefined): void {
  if (!image) return;
  const file = ownedImages.get(image);
  if (!file || image.uri !== file.uri || !file.uri.startsWith(`${Paths.cache.uri.replace(/\/$/, '')}/`)) return;
  try { file.delete(); ownedImages.delete(image); } catch { /* Cache cleanup is best effort. */ }
}

export async function readSmartClipboard(): Promise<{ text: string; image?: SharedImage }> {
  let image: SharedImage | undefined;
  if (await Clipboard.hasImageAsync()) {
    const captured = await Clipboard.getImageAsync({ format: 'png' });
    if (captured) {
      const file = new File(Paths.cache, `clipboard-${makeUuid()}.png`);
      const bytes = imageDataBytes(captured.data);
      image = { uri: file.uri, mimeType: 'image/png', fileName: null };
      ownedImages.set(image, file);
      try { await file.write(bytes); } catch (error) { releaseOwnedClipboardImage(image); throw error; }
    }
  }
  // Some providers offer an image but no readable string. Keep the image in that case.
  const text = await Clipboard.getStringAsync().catch((error) => {
    if (!image) throw error;
    return '';
  });
  return { text, image };
}

export async function imageFromBlob(_blob: Blob): Promise<SharedImage> {
  throw new Error('Browser image paste is unavailable on native.');
}
