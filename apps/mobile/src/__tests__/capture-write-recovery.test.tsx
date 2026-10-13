import { act, renderHook } from '@testing-library/react-native';
import { useRef, useState } from 'react';
import type { Bookmark, LocalPendingBookmark, SyncChangeSource } from '@/domain/types';
import { useAddBookmark } from '@/store/bookmarks/use-add-bookmark';
import type { AddBookmarkResult } from '@/store/bookmarks/types';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

jest.mock('@/storage/repository', () => require('./helpers/fake-repository').createFakeRepositoryModule());
jest.mock('@/storage/image-store', () => ({ copyImageToLibrary: jest.fn(async () => 'file:///durable.png') }));
const mockFiles = new Map<string, string>();
const mockCopyFailures = new Set<string>();
jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///documents' }, UploadType: { BINARY_CONTENT: 0 },
  Directory: class {
    uri: string;
    exists = true;
    constructor(parent: string, name: string) { this.uri = `${parent}/${name}`; }
    create() {}
  },
  File: class {
    uri: string;
    constructor(parent: string | { uri: string }, name?: string) {
      this.uri = name ? `${typeof parent === 'string' ? parent : parent.uri}/${name}` : parent as string;
    }
    get exists() { return mockFiles.has(this.uri); }
    delete() { mockFiles.delete(this.uri); }
    copy(destination: { uri: string }) {
      if (mockCopyFailures.has(this.uri)) throw new Error('copy failed');
      const bytes = mockFiles.get(this.uri);
      if (bytes === undefined) throw new Error('source missing');
      mockFiles.set(destination.uri, bytes);
    }
  },
}));
const fake = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

async function harness(rows: Bookmark[] = [], owner: string | null = null) {
  const resetEpoch = { current: 0 };
  const enqueueMutation = jest.fn<Promise<boolean>, [string, 'update' | 'delete', SyncChangeSource?, string[]?]>(async () => true);
  let hidden = false;
  const hook = await renderHook(() => {
    const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(rows);
    const [queue, setQueue] = useState<LocalPendingBookmark[]>([]);
    const bookmarksRef = useRef<Bookmark[] | null>(bookmarks);
    const queueRef = useRef(queue);
    bookmarksRef.current = bookmarks;
    queueRef.current = queue;
    const capture = useAddBookmark({
      hideAccountCache: hidden, loadedBookmarks: bookmarks ?? [], setBookmarks, setQueue,
      bookmarksRef, queueRef, resetEpoch, realOwnerId: owner,
      localCreateFlushesInFlight: useRef(0), syncPendingRef: useRef(false), syncPendingForceRef: useRef(false),
      syncNowRef: useRef(null), pendingUserTitleEdits: useRef(new Set<string>()),
      enrichInBackground: () => {}, markEnrichmentStale: () => {},
      hasSyncedOnce: (id) => rows.some((row) => row.id === id && row.ever_synced === true),
      enqueueMutation,
    });
    return { ...capture, bookmarks, queue, bookmarksRef, queueRef, setBookmarks, setQueue };
  });
  return { ...hook, resetEpoch, enqueueMutation, switchOwner: async (next: string | null) => { owner = next; await hook.rerender({}); }, hide: async () => { hidden = true; await hook.rerender({}); } };
}

async function capture(h: Awaited<ReturnType<typeof harness>>, input: Parameters<ReturnType<typeof useAddBookmark>['addBookmark']>[0]) {
  let saved!: AddBookmarkResult;
  await act(async () => { saved = h.result.current.addBookmark(input); });
  if (saved.status === 'invalid') throw new Error(saved.error);
  const acknowledgement = saved.persisted;
  let persisted!: boolean;
  await act(async () => { persisted = await acknowledgement; });
  return { ...saved, persisted };
}

beforeEach(() => { jest.restoreAllMocks(); jest.spyOn(console, 'warn').mockImplementation(() => {}); fake.__reset([]); });

it('restores a missing optimistic create and queue with the same capture identity after failure', async () => {
  const insert = jest.spyOn(fake.repository, 'insertBookmark').mockRejectedValueOnce(new Error('disk full'));
  const h = await harness();
  const input = { capture_attempt_id: 'capture-a', shared_text: 'Original note' };
  const first = await capture(h, input);
  expect(first.persisted).toBe(false);
  await act(async () => { h.result.current.setBookmarks([]); h.result.current.setQueue([]); });
  const retry = await capture(h, { ...input, shared_text: 'Edited note' });
  expect(retry.persisted).toBe(true);
  expect(retry.bookmark.id).toBe(first.bookmark.id);
  expect(fake.__bookmarks()).toHaveLength(1);
  expect(fake.__bookmarks()[0].description).toBe('Edited note');
  expect(h.result.current.bookmarksRef.current?.[0].id).toBe(first.bookmark.id);
  expect(h.result.current.queueRef.current[0].local_id).toBe(first.bookmark.id);
  expect(fake.__queue()[0].payload.shared_text).toBe('Edited note');
  expect(insert).toHaveBeenCalledTimes(2);
});

it('retains existing Markdown notes and title provenance when failed replacement is cleared', async () => {
  const original = makeStoredBookmark({ notes: '**Existing**', notes_format: 'markdown', title: 'User title', title_is_derived: false, ever_synced: true });
  fake.__reset([original]);
  jest.spyOn(fake.repository, 'updateBookmark').mockRejectedValueOnce(new Error('disk full'));
  const h = await harness([original]);
  const input = { capture_attempt_id: 'duplicate', url: original.url!, notes: 'Failed replacement', title: 'Failed title', replace_existing_notes: true };
  expect((await capture(h, input)).persisted).toBe(false);
  expect(h.enqueueMutation).not.toHaveBeenCalled();
  expect((await capture(h, { ...input, title: '', notes: '', notes_format: 'plain' })).persisted).toBe(true);
  expect(fake.__bookmarks()[0]).toMatchObject({ notes: '**Existing**', notes_format: 'markdown', title: 'User title', title_is_derived: false });
});

it('waits for row persistence before queueing and retries failed queue acknowledgement', async () => {
  const original = makeStoredBookmark({ ever_synced: true });
  fake.__reset([original]);
  const events: string[] = [];
  const update = fake.repository.updateBookmark;
  jest.spyOn(fake.repository, 'updateBookmark').mockImplementation(async (row) => { events.push('row'); await update(row); });
  const h = await harness([original]);
  h.enqueueMutation.mockImplementationOnce(async () => { events.push('queue-failed'); return false; });
  h.enqueueMutation.mockImplementationOnce(async () => { events.push('queue'); return true; });
  const input = { capture_attempt_id: 'duplicate', url: original.url!, notes: 'Changed', replace_existing_notes: true };
  expect((await capture(h, input)).persisted).toBe(false);
  expect((await capture(h, input)).persisted).toBe(true);
  expect(events).toEqual(['row', 'queue-failed', 'row', 'queue']);
  expect(h.enqueueMutation.mock.calls[1][3]).toContain('notes');
});

it('never resurrects a pre-reset failed capture', async () => {
  jest.spyOn(fake.repository, 'insertBookmark').mockRejectedValueOnce(new Error('disk full'));
  const h = await harness();
  const input = { capture_attempt_id: 'reset-capture', shared_text: 'Note' };
  const first = await capture(h, input);
  await act(async () => { h.resetEpoch.current++; h.result.current.setBookmarks([]); h.result.current.setQueue([]); });
  const next = await capture(h, input);
  expect(next.bookmark.id).not.toBe(first.bookmark.id);
});

it.each([[null, 'real-a'], ['real-a', null]] as const)('preserves failed local capture through owner transition %s to %s', async (from, to) => {
  jest.spyOn(fake.repository, 'insertBookmark').mockRejectedValueOnce(new Error('disk full'));
  const h = await harness([], from);
  const input = { capture_attempt_id: 'owner-capture', shared_text: 'Note' };
  const first = await capture(h, input);
  await h.switchOwner(to);
  await act(async () => { h.result.current.setBookmarks([]); h.result.current.setQueue([]); });
  const retry = await capture(h, input);
  expect(retry.persisted).toBe(true);
  expect(retry.bookmark.id).toBe(first.bookmark.id);
});

it('blocks a failed real-account capture after switching to a different real account', async () => {
  const insert = jest.spyOn(fake.repository, 'insertBookmark').mockRejectedValueOnce(new Error('disk full'));
  const h = await harness([], 'real-a');
  const input = { capture_attempt_id: 'owner-capture', shared_text: 'Private note' };
  const first = await capture(h, input);
  await h.switchOwner('real-b');
  await act(async () => { h.result.current.setBookmarks([]); h.result.current.setQueue([]); });
  const retry = await capture(h, input);
  expect(retry.persisted).toBe(false);
  expect(retry.bookmark.id).toBe(first.bookmark.id);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(h.result.current.bookmarks).toEqual([]);
});

it('blocks a late image write after real-account ownership changes', async () => {
  const images = jest.requireMock('@/storage/image-store') as { copyImageToLibrary: jest.Mock };
  let completeCopy!: (uri: string) => void;
  images.copyImageToLibrary.mockImplementationOnce(() => new Promise<string>((resolve) => { completeCopy = resolve; }));
  const insert = jest.spyOn(fake.repository, 'insertBookmark');
  const h = await harness([], 'real-a');
  let saving!: AddBookmarkResult;
  await act(async () => { saving = h.result.current.addBookmark({ capture_attempt_id: 'late-image', image: { uri: 'file:///image.png', mimeType: 'image/png', fileName: 'image.png' } }); });
  await h.switchOwner('real-b');
  await act(async () => { h.result.current.setBookmarks([]); h.result.current.setQueue([]); });
  let persisted!: boolean;
  await act(async () => { completeCopy('file:///durable.png'); if (saving.status !== 'invalid') persisted = await saving.persisted; });
  expect(persisted).toBe(false);
  expect(insert).not.toHaveBeenCalled();
  expect(fake.__queue()).toEqual([]);
  expect(h.result.current.bookmarks).toEqual([]);
});

it('does not resurrect discarded account-owned duplicate rows', async () => {
  const original = makeStoredBookmark({ ever_synced: true });
  fake.__reset([original]);
  const update = jest.spyOn(fake.repository, 'updateBookmark').mockRejectedValueOnce(new Error('disk full'));
  const h = await harness([original], 'real-a');
  const input = { capture_attempt_id: 'owned-duplicate', url: original.url!, notes: 'Changed', replace_existing_notes: true };
  expect((await capture(h, input)).persisted).toBe(false);
  await h.hide();
  await act(async () => { h.result.current.setBookmarks([]); });
  expect((await capture(h, input)).persisted).toBe(false);
  expect(update).toHaveBeenCalledTimes(1);
  expect(h.result.current.bookmarks).toEqual([]);
});

it('finishes the original duplicate outbox before persisting a changed retry URL', async () => {
  const original = makeStoredBookmark({ ever_synced: true });
  fake.__reset([original]);
  const events: string[] = [];
  const insert = fake.repository.insertBookmark;
  jest.spyOn(fake.repository, 'insertBookmark').mockImplementation(async (row) => { events.push('new-row'); await insert(row); });
  const h = await harness([original]);
  h.enqueueMutation.mockImplementationOnce(async () => { events.push('old-queue-failed'); return false; });
  h.enqueueMutation.mockImplementationOnce(async () => { events.push('old-queue'); return true; });
  const input = { capture_attempt_id: 'changed-url', url: original.url!, notes: 'Original edit', replace_existing_notes: true };
  expect((await capture(h, input)).persisted).toBe(false);
  const next = await capture(h, { ...input, url: 'https://new.example/path', notes: 'New URL notes' });
  expect(next.persisted).toBe(true);
  expect(next.bookmark.id).not.toBe(original.id);
  expect(events).toEqual(['old-queue-failed', 'old-queue', 'new-row']);
  expect(fake.__bookmarks().find((row) => row.id === original.id)?.notes).toBe('Original edit');
  expect(fake.__queue()[0].local_id).toBe(next.bookmark.id);
});

it('keeps a failed original outbox as a prerequisite across changed-URL retries', async () => {
  const original = makeStoredBookmark({ ever_synced: true });
  fake.__reset([original]);
  const insert = jest.spyOn(fake.repository, 'insertBookmark');
  const h = await harness([original]);
  h.enqueueMutation.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const input = { capture_attempt_id: 'changed-url', url: original.url!, notes: 'Original edit', replace_existing_notes: true };
  expect((await capture(h, input)).persisted).toBe(false);
  const newInput = { ...input, url: 'https://new.example/path' };
  const failed = await capture(h, newInput);
  expect(failed.persisted).toBe(false);
  expect(insert).not.toHaveBeenCalled();
  const retry = await capture(h, newInput);
  expect(retry.persisted).toBe(true);
  expect(retry.bookmark.id).toBe(failed.bookmark.id);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(h.enqueueMutation).toHaveBeenCalledTimes(3);
});

it('preserves old durable image bytes if a replacement copy fails after enqueue failure', async () => {
  mockFiles.clear(); mockCopyFailures.clear();
  mockFiles.set('file:///first.png', 'original bytes');
  mockFiles.set('file:///replacement.png', 'replacement bytes');
  const images = jest.requireMock('@/storage/image-store') as { copyImageToLibrary: jest.Mock };
  const native = jest.requireActual('@/storage/image-store.native') as typeof import('@/storage/image-store.native');
  images.copyImageToLibrary.mockImplementation(native.copyImageToLibrary);
  jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness();
  const input = { capture_attempt_id: 'replacement', image: { uri: 'file:///first.png', mimeType: 'image/png', fileName: 'first.png' } };
  const first = await capture(h, input);
  expect(first.persisted).toBe(false);
  const oldUri = fake.__bookmarks()[0].local_image_uri!;
  expect(mockFiles.get(oldUri)).toBe('original bytes');
  mockCopyFailures.add('file:///replacement.png');
  const replacement = { ...input, image: { ...input.image, uri: 'file:///replacement.png' } };
  expect((await capture(h, replacement)).persisted).toBe(false);
  expect(mockFiles.get(oldUri)).toBe('original bytes');
  expect(fake.__bookmarks()[0].local_image_uri).toBe(oldUri);
  mockCopyFailures.clear();
  expect((await capture(h, replacement)).persisted).toBe(true);
  const newUri = fake.__bookmarks()[0].local_image_uri!;
  expect(newUri).not.toBe(oldUri);
  expect(mockFiles.get(newUri)).toBe('replacement bytes');
  expect(mockFiles.get(oldUri)).toBe('original bytes');
  images.copyImageToLibrary.mockImplementation(async () => 'file:///durable.png');
});

it.each(['row', 'queue'])('reuses the failed duplicate job for tracking URL edits after %s failure', async (failure) => {
  const original = makeStoredBookmark({ ever_synced: true, title: 'User title', title_is_derived: false, notes: '**Existing**', notes_format: 'markdown' });
  fake.__reset([original]);
  const h = await harness([original]);
  if (failure === 'row') jest.spyOn(fake.repository, 'updateBookmark').mockRejectedValueOnce(new Error('row failed'));
  else h.enqueueMutation.mockResolvedValueOnce(false);
  const input = { capture_attempt_id: 'tracking-retry', url: original.url!, notes: 'New notes', replace_existing_notes: true };
  expect((await capture(h, input)).persisted).toBe(false);
  const retry = await capture(h, { ...input, url: `${original.url}?utm_source=shared`, title: 'Derived source hint', title_is_derived: true });
  expect(retry.persisted).toBe(true);
  expect(retry.bookmark.id).toBe(original.id);
  expect(fake.__bookmarks()).toHaveLength(1);
  expect(fake.__bookmarks()[0]).toMatchObject({ url: original.url, notes: 'New notes', title: 'User title', title_is_derived: false });
  expect(h.enqueueMutation.mock.calls.at(-1)?.[3]).toContain('notes');
});

it('restores the original duplicate baseline when tracking URL retry clears failed replacement', async () => {
  const original = makeStoredBookmark({ ever_synced: true, title: 'User title', title_is_derived: false, notes: '**Existing**', notes_format: 'markdown' });
  fake.__reset([original]);
  const h = await harness([original]);
  h.enqueueMutation.mockResolvedValueOnce(false);
  const input = { capture_attempt_id: 'tracking-retry', url: original.url!, notes: 'Failed notes', title: 'Failed title', replace_existing_notes: true };
  expect((await capture(h, input)).persisted).toBe(false);
  const retry = await capture(h, { ...input, url: `${original.url}?utm_source=shared`, title: '', notes: '', notes_format: 'plain' });
  expect(retry.persisted).toBe(true);
  expect(fake.__bookmarks()[0]).toMatchObject({ url: original.url, notes: '**Existing**', notes_format: 'markdown', title: 'User title', title_is_derived: false });
  expect(h.enqueueMutation.mock.calls.at(-1)?.[3]).toContain('notes');
});

it.each(['row', 'queue'])('preserves filename-derived image title on unchanged undefined-title retry after %s failure', async (failure) => {
  if (failure === 'row') jest.spyOn(fake.repository, 'insertBookmark').mockRejectedValueOnce(new Error('row failed'));
  else jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness();
  const input = { capture_attempt_id: 'image-title', image: { uri: 'file:///design.png', mimeType: 'image/png', fileName: 'Design reference.png' } };
  const first = await capture(h, input);
  expect(first.persisted).toBe(false);
  const retry = await capture(h, input);
  expect(retry.persisted).toBe(true);
  expect(fake.__bookmarks()[0].title).toBe(first.bookmark.title);
  expect(fake.__bookmarks()[0].title_is_derived).toBe(first.bookmark.title_is_derived);
  expect(fake.__queue()[0].payload.title).toBe(first.bookmark.title);
});

it('derives a replacement image title from its filename and honors an explicit empty title', async () => {
  jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed')).mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness();
  const input = { capture_attempt_id: 'image-title', image: { uri: 'file:///first.png', mimeType: 'image/png', fileName: 'First reference.png' } };
  expect((await capture(h, input)).persisted).toBe(false);
  const replacement = { ...input, image: { ...input.image, uri: 'file:///second.png', fileName: 'Second reference.png' } };
  const second = await capture(h, replacement);
  expect(second.persisted).toBe(false);
  expect(fake.__bookmarks()[0].title).toBe('Second reference');
  const cleared = await capture(h, { ...replacement, title: '' });
  expect(cleared.persisted).toBe(true);
  expect(fake.__bookmarks()[0].title).toBeNull();
  expect(fake.__queue()[0].payload.title).toBeUndefined();
});
