import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookmarkApi } from '@/api/bookmarks';
import type { Bookmark, CreateBookmarkInput, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository } from '@/storage/types';
import { BulkCreateSupersededError, syncCreateQueueEntryBatch, syncQueueEntry } from './sync-bookmarks.ts';

function fixture() {
  const now = '2026-10-14T00:00:00.000Z';
  const entry: LocalPendingBookmark = {
    local_id: 'capture', remote_id: null, operation: 'create', payload: { id: 'capture', client_id: 'own-capture', url: 'https://example.com/' },
    sync_status: 'pending', retry_count: 0, last_error: null, created_at: now, updated_at: now,
  };
  const row: Bookmark = {
    id: entry.local_id, user_id: 'user', client_id: 'own-capture', url: entry.payload.url!, url_hash: entry.payload.url!, canonical_url: null,
    title: 'Post-capture title', notes: 'Post-capture caption', description: null, source_app: null, content_type: 'url',
    preview_image_url: null, favicon_url: null, site_name: null, collection_id: null, is_archived: false, deleted_at: null,
    created_at: now, updated_at: now, last_saved_at: now, metadata_status: 'pending', sync_status: 'pending',
  };
  let durable = JSON.stringify([entry]);
  const queue = () => JSON.parse(durable) as LocalPendingBookmark[];
  const write = (value: LocalPendingBookmark) => {
    durable = JSON.stringify([...queue().filter((item) => item.local_id !== value.local_id), value]);
  };
  let supersede = false;
  const replacement: LocalPendingBookmark = { ...entry, operation: 'delete', payload: {}, updated_at: '2026-10-14T00:00:01.000Z' };
  const repository = {
    listQueue: async () => queue(),
    updateQueueEntry: async (value: LocalPendingBookmark) => write(value),
    removeQueueEntry: async (id: string) => { durable = JSON.stringify(queue().filter((item) => item.local_id !== id)); },
    updateBookmark: async () => {},
    insertBookmark: async () => {},
    checkpointCreatePayload: async (expected: LocalPendingBookmark, payload: CreateBookmarkInput) => {
      if (supersede) write(replacement);
      const current = queue().find((item) => item.local_id === expected.local_id);
      if (!current || current.operation !== 'create' || current.updated_at !== expected.updated_at || JSON.stringify(current.payload) !== JSON.stringify(expected.payload)) return false;
      write({ ...current, payload });
      return true;
    },
  } as unknown as BookmarkRepository;
  return { entry, row, repository, queue, replacement, supersede: (operation: LocalPendingBookmark['operation']) => {
    replacement.operation = operation;
    replacement.payload = operation === 'create' ? { ...entry.payload, title: 'Newer capture' } : {};
    supersede = true;
  } };
}

for (const bulk of [false, true]) {
  test(`${bulk ? 'bulk' : 'single'} create checkpoints attempted fields across a lost response and restart before clears`, async () => {
    const f = fixture();
    let received: CreateBookmarkInput | undefined;
    let loseResponse = true;
    const create = async (payload: CreateBookmarkInput) => {
      received = payload;
      const durable = f.queue()[0];
      assert.equal(durable.payload.title, payload.title);
      assert.equal(durable.payload.notes, payload.notes);
      if (loseResponse) throw new Error('response lost after server accepted create');
      return { bookmark_id: f.row.id, status: 'duplicate' as const, metadata_status: 'pending' as const };
    };
    const api = { createBookmark: create, createBookmarks: async (payloads: CreateBookmarkInput[]) => Promise.all(payloads.map(create)) } as unknown as BookmarkApi;
    const attempt = (entry: LocalPendingBookmark) => bulk
      ? syncCreateQueueEntryBatch(api, [entry], () => f.row, undefined, f.repository)
      : syncQueueEntry(api, f.repository, entry, () => f.row);
    if (bulk) await assert.rejects(attempt(f.entry), /response lost/);
    else await attempt(f.entry);
    assert.equal(received?.title, 'Post-capture title');
    assert.equal(received?.notes, 'Post-capture caption');
    // Reload the durable outbox, rather than retaining the original snapshot.
    const restartedEntry = f.queue()[0];
    f.row.title = null; f.row.notes = null;
    loseResponse = false;
    await attempt(restartedEntry);
    assert.equal(received?.title, null);
    assert.equal(received?.notes, '');
  });

  for (const operation of ['delete', 'update', 'create'] as const) {
    test(`${bulk ? 'bulk' : 'single'} attempted create checkpoint cannot overwrite a superseding ${operation}`, async () => {
      const f = fixture();
      f.supersede(operation);
      let calls = 0;
      const api = { createBookmark: async () => { calls++; throw new Error('unexpected dispatch'); }, createBookmarks: async () => { calls++; throw new Error('unexpected dispatch'); } } as unknown as BookmarkApi;
      if (bulk) await assert.rejects(syncCreateQueueEntryBatch(api, [f.entry], () => f.row, undefined, f.repository), BulkCreateSupersededError);
      else await syncQueueEntry(api, f.repository, f.entry, () => f.row);
      assert.equal(calls, 0);
      assert.deepEqual(f.queue(), [f.replacement]);
    });
  }
}
