# Issue 954: first-save review

Codex reviewed [issue #954](https://github.com/stlim0727/stash/issues/954)
with a Jony Ive-inspired design subagent on 2026-10-15.

A screenshot review with the same design subagent on 2026-10-16 found that
button prominence alone left both actions feeling like chores. The long heading
wrapped awkwardly, the login explanation was detached from its action, and the
reassurance under login weakened its invitation.

The revised composition leads with “Keep something worth revisiting” and a
filled “Save your first link” action. “No account needed” belongs to saving.
A softly tinted account card groups “Your links, on every device” with a
high-contrast outlined “Sign in to sync” action. Native share guidance follows
both invitations. Web's redundant + instruction is removed; the platform sharing
limitation appears inside the existing capture tutorial instead. Both English
and Korean use the same hierarchy, with natural wrapping and flexible heights.

## Evidence and limits

The reported 20 empty accounts out of 29 identify an activation question; they
do not establish why people left. Observation windows, anonymous account/device
identity, offline saves and deleted bookmarks need reconciliation before treating
this as a conversion funnel. The 163 imported bookmarks constitute about 88.6%
of the reported 184; the remainder alone does not prove organic capture behavior.
The claimed >85% suggestion adoption needs its eligible denominator and a
separation of requested, presented and accepted suggestions. Subsequent inactivity
after an error-page save does not establish that the error caused churn.

## Acceptance

- A settled empty library offers a direct save action before account actions.
- Optional sign-in and its cross-device benefit appear before sharing guidance
  so account promotion remains prominent without blocking capture.
- Anonymous and signed-out users can open `/add` without an auth prerequisite.
- Web opens the existing add form directly; native retains its share-sheet
  instructions. The web sharing limitation remains accessible in the tutorial.
- Loading, account verification, sync, filtered-empty and search branches retain
  their existing eligibility rules.
- Existing save persistence and cancel behavior are reused. Device checks for
  offline save, cancel and enlarged text remain acceptance work; component
  assertions do not establish those native outcomes.

## Follow-up work

Measure empty-state exposure, CTA use and the first durable non-import capture
with a defined cohort and observation window. Current capture completion
analytics cover sharing, so opening the add screen cannot establish activation
uplift. Avoid promising a three-second AI result: availability and metadata
quality vary.

Handle error/login-page detection and short-form metadata extraction as separate
changes with server fixtures and recovery behavior. Preserve the saved link when
enrichment is unavailable, and avoid presenting host-only topics as meaningful
organization. Bulk import enrichment remains tracked by #940, including quota
and scheduling safeguards.

## Metadata resilience and short-form recovery

Following PR #957's welcoming actions, the metadata ingestion and enrichment
pipeline was hardened against the failure modes identified in audit #954:
- **Error / Login-Page Interception**: `isChallengeOrBoilerplateTitle` in
  `domain/page-metadata.ts` detects Korean portal error shells (`오류안내 페이지`,
  `로그인이 필요합니다`, `성인 인증`) and server errors (`403 Forbidden`,
  `Access Denied`). Rejected error titles fall back cleanly to URL domain
  derivation with `title_is_derived: true`.
- **Short-Form Video Recovery (TikTok / Reels / Shorts)**: `domain/tiktok.ts`
  resolves TikTok's public unauthenticated oEmbed endpoint across standard URLs,
  TikTok Lite (`lite.tiktok.com/t/`), and mobile shortlinks (`vt.tiktok.com`),
  bypassing client-side JavaScript hydration shells. Generic host titles
  (`TikTok Lite`, `틱톡`) are filtered out.
- **AI Tag Disinfection**: `supabase/functions/ai-enrich/gemini-provider.ts`
  explicitly instructs the Gemini prompt against generating error-state tags
  (`오류`, `error`) or host-only media labels (`소셜미디어`, `동영상`) when content
  is unavailable.
