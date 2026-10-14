import {
  imageTitleFromFileName,
  localImageFileName,
  type SharedImage
} from "@/domain/image-share";
import { mockUserId } from "@/domain/mock-data";
import { resolveAliasedId } from '@/domain/bookmark-id-swap';
import { changedSyncFields } from "@/domain/sync-changes";
import type {
  Bookmark,
  LocalPendingBookmark,
  SyncChangeSource, TextFormat
} from "@/domain/types";
import { isRepairableSourceTitle } from "@/domain/url-title";
import { canonicalizeUrl, isUrlTooLong, normalizeUrl } from "@/domain/urls";
import {
  copyImageToLibrary
} from "@/storage/image-store";
import { repository } from "@/storage/repository";
import { currentDedupeKey, isActiveBookmark, isBookmarkSyncedOnce, logStorageError, makeBookmarkId, makeClientId } from '@/store/bookmarks/helpers';
import { abandonCaptureWrite, cleanObsoleteImages, type CaptureWrite } from '@/store/bookmarks/capture-write-recovery';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { type AddBookmarkResult } from '@/store/bookmarks/types';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback, useRef
} from "react";


interface Dependencies {
  hideAccountCache: boolean;
  loadedBookmarks: Bookmark[];
  setBookmarks: Dispatch<SetStateAction<Bookmark[] | null>>;
  setQueue: Dispatch<SetStateAction<LocalPendingBookmark[]>>;
  localCreateFlushesInFlight: RefObject<number>;
  syncPendingRef: RefObject<boolean>;
  syncPendingForceRef: RefObject<boolean>;
  syncNowRef: RefObject<((options?: { force?: boolean; }) => Promise<boolean>) | null>;
  enrichInBackground: (bookmark: Bookmark) => void;
  hasSyncedOnce: (bookmarkId: string) => boolean;
  bookmarksRef: RefObject<Bookmark[] | null>;
  queueRef: RefObject<LocalPendingBookmark[]>;
  idAliases: RefObject<Map<string, string>>;
  resetEpoch: RefObject<number>;
  realOwnerId: string | null;
  pendingUserTitleEdits: RefObject<Set<string>>;
  markEnrichmentStale: (bookmarkId: string) => void;
  enqueueMutation: (bookmarkId: string, operation: "update" | "delete", source?: SyncChangeSource, fields?: string[]) => Promise<boolean>;
}

export function useAddBookmark({
  hideAccountCache,
  loadedBookmarks,
  setBookmarks,
  setQueue,
  localCreateFlushesInFlight,
  syncPendingRef,
  syncPendingForceRef,
  syncNowRef,
  enrichInBackground,
  hasSyncedOnce,
  bookmarksRef,
  queueRef,
  idAliases,
  resetEpoch,
  realOwnerId,
  pendingUserTitleEdits,
  markEnrichmentStale,
  enqueueMutation,
}: Dependencies) {
  // Replay the same durable operation after a failed acknowledgement. An optimistic
  // row is not evidence that its image, bookmark row, and queue were committed.
  const captureWrites = useRef(new Map<string, CaptureWrite>());
  const hiddenCache = useRef(hideAccountCache);
  hiddenCache.current = hideAccountCache;
  const realOwner = useRef(realOwnerId);
  realOwner.current = realOwnerId;
  const epoch = useRef(resetEpoch.current);
  if (epoch.current !== resetEpoch.current) {
    captureWrites.current.clear();
    epoch.current = resetEpoch.current;
  }
  const refreshCaptureIdentity = (job: CaptureWrite) => {
    if (job.prerequisite) refreshCaptureIdentity(job.prerequisite);
    const id = resolveAliasedId(job.bookmark.id, idAliases.current);
    if (id === job.bookmark.id) {
      const live = bookmarksRef.current?.find((row) => row.id === id);
      if (live) job.bookmark = {
        ...job.bookmark, sync_status: live.sync_status,
        ever_synced: live.ever_synced ?? job.bookmark.ever_synced,
        collection_id: live.collection_id, deleted_at: live.deleted_at,
      };
      if (job.realOwnerId === null && realOwner.current !== null) job.realOwnerId = realOwner.current;
      return;
    }
    const live = bookmarksRef.current?.find((row) => row.id === id);
    if (!live) throw new Error('Capture identity is no longer available.');
    const currentEntry = queueRef.current.find((entry) => entry.local_id === id);
    job.bookmark = {
      ...live, ...job.bookmark,
      id, user_id: live.user_id, client_id: live.client_id,
      collection_id: live.collection_id, sync_status: live.sync_status, ever_synced: live.ever_synced,
      preview_image_url: job.imageReplaced ? null : live.preview_image_url,
      local_image_uploaded_for_user_id: job.imageReplaced ? null : live.local_image_uploaded_for_user_id,
    };
    const entry = job.entry ?? (currentEntry?.operation === 'create' ? currentEntry : undefined);
    if (entry) {
      job.entry = {
        ...entry, local_id: id, remote_id: entry.operation === 'create' ? null : id,
        payload: { ...entry.payload, id, client_id: live.client_id ?? undefined },
      };
    }
    // An adoption alias alone does not transfer account ownership. Only an
    // explicit account rehome may rebind a capture from a prior real owner.
    if (job.realOwnerId === null || currentEntry?.changes?.some((change) => change.source === 'account_rehome')) {
      job.realOwnerId = realOwner.current;
    }
  };
  const runCaptureWrite = (job: CaptureWrite): Promise<boolean> => {
    if (job.pending) return job.pending;
    job.pending = (async () => {
      if (job.prerequisite) {
        if (!await runCaptureWrite(job.prerequisite)) return false;
        job.prerequisite = undefined;
      }
      return job.retry(job);
    })().then((ok) => { job.pending = null; return ok; });
    return job.pending;
  };
  const startCaptureWrite = (
    key: string | undefined, retry: CaptureWrite['retry'], bookmark: Bookmark,
    entry?: LocalPendingBookmark, image?: SharedImage, baseline?: Bookmark, mutationFields?: string[],
  ) => {
    if (!key) return retry();
    const previous = captureWrites.current.get(key);
    const sameRow = previous?.bookmark.id === bookmark.id;
    const job: CaptureWrite = { retry, bookmark, entry, image, baseline: baseline ?? (sameRow ? previous?.baseline : undefined),
      mutationFields: mutationFields ?? previous?.mutationFields,
      realOwnerId: previous ? previous.realOwnerId : realOwner.current,
      copiedImage: sameRow ? previous?.copiedImage : undefined,
      obsoleteImageUris: sameRow ? previous?.obsoleteImageUris : undefined,
      imageReplaced: sameRow ? previous?.imageReplaced : undefined,
      prerequisite: sameRow ? previous?.prerequisite : previous,
      pending: null };
    captureWrites.current.set(key, job);
    const pending = runCaptureWrite(job).then((ok) => {
      if (ok && captureWrites.current.get(key) === job) captureWrites.current.delete(key);
      return ok;
    });
    return pending;
  };

  const abandonCapture = (attemptKey: string) => abandonCaptureWrite({
    attemptKey, captureWrites, resetEpoch, realOwner,
    idAliases, bookmarksRef, queueRef, setBookmarks, setQueue,
  });

  const addBookmark = useCallback(
    ({
      url,
      title,
      title_is_derived = false,
      notes,
      replace_existing_notes = false,
      capture_client_id,
      capture_attempt_id,
      description_format = "plain",
      notes_format = "plain",
      shared_text,
      image,
    }: {
      url?: string;
      title?: string;
      title_is_derived?: boolean;
      notes?: string;
      replace_existing_notes?: boolean;
      capture_client_id?: string;
      capture_attempt_id?: string;
      description_format?: TextFormat;
      notes_format?: TextFormat;
      shared_text?: string;
      image?: SharedImage;
    }): AddBookmarkResult => {
      if (epoch.current !== resetEpoch.current) {
        captureWrites.current.clear();
        epoch.current = resetEpoch.current;
      }
      const attemptKey = capture_attempt_id ?? capture_client_id;
      const epochAtStart = resetEpoch.current;
      const ownerAtStart = realOwner.current;
      const assertOwnership = (job?: CaptureWrite) => {
        if (job) refreshCaptureIdentity(job);
        const row = job?.bookmark;
        const jobOwner = job ? job.realOwnerId : ownerAtStart;
        if (resetEpoch.current !== epochAtStart || (jobOwner && realOwner.current && jobOwner !== realOwner.current) || (row && isBookmarkSyncedOnce(row) &&
          (hiddenCache.current || !bookmarksRef.current?.some((value) => value.id === row.id)))) {
          throw new Error('Capture ownership changed.');
        }
      };
      const candidateJob = attemptKey ? captureWrites.current.get(attemptKey) : undefined;
      if (candidateJob) {
        try { refreshCaptureIdentity(candidateJob); }
        catch { return { status: 'duplicate', bookmark: candidateJob.bookmark, persisted: Promise.resolve(false) }; }
      }
      if (candidateJob && ((candidateJob.realOwnerId && realOwner.current && candidateJob.realOwnerId !== realOwner.current) ||
        (isBookmarkSyncedOnce(candidateJob.bookmark) && (hideAccountCache || !bookmarksRef.current?.some((row) => row.id === candidateJob.bookmark.id))))) {
        return { status: "duplicate", bookmark: candidateJob.bookmark, persisted: Promise.resolve(false) };
      }
      const incomplete = candidateJob;
      const captureBookmarks = hideAccountCache
        ? loadedBookmarks.filter((row) => !isBookmarkSyncedOnce(row))
        : loadedBookmarks;
      // Changing the URL after a failed duplicate update starts a different
      // bookmark; it must never change the existing bookmark's address.
      const changedDuplicateUrl = capture_attempt_id !== undefined && incomplete &&
        (incomplete.baseline || isBookmarkSyncedOnce(captureBookmarks.find((row) => row.id === incomplete.bookmark.id) ?? incomplete.bookmark)) &&
        url !== undefined && normalizeUrl(url) !== incomplete.bookmark.url &&
        currentDedupeKey(incomplete.bookmark) !== canonicalizeUrl(normalizeUrl(url) ?? url);
      const replayedCapture = changedDuplicateUrl ? undefined : incomplete
        ? captureBookmarks.find((row) => row.id === incomplete.bookmark.id) ?? incomplete.bookmark
        : attemptKey ? captureBookmarks.find(
          // Capture ids are idempotency keys, unlike content URLs: a replay
          // must find its original row even if the user trashed it after an
          // acknowledgement failure. Creating another row would later
          // conflict with the cloud's all-rows client_id uniqueness too.
          (bookmark) => bookmark.client_id === attemptKey,
        )
        : undefined;
      if (replayedCapture) {
        const job = attemptKey ? captureWrites.current.get(attemptKey) : undefined;
        if (!job || job.pending) {
          return { status: "duplicate", bookmark: replayedCapture, persisted: job?.pending ?? Promise.resolve(true) };
        }
        // A failed draft remains one capture even after editing. Update the row
        // AND its required create payload before retrying the durable operation.
        const requestedRetry = url === undefined ? replayedCapture.url : normalizeUrl(url);
        if (url !== undefined && (!requestedRetry || isUrlTooLong(canonicalizeUrl(requestedRetry)))) {
          return { status: "invalid", error: "This web address cannot be saved." };
        }
        // Canonical-equivalent duplicate input may update the draft details,
        // but must retain the existing bookmark's original address.
        const isCreateDraft = Boolean(job.entry && !job.baseline);
        const normalizedRetry = isCreateDraft && !isBookmarkSyncedOnce(replayedCapture) ? requestedRetry : replayedCapture.url;
        const hasDraft = capture_attempt_id !== undefined &&
          (image !== undefined || url !== undefined || shared_text !== undefined);
        const baseline = job.baseline ?? replayedCapture;
        const isRepairable = isRepairableSourceTitle(baseline);
        const improveTitle = Boolean(title?.trim()) && (!title_is_derived || baseline.title == null || baseline.title_is_derived === true || isRepairable);
        const improveNotes = Boolean(notes?.trim()) && (replace_existing_notes || !baseline.notes);
        const imageChanged = image !== undefined && image.uri !== job.image?.uri;
        if (imageChanged) job.imageReplaced = true;
        const imageTitle = title !== undefined ? title.trim() || null
          : imageChanged ? imageTitleFromFileName(image?.fileName)
          : replayedCapture.title;
        const imageTitleDerived = title !== undefined ? (title.trim() ? title_is_derived : undefined)
          : imageChanged ? undefined : replayedCapture.title_is_derived;
        const updated: Bookmark = hasDraft ? {
          ...replayedCapture,
          title: isCreateDraft ? replayedCapture.content_type === 'image' ? imageTitle : title?.trim() || null : improveTitle ? title!.trim() : baseline.title,
          title_is_derived: isCreateDraft ? replayedCapture.content_type === 'image' ? imageTitleDerived : (title?.trim() ? title_is_derived : undefined) : improveTitle ? title_is_derived : isRepairable ? true : baseline.title_is_derived,
          notes: isCreateDraft ? (notes || null) : improveNotes ? notes! : baseline.notes,
          notes_format: isCreateDraft || improveNotes ? notes_format : baseline.notes_format,
          description: replayedCapture.content_type === "text" ? (shared_text ?? replayedCapture.description) : replayedCapture.description,
          description_format: replayedCapture.content_type === 'text' ? description_format : replayedCapture.description_format,
          url: normalizedRetry,
          canonical_url: normalizedRetry !== replayedCapture.url ? null : replayedCapture.canonical_url,
          url_hash: normalizedRetry ? canonicalizeUrl(normalizedRetry) : null,
          ...(normalizedRetry !== replayedCapture.url ? {
            metadata_status: "pending" as const, description: null, preview_image_url: null,
            favicon_url: null, site_name: null,
          } : {}),
          local_image_mime_type: image?.mimeType ?? replayedCapture.local_image_mime_type,
          ...(imageChanged ? { preview_image_url: null, local_image_uploaded_for_user_id: null } : {}),
          updated_at: new Date().toISOString(),
        } : replayedCapture;
        const retryFields = changedSyncFields(replayedCapture, updated);
        job.mutationFields = [...new Set([...(job.mutationFields ?? []), ...retryFields])];
        if (!job.entry && retryFields.length && hasSyncedOnce(updated.id)) {
          updated.sync_status = "pending";
          updated.ever_synced = true;
        }
        job.bookmark = updated;
        if (hasDraft && image) job.image = image;
        if (job.entry) {
          job.entry = {
            ...job.entry, updated_at: updated.updated_at,
            payload: {
              ...job.entry.payload,
              url: updated.url ?? undefined,
              title: updated.title ?? (title !== undefined || job.entry.payload.title === null ? null : undefined),
              notes: updated.notes ?? (notes !== undefined || job.entry.payload.notes !== undefined ? '' : undefined),
              shared_text: updated.content_type === "text" ? updated.description ?? undefined : undefined,
              description_format: updated.description_format,
              notes_format: updated.notes_format,
            },
          };
          const entry = job.entry;
          setQueue((current) => [...current.filter((value) => value.local_id !== entry.local_id), entry]);
          queueRef.current = [...queueRef.current.filter((value) => value.local_id !== entry.local_id), entry];
        }
        setBookmarks((current) => [updated, ...(current ?? []).filter((row) => row.id !== updated.id)]);
        bookmarksRef.current = [updated, ...(bookmarksRef.current ?? []).filter((row) => row.id !== updated.id)];
        if (updated.title !== replayedCapture.title || updated.notes !== replayedCapture.notes) {
          markEnrichmentStale(updated.id);
        }
        const persisted = startCaptureWrite(attemptKey, job.retry, job.bookmark, job.entry, job.image);
        if (hasDraft && updated.url && updated.metadata_status === 'pending') {
          void persisted.then((saved) => { if (saved) enrichInBackground(updated); }).catch(() => {});
        }
        return { status: "duplicate", bookmark: updated, persisted };
      }
      // A shared image becomes an image bookmark: capture is local-first and
      // optimistic exactly like every other save, then queued for a real
      // background upload (binary to Storage, then the row) — same shape as
      // the text-note path below. sync_status starts 'pending' (not the old
      // fake 'synced' bookkeeping trick) so the orphan reconciler and the
      // Inbox/Detail "sync pending" chip both read it honestly; `local_image_uri`
      // still keeps it rendering locally with zero dependency on the network
      // the whole time (isLocalOnlyBookmark/STASH-65 continues to protect it
      // from the remote-deletion diff until ever_synced actually flips true on
      // a confirmed upload). Capture is sacred: the durable file copy is
      // folded into `persisted` so the share handler only dismisses once it
      // has actually landed on disk.
      if (image) {
        const now = new Date().toISOString();
        const id = makeBookmarkId();
        // Not a content key (there's no URL to dedupe on) — this capture's
        // stable id, resent unchanged on every upload retry so an interrupted
        // create dedupes against its own first attempt instead of inserting a
        // twin, same role it plays for text notes.
        const imageClientId = capture_client_id ?? capture_attempt_id ?? makeClientId();
        const imageBookmark: Bookmark = {
          id,
          user_id: mockUserId,
          url: null,
          canonical_url: null,
          url_hash: null,
          client_id: imageClientId,
          // A title typed at capture is user-authored; otherwise derive a
          // readable one from the shared filename (may be null → "Untitled").
          title: title?.trim()
            ? title.trim()
            : imageTitleFromFileName(image.fileName),
          title_is_derived: title?.trim() ? title_is_derived : undefined,
          description: null,
          notes: notes?.length ? notes : null,
          description_format,
          notes_format,
          source_app: null,
          content_type: "image",
          preview_image_url: null,
          favicon_url: null,
          site_name: null,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: now,
          updated_at: now,
          last_saved_at: now,
          // No URL/text to derive metadata from — nothing to enrich.
          metadata_status: "skipped",
          sync_status: "pending",
          // Temporary share URI for the optimistic render; swapped for the
          // durable copy once `copyImageToLibrary` resolves below.
          local_image_uri: image.uri,
          // The real MIME type the OS share sheet reported — recorded now
          // because it's the only place this is ever known; the durable
          // local file's own extension alone can't always be trusted to
          // recover it later (see the field's doc comment in domain/types.ts).
          local_image_mime_type: image.mimeType,
        };

        const imageEntry: LocalPendingBookmark = {
          local_id: id,
          remote_id: null,
          operation: "create",
          changes: [{ source: "capture", fields: [], at: now }],
          payload: {
            id,
            // The explicit signal requirePayload needs — there's no
            // url/shared_text to infer content_type from for this row. The
            // binary itself is uploaded by the sync engine right before it
            // sends this create (see syncQueueEntry), never here.
            content_type: "image",
            title: imageBookmark.title ?? undefined,
            notes: imageBookmark.notes ?? undefined,
            description_format: imageBookmark.description_format,
            notes_format: imageBookmark.notes_format,
            client_id: imageClientId,
          },
          sync_status: "pending",
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        };

        setBookmarks((current) => [imageBookmark, ...(current ?? [])]);
        setQueue((current) => [...current, imageEntry]);
        bookmarksRef.current = [imageBookmark, ...(bookmarksRef.current ?? [])];
        queueRef.current = [...queueRef.current, imageEntry];
        // A real (potentially slow, for a large screenshot/photo) file copy
        // sits between this optimistic update and the durable insert+enqueue
        // below — unlike the URL/text capture paths, which have no
        // meaningful I/O in that gap. That's long enough for the 250ms
        // auto-sync debounce to fire syncNow first, and syncNow
        // unconditionally reloads bookmarks/queue from the repository and
        // REPLACES React state with that snapshot (deliberate, for
        // account-transition correctness — see the comment above
        // `reconcileAccountTransition` in syncNow). If that reload runs
        // before this row durably lands, it wipes the just-captured image
        // straight out of the UI — not off disk (the durable write still
        // lands and the row is recovered on the NEXT full reload), but gone
        // from the screen and out of live sync tracking until then, which
        // looks exactly like data loss to the user. `localCreateFlushesInFlight`
        // is the existing guard for precisely this shape of problem — see
        // `importBookmarks` and docs/architecture/sync-pause-import-reset.md
        // — `syncNow`/`resetLibrary` already defer while it's nonzero and
        // self-retrigger once it clears, so reusing it here needs no changes
        // to either of them.
        const persistImage = (job?: CaptureWrite) => {
          const source = job?.image ?? image;
          localCreateFlushesInFlight.current += 1;
          return ensureRepositoryReady()
          .then(async () => {
            assertOwnership(job);
            if (job?.copiedImage?.source === source.uri) return job.copiedImage.durable;
            // A replacement copy must never delete the file still referenced by
            // the durable row if copying or the subsequent row write fails.
            const durable = await copyImageToLibrary(source.uri, localImageFileName(`${job?.bookmark.id ?? id}-${makeClientId()}`, source));
            if (job) {
              if (job.copiedImage && job.copiedImage.durable !== durable) {
                job.obsoleteImageUris = [...(job.obsoleteImageUris ?? []), job.copiedImage.durable];
              }
              job.copiedImage = { source: source.uri, durable };
            }
            return durable;
          })
          .then((durableUri) => {
            assertOwnership(job);
            const stored: Bookmark = {
              ...(job?.bookmark ?? imageBookmark),
              local_image_uri: durableUri,
            };
            setBookmarks((current) => [stored, ...(current ?? []).filter((b) => b.id !== stored.id)]);
            bookmarksRef.current = [stored, ...(bookmarksRef.current ?? []).filter((b) => b.id !== stored.id)];
            // Sequential, not Promise.all: insert the bookmark row FIRST,
            // then enqueue. A crash between the two durable writes must land
            // on the side reconcileOrphanedQueueEntries already self-heals
            // (a bookmark with no queue entry yet) — not a queue entry with
            // no matching bookmark row, which would retry the create forever
            // (requirePayload rejects an image create with no
            // preview_image_url, and createUploadPayload's own "row is
            // missing" guard returns the payload unchanged, so the image
            // never re-uploads either). Running the two writes concurrently
            // via Promise.all leaves the order — and therefore which of the
            // two partial states a crash lands on — unspecified.
            return repository
              .insertBookmark(stored)
              .then(async () => {
                assertOwnership(job);
                if (job) await cleanObsoleteImages(job).catch((error) => logStorageError('superseded image staging', error));
                assertOwnership(job);
                return repository.enqueue(job?.entry ?? imageEntry);
              });
          })
          .then(() => { assertOwnership(job); return true; })
          .catch((error) => {
            logStorageError("new image bookmark", error);
            return false;
          })
          .finally(() => {
            // Mirrors importBookmarks' own flush completion exactly: once
            // the last in-flight local write clears, release any sync a
            // debounce fired (and got deferred) during the window, and
            // explicitly kick a fresh one so the just-landed row/entry
            // actually gets picked up instead of waiting for the next
            // unrelated trigger.
            localCreateFlushesInFlight.current = Math.max(
              0,
              localCreateFlushesInFlight.current - 1,
            );
            if (localCreateFlushesInFlight.current === 0) {
              syncPendingRef.current = false;
              const pendingForce = syncPendingForceRef.current;
              syncPendingForceRef.current = false;
              setTimeout(() => {
                void syncNowRef.current?.({ force: pendingForce }).catch(() => { });
              }, 50);
            }
          });

        };
        const persisted = startCaptureWrite(attemptKey, persistImage, imageBookmark, imageEntry, image);
        return { status: "created", bookmark: imageBookmark, persisted };
      }

      const normalized = url ? normalizeUrl(url) : null;
      if (!normalized) {
        // No usable URL. If the share carried text (e.g. a KakaoTalk message
        // with no link), save it as a text note rather than dropping deliberately
        // shared content — capture is sacred. Reject only when there is nothing
        // at all to save.
        if (!shared_text?.trim()) {
          return {
            status: "invalid",
            error:
              "Enter a valid web address, like example.com or https://example.com.",
          };
        }
        // Test emptiness on a trimmed copy above, but persist the original
        // body — leading whitespace is meaningful Markdown (e.g. an indented
        // code block), so a Markdown memo must not be silently rewritten.
        const text = shared_text;

        const noteNow = new Date().toISOString();
        // Text notes have no canonical URL key, so distinct shares are distinct
        // notes by design. The client_id below is NOT a content key: it's this
        // capture's stable id, resent on every retry so an interrupted upload
        // dedupes against its own first attempt instead of inserting a twin.
        const noteClientId = capture_client_id ?? capture_attempt_id ?? makeClientId();
        const note: Bookmark = {
          id: makeBookmarkId(),
          user_id: mockUserId,
          url: null,
          canonical_url: null,
          url_hash: null,
          client_id: noteClientId,
          title: title?.trim() ? title.trim() : null,
          title_is_derived: title?.trim() ? title_is_derived : undefined,
          // The shared text is the note's body. Stored as the description to
          // mirror the cloud API (which maps shared_text → description), so a
          // pulled-back note matches the locally captured one.
          description: text,
          notes: notes?.length ? notes : null,
          description_format,
          notes_format,
          source_app: null,
          content_type: "text",
          preview_image_url: null,
          favicon_url: null,
          site_name: null,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: noteNow,
          updated_at: noteNow,
          last_saved_at: noteNow,
          metadata_status: "pending",
          sync_status: "pending",
        };

        const noteEntry: LocalPendingBookmark = {
          local_id: note.id,
          remote_id: null,
          operation: "create",
          changes: [{ source: "capture", fields: [], at: noteNow }],
          payload: {
            id: note.id,
            title: note.title ?? undefined,
            notes: note.notes ?? undefined,
            description_format: note.description_format,
            notes_format: note.notes_format,
            shared_text: text,
            client_id: noteClientId,
          },
          sync_status: "pending",
          retry_count: 0,
          last_error: null,
          created_at: noteNow,
          updated_at: noteNow,
        };

        setBookmarks((current) => [note, ...(current ?? [])]);
        setQueue((current) => [...current, noteEntry]);
        bookmarksRef.current = [note, ...(bookmarksRef.current ?? [])];
        queueRef.current = [...queueRef.current, noteEntry];
        const persisted = startCaptureWrite(attemptKey, (job) => ensureRepositoryReady()
          .then(() => { assertOwnership(job); return repository.insertBookmark(job?.bookmark ?? note); })
          .then(() => { assertOwnership(job); return repository.enqueue(job?.entry ?? noteEntry); })
          .then(() => { assertOwnership(job); return true; })
          .catch((error) => {
            logStorageError("new text note", error);
            return false;
          }), note, noteEntry);

        // No URL to derive metadata from; this transitions metadata_status to
        // 'skipped' via the existing, tested enrichment path.
        enrichInBackground(note);

        return { status: "created", bookmark: note, persisted };
      }

      const now = new Date().toISOString();

      // Idempotent saves: reuse the existing bookmark for the same URL. Dedupe
      // on the canonical form so tracking params / fragments don't create dupes.
      const dedupeKey = canonicalizeUrl(normalized);

      // Reject up front rather than queuing a save that can never succeed: the
      // server's `url_hash` index has a Postgres row-size limit that a sufficiently
      // long canonical URL blows on every retry, forever (Sentry STASH-2V / STASH-2J).
      if (isUrlTooLong(dedupeKey)) {
        return {
          status: "invalid",
          error: "This web address is too long to save.",
          reason: "too_long",
        };
      }

      const existing = captureBookmarks.find(
        (bookmark) =>
          isActiveBookmark(bookmark) &&
          currentDedupeKey(bookmark) === dedupeKey,
      );
      if (existing) {
        const isRepairable = isRepairableSourceTitle(existing);
        const titleCanBeImproved =
          Boolean(title?.trim()) &&
          (!title_is_derived ||
            existing.title == null ||
            existing.title_is_derived === true ||
            isRepairable);
        const updatedTitle = titleCanBeImproved ? title!.trim() : existing.title;
        const updatedTitleDerived = titleCanBeImproved
          ? title_is_derived
          : isRepairable
            ? true
            : existing.title_is_derived;

        const notesCanBeImproved = Boolean(notes?.trim()) &&
          (replace_existing_notes || !existing.notes);
        const updatedNotes = notesCanBeImproved ? (notes ?? null) : existing.notes;
        const updatedNotesFormat = notesCanBeImproved ? notes_format : existing.notes_format;
        const notesChanged = notesCanBeImproved && updatedNotes !== existing.notes;
        const notesFormatChanged = updatedNotesFormat !== existing.notes_format;

        const needsMetadataRefresh =
          Boolean(existing.url) &&
          (updatedTitle == null || updatedTitleDerived === true || isRepairable);

        const titleChanged = titleCanBeImproved && updatedTitle !== existing.title;
        // A native share's attempt id is also its retry key.  When a URL is
        // already present under its canonical form, retain that key on the
        // existing row before acknowledging the Android intent.  A later
        // replay can then find this row even after the user changes its URL or
        // moves it to Trash, instead of treating the edited content as new.
        const captureClientIdChanged =
          capture_client_id !== undefined && existing.client_id !== capture_client_id;
        const contentChanged =
          titleChanged || notesChanged || notesFormatChanged || captureClientIdChanged;
        const syncsRemotely = contentChanged ? hasSyncedOnce(existing.id) : false;

        const updated: Bookmark = {
          ...existing,
          title: updatedTitle,
          title_is_derived: updatedTitleDerived,
          client_id: capture_client_id ?? existing.client_id,
          notes: updatedNotes,
          notes_format: updatedNotesFormat,
          last_saved_at: now,
          last_accessed_at: now,
          updated_at: contentChanged ? now : existing.updated_at,
          sync_status: syncsRemotely ? "pending" : existing.sync_status,
          ever_synced: syncsRemotely ? true : existing.ever_synced,
          metadata_status: needsMetadataRefresh ? "pending" : existing.metadata_status,
        };

        setBookmarks((current) =>
          (current ?? []).map((bookmark) =>
            bookmark.id === existing.id ? updated : bookmark,
          ),
        );
        if (bookmarksRef.current !== null) {
          bookmarksRef.current = bookmarksRef.current.map((bookmark) =>
            bookmark.id === existing.id ? updated : bookmark,
          );
        }
        const persisted = startCaptureWrite(attemptKey, (job) => ensureRepositoryReady()
          .then(() => { assertOwnership(job); return repository.updateBookmark(job?.bookmark ?? updated); })
          .then(async () => {
            assertOwnership(job);
            const fields = job?.mutationFields ?? (syncsRemotely ? changedSyncFields(existing, updated) : []);
            if (job?.entry) {
              return repository.enqueue(job.entry).then(() => true);
            }
            const id = job?.bookmark.id ?? existing.id;
            if (fields.length && hasSyncedOnce(id)) {
              return enqueueMutation(id, "update", "capture", fields);
            }
            return true;
          })
          .then((saved) => { assertOwnership(job); return saved; })
          .catch((error) => {
            logStorageError("duplicate save", error);
            return false;
          }), updated, undefined, undefined, existing, syncsRemotely ? changedSyncFields(existing, updated) : []);

        if (titleChanged && !title_is_derived && !hasSyncedOnce(existing.id)) {
          pendingUserTitleEdits.current.add(existing.id);
        }
        if (titleChanged || notesChanged) {
          markEnrichmentStale(existing.id);
        }

        if (needsMetadataRefresh) {
          // Clear repairable title on the refresh target so enrichBookmark emits a title patch
          // even when the incoming duplicate share supplied no title (Codex review)
          enrichInBackground({
            ...updated,
            title: isRepairable && !titleCanBeImproved ? null : updated.title,
            title_is_derived: isRepairable ? true : updated.title_is_derived,
          });
        }

        return { status: "duplicate", bookmark: updated, persisted };
      }

      const clientId = capture_client_id ?? capture_attempt_id ?? makeClientId();
      const bookmark: Bookmark = {
        id: makeBookmarkId(),
        user_id: mockUserId,
        url: normalized,
        canonical_url: null,
        // Canonical dedupe key (tracking params/fragment stripped). canonical_url
        // stays null until enrichment resolves a real rel=canonical / og:url.
        url_hash: dedupeKey,
        client_id: clientId,
        // Manual Add titles are user-authored. Source-app share titles are
        // generated hints and may be improved by enrichment (STASH-6C).
        title: title?.trim() ? title.trim() : null,
        title_is_derived: title?.trim() ? title_is_derived : undefined,
        description: null,
        notes: notes?.length ? notes : null,
        description_format,
        notes_format,
        source_app: null,
        content_type: "url",
        preview_image_url: null,
        favicon_url: null,
        site_name: null,
        collection_id: null,
        is_archived: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        last_saved_at: now,
        metadata_status: "pending",
        sync_status: "pending",
      };

      const queueEntry: LocalPendingBookmark = {
        local_id: bookmark.id,
        remote_id: null,
        operation: "create",
        changes: [{ source: "capture", fields: [], at: now }],
        payload: {
          id: bookmark.id,
          url: normalized,
          title: bookmark.title ?? undefined,
          notes: bookmark.notes ?? undefined,
          description_format: bookmark.description_format,
          notes_format: bookmark.notes_format,
          client_id: clientId,
        },
        sync_status: "pending",
        retry_count: 0,
        last_error: null,
        created_at: now,
        updated_at: now,
      };

      // Optimistic update first; persistence happens in the background so
      // capture never waits on storage or (later) the network.
      setBookmarks((current) => [bookmark, ...(current ?? [])]);
      setQueue((current) => [...current, queueEntry]);
      bookmarksRef.current = [bookmark, ...(bookmarksRef.current ?? [])];
      queueRef.current = [...queueRef.current, queueEntry];
      const persisted = startCaptureWrite(attemptKey, (job) => ensureRepositoryReady()
        .then(() => { assertOwnership(job); return repository.insertBookmark(job?.bookmark ?? bookmark); })
        .then(() => { assertOwnership(job); return repository.enqueue(job?.entry ?? queueEntry); })
        .then(() => { assertOwnership(job); return true; })
        .catch((error) => {
          logStorageError("new bookmark", error);
          return false;
        }), bookmark, queueEntry);

      // Enrich after the bookmark is already visible and persisted.
      enrichInBackground(bookmark);

      return { status: "created", bookmark, persisted };
    },
    [loadedBookmarks, hideAccountCache, enrichInBackground, hasSyncedOnce, enqueueMutation, markEnrichmentStale],
  );
  return { addBookmark, abandonCapture };
}
