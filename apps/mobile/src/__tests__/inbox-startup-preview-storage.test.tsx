let mockDisk: string | null = null;
let mockDenied = false;
let mockWriteRejects = false;
const mockDelete = jest.fn(() => { mockDisk = null; });
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache/' },
  File: class {
    get exists() { if (mockDenied) throw new Error('denied'); return mockDisk !== null; }
    get size() { return mockDisk?.length ?? 0; }
    create() { mockDisk = ''; }
    write(raw: string) {
      if (mockWriteRejects) return Promise.reject(new Error('write failed'));
      mockDisk = raw;
      return Promise.resolve();
    }
    text() { return Promise.resolve(mockDisk); }
    delete() { mockDelete(); }
  },
}));

import { invalidateInboxStartupPreview, readInboxStartupPreview, writeInboxStartupPreview } from '@/storage/inbox-startup-preview';

beforeEach(async () => {
  mockDenied = false;
  mockWriteRejects = false;
  await writeInboxStartupPreview('reset invalidation state');
  await writeInboxStartupPreview(null);
  mockDelete.mockClear();
});

test('native snapshot reads and writes work independently of SQLite', async () => {
  expect(await readInboxStartupPreview()).toBeNull();
  await writeInboxStartupPreview('first snapshot');
  expect(await readInboxStartupPreview()).toBe('first snapshot');
  await writeInboxStartupPreview('latest snapshot');
  expect(await readInboxStartupPreview()).toBe('latest snapshot');
  invalidateInboxStartupPreview();
  invalidateInboxStartupPreview();
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(await readInboxStartupPreview()).toBeNull();
});

test('native cache failures and oversized files fall back without affecting library storage', async () => {
  mockDenied = true;
  expect(await readInboxStartupPreview()).toBeNull();
  await expect(writeInboxStartupPreview('ignored')).resolves.toBeUndefined();
  mockDenied = false;
  mockWriteRejects = true;
  await expect(writeInboxStartupPreview('ignored')).resolves.toBeUndefined();
  mockWriteRejects = false;
  mockDisk = 'x'.repeat(256_001);
  expect(await readInboxStartupPreview()).toBeNull();
});
