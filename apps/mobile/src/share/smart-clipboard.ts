import { imageBlobData } from '@/domain/image-data';
import type { SharedImage } from '@/domain/image-share';

export async function imageFromBlob(blob: Blob): Promise<SharedImage> {
  return { uri: await imageBlobData(blob), mimeType: blob.type, fileName: null };
}

/** A single read keeps image and text representations in the same clipboard snapshot. */
export async function readSmartClipboard(): Promise<{ text: string; image?: SharedImage }> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard unavailable.');
  if (typeof navigator.clipboard.read !== 'function') return { text: await navigator.clipboard.readText() };
  const items = await navigator.clipboard.read();
  let image: SharedImage | undefined;
  let text = '';
  for (const item of items) {
    const type = item.types.find((value) => value.startsWith('image/'));
    if (!image && type) image = await imageFromBlob(await item.getType(type));
    if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
  }
  return { text, image };
}

/** Browser clipboard images are inline data, with no owned cache file. */
export function releaseOwnedClipboardImage(_image: SharedImage | undefined): void {}
