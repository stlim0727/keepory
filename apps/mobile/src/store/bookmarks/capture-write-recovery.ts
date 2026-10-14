import type { SharedImage } from '@/domain/image-share';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import { resolveAliasedId } from '@/domain/bookmark-id-swap';
import { deleteLibraryImage } from '@/storage/image-store';
import { repository } from '@/storage/repository';
import { logStorageError } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import type { Dispatch, RefObject, SetStateAction } from 'react';

export interface CaptureWrite {
  retry: (job?: CaptureWrite) => Promise<boolean>;
  pending: Promise<boolean> | null;
  bookmark: Bookmark;
  entry?: LocalPendingBookmark;
  image?: SharedImage;
  copiedImage?: { source: string; durable: string };
  obsoleteImageUris?: string[];
  imageReplaced?: boolean;
  baseline?: Bookmark;
  mutationFields?: string[];
  realOwnerId: string | null;
  prerequisite?: CaptureWrite;
}

export async function cleanObsoleteImages(job: CaptureWrite) {
  if (!job.obsoleteImageUris?.length) return;
  const rows = await repository.listBookmarks();
  for (const uri of [...job.obsoleteImageUris]) {
    if (rows.some((row) => row.local_image_uri === uri)) continue;
    await deleteLibraryImage(uri);
    job.obsoleteImageUris = job.obsoleteImageUris.filter((value) => value !== uri);
  }
}

interface AbandonDependencies {
  attemptKey: string;
  captureWrites: RefObject<Map<string, CaptureWrite>>;
  resetEpoch: RefObject<number>;
  realOwner: RefObject<string | null>;
  idAliases: RefObject<Map<string, string>>;
  bookmarksRef: RefObject<Bookmark[] | null>;
  queueRef: RefObject<LocalPendingBookmark[]>;
  setBookmarks: Dispatch<SetStateAction<Bookmark[] | null>>;
  setQueue: Dispatch<SetStateAction<LocalPendingBookmark[]>>;
}

/** Reconcile only the failed attempt with durable state before dismissal. */
export async function abandonCaptureWrite({ attemptKey, captureWrites, resetEpoch, realOwner,
  idAliases, bookmarksRef, queueRef, setBookmarks, setQueue,
}: AbandonDependencies): Promise<boolean> {
  const job = captureWrites.current.get(attemptKey);
  if (!job) return true;
  if (job.pending) return false;
  const startedEpoch = resetEpoch.current;
  const startedOwner = realOwner.current;
  try {
    const jobs: CaptureWrite[] = [];
    for (let current: CaptureWrite | undefined = job; current; current = current.prerequisite) {
      jobs.push(current);
    }
    const jobIds = new Map(jobs.map((value) => [value, resolveAliasedId(value.bookmark.id, idAliases.current)]));
    const ids = new Set(jobIds.values());
    const liveRows = new Map((bookmarksRef.current ?? []).filter((row) => ids.has(row.id)).map((row) => [row.id, JSON.stringify(row)]));
    const liveQueue = new Map(queueRef.current.filter((entry) => ids.has(entry.local_id)).map((entry) => [entry.local_id, JSON.stringify(entry)]));
    await ensureRepositoryReady();
    const rows = await repository.listBookmarks();
    const entries = await repository.listQueue();
    if (startedEpoch !== resetEpoch.current || startedOwner !== realOwner.current || captureWrites.current.get(attemptKey) !== job) return false;
    if (jobs.some((value) => resolveAliasedId(value.bookmark.id, idAliases.current) !== jobIds.get(value))) return false;
    const unchangedRows = new Set([...ids].filter((id) => JSON.stringify(bookmarksRef.current?.find((row) => row.id === id)) === liveRows.get(id)));
    const unchangedQueue = new Set([...ids].filter((id) => JSON.stringify(queueRef.current.find((entry) => entry.local_id === id)) === liveQueue.get(id)));
    // A concurrent edit/sync needs a fresh durable read rather than an old
    // snapshot overwriting it or an undurable row surviving dismissal.
    if (unchangedRows.size !== ids.size || unchangedQueue.size !== ids.size) return false;
    const nextRows = [...(bookmarksRef.current ?? []).filter((row) => !unchangedRows.has(row.id)), ...rows.filter((row) => unchangedRows.has(row.id))];
    const nextQueue = [...queueRef.current.filter((entry) => !unchangedQueue.has(entry.local_id)), ...entries.filter((entry) => unchangedQueue.has(entry.local_id))];
    bookmarksRef.current = nextRows;
    queueRef.current = nextQueue;
    setBookmarks(nextRows);
    setQueue(nextQueue);
    captureWrites.current.delete(attemptKey);
    for (const value of jobs) {
      if (value.copiedImage) value.obsoleteImageUris = [...(value.obsoleteImageUris ?? []), value.copiedImage.durable];
      // Cleanup failure must not undo successful live-state reconciliation.
      await cleanObsoleteImages(value).catch((error) => logStorageError('abandoned image staging', error));
    }
    return true;
  } catch (error) {
    logStorageError('abandoned capture reconciliation', error);
    return false;
  }
}
