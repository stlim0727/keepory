import test from 'node:test';
import assert from 'node:assert/strict';
import { copyImageToLibrary, localFileSizeBytes, uploadImageFile } from './image-store.ts';
const image = 'data:image/png;base64,AP8MYwE=';
test('browser copy requires durable storage and converts transient object URLs', async () => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const fetchImpl = globalThis.fetch;
  try {
    Object.defineProperty(globalThis, 'localStorage', {configurable:true,value:undefined});
    await assert.rejects(copyImageToLibrary(image,'capture.png'), /storage unavailable/);
    Object.defineProperty(globalThis, 'localStorage', {configurable:true,value:{}});
    assert.equal(await copyImageToLibrary(image,'capture.png'), image);
    globalThis.fetch = async () => new Response(Uint8Array.from([0,255,12,99,1]), {headers:{'Content-Type':'image/png'}});
    assert.equal(await copyImageToLibrary('blob:temporary','capture.png'), image);
    assert.equal(localFileSizeBytes(image),5);
    await assert.rejects(copyImageToLibrary('https://example.com/image','capture.png'));
  } finally {
    globalThis.fetch = fetchImpl;
    if (storage) Object.defineProperty(globalThis,'localStorage',storage);
    else Reflect.deleteProperty(globalThis,'localStorage');
  }
});
test('web upload sends binary/auth headers and rejects non-success HTTP status', async () => {
  const previous = globalThis.fetch;
  let calls=0;
  try {
    globalThis.fetch = async (_url, options) => {
      calls++;
      assert.equal(options?.method,'POST');
      assert.deepEqual(options?.headers, {Authorization:'Bearer test-token','Content-Type':'image/png'});
      assert.deepEqual(new Uint8Array(options?.body as ArrayBuffer), Uint8Array.from([0,255,12,99,1]));
      assert.ok(options?.signal);
      return new Response('',{status:calls===1 ? 200 : 413});
    };
    const headers = {Authorization:'Bearer test-token','Content-Type':'image/png'};
    await uploadImageFile(image,'https://example.com/storage/object',headers);
    await assert.rejects(uploadImageFile(image,'https://example.com/storage/object',headers), {status:413});
  } finally {globalThis.fetch=previous;}
});
