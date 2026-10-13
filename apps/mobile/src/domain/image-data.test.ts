import test from 'node:test';
import assert from 'node:assert/strict';
import { imageBlobData, imageDataBytes } from './image-data.ts';

test('image binary survives data URI serialization and blob URL lifetime', async () => {
  const bytes = Uint8Array.from([0, 255, 12, 99, 1]);
  const data = await imageBlobData(new Blob([bytes], { type: 'image/png' }));
  assert.deepEqual(imageDataBytes(JSON.parse(JSON.stringify(data))), bytes);
});
test('invalid, empty and non-image sources are rejected', async () => {
  for (const input of ['blob:temporary', 'data:text/plain;base64,YQ==', 'data:image/png;base64,', 'data:image/png;base64,???']) {
    assert.throws(() => imageDataBytes(input));
  }
  await assert.rejects(imageBlobData(new Blob([], { type: 'image/png' })));
});

test('native decoding needs no browser base64 globals and rejects malformed data', () => {
  const originalAtob = globalThis.atob;
  const originalBtoa = globalThis.btoa;
  Reflect.deleteProperty(globalThis, 'atob');
  Reflect.deleteProperty(globalThis, 'btoa');
  try {
    assert.deepEqual(imageDataBytes('data:image/png;base64,AP8MYwE='), Uint8Array.from([0, 255, 12, 99, 1]));
    assert.deepEqual(imageDataBytes('data:image/png;base64,AP8='), Uint8Array.from([0, 255]));
    assert.deepEqual(imageDataBytes('data:image/png;base64,/w=='), Uint8Array.from([255]));
    assert.deepEqual(imageDataBytes('data:image/png;base64,AP8M'), Uint8Array.from([0, 255, 12]));
    for (const encoded of ['A===', '=AAA', 'AA=A', 'A', 'AAA', 'AB==', 'AAB=', '%%%%']) {
      assert.throws(() => imageDataBytes(`data:image/png;base64,${encoded}`), /Invalid image data/);
    }
  } finally {
    globalThis.atob = originalAtob;
    globalThis.btoa = originalBtoa;
  }
});
