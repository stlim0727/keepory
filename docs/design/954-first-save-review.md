# Issue 954: first-save review

Codex reviewed [issue #954](https://github.com/stlim0727/stash/issues/954)
with a Jony Ive-inspired design subagent on 2026-10-15.

The empty library previously offered sign-in before capture instructions. Its
save path was prose pointing to a separate + control. The first change makes
“Save your first link” a direct action into the existing add screen, moves
optional sign-in below capture guidance with secondary styling, and removes the
disabled Android acquisition button. Native sharing guidance remains available.
English and Korean copy lead with the user's intent to return to a link.

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
- Anonymous and signed-out users can open `/add` without an auth prerequisite.
- Web offers paste guidance; native retains its share-sheet instructions.
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
and scheduling safeguards. This first-save change does not resolve all of #954.
