# Latest Sentry triage — 2026-11-16

Live Sentry project: `self-463/stash`. Latest main: `708818b`.
The three most recently active unresolved issues were investigated.

## STASH-87: TikTok preview

- Evidence bucket: `clear` after targeted inspection.
- Action bucket: `immediate-fix`.
- Similar-surface check: yes — canonical/shortlink previews, oEmbed, ordinary OG parsing.
- Build 42 / 1.4.0 (`708818b`) logs successful expansion to a video URL,
  no usable OG tags, and no title from direct or redirected oEmbed.
- Obscura opened the reported shortlink and exposed the requested video's
  caption and cover in `__UNIVERSAL_DATA_FOR_REHYDRATION__`, under
  `__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct`.
- Add a bounded, non-executing JSON fallback with exact video ID matching,
  successful provider status, and public image URL validation. Preserve OG priority.
- Verify malformed/truncated/wrong-video/unavailable data and integrated page parsing.
  This recovers caption/title and cover; it does not add a separate description field
  to the existing metadata contract. TikTok can still refuse to deliver video data.

## STASH-86: tags disappear while folder assignment arrives

- Evidence bucket: `enough-logs` plus a controlled store regression.
- Action bucket: `careful-fix`.
- Similar-surface check: yes — tag additions/removals, confirming pulls,
  account rehoming, and existing acknowledged-removal scheduling.
- Build 39 / 1.3.2 (`9384c32`) reports auto-accepted tags/folder with pulls
  taking roughly six seconds around the operation. Logs alone cannot prove
  the precise overlap in that event.
- Upload used to dequeue an add before an in-flight pull published its older
  organization snapshot. The local tag then disappeared until the next pull.
- Keep acknowledged adds layered like acknowledged removals. Skip re-upload,
  retire only when a real remote snapshot includes the association. Existing
  operation IDs protect later user edits; account rehoming resets confirmation.
- Verify a delayed pull overlapping a successful AI tag upload, visible tags
  after publication, durable confirmation, eventual retirement, and no re-upload.
  Existing removal tests continue to cover stale snapshot tombstones.

## STASH-K: JS loop stall

- Evidence bucket: `limited-hypotheses`.
- Action bucket: `instrument-first`.
- Similar-surface check: yes — watchdog lifecycle, React cycle measurement,
  synchronous preview parsing, and upload/pull segment telemetry.
- Latest event: 1.4.0 build 42 (`708818b`), roughly 57 seconds after startup,
  `syncing=false`, queue zero, 3130 ms delayed heartbeat on a two-CPU x86_64
  Android device. The 2738 ms React cycle ended roughly 44 seconds earlier;
  it cannot be called the cause of this stall. Emulator/test origin is plausible
  from device characteristics but unproven.
- The watchdog's stack is captured after the blocker unwinds. Do not change
  scheduling, thresholds, or suppress this report based on this evidence.
- Add content-free `bookmarks` and `aiInFlight` counts to the watchdog's
  existing error message, alongside `syncing`, `queue`, and `recentSlow`.
  These appear in future automatic Sentry events and local buffered logs.
- Root cause remains open. Reproduce on the affected Android configuration
  and capture a Hermes sampling profile before choosing a behavior change.

## Verification limits

Domain regressions and the controlled store overlap establish JavaScript behavior.
Obscura supplied live provider evidence; this is not standalone Android acceptance.
No claim is made that these fixes are deployed or that a Sentry issue is resolved.
