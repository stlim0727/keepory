import { act, renderHook } from '@testing-library/react-native';
import { useRef, useState } from 'react';
import type { Bookmark, LocalPendingBookmark, SyncChangeSource } from '@/domain/types';
import { useAddBookmark } from '@/store/bookmarks/use-add-bookmark';
import type { AddBookmarkResult } from '@/store/bookmarks/types';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

jest.mock('@/storage/repository', () => require('./helpers/fake-repository').createFakeRepositoryModule());
jest.mock('@/storage/image-store', () => ({ copyImageToLibrary: jest.fn(async () => 'file:///durable.png'), deleteLibraryImage: jest.fn(async () => {}) }));
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
  const idAliases = { current: new Map<string, string>() };
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
      bookmarksRef, queueRef, idAliases, resetEpoch, realOwnerId: owner,
      localCreateFlushesInFlight: useRef(0), syncPendingRef: useRef(false), syncPendingForceRef: useRef(false),
      syncNowRef: useRef(null), pendingUserTitleEdits: useRef(new Set<string>()),
      enrichInBackground: () => {}, markEnrichmentStale: () => {},
      cancelCaptureEnrichment: () => {},
      hasSyncedOnce: (id) => bookmarksRef.current?.some((row) => row.id === id && row.ever_synced === true) ?? false,
      enqueueMutation,
    });
    return { ...capture, bookmarks, queue, bookmarksRef, queueRef, setBookmarks, setQueue };
  });
  return { ...hook, resetEpoch, idAliases, enqueueMutation, switchOwner: async (next: string | null) => { owner = next; await hook.rerender({}); }, hide: async () => { hidden = true; await hook.rerender({}); } };
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

it('removes an undurable optimistic capture and outbox before abandoning, retaining unrelated captures', async () => {
  const original = makeStoredBookmark();
  fake.__reset([original]);
  jest.spyOn(fake.repository, 'insertBookmark').mockRejectedValueOnce(new Error('disk full'));
  const h = await harness([original]);
  const failed = await capture(h, { capture_attempt_id: 'abandon', shared_text: 'Undurable body' });
  expect(failed.persisted).toBe(false);
  expect(h.result.current.bookmarks).toHaveLength(2);
  await act(async () => { expect(await h.result.current.abandonCapture('abandon')).toBe(true); });
  expect(h.result.current.bookmarks).toEqual([original]);
  expect(h.result.current.bookmarksRef.current).toEqual([original]);
  expect(h.result.current.queue).toEqual([]);
  expect(h.result.current.queueRef.current).toEqual([]);
});

it('retains a partially durable row and repairs its durable outbox before abandonment', async () => {
  jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness();
  expect((await capture(h, { capture_attempt_id: 'partial', shared_text: 'Durable body' })).persisted).toBe(false);
  await act(async () => { expect(await h.result.current.abandonCapture('partial')).toBe(true); });
  expect(h.result.current.bookmarks).toEqual(fake.__bookmarks());
  expect(h.result.current.bookmarks).toHaveLength(1);
  expect(h.result.current.queue).toEqual(fake.__queue());
  expect(h.result.current.queue).toHaveLength(1);
  expect(h.result.current.queue[0]).toMatchObject({ operation: 'create', payload: { shared_text: 'Durable body' } });
});

it('restores the durable duplicate baseline when abandoning a failed replacement', async () => {
  const original = makeStoredBookmark({ ever_synced: true, notes: '**Existing**', notes_format: 'markdown' });
  fake.__reset([original]);
  jest.spyOn(fake.repository, 'updateBookmark').mockRejectedValueOnce(new Error('row failed'));
  const h = await harness([original]);
  expect((await capture(h, { capture_attempt_id: 'duplicate-abandon', url: original.url!, notes: 'Undurable notes', replace_existing_notes: true })).persisted).toBe(false);
  await act(async () => { expect(await h.result.current.abandonCapture('duplicate-abandon')).toBe(true); });
  expect(h.result.current.bookmarks).toEqual([original]);
  expect(fake.__bookmarks()).toEqual([original]);
});

it('keeps partial capture recovery open when its missing durable queue cannot be repaired', async () => {
  jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness();
  const input = { capture_attempt_id: 'repair-failed', shared_text: 'Durable body' };
  const first = await capture(h, input);
  expect(first.persisted).toBe(false);
  jest.spyOn(fake.repository, 'recoverQueueEntry').mockRejectedValueOnce(new Error('repair failed'));
  await act(async () => { expect(await h.result.current.abandonCapture('repair-failed')).toBe(false); });
  const retry = await capture(h, input);
  expect(retry.persisted).toBe(true);
  expect(retry.bookmark.id).toBe(first.bookmark.id);
  expect(fake.__queue()).toHaveLength(1);
});

it('keeps the failed attempt retryable if abandonment cannot read durable state', async () => {
  jest.spyOn(fake.repository, 'insertBookmark').mockRejectedValueOnce(new Error('row failed'));
  const h = await harness();
  const input = { capture_attempt_id: 'read-failed', shared_text: 'Retained draft' };
  const first = await capture(h, input);
  jest.spyOn(fake.repository, 'listBookmarks').mockRejectedValueOnce(new Error('read failed'));
  await act(async () => { expect(await h.result.current.abandonCapture(input.capture_attempt_id)).toBe(false); });
  expect(h.result.current.bookmarks?.[0].id).toBe(first.bookmark.id);
  const retry = await capture(h, input);
  expect(retry.persisted).toBe(true);
  expect(retry.bookmark.id).toBe(first.bookmark.id);
});

it('does not overwrite a newer live operation while abandonment reads storage', async () => {
  jest.spyOn(fake.repository, 'insertBookmark').mockRejectedValueOnce(new Error('row failed'));
  const h = await harness();
  const first = await capture(h, { capture_attempt_id: 'concurrent-abandon', shared_text: 'Failed body' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  jest.spyOn(fake.repository, 'listQueue').mockImplementationOnce(async () => { await gate; return []; });
  let abandoned!: Promise<boolean>;
  await act(async () => { abandoned = h.result.current.abandonCapture('concurrent-abandon'); });
  const newer = { ...first.bookmark, description: 'Newer live edit' };
  await act(async () => { h.result.current.setBookmarks([newer]); });
  let result!: boolean;
  await act(async () => { release(); result = await abandoned; });
  expect(result).toBe(false);
  expect(h.result.current.bookmarks).toEqual([newer]);
});

it('routes URL corrections through a new capture after orphan sync already confirmed the original create', async () => {
  jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness([], 'real-a');
  const input = { capture_attempt_id: 'confirmed-create', url: 'https://example.com/original', title: 'Original subject' };
  const first = await capture(h, input);
  expect(first.persisted).toBe(false);
  const confirmed = { ...fake.__bookmarks()[0], ever_synced: true, sync_status: 'synced' as const };
  await fake.repository.updateBookmark(confirmed);
  await act(async () => { h.result.current.setBookmarks([confirmed]); });
  const corrected = await capture(h, { ...input, url: 'https://example.com/corrected', title: 'Corrected subject' });
  expect(corrected.persisted).toBe(true);
  expect(corrected.bookmark.id).not.toBe(first.bookmark.id);
  expect(fake.__bookmarks().find((row) => row.id === first.bookmark.id)).toMatchObject({ url: input.url, title: input.title, ever_synced: true });
  expect(fake.__bookmarks()).toHaveLength(2);
  expect(fake.__queue().map((entry) => entry.payload.url).sort()).toEqual([input.url, 'https://example.com/corrected'].sort());
});

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
  const images = jest.requireMock('@/storage/image-store') as { copyImageToLibrary: jest.Mock; deleteLibraryImage: jest.Mock };
  const native = jest.requireActual('@/storage/image-store.native') as typeof import('@/storage/image-store.native');
  images.copyImageToLibrary.mockImplementation(native.copyImageToLibrary);
  images.deleteLibraryImage.mockImplementation(native.deleteLibraryImage);
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
  jest.spyOn(fake.repository, 'insertBookmark').mockRejectedValueOnce(new Error('replacement row failed'));
  expect((await capture(h, replacement)).persisted).toBe(false);
  expect(mockFiles.get(oldUri)).toBe('original bytes');
  expect(fake.__bookmarks()[0].local_image_uri).toBe(oldUri);
  const stagedUri = h.result.current.bookmarks?.[0].local_image_uri!;
  expect(stagedUri).not.toBe(oldUri);
  expect(mockFiles.get(stagedUri)).toBe('replacement bytes');
  expect((await capture(h, replacement)).persisted).toBe(true);
  const newUri = fake.__bookmarks()[0].local_image_uri!;
  expect(newUri).toBe(stagedUri);
  expect(newUri).not.toBe(oldUri);
  expect(mockFiles.get(newUri)).toBe('replacement bytes');
  expect(mockFiles.has(oldUri)).toBe(false);
  images.copyImageToLibrary.mockImplementation(async () => 'file:///durable.png');
  images.deleteLibraryImage.mockImplementation(async () => {});
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
  expect(fake.__queue()[0].payload.title).toBeNull();
});

it.each([true, false])('invalidates orphan-upload confirmation only when image source changes: %s', async (replaceImage) => {
  jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness();
  const input = { capture_attempt_id: 'orphan-image', image: { uri: 'file:///first.png', mimeType: 'image/png', fileName: 'First.png' } };
  expect((await capture(h, input)).persisted).toBe(false);
  const uploaded = { ...fake.__bookmarks()[0], preview_image_url: 'https://storage.example/first.png', local_image_uploaded_for_user_id: 'real-a', ever_synced: true, sync_status: 'synced' as const };
  await fake.repository.updateBookmark(uploaded);
  await act(async () => { h.result.current.setBookmarks([uploaded]); });
  const retryInput = { ...input, notes: 'Changed caption', image: replaceImage ? { ...input.image, uri: 'file:///second.png', fileName: 'Second.png' } : input.image };
  const retry = await capture(h, retryInput);
  expect(retry.persisted).toBe(true);
  expect(fake.__bookmarks()[0].preview_image_url).toBe(replaceImage ? null : uploaded.preview_image_url);
  expect(fake.__bookmarks()[0].local_image_uploaded_for_user_id).toBe(replaceImage ? null : uploaded.local_image_uploaded_for_user_id);
  expect(fake.__bookmarks()[0].notes).toBe('Changed caption');
  expect(fake.__queue()[0].operation).toBe('create');
});

it('preserves existing duplicate description format after failed notes capture', async () => {
  const original = makeStoredBookmark({ ever_synced: true, description: '**Markdown description**', description_format: 'markdown' });
  fake.__reset([original]);
  const h = await harness([original]);
  h.enqueueMutation.mockResolvedValueOnce(false);
  const input = { capture_attempt_id: 'format-retry', url: original.url!, notes: 'Notes', replace_existing_notes: true };
  expect((await capture(h, input)).persisted).toBe(false);
  expect((await capture(h, input)).persisted).toBe(true);
  expect(fake.__bookmarks()[0].description_format).toBe('markdown');
  expect(h.enqueueMutation.mock.calls.at(-1)?.[3]).not.toContain('description_format');
});

it('retries a failed create through an adopted remote identity without resurrecting the old row', async () => {
  jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness([], 'real-a');
  const input = { capture_attempt_id: 'adopt-create', shared_text: 'Original body' };
  const first = await capture(h, input);
  expect(first.persisted).toBe(false);
  const adopted = { ...fake.__bookmarks()[0], id: 'remote-adopted-id', client_id: 'remote-client', ever_synced: true, sync_status: 'synced' as const };
  fake.__reset([adopted]);
  h.idAliases.current.set(first.bookmark.id, adopted.id);
  await act(async () => { h.result.current.setBookmarks([adopted]); h.result.current.setQueue([]); });
  const retry = await capture(h, { ...input, shared_text: 'Edited body' });
  expect(retry.persisted).toBe(true);
  expect(retry.bookmark.id).toBe(adopted.id);
  expect(fake.__bookmarks()).toHaveLength(1);
  expect(fake.__bookmarks()[0]).toMatchObject({ id: adopted.id, client_id: adopted.client_id, description: 'Edited body' });
  expect(fake.__queue()[0]).toMatchObject({ local_id: adopted.id, payload: { id: adopted.id, client_id: adopted.client_id, shared_text: 'Edited body' } });
});

it('carries a failed anonymous duplicate through a rehome alias and retains duplicate replacement rules', async () => {
  const original = makeStoredBookmark({ ever_synced: true, notes: '**Original notes**', notes_format: 'markdown', title: 'User title', title_is_derived: false });
  fake.__reset([original]);
  const h = await harness([original]);
  h.enqueueMutation.mockResolvedValueOnce(false);
  const input = { capture_attempt_id: 'carry-duplicate', url: original.url!, notes: 'Failed replacement', replace_existing_notes: true };
  expect((await capture(h, input)).persisted).toBe(false);
  const rehomed = { ...fake.__bookmarks()[0], id: 'rehomed-id', client_id: 'rehomed-client', ever_synced: false, sync_status: 'pending' as const };
  const entry: LocalPendingBookmark = { local_id: rehomed.id, remote_id: null, operation: 'create', changes: [{ source: 'account_rehome', fields: [], at: rehomed.updated_at }], payload: { id: rehomed.id, client_id: rehomed.client_id, url: rehomed.url! }, sync_status: 'pending', retry_count: 0, last_error: null, created_at: rehomed.created_at, updated_at: rehomed.updated_at };
  fake.__reset([rehomed]);
  await fake.repository.enqueue(entry);
  h.idAliases.current.set(original.id, rehomed.id);
  await h.switchOwner('real-a');
  await act(async () => { h.result.current.setBookmarks([rehomed]); h.result.current.setQueue([entry]); });
  const retry = await capture(h, { ...input, title: 'Derived hint', title_is_derived: true, notes: '', notes_format: 'plain' });
  expect(retry.persisted).toBe(true);
  expect(fake.__bookmarks()).toHaveLength(1);
  expect(fake.__bookmarks()[0]).toMatchObject({ id: rehomed.id, client_id: rehomed.client_id, title: 'User title', title_is_derived: false, notes: '**Original notes**', notes_format: 'markdown' });
  expect(fake.__queue()[0]).toMatchObject({ local_id: rehomed.id, operation: 'create', payload: { id: rehomed.id, client_id: rehomed.client_id, notes: '**Original notes**', notes_format: 'markdown' } });
});

it('refreshes the current identity after a pending image copy and preserves the latest queue identity', async () => {
  const images = jest.requireMock('@/storage/image-store') as { copyImageToLibrary: jest.Mock };
  let finish!: (uri: string) => void;
  images.copyImageToLibrary.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
  const h = await harness();
  let first!: AddBookmarkResult;
  await act(async () => { first = h.result.current.addBookmark({ capture_attempt_id: 'image-adopt', image: { uri: 'file:///image.png', fileName: 'image.png', mimeType: 'image/png' } }); });
  if (first.status === 'invalid') throw new Error(first.error);
  const acknowledgement = first.persisted;
  const remapped = { ...first.bookmark, id: 'current-image-id', client_id: 'current-image-client' };
  const entry = { ...h.result.current.queue[0], local_id: remapped.id, payload: { ...h.result.current.queue[0].payload, id: remapped.id, client_id: remapped.client_id } };
  fake.__reset([remapped]);
  h.idAliases.current.set(first.bookmark.id, remapped.id);
  await h.switchOwner('real-a');
  await act(async () => { h.result.current.setBookmarks([remapped]); h.result.current.setQueue([entry]); });
  let persisted!: boolean;
  await act(async () => { finish('file:///durable.png'); persisted = await acknowledgement; });
  expect(persisted).toBe(true);
  expect(fake.__bookmarks()).toHaveLength(1);
  expect(fake.__bookmarks()[0].id).toBe(remapped.id);
  expect(fake.__queue()[0]).toMatchObject({ local_id: remapped.id, payload: { id: remapped.id, client_id: remapped.client_id } });
  expect(h.result.current.bookmarks?.map((row) => row.id)).toEqual([remapped.id]);
});

it('binds a guest capture to its real owner so a subsequent direct real-account switch blocks retry', async () => {
  const insert = jest.spyOn(fake.repository, 'insertBookmark').mockRejectedValueOnce(new Error('row failed')).mockRejectedValueOnce(new Error('row failed'));
  const h = await harness();
  const input = { capture_attempt_id: 'owner-binding', shared_text: 'Private body' };
  expect((await capture(h, input)).persisted).toBe(false);
  await h.switchOwner('real-a');
  expect((await capture(h, input)).persisted).toBe(false);
  await h.switchOwner('real-b');
  expect((await capture(h, input)).persisted).toBe(false);
  expect(insert).toHaveBeenCalledTimes(2);
});

it('uses the replacement filename after a whole image draft replacement removes an earlier custom title', async () => {
  jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness();
  const input = { capture_attempt_id: 'replace-custom-title', title: 'Earlier custom title', image: { uri: 'file:///first.png', fileName: 'First reference.png', mimeType: 'image/png' } };
  expect((await capture(h, input)).persisted).toBe(false);
  const retry = await capture(h, { ...input, title: undefined, image: { ...input.image, uri: 'file:///second.png', fileName: 'Second reference.png' } });
  expect(retry.persisted).toBe(true);
  expect(fake.__bookmarks()[0]).toMatchObject({ title: 'Second reference', title_is_derived: undefined });
});

it('marks a cleared orphan-uploaded image caption explicitly and preserves unrelated description format', async () => {
  jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness();
  const input = { capture_attempt_id: 'caption-clear', notes: 'Original caption', image: { uri: 'file:///image.png', fileName: 'image.png', mimeType: 'image/png' } };
  expect((await capture(h, input)).persisted).toBe(false);
  const uploaded = { ...fake.__bookmarks()[0], description: '**Cloud description**', description_format: 'markdown' as const, preview_image_url: 'https://storage.example/image.png', local_image_uploaded_for_user_id: 'real-a', ever_synced: true, sync_status: 'synced' as const };
  await fake.repository.updateBookmark(uploaded);
  await act(async () => { h.result.current.setBookmarks([uploaded]); });
  expect((await capture(h, { ...input, notes: '', notes_format: 'plain', description_format: 'plain' })).persisted).toBe(true);
  expect(fake.__bookmarks()[0]).toMatchObject({ notes: null, description: '**Cloud description**', description_format: 'markdown', preview_image_url: uploaded.preview_image_url });
  expect(fake.__queue()[0].payload.notes).toBe('');
  expect(fake.__queue()[0].payload.description_format).toBe('markdown');
});

it('does not transfer a departed real owner through a server adoption alias while its row remains visible', async () => {
  jest.spyOn(fake.repository, 'enqueue').mockRejectedValueOnce(new Error('queue failed'));
  const h = await harness([], 'real-a');
  const input = { capture_attempt_id: 'adoption-owner-race', shared_text: 'Private body' };
  const first = await capture(h, input);
  expect(first.persisted).toBe(false);
  const adopted = { ...fake.__bookmarks()[0], id: 'server-owned-by-a', ever_synced: true, sync_status: 'synced' as const };
  fake.__reset([adopted]);
  h.idAliases.current.set(first.bookmark.id, adopted.id);
  await act(async () => { h.result.current.setBookmarks([adopted]); h.result.current.setQueue([]); });
  await h.switchOwner('real-b');
  expect((await capture(h, input)).persisted).toBe(false);
  expect(fake.__queue()).toEqual([]);
  expect(fake.__bookmarks()).toEqual([adopted]);
});
