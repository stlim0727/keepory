# Agent PR execution checklist

Lesson from [PR #931](https://github.com/stlim0727/stash/pull/931), 2026-10-13:
review became a debugging loop because fixes addressed individual findings
without consistently checking the shared contract or preserving earlier evidence.
Own the coherent change through completion; reviewers provide an independent check.

Follow the authoritative [PR workflow](agent-reference.md#collaboration-and-pr-workflow).
For asynchronous changes, consult the [boundary review guide](../design/sync-change-review.md).
See the [PR #936 retrospective](pr-936-retrospective.md) for native acceptance and final handoff lessons.
Scale these checks to the change's risk; trivial edits do not need a state-machine audit.

## Before publishing

- Define observable success, scope, and affected boundaries: eligibility,
  durability, failure/recovery, interruption, and late completion. Trace callers
  and consumers; retain intentional differences between paths.
- Map important requirements to assertions about requests, durable state,
  cancellation, or visible behavior. Cover representative success, recovery,
  and overlap sequences. Test totals alone do not establish coverage.
- For native acceptance, verify process continuity and inspect crash logs alongside
  screenshots and durable content. A foreground helper or screenshot alone cannot
  establish successful navigation. Record the tested SHA with each evidence set.
- Mock dependencies, not production semantics. Investigate hangs and failures;
  never bypass the behavior under review to make tests pass. Confirm a failure
  on the base before calling it pre-existing. Follow the CI-first testing policy.
- Review the whole diff against the contract and earlier regressions. Keep the
  PR title/body aligned with the final change. Batch related validated fixes.

## During review

- Validate findings; explain stale or inapplicable feedback.
- Group actionable findings by violated invariant. Check representative related
  paths and prior regressions before publishing the combined correction.
- If the same mechanism recurs, revisit the contract and missing verification
  before another patch. Stay within scope; avoid unrelated rewrites.
- Reply with the fixing commit and transition verified, then resolve addressed
  threads. Do not request another review while the latest one is running.

## Ownership and handoff

Keep one accountable PR owner. Coordinate editing ownership and preserve others'
work. A successor verifies the live remote head and local state before editing;
conversation history and old test results are not a verified baseline.

```text
PR, branch/worktree, remote head/base:
Local changes and editing owner:
Success contract and scope:
Resolved findings/regressions to preserve; unresolved findings/common cause:
Validation evidence and tested SHA; running CI/review:
Next action and authorization limits, including merge permission:
```

## Completion

- Distinguish implemented, published, CI-passed, reviewed, ready, and merged.
  Require evidence for the current remote head; a fix, rebase, or squash requires
  checking the new head's CI/review status.
- Retain ownership through required checks, feedback resolution, conflict checks,
  and the repository review window. Report concrete blockers; a pending review
  or quota failure is not approval. A status question is not cancellation.
- Before final handoff, reconcile the PR body and linked issue state with actual
  results. Identify evidence from earlier heads explicitly; do not relabel it as
  verification of the final head. If review is unavailable, record that gap and
  obtain an explicit alternative review decision before merging.
- Merge only within authorization and repository rules.
- Optimize for fewer avoidable review rounds and preserved regression evidence,
  not fewer commits. Squashing improves history, not correctness. Coordinate
  history rewrites, preserve a recovery point, and use an explicit push lease.
  Never hide findings, weaken tests, or suppress independent review to reduce rounds.
