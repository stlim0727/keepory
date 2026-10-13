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
