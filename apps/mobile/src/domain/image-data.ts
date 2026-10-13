/** Browser image data can be stored with the existing durable bookmark row. */
export function imageDataBytes(uri: string): Uint8Array {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(uri);
  if (!match || !match[1] || match[1].length % 4 !== 0) throw new Error('Invalid image data.');
  const binary = atob(match[1]);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function imageBlobData(blob: Blob): Promise<string> {
  if (!blob.type.startsWith('image/') || blob.size === 0) throw new Error('No image data.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
