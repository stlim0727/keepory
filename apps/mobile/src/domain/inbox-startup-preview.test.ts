import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInboxStartupPreview, STARTUP_PREVIEW_LIMIT, STARTUP_PREVIEW_MAX_BYTES } from '@/domain/inbox-startup-preview';

const row = {
  id: 'bookmark-1', title: 'Cached title', url: 'https://example.com',
  content_type: 'url', created_at: '2026-10-12', updated_at: '2026-10-12',
  is_archived: false, deleted_at: null,
};
const snapshot = {
  version: 1, userId: 'user-1', isAnonymous: false,
  viewMode: 'list', sort: { field: 'date', dir: 'desc' },
  totalCount: 100, bookmarks: [row], tags: {}, collections: [],
};

test('accepts a bounded preview while preserving the full library count', () => {
  assert.deepEqual(parseInboxStartupPreview(JSON.stringify(snapshot)), snapshot);
});

test('rejects malformed, incompatible, oversized, or unsafe display snapshots', () => {
  const invalid = [
    null, '{invalid', JSON.stringify(null), JSON.stringify({}),
    JSON.stringify({ ...snapshot, version: 2 }),
    JSON.stringify({ ...snapshot, userId: '' }),
    JSON.stringify({ ...snapshot, sort: { field: 'unknown', dir: 'desc' } }),
    JSON.stringify({ ...snapshot, viewMode: 'folder' }),
    JSON.stringify({ ...snapshot, totalCount: 0 }),
    JSON.stringify({ ...snapshot, bookmarks: Array(STARTUP_PREVIEW_LIMIT + 1).fill(row) }),
    JSON.stringify({ ...snapshot, bookmarks: [{ ...row, deleted_at: '2026-10-12' }] }),
    JSON.stringify({ ...snapshot, bookmarks: [{ ...row, title: {} }] }),
    JSON.stringify({ ...snapshot, tags: { 'bookmark-1': [null] } }),
    JSON.stringify({ ...snapshot, collections: [{ id: 'folder-1' }] }),
    ' '.repeat(STARTUP_PREVIEW_MAX_BYTES + 1),
  ];
  for (const raw of invalid) assert.equal(parseInboxStartupPreview(raw), null);
});
