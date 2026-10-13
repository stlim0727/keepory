import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import { imageDataBytes } from '@/domain/image-data';
import type { SharedImage } from '@/domain/image-share';
import { makeUuid } from '@/domain/uuid';

export async function readSmartClipboard(): Promise<{ text: string; image?: SharedImage }> {
  let image: SharedImage | undefined;
  if (await Clipboard.hasImageAsync()) {
    const captured = await Clipboard.getImageAsync({ format: 'png' });
    if (captured) {
      const file = new File(Paths.cache, `clipboard-${makeUuid()}.png`);
      await file.write(imageDataBytes(captured.data));
      image = { uri: file.uri, mimeType: 'image/png', fileName: null };
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
