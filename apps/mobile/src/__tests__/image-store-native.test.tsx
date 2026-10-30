const mockUpload = jest.fn();
const mockCopy = jest.fn();
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    exists = false;
    upload = mockUpload;
    constructor(parent: string | { uri: string }, name?: string) {
      this.uri = typeof parent === 'string' ? parent : `${parent.uri}/${name}`;
    }
    copy(destination: { uri: string }) {
      // Match the native requirement that triggered the reported failure.
      const source = new URL(this.uri);
      mockCopy(source.href, destination.uri);
    }
  },
  Directory: class {
    uri: string;
    exists = true;
    constructor(parent: string, name: string) { this.uri = `${parent}/${name}`; }
  },
  Paths: { document: 'file:///documents' },
  UploadType: { BINARY_CONTENT: 0 },
}));

import { copyImageToLibrary, uploadImageFile } from '@/storage/image-store.native';
import { SupabaseRequestError } from '@/supabase/client';
import { syncErrorKind } from '@/sync/sync-bookmarks';
import { canAutomaticallyRetry } from '@/sync/automatic-retry';

test.each([
  ['/data/user/0/app/cache/IMG_1234.jpg', 'file:///data/user/0/app/cache/IMG_1234.jpg'],
  ['/data/user/0/app/cache/사진 100% #1?.jpg', 'file:///data/user/0/app/cache/%EC%82%AC%EC%A7%84%20100%25%20%231%3F.jpg'],
  ['file:///cache/photo%20one.jpg', 'file:///cache/photo%20one.jpg'],
  ['content://com.google.android.apps.photos.contentprovider/photo%2F123', 'content://com.google.android.apps.photos.contentprovider/photo%2F123'],
])('native capture durably copies shared image %s', async (source, expected) => {
  await expect(copyImageToLibrary(source, 'capture.jpg')).resolves.toBe('file:///documents/stash-images/capture.jpg');
  expect(mockCopy).toHaveBeenCalledWith(expected, 'file:///documents/stash-images/capture.jpg');
});

test('native copy failure rejects instead of confirming durable capture', async () => {
  const failure = new Error('Shared file is no longer readable');
  mockCopy.mockImplementationOnce(() => { throw failure; });
  await expect(copyImageToLibrary('/cache/missing.jpg', 'capture.jpg')).rejects.toBe(failure);
});

test.each([
  [401, 'auth', false], [403, 'permission', false],
  [408, 'retryable_http', true], [429, 'retryable_http', true],
  [503, 'retryable_http', true], [400, 'other', false],
] as const)('native image HTTP %s preserves retry and recovery provenance', async (status, kind, retryable) => {
  mockUpload.mockResolvedValue({ status, body: 'timed out' });
  let failure: unknown;
  try { await uploadImageFile('file:///image.jpg', 'https://example.com/upload', {}); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SupabaseRequestError);
  expect((failure as SupabaseRequestError).status).toBe(status);
  expect(syncErrorKind(failure)).toBe(kind);
  expect(canAutomaticallyRetry(syncErrorKind(failure), 3)).toBe(retryable);
});

test('native successful upload completes and network rejection retains its cause', async () => {
  mockUpload.mockResolvedValue({ status: 201, body: '' });
  await expect(uploadImageFile('file:///image.jpg', 'https://example.com/upload', {})).resolves.toBeUndefined();
  const failure = new Error('Network request failed');
  mockUpload.mockRejectedValue(failure);
  await expect(uploadImageFile('file:///image.jpg', 'https://example.com/upload', {})).rejects.toBe(failure);
  expect(syncErrorKind(failure)).toBe('transient_network');
});
