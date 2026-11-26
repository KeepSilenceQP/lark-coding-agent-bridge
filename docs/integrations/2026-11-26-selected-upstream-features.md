# Selected upstream features — 2026-11-26

## Scope and provenance

Start from fork main `d3cdb0211eab354d6636706e40cd3d6ec633fd35` in an isolated branch/worktree. Select the four capabilities discussed with the operator; do not import unrelated OMP or Claude effort changes. These are open upstream PRs, not a new upstream main release. The upstream main synchronization anchor remains `5898681`.

| Capability | Upstream PR | Source commits | Adapted fork commits |
|---|---|---|---|
| Attachment batches | [351](https://github.com/zarazhangrui/lark-coding-agent-bridge/pull/351) | `b2c5a04` | `eeb02cb` |
| Terminal delivery when progress stalls | [347](https://github.com/zarazhangrui/lark-coding-agent-bridge/pull/347) | `d8a314d` | `d2d8a8b` |
| Meeting lifecycle, context and authorization | [348](https://github.com/zarazhangrui/lark-coding-agent-bridge/pull/348), [349](https://github.com/zarazhangrui/lark-coding-agent-bridge/pull/349), [350](https://github.com/zarazhangrui/lark-coding-agent-bridge/pull/350) | `eefbd32`, `8267d4a`, `a4441d9`, `a133e61`, `c3cc295` | `951390d`, `6c2afd2`, `912c52e`, `7d3402e`, `fe1cf85` |
| Inline local images | [340](https://github.com/zarazhangrui/lark-coding-agent-bridge/pull/340) | `a40b6bf` | `c9bbe94` |

Cherry-picks retain source attribution. A final integration commit contains fork-specific hardening, cross-feature regression tests and these notes.

## Behavior and integration decisions

### Attachment batches

At least `attachments.batchThreshold` accepted attachments in one debounced batch create a directory under the selected workspace's `.lark-batches/`. The default threshold is 3; `attachments.batchKeep` defaults to 20. Numbered, sanitized original file names link to the existing cache; `manifest.json` records accepted files, their original delivery indexes and rejected files with reasons. This is an index over the existing cache, not a second permanent copy. Cache expiry can invalidate links.

Keep the fork's workspace resolution, attachment policy, topic history bootstrap, reaction context, prompt bindings and session catalog. If batch indexing fails, the original per-file prompt paths still work. Reject a symlinked batch root; bound file-name characters and bytes, and sanitize the batch hash component. Rejected files remain in the normal attachment decisions even when too few files qualify for a directory.

### Stalled progress and final replies

Retain the fork's CoT side channel, startup/degraded notices, CardKit rollover/readback repair, reaction lifecycle correlation and thread routing. CoT still closes independently of terminal delivery.

For the non-CoT streaming path, coalesce progress updates in order without awaiting their network writes during agent event consumption. When an open stream fails or does not settle after terminal rendering, send the terminal state through the shared final sender. `LARK_CHANNEL_STREAM_TERMINAL_GRACE_MS` defaults to 3000; finite nonnegative values override it. Abandon pending progress writes and suppress late producers after fallback. A late rejection is observed and logged, not retried.

The fork keeps its eager progress/acknowledgment behavior rather than replacing it with upstream's lazy-stream architecture. It also keeps same-card readback repair and does not restore upstream's automatic recall of messages. An already in-flight network write cannot be canceled; it may leave a stale progress card visible, but cannot hold agent consumption or the next queued turn.

### Meeting agent

This extends the existing real meeting participant support. A complete forwarded meeting card in an authorized administrator's DM joins through the bridge manager. Meeting numbers may also be extracted from links and formatted text; ambiguous numbers are refused. Meeting chat sender identity is taken from the actual event operator.

Meeting chat and transcript contribute context, including chat-only meetings. Ignore bot self-echoes. Recognize a bot trigger anywhere with word/email boundaries. Handle meeting-gone code 122001 once, summarize once, and report failures to the owner. Resume live meeting records after reconnect/restart without replaying old questions as fresh requests. State records contain meeting identity/routing, not a persisted transcript; catch-up is supplied by the meeting API. Records older than 24 hours are dropped.

`meeting.enabled` remains opt-in and requires the existing Feishu meeting-agent scopes and platform availability. It is not enabled on the running profiles by this integration.

Authorization defaults: `access: dm-policy`, `executionAccess: read-only`, `elevateWord: ''`. Missing or unauthorized senders fail closed. `admins-only` restricts access further. A configured elevation word only works for an administrator and never exceeds the profile's maximum. `/meeting ask`, notes and summaries remain read-only. Permission changes retain the fork's policy/session isolation. A group-only guest grant does not become a DM or meeting grant. The web settings form preserves authorization fields when saving other settings.

### Inline local images

Final Markdown such as `Before\n![result](<./result image.png>)\nAfter` becomes one Feishu rich post with text, image, text in order. It works in text, Markdown and card modes, with or without CoT, preserving the originating topic. Code examples and remote image URLs are left alone; repeated references upload once per reply.

Only supported, nonempty image files within the real workspace, at most 10 MB each, are uploaded. Check real paths and the opened file identity, bound reads, and give image uploads a 15-second total budget per final reply. An upload failure is represented at its image position while retaining the rest of the answer. If rich-post delivery rejects, send the original Markdown text through the ordinary sender. The existing streaming card may remain as progress; final image delivery does not remove it.

## Acceptance

- Unit/integration fault injection covers ordered/coalesced updates, hanging create/update calls, terminal fallback, queued follow-ups, late completion, image upload timeout/failure, rich-post rejection, all reply modes, CoT and topic routing.
- Meeting tests cover event parsing, forwarding, meeting-number parsing, authorization/elevation, read-only entry points, chat-only context, self-echo filtering, meeting end, restart recovery and transient API failures.
- Existing fork access, selective group guests, sessions, reactions, callbacks, bootstrap, supervisor/restart and delivery tests are included in the full regression suite.
- Live meeting admission, real Feishu image rendering and production network failure behavior require runtime acceptance after deployment; local tests use fake APIs. No production profile or current service is changed by this branch.

### Local verification results

- `pnpm test`: 193 files passed; 2199 tests passed, 33 skipped (2232 total).
- The final additional unfinished-code-fence regression was then checked with `pnpm exec vitest run tests/integration/bot/local-images.test.ts`: all 6 tests passed.
- `pnpm typecheck`, `pnpm build` and `git diff --check`: passed.
- Validation is local macOS source/build validation. No CI, npm packaging/privacy gate, release or live deployment is claimed by this worktree.
