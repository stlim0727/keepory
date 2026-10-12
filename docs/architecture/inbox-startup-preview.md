# Inbox startup preview

On repeat launches, Inbox may display up to 30 cached bookmarks before SQLite
hydration and account reconciliation finish. Native uses a small file in the OS
cache directory; web uses a separate localStorage key. Reading the preview never
waits for repository initialization, metadata repairs, AI data, or remote sync.

The snapshot records the session user id and anonymity, the saved sort and list
or card layout, the total library count, and the displayed rows' tags and folders.
Only the All scope without a search or facet deep link uses the preview. Folder
view stays on the normal path; it is a transient layout rather than a persisted
resting view. Snapshots are versioned and bounded to 30 rows / 256 KB, with missing,
malformed, incompatible, or oversized caches falling back to ordinary hydration.

Preview rows are display-only. They never enter bookmark state, identity aliases,
the queue, sync, or command hooks. Pointer and accessibility actions are disabled
until the live store owns the displayed rows. A matching usable session is required;
loading auth, expiry, errors, logout, and another account never reveal the preview.
An account departure or settled startup permanently retires that mount's preview.

`accountCacheReady` reports local ownership reconciliation separately from the
first successful cloud pull. Live rows replace the preview as soon as storage and
ownership settle, including offline or paused sessions. Cache refresh also uses
this local readiness instead of waiting for `accountLibraryState` to become ready.

Bookmark writes, identity replacement, deletions, and library resets invalidate
older disk previews. Inbox refreshes a snapshot from the current projection after
queued repository work; abandoned writes are cancelled on projection or account
changes. Cache failures never affect durable storage or capture completion. Tag
and folder changes refresh the displayed metadata while Inbox is mounted.

The splash coordinator releases only the Inbox route once a matching preview and
its saved layout commit. Deep links still require the real store; the existing
timeout and terminal-error behavior stay in place.

## Validation

Automated suites cover same-account restoration, delayed auth, A→B→A, expiry,
missing/corrupt caches, cache bounds, local readiness before pull, abandoned cache
writes, edits/deletions/reset invalidation, native cache I/O failure, actual Inbox
replacement and pointer gating, and splash/deep-link readiness.

Standalone Android/iOS acceptance still needs a populated account: open Inbox
once to create the cache, force-stop and relaunch, then repeat offline and paused.
Check title/image/tag continuity, list/card and saved sorts, full-count continuity,
preview action gating, and the handoff to live rows. Repeat after trash, permanent
delete, reset, expiry, and account switching. Compare startup timings with the
baseline build on the same device; unit tests do not establish a latency reduction.
