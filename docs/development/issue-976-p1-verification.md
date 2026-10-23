# Issue #976 P1 verification

Scope: authentication/ownership boundaries and current trash/archive eligibility
in `ai-enrich`. P2 duplicate execution/CORS/SQLite work remains in issue #976.

## Contract

- PostgREST validates forwarded user JWTs and RLS determines bookmark visibility.
  No user-provided owner ID is used for enrichment writes.
- Invalid shared secrets never downgrade to a user session. Only the shared
  secret caller can invoke the cross-user batch worker.
- The single-item lookup selects current `deleted_at` and `is_archived` before
  context, quota, budget, model, or result writes. Trash is always ineligible;
  archived rows are ineligible for server/automatic/preview work. Manual archive
  refresh remains supported. Older clients omit `source` and retain their
  previous manual endpoint contract; their automatic/manual intent is unknown.
- App requests receive HTTP 409 for ineligible state and clear retry/pending
  markers instead of enqueueing work. Server triggers receive a successful skip.
- This is a check on the initial read, not cancellation after a later state
  change or cross-request deduplication.

## Observed on 2026-10-23

Project: `stzutoejnhzxzhjsjtsi`. Read the actual deployed function bundle, not
just repository configuration: `ai-enrich` v32 is active with `verify_jwt=false`.
Its single-item lookup does not yet select/check trash/archive fields. The
shared-secret decision, user JWT forwarding and global budget gate are present.
No deployment was performed during these checks.

The actual DB ownership fixture `supabase/tests/ai-enrichment-ownership.sql`
passed against the live target in a transaction that rolled back all fixture
users/bookmarks/enrichments/quota slots. It verifies own read and upsert,
foreign-parent INSERT/UPDATE rejection, unauthenticated invisibility, self quota,
and client denial/server availability of privileged budget/worker RPCs. Both
anonymous and registered JWT claim contexts were exercised via SQL; this is
not signature/expiry verification.

HTTP checks against v32 passed with two disposable anonymous sessions minted
by Supabase Auth: no session and malformed JWT returned 401; wrong shared secret
returned 401 even alongside a valid session; a valid session reached the missing
row lookup (404); a valid user's batch-worker attempt returned 401; another
fixture owner's existing bookmark returned 404. The fixture owner observed no
enrichment or model-call ledger entry after the foreign request. The bookmark,
sessions, and both disposable auth users were removed. No successful deployed
model call or real batch drain was deliberately invoked.
An additional probe with a structurally valid JWT and a forged signature also
returned 401.

The added handler boundary suite exercises successful anonymous/registered
token forwarding, trigger/worker execution, invalid credentials, invisible
bookmarks, inactive rows, source propagation, and owner-field spoofing with
mocked PostgREST/provider responses. Those tests do not establish live JWT/RLS.

## Remaining acceptance

- A genuinely signed expired user JWT and a registered user's signed session
  have not been exercised over HTTP. The repeatable probe reports missing
  fixture tokens as SKIP; supply dedicated tokens to complete these checks.
- Successful deployed trigger and worker execution, and the new state guards,
  need a controlled non-billable deployment/fixture smoke. Local mocked handler
  successes do not prove the deployed configuration or secret wiring.
- Run the required PR CI/review gates. Deployment and merge require the normal
  repository approvals for Supabase function changes. There is no schema change.
