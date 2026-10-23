---
name: play-store-release
description: >-
  Build and publish Keepory Android releases through EAS and Google Play,
  including stable tags, localized notes, exact-build production promotion,
  and resuming an existing build. Also use for Play submission blockers and
  store setup; excludes the debug-signed sideload APK workflow.
---

# Keepory Play release

Use this procedure for an existing Play app. For first publication, policy
forms, signing setup, and native QA, read `docs/development/play-store.md`.
Use `versioning` and `docs/development/releasing.md` for version selection;
verify live state rather than assuming the last recorded version still applies.
Both agent mirrors use the shared helper `scripts/play-production-release.mjs`.

## Establish source, target, and authorization

- A user request to publish to production authorizes that release. A request
  to build, test, or edit this skill does not authorize a production rollout.
- Read `AGENTS.md` / `CLAUDE.md`; work in an isolated worktree for edits.
- Confirm package `com.keepory.app`, repo remote, app version, EAS production
  profile, submission track, latest stable tag, and changes since that tag.
  Check open PRs as required by `versioning`; do not silently merge unrelated work.
- Inspect Play tracks using a configured publisher credential path (never print
  key contents). `GOOGLE_APPLICATION_CREDENTIALS` or `--credentials` selects it.
  A prior environment used `/home/stlim/keepory-playstore.json`; verify the
  configured path exists rather than assuming it is portable.

```sh
node scripts/play-production-release.mjs inspect --credentials "$PLAY_KEY_PATH"
gh run list --repo stlim0727/keepory --workflow android-playstore.yml --limit 5 \
  --json databaseId,status,conclusion,headSha,url
```

`inspect` uses the read-only release-summary endpoint; it never creates an edit
and can run while EAS submits. Summaries contain release lifecycle state and
artifact codes, not the full notes or track rollout status. Do not replace this
with edit creation: a new edit invalidates another open edit by the same API
user. See [Google edit semantics](https://developers.google.com/android-publisher/edits).
Credential absence is not evidence Play is unavailable: check configured app
capabilities and bindings. Never extract GitHub secret values. Existing workflow
secrets can build remotely even when local EAS says "Not logged in".

## Prepare once

1. Choose the version from the actual change and release line. Changed shipped
   code needs a new marketing version; an identical rebuild can retain it.
   Respect maintenance-branch rules; do not hardcode the previous release number.
2. Keep `apps/mobile/app.json` `expo.version` and
   `apps/mobile/eas.json` `build.production.env.APP_VERSION` equal. Leave remote
   `autoIncrement` responsible for Android versionCode.
3. Write `docs/release-notes/vX.Y.Z.md` from user-visible changes since the last
   shipped tag. Prepare separate `en-US` and `ko-KR` texts, each <=500 characters.
   Save the API payload as JSON (see below), with no credentials in it.
4. Run local static gates; use CI for full suites. Open a regular PR and follow
   the repo review/merge rules. Tag the merged release commit, not an earlier
   local SHA. A clean tag also triggers the separate sideload release workflow;
   that APK is not the Play artifact.

The existing `prepare-eas-release.mjs` ignores Markdown locale headings and
writes the same combined text to both Fastlane changelog files. Generating those
files does **not** prove localized notes were attached to Play. This procedure
sets notes explicitly through the Publisher API and verifies them afterward.

## Build and monitor, or resume

Inspect `.github/workflows/android-playstore.yml` and `eas.json` before dispatch:
current workflow builds a production AAB but auto-submits to **internal**, not
production. Dispatch accepts `main` or `release/*`, not arbitrary feature branches
or tag refs. Check the selected branch SHA equals the intended tagged commit.

```sh
git tag -a vX.Y.Z RELEASE_SHA -m 'Keepory vX.Y.Z'
git push origin vX.Y.Z
gh workflow run android-playstore.yml --repo stlim0727/keepory --ref RELEASE_BRANCH -f version=vX.Y.Z
```

Record the resulting run ID, head SHA, tag, and intended version immediately.
On **resume**, query that run first. Do not redispatch just because it is slow.
The workflow repeats its checks before EAS. Builds can take tens of minutes;
the v1.2.8 build took about 46 minutes plus submission time. GitHub's downloadable
job logs can lag substantially while the job is active. That alone is not a hang.
Poll at roughly one-minute intervals, use short waits that permit user steering,
and give updates when stage/evidence changes without repeating empty status text.

```sh
gh run view RUN_ID --repo stlim0727/keepory --json status,conclusion,jobs
# When logs are available; use --allow-escape-sequences only if gh requests it:
gh run view RUN_ID --repo stlim0727/keepory --log
```

Do not dump full logs: filter for EAS build/submission URLs, versionCode,
completion, and errors. Record EAS build ID, artifact URL, and exact versionCode.
If the workflow fails, diagnose its failed step and query Play before retrying:
a submitted build can exist even when a later workflow step fails. An uncertain
network response is also a reason to inspect, not blindly repeat a write.

## Promote the exact uploaded build

Verify workflow success, source SHA, AAB identity/version, and the exact internal
release. Follow the repo's native smoke/pre-launch guidance; automated CI does
not prove native acceptance. Record unavailable device evidence honestly.

Prepare a UTF-8 JSON file with independently written notes, for example:

```json
[
  { "language": "en-US", "text": "• Improved bookmark sync reliability." },
  { "language": "ko-KR", "text": "• 북마크 동기화 안정성을 개선했습니다." }
]
```

First preview, replacing all sample arguments with inspected values. Preview
shows read-only summaries and the proposed notes; it is provisional. Exact track
status, code guards, and idempotence are checked inside the commit's edit:

```sh
node scripts/play-production-release.mjs promote --credentials "$PLAY_KEY_PATH" \
  --version X.Y.Z --code NEW_CODE --expected-production-codes OLD_CODE \
  --notes /tmp/play-release-notes.json
```

When production publishing is authorized, wait for EAS Submit and any other
publisher/Console operations to finish. Keep publisher operations serialized
through the entire promotion and readback. Then repeat with
`--commit --publisher-idle`: the latter acknowledges you verified this exclusive
window; it is not a distributed lock. The helper cannot discover another
publisher's open edit. Do not ask again if the request already authorizes the
rollout. An empty production track uses `--expected-production-codes ''`.

The commit uses `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, so an existing
review blocks publication instead of being cancelled. Do not remove this guard
to force publication. See [Google commit behavior](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit).

The helper checks the exact completed internal version/code, the expected current
production codes, increasing versionCode, and both locales. It replaces the
production track release with a `completed` release (full rollout), validates the
edit, commits once, then rereads production to verify version, code, status, and
notes. Staged, halted, draft, and multiple production releases are rejected;
use a separate reviewed approach for those cases. A repeated commit call
with the same already-published version/code/notes succeeds without a new commit.

On API policy/access errors, stop the rollout and report the concrete blocker.
Do not switch to draft, suppress review, or change rollout scope to force success.
After ambiguous commit failure, inspect before retrying. `completed` is a track
status, not proof the app is already visible to every user: Play review and
propagation may still apply.

## Completion / handoff

Report version + code, durable tag/SHA, build result/link, production readback,
locales attached, and any missing device evidence. If interrupted, hand off the
run ID, build ID/code if known, notes JSON path, and next unfinished step.
Never describe an internal upload or a queued build as a published production
release. Do not rebuild just to change release notes.
