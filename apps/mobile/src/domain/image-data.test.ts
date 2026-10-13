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
    for (const encoded of ['A===', '=AAA', 'AA=A', 'A', 'AAA', 'AB==', 'AAB=', '%%%%', ' \t\r\n', 'AP8=\u00a0', 'AP8=\u000b', 'AP8=\u2028']) {
      assert.throws(() => imageDataBytes(`data:image/png;base64,${encoded}`), /Invalid image data/);
    }
  } finally {
    globalThis.atob = originalAtob;
    globalThis.btoa = originalBtoa;
  }
});

test('Android line-wrapped base64 with trailing newline preserves image bytes', () => {
  const bytes = Uint8Array.from({ length: 128 }, (_, index) => index);
  const encoded = Buffer.from(bytes).toString('base64');
  const wrapped = encoded.match(/.{1,76}/g)!.join('\n') + '\n';
  assert.equal(wrapped.indexOf('\n'), 76);
  assert.deepEqual(imageDataBytes(`data:image/png;base64,${wrapped}`), bytes);
  assert.deepEqual(imageDataBytes('data:image/png;base64, \tA\rP\n8 =\n'), Uint8Array.from([0, 255]));
});
