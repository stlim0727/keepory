import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookmarkApi } from '@/api/bookmarks';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import { repository } from '@/storage/repository';
import { syncQueueEntry } from './sync-bookmarks.ts';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const id = '00000000-0000-4000-8000-000000000001';
const now = '2026-10-15T00:00:00.000Z';
const bookmark = {
  id, user_id: 'user-test', url: 'https://example.com', title: 'Original',
  content_type: 'url', sync_status: 'pending', metadata_status: 'pending',
  created_at: now, updated_at: now,
} as Bookmark;

for (const operation of ['create', 'update', 'delete'] as const) {
  for (const newerOperation of ['create', 'update', 'delete'] as const) {
    test(`${operation} completion preserves newer ${newerOperation} durably`, async () => {
      Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
      await repository.init([]);
      await repository.clearAllData();
      await repository.insertBookmark(bookmark);
      const entry: LocalPendingBookmark = {
        local_id: id, remote_id: operation === 'create' ? null : id, operation,
        payload: { url: bookmark.url! }, sync_status: 'pending', retry_count: 0,
        last_error: null, created_at: now, updated_at: now,
      };
      await repository.enqueue(entry);
      let dispatch!: () => void;
      const dispatched = new Promise<void>((resolve) => { dispatch = resolve; });
      let release!: () => void;
      const response = new Promise<void>((resolve) => { release = resolve; });
      const wait = async () => { dispatch(); await response; };
      const api = {
        userId: 'user-test',
        createBookmark: async () => {
          await wait();
          return { bookmark_id: id, status: 'created', metadata_status: 'pending' };
        },
        updateBookmark: async () => { await wait(); return bookmark; },
        deleteBookmark: wait,
      } as unknown as BookmarkApi;
      const syncing = syncQueueEntry(api, repository, entry, () => bookmark);
      await dispatched;
      const newer: LocalPendingBookmark = {
        ...entry, operation: newerOperation, updated_at: '2026-10-15T00:00:01.000Z',
        payload: { url: bookmark.url!, title: 'Newer edit' },
      };
      await repository.enqueue(newer);
      release();
      await syncing;
      assert.deepEqual(await repository.listQueue(), [newer]);
      await repository.init([]);
      assert.deepEqual(await repository.listQueue(), [newer]);
    });
  }
}

test('retirement compares payload even when the timestamp is unchanged', async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  await repository.init([]);
  await repository.clearAllData();
  const entry: LocalPendingBookmark = {
    local_id: id, remote_id: null, operation: 'create', payload: { url: bookmark.url! },
    sync_status: 'pending', retry_count: 0, last_error: null, created_at: now, updated_at: now,
  };
  await repository.enqueue(entry);
  await repository.enqueue({ ...entry, payload: { ...entry.payload, title: 'Same-clock edit' } });
  assert.equal(await repository.retireQueueEntry!(entry), false);
  await repository.enqueue(entry);
  assert.equal(await repository.retireQueueEntry!(entry), true);
  assert.equal(await repository.retireQueueEntry!(entry), false);
  assert.deepEqual(await repository.listQueue(), []);
});
