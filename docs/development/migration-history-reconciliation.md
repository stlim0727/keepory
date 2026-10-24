# Migration history reconciliation: #996, #1000, #1004

Initial observation 2026-10-24 by Codex (AI coding assistant). The original plan
was read-only. The follow-up below records a rolled-back DB probe and a verified
AI function deployment; production migration bookkeeping remains untouched.

## Current evidence

- The live migration ledger has 62 rows; the repository has 77 SQL files.
- 37 live versions have no matching local filename prefix (table below).
- The duplicate local version belongs to rate_limit and degraded. Git history
  shows rate_limit arrived first; the live ledger records them separately at
  20260621044644 and 20260621044602 respectively. The proposed local-only fix
  retains the SQL unchanged and moves the later-added degraded file to
  20260620000001. The two migrations operate on separate tables and do not
  depend on each other. Neither draft version
  exists in the live ledger. This fixes local uniqueness, not #996.
- Capacity seeding and trigger creation now share a single DO statement, retaining
  the write lock through initialization even under a statement-splitting applier.
  Do not reapply this non-idempotent historical migration to production.
- CI now uses the real CLI start and local reset, followed by the existing SQL
  assertions. A successful CI run on the PR head is required evidence for #1004.
- Missing drift-check credentials now fail instead of producing a green no-op.
  `node scripts/check-migration-drift.mjs --report-versions` prints the orphan
  versions and exact slug candidates without changing anything remotely.

## Production verification for #1000

Read directly through the connected Supabase tools, rather than inferred from
successful apply responses:

| Check | Observed |
| --- | --- |
| user_preferences | Present, RLS enabled, owner-only SELECT/INSERT/UPDATE policies, locale and preference columns present |
| Preferences data | 1 row; does not establish which device/sign-in created it |
| Bookmark policy constraint | Accepts auto, skip, trickle |
| Queue priority | smallint column present |
| Slot RPC | Only request_ai_enrichment_slot_for(uuid,boolean) present |
| chat_requests | Present |
| AI queue | 605 done; no pending, processing, or failed rows at observation time |
| Bookmark policies | 2698 auto, 1192 skip, 0 trickle; real import smoke still outstanding |
| Old filed move suggestions | 0 with updated_at before 2026-09-30T10:00:00Z (the actual migration predicate) |
| Anonymous cleanup cron | Enabled, 17 0 * * * |
| AI overflow worker cron | Enabled, * * * * * |
| ai-enrich deployment | ACTIVE, version 33, SHA-256 46b9be4a82935d9084aaf2db8e7ad49848ed03163635598fe2a02cb2249a528d; not yet matched to source artifact |
| Authenticated Realtime workflow 40067297691 | Still waiting for supabase-live environment approval |

Outstanding acceptance: device sign-in writing preferences, an HTML/CSV import
producing trickle rows, first authenticated Realtime run, and confirmation of
anonymous cleanup after the seven-day idle cutoff. No accounts were created by
these read-only checks. The Nov 1 automation mentioned in #1000 is not a tracked
repository file; changing it requires the scheduler that owns b21cfa62. Play
production promotion remains a separate explicit authorization.

## Follow-up observed 2026-10-24 after #1005

- #1005 merged as a5a5d18. Fresh CLI start/reset and all six existing SQL
  assertions passed before merge; #1004 is resolved.
- Ran `supabase/tests/preferences-trickle-import.sql` against production inside
  a transaction, then rolled back. It passed owner preference insert/update/read,
  foreign-owner denial, and a pending-metadata -> complete import transition
  producing exactly one pending queue row with priority 50 and locale ko.
  An ordinary retry update did not duplicate work. A subsequent read found zero
  fixture bookmarks or preferences. This verifies the DB path, not a device
  sign-in or actual HTML/CSV parsing/upload.
- Anonymous cleanup has 120 logged runs and 484 total deletions. The 2026-10-24
  00:17 UTC run deleted two accounts; the current cleanup predicate finds zero
  eligible empty anonymous accounts. Cron run history reports 118 successful
  scheduled cleanup runs. The log count includes other invocations, so these
  counts need not match. The particular 2026-10-23 verifier cohort is still too
  young for its seven-day acceptance check.
- Read back the deployed ai-enrich v33 source. Seven runtime files matched main;
  index.ts and gemini-provider.ts did not. The deployed worker omitted
  p_is_trickle and quota retry_after handling, and the provider omitted the
  generic error/social-platform label filtering already merged in main.
- Deployed the existing, CI-tested main function sources (all ten input files
  verified byte-for-byte against passing CI ee982344) as ai-enrich v34. Kept
  verify_jwt=false, matching the existing handler-owned authentication. Source
  readback confirmed all nine returned runtime files match the repository (the
  type-only provider.ts is not returned by the bundle API). Artifact SHA-256:
  0b2b932906408df41d245e0456f3e4229726e798cfda954b764b5d9aed30361f.
  An unauthenticated POST returned 401 without model work. The source hash
  evidence is in [ai-enrich-deployment-audit-20261024.json](ai-enrich-deployment-audit-20261024.json).
  Previous v33 source is retained privately for rollback. No function source was
  modified in this follow-up PR. This is source/readback and auth-rejection
  evidence, not a successful authenticated model invocation.
- Realtime run 40067297691 still awaits protected-environment approval; this
  session has no local Supabase credentials and did not bypass the approval.
- No accessible scheduler tool exposes b21cfa62, and this user's crontab is empty.
  Its stale equality guard cannot be changed from this session. No build was
  dispatched or promoted.

### SQL-content audit before any ledger repair

All 62 ledger rows were exported with their SQL statements to a private local
snapshot (outside git, mode 0600). The hash-only report is checked in as
[migration-ledger-audit-20261024.json](migration-ledger-audit-20261024.json).
Reproduce from a new private snapshot with:

```sh
node scripts/audit-migration-ledger.mjs /private/ledger-snapshot.json
```

The audit reads an array of full ledger rows, compares exact slugs and hashes,
prints no SQL, and never creates repair statements or touches a database.
Hashes ignore only outer whitespace and the final semicolon. A mismatch can be
formatting/comments and does not by itself establish a semantic difference.

- 36 of 62 ledger rows match at least one local file's SQL content.
- 23 rows have local slug candidates but no exact content match. These require
  inspection before a ledger repair; name matching alone is insufficient.
- Three rows have no exact slug candidate: admin_ai_quota_hourly_v2,
  admin_ai_quota_hourly_v2_pacific_reset_drop, and the misnamed
  20261024000200_revoke_internal_ai_slot_from_client_roles.
- The SQL statement arrays for the misnamed row 20261024050502 and correctly
  named row 20261024050549 are exactly identical. This resolves the content
  question, but does not itself authorize deleting either record.
- The two missing admin rows are historical revisions of
  public.admin_google_quota_hourly: the first adds a cumulative trailing count;
  the second drops/recreates it with Pacific-reset totals. Preserve these
  historical statements in the reconciliation design rather than mapping them
  by a similar name or silently discarding them.

The original 37 orphan versions remain. Content equality is evidence about
recorded SQL only, not proof of present catalog state or permission to repair.

## Proposed decision for #996

Prefer repairing ledger bookkeeping to the authored local versions after a
reviewed one-to-one/equivalence mapping. Do not add empty same-slug stub files:
they multiply ambiguity in the slug check. Do not rename the whole history to
apply-time order: apply-time order differs from dependency order (for example,
chat_rate_limit was authored in June but recorded in October).

This document is **not permission to execute a repair**. Before an executable
repair is offered for approval:

1. Export the full ledger including statements and retain a recoverable snapshot.
2. Compare SQL for every duplicate-slug pair; one applied slug does not prove
   that both files' contents were applied. Retain all historical statements.
3. Verify the five existing exemptions separately: initial_schema,
   ai_enrich_server_trigger, feedback_bridge_webhook,
   secure_tidy_backup_totohero_tables, and the superseded
   clear_persisted_collection_move_suggestions. A superseded data update must
   not be rerun merely to populate its ledger entry.
4. Resolve the misnamed 20261024050502 row against 20261024050549 by actual SQL,
   not name similarity. Do not delete it as an incidental cleanup.
5. Prepare an atomic, guarded, reversible bookkeeping-only repair and have the
   owner approve it. Do not call apply_migration to recreate existing objects.
6. Read the ledger back, require zero orphan versions, and verify no tracked
   migration would be replayed by the integration before restoring Preview.
7. Then enable strict reverse-direction/version checking. Keep the existing
   unapplied-slug alarm active throughout.

The repository PR can fix local replay and improve diagnostics independently.
It must not claim that Supabase Preview or production reconciliation is fixed,
and must not be auto-merged (repository migration workflow gate).

## Orphan versions and exact local slug candidates

| Live version | Live name | Local candidate |
| --- | --- | --- |
| 20260713034125 | sync_ai_suggestion_dismissals | `20260711100000_sync_ai_suggestion_dismissals.sql` |
| 20260714120724 | feedback_reports_require_signed_in | `20260714000000_feedback_reports_require_signed_in.sql` |
| 20260716071728 | ai_enrichment_token_usage | `20260716120000_ai_enrichment_token_usage.sql` |
| 20260716071741 | ai_enrichment_calls | `20260716130000_ai_enrichment_calls.sql` |
| 20260716073024 | ai_enrichment_calls_server_only | `20260716140000_ai_enrichment_calls_server_only.sql` |
| 20260724001717 | pending_ai_enrichment_queue | `20260723150000_pending_ai_enrichment_queue.sql` |
| 20260724014153 | admin_ai_queue_views | `20260724110000_admin_ai_queue_views.sql` |
| 20260728123741 | reset_user_library | `20260728120000_reset_user_library.sql` |
| 20260728124937 | push_tokens | `20260724100000_push_tokens.sql` |
| 20260731142132 | pending_ai_enrichment_select_policy | `20260731150000_pending_ai_enrichment_select_policy.sql` |
| 20260731153200 | ai_enrichment_daily_quota_500 | `20260731153000_ai_enrichment_daily_quota_500.sql` |
| 20260731162616 | admin_ai_quota_hourly | `20260731170000_admin_ai_quota_hourly.sql` |
| 20260731163156 | admin_ai_quota_hourly_v2 | No exact slug match; investigate separately |
| 20260731163345 | admin_ai_quota_hourly_v2_pacific_reset_drop | No exact slug match; investigate separately |
| 20260731170105 | ai_enrichment_slot_for_500 | `20260731180000_ai_enrichment_slot_for_500.sql` |
| 20260802052844 | ai_enrichment_daily_limit_accurate_retry | `20260802060000_ai_enrichment_daily_limit_accurate_retry.sql` |
| 20260802055413 | ai_enrichment_slot_binding_window_wins | `20260802061500_ai_enrichment_slot_binding_window_wins.sql` |
| 20260803041103 | ai_enrichment_slot_refund_on_rate_limit | `20260803041500_ai_enrichment_slot_refund_on_rate_limit.sql` |
| 20260803042513 | ai_enrichment_slot_refund_serialize | `20260803050000_ai_enrichment_slot_refund_serialize.sql` |
| 20260804033159 | ai_enrich_dispatch_trigger_attach | `20260804180000_ai_enrich_dispatch_trigger_attach.sql` |
| 20260804055011 | user_sync_status | `20260804190000_user_sync_status.sql` |
| 20260804055048 | admin_dashboard_views | `20260804191500_admin_dashboard_views.sql` |
| 20260805050550 | ai_enrichment_calls_source | `20260805050500_ai_enrichment_calls_source.sql` |
| 20260807055402 | bulk_attach_bookmark_tags_and_collections | `20260807120000_bulk_attach_bookmark_tags_and_collections.sql` |
| 20260807111847 | realtime_broadcast_policies | `20260712000000_realtime_broadcast_policies.sql` |
| 20260819071612 | bookmark_images_storage_bucket | `20260819071500_bookmark_images_storage_bucket.sql` |
| 20260929065528 | clear_ai_summary_suggestions | `20260929070000_clear_ai_summary_suggestions.sql` |
| 20261002153439 | collection_management_rpcs | `20261002140000_collection_management_rpcs.sql` |
| 20261024014157 | user_preferences_locale | `20260922022000_user_preferences_locale.sql` |
| 20261024014158 | user_preferences_preference | `20260922053000_user_preferences_preference.sql` |
| 20261024014225 | trickle_ai_enrichment | `20261016000000_trickle_ai_enrichment.sql` |
| 20261024014247 | chat_rate_limit | `20260623120000_chat_rate_limit.sql` |
| 20261024014713 | drop_ambiguous_ai_slot_wrapper | `20261024000000_drop_ambiguous_ai_slot_wrapper.sql` |
| 20261024014714 | clear_stale_ai_collection_move_suggestions | `20261024000100_clear_stale_ai_collection_move_suggestions.sql` |
| 20261024050502 | 20261024000200_revoke_internal_ai_slot_from_client_roles | No exact slug match; investigate separately |
| 20261024050549 | revoke_internal_ai_slot_from_client_roles | `20261024000200_revoke_internal_ai_slot_from_client_roles.sql` |
| 20261024050551 | revoke_chat_slot_rpc_from_client_roles | `20261024000300_revoke_chat_slot_rpc_from_client_roles.sql` |
