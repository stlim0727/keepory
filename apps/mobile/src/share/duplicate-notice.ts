import { makeUuid } from '@/domain/uuid';
import { getPreference, setPreference } from '@/storage/preferences';

export const DUPLICATE_SHARE_NOTICE_KEY = 'pref.share.duplicateNotice';

export interface DuplicateShareNotice {
  id: string;
  bookmarkId: string;
}

const listeners = new Set<(notice: DuplicateShareNotice | null) => void>();
let operations: Promise<unknown> = Promise.resolve();
let latest: DuplicateShareNotice | null = null;

// Serialize hydration, new notices and dismissal. Closing an old ribbon must
// never erase a newer share that arrived while a preference write was pending.
function enqueue(operation: () => Promise<void>): Promise<void> {
  const next = operations.then(operation).catch(() => {
    // Confirmation bookkeeping must never break capture or dismissal.
  });
  operations = next;
  return next;
}

function parse(raw: string | null): DuplicateShareNotice | null {
  try {
    const value = JSON.parse(raw ?? 'null');
    return typeof value?.id === 'string' && value.id &&
      typeof value?.bookmarkId === 'string' && value.bookmarkId
      ? { id: value.id, bookmarkId: value.bookmarkId }
      : null;
  } catch {
    return null;
  }
}

function publish(notice: DuplicateShareNotice | null) {
  latest = notice;
  listeners.forEach((listener) => listener(notice));
}

export function subscribeDuplicateShareNotice(listener: (notice: DuplicateShareNotice | null) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function refreshDuplicateShareNotice(): Promise<void> {
  return enqueue(async () => {
    publish(parse(await getPreference(DUPLICATE_SHARE_NOTICE_KEY)));
  });
}

export function recordDuplicateShareNotice(bookmarkId: string): Promise<void> {
  const notice = { id: makeUuid(), bookmarkId };
  return enqueue(async () => {
    try {
      await setPreference(DUPLICATE_SHARE_NOTICE_KEY, JSON.stringify(notice));
    } finally {
      // Even a failed preference write can still confirm the current session.
      publish(notice);
    }
  });
}

export function dismissDuplicateShareNotice(id: string): Promise<void> {
  return enqueue(async () => {
    if (latest?.id !== id) return;
    try {
      await setPreference(DUPLICATE_SHARE_NOTICE_KEY, '');
    } finally {
      publish(null);
    }
  });
}
