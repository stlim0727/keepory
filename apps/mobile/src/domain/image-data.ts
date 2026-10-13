/** Browser image data can be stored with the existing durable bookmark row. */
export function imageDataBytes(uri: string): Uint8Array {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([\s\S]*)$/i.exec(uri);
  if (!match || /[^A-Za-z0-9+/= \t\r\n]/.test(match[1])) throw new Error('Invalid image data.');
  // Android Base64.DEFAULT wraps clipboard image data and adds a trailing newline.
  const encoded = match[1].replace(/[ \t\r\n]/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('Invalid image data.');
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  // Reject nonzero unused bits rather than silently accepting corrupt data.
  const lastValue = alphabet.indexOf(encoded[encoded.length - padding - 1]);
  if ((padding === 2 && (lastValue & 15) !== 0) || (padding === 1 && (lastValue & 3) !== 0)) {
    throw new Error('Invalid image data.');
  }
  const bytes = new Uint8Array(encoded.length / 4 * 3 - padding);
  let output = 0;
  for (let offset = 0; offset < encoded.length; offset += 4) {
    const a = alphabet.indexOf(encoded[offset]);
    const b = alphabet.indexOf(encoded[offset + 1]);
    const c = encoded[offset + 2] === '=' ? 0 : alphabet.indexOf(encoded[offset + 2]);
    const d = encoded[offset + 3] === '=' ? 0 : alphabet.indexOf(encoded[offset + 3]);
    bytes[output++] = (a << 2) | (b >> 4);
    if (output < bytes.length) bytes[output++] = (b << 4) | (c >> 2);
    if (output < bytes.length) bytes[output++] = (c << 6) | d;
  }
  return bytes;
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
