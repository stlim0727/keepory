-- Scoped re-run of 20260930100000_clear_persisted_collection_move_suggestions, which was
-- merged but never applied to production (#996).
--
-- The original statement cleared every move suggestion attached to a bookmark that had
-- already been filed into a collection (STASH-74, STASH-78). Run today it would also clear
-- suggestions generated since then by the enrichment functions that were fixed for those
-- issues, so this version keeps the same intent and restricts it to rows last updated
-- before the original migration's own timestamp.
--
-- Supersedes 20260930100000_clear_persisted_collection_move_suggestions.sql, which is left
-- in place as applied history and is listed as such in scripts/check-migration-drift.mjs.
update public.ai_enrichments e
set suggested_collection_id = null,
    suggested_collection_name = null,
    updated_at = now()
from public.bookmarks b
where e.bookmark_id = b.id
  and b.collection_id is not null
  and e.updated_at < '2026-09-30T10:00:00Z'
  and (e.suggested_collection_id is not null or e.suggested_collection_name is not null);
