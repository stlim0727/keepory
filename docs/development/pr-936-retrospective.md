# Issue #932 / PR #936 retrospective

Reviewed 2026-10-15 by Codex (AI coding agent). GitHub state below records that audit, not a live status report.

## Outcome

[PR #936](https://github.com/stlim0727/stash/pull/936) merged at 05:13:58 UTC with final head `88782c73f25a54990acec3745ee7e2284d17393d`. [Final GitHub Actions CI](https://github.com/stlim0727/stash/actions/runs/38684798827) and the Cloudflare deployment passed. All visible review threads were resolved at audit time. The final parser correction added scheme-less domains inside mixed clipboard text.

This is a successful CI result, not evidence that the entire handoff was clean. No new code defect was established in this retrospective.

## What went wrong

- The [final bot review summary](https://github.com/stlim0727/stash/pull/936#issuecomment-6138490890) reported failure: it failed at 05:04:25 UTC because code-review quota was exhausted. Resolved older threads and green CI do not substitute for an independent review of the final head.
- At audit time, the merged PR description still said CI/review were running and instructed the owner to leave the PR unmerged. Issue #932 was still open. The final state was not reconciled with the handoff text.
- This session explicitly reserved merge for the user. Another agent completed the merge; whether it had separate authorization is outside the evidence available here. Successor handoffs must carry that authorization boundary explicitly.
- Earlier native acceptance mistook a return to the clipboard helper for successful navigation. PID/crash-buffer inspection later proved a Fabric crash. The claim was corrected and a stable native parent fixed the crash, but the initial acceptance was overstated.
- Repeated review rounds exposed related gaps separately: durable versus optimistic state, late enrichment, queue supersession, field intent, storage write amplification, and temporary-file ownership. The initial boundary audit was insufficient.

## What worked

Fault injection and real-provider tests exposed partial writes and response-loss races. Native process IDs, crash logs, image hashes, and real OS paste verified behavior beyond screenshots. Atomic queue guards, staged web writes, batched checkpoints, explicit draft replacement, and owned-file cleanup addressed the recurring mechanisms. Design review contributed without replacing technical verification.

## Changes to the workflow

1. Before publishing, map capture transitions across optimistic state, durable row, outbox, enrichment, file ownership, cancellation, and retry. Audit sibling paths together.
2. Keep a SHA-specific evidence ledger. Native acceptance requires process continuity/crash inspection as well as screenshots and durable content. Earlier `63a4f47` device/browser evidence must not be relabeled as final `88782c7` evidence.
3. Treat review quota failure as an unavailable gate, never approval. Obtain an explicit alternative review decision before merging.
4. Assign one accountable final owner. Verify merge authorization, update the PR body to actual results, and reconcile the issue state before declaring completion.

Existing follow-ups remain separate: [#938](https://github.com/stlim0727/stash/issues/938) for the pre-existing create-completion queue race and [#939](https://github.com/stlim0727/stash/issues/939) for the cold offline web shell. This retrospective changes documentation only; it does not establish a new defect or resolve those follow-ups.
