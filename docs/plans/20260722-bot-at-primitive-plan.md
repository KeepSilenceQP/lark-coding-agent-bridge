# Bot-to-Bot Native Mention Primitive Coding Plan

Date: 2026-07-22
Status: reviewed — R8 independent Plan Review PASS
Authority: `docs/specs/20260722-bot-at-primitive.md` (`confirmed — R7 independent review PASS`)
Bridge branch: `feat/bot-at-primitive` from `a6185f9`
Companion repository: `/Users/bytedance/repo/sayToLittleP` (`main@2efbb50`, clean at planning time)
Plan Writer: 小P
Plan Reviewer: independent SubAgent
Execution mode: direct repository work; this task does **not** run the sayToLittleP Harness

## Outcome

Add one three-argument command to `lark-channel-bridge`:

```bash
lark-channel-bridge at-bot \
  --chat-id oc_xxx \
  --bot-id ou_xxx \
  --message "Plan Review 已完成，请复审。"
```

The command stays stateless. It validates the target against the current group’s live Bot list, constructs one canonical Feishu post containing exactly one structured Bot mention plus one text element, sends with the current bridge-bound profile’s Bot identity, and reports success only after receiving a real `message_id`.

The same delivery updates the shared Bridge system prompt and sayToLittleP’s Harness / Task Brief contract so that weak models map `@ / mention / 通知 / 转交 / Return to / 完成后回给某 Bot` to this command instead of hand-writing mention XML or post JSON. No task state, ACK protocol, retry ledger, daemon IPC, fourth identity argument, or automatic return path is added.

## Repository And Commit Boundary

This feature has two source repositories but no cross-repository runtime state:

1. **Bridge repository** — current worktree and `feat/bot-at-primitive`
   - owns CLI implementation, shared system prompt, automated tests, build artifact, deployment, and runtime proof;
   - first checkpoint after Plan `PASS` commits the confirmed Spec and reviewed Plan before production code;
   - implementation lands in a later bridge commit so design documents and runtime diff remain reviewable.
2. **sayToLittleP repository** — create `feat/bot-at-primitive` from the then-current clean `main` before Unit 4
   - owns Harness wording, Task Brief wording, and Feishu Bot interop guidance;
   - produces a separate companion commit; it is not vendored, copied, or symlinked into the Bridge repository.

The final handoff records both commit SHAs. Either repository may be reviewed independently, but live close requires a Bridge artifact containing both CLI and Prompt plus a Task Brief generated from the companion revision.

## Current Evidence

### Bridge repository

- `src/cli/index.ts:28-69` owns Commander registration and async actions. Its top-level catch at the end of the file prints `Error: <message>` and exits nonzero, so the new command must throw already-sanitized, actionable errors.
- `src/platform/spawn.ts:10-15` provides argv-based `spawnProcess`. The installed `lark-cli` is a Node wrapper (`scripts/run.js`) that calls the native CLI through `execFileSync`; killing only the wrapper can leave the request subprocess alive. The new command therefore needs a bounded process-tree runner, not plain `spawnSync` timeout semantics.
- `src/project/dispatch.ts:84-157` demonstrates the current subprocess pattern for `lark-cli im chat.members bots`, JSON parsing, stderr capture, and a 20-second timeout. It is project-specific and currently uses `--as user`; the new primitive should not refactor this unrelated path.
- A planning-time bridge-bound read-only probe proved the command required by the Spec works with Bot identity: `lark-cli im chat.members bots ... --as bot --format json` exited `0` and returned this group’s `bot_id` / `bot_name` entries.
- `src/agent/bridge-system-prompt.ts:26-35` currently tells models to hand-write native mention payloads and uses `--as user` for discovery. Those lines are the replacement site; a second parallel rule block must not be appended elsewhere.
- `tests/unit/agent/bridge-system-prompt.test.ts:9-46` already owns semantic assertions for Bot collaboration rules. `tests/unit/agent/adapter-system-prompt-wiring.test.ts:45-148` proves Claude and Codex receive the shared prompt through their different adapters.
- `tests/unit/cli/index-registration.test.ts` statically verifies CLI registrations. There is no current `at-bot` module or test.
- `.github/workflows/ci.yml:8-11` runs the full suite on macOS, Ubuntu, and Windows; process-tree behavior must pass a real wrapper→child regression on all three rather than treating Windows as a mocked-only branch.
- The package entry is `bin/lark-channel-bridge.mjs → dist/cli.js`; source edits are not live until `pnpm build` and the participating daemon profiles are restarted or rolled to that artifact.

### sayToLittleP repository

- `HARNESS.md:84-99`, `templates/task-brief.md:1-21`, and the repository README’s confirmed authority `docs/2026-07-20-harness-core-workflow-spec.md:185-202` currently use the ambiguous label `Return to：小P` and do not tell a weak model that the target is a Bot or that it must invoke `at-bot`.
- `HARNESS.md:115-125` requires native mention but delegates operational details to `foundation/feishu-bot-interop/`.
- `foundation/feishu-bot-interop/lark-channel-bridge飞书群协作接入与行为规则.md:31-45` still describes direct structured-mention construction rather than the new primitive.
- `foundation/feishu-bot-interop/Bot接入验收清单.md:52-92` already defines sender mapping, mention readback, nonce continuity, and target receipt evidence; it needs to name `at-bot` as the send path while retaining user-identity message readback.

## Design Decisions

### DD1 — A self-contained CLI command with a bounded process-tree seam

Add `src/cli/commands/at-bot.ts` plus a small internal `src/cli/commands/at-bot-process.ts`. Export a testable `runAtBot(options, deps?)`; its production dependency invokes `lark-cli` through the bounded runner, while tests inject or mock the runner. Keep both files local to this command instead of changing `src/project/dispatch.ts`, because project bootstrap’s discovery identity and error behavior are outside this feature.

Command registration in `src/cli/index.ts` uses three `requiredOption` declarations and prints exactly one JSON success object returned by `runAtBot`:

```json
{"ok":true,"chatId":"oc_xxx","botId":"ou_xxx","messageId":"om_xxx"}
```

Runtime validation order:

1. Require `LARK_CHANNEL === "1"`; if absent, fail before spawning. Preserve the full inherited environment unchanged. Do not unset, rebuild, or fall back to another profile. Missing or invalid projection variables are allowed to reach bridge-aware `lark-cli`, whose “context detected but not bound” failure is returned as a blocker.
2. Validate `chatId` as nonempty `oc_...`, `botId` as nonempty `ou_...`, and `message.trim()` as nonempty while preserving the original message bytes for the payload.
3. Invoke `lark-cli` with an argv array to read `im chat.members bots`, fixed `--as bot`, and `--format json`. A valid envelope is an object with `ok === true`, `identity === "bot"`, optional `code` either absent or the number `0`, and the stage-specific `data` shape. Missing fields, wrong types, unknown envelopes, malformed JSON, `ok !== true`, `identity !== "bot"`, or a present nonzero/non-numeric `code` fail closed. Discovery additionally requires an exact `data.items[].bot_id === botId` item with a nonempty `bot_name`; the name and ID used later must come from that same live item.
4. Construct the canonical post in TypeScript objects, then `JSON.stringify` once. The caller cannot provide message type, identity, title, elements, or prebuilt content.
5. Invoke `lark-cli im +messages-send` with an argv array, fixed `--as bot --msg-type post --format json`, and the serialized canonical post as one argv value.
6. Return success only when the send envelope satisfies the same strict predicate and `data.message_id` is a nonempty `om_...`. A zero subprocess exit with an incomplete/unknown envelope or missing message ID is still failure.

Canonical content:

```json
{
  "zh_cn": {
    "title": "",
    "content": [[
      {"tag":"at","user_id":"<validated-bot-id>","user_name":"<live-bot-name>"},
      {"tag":"text","text":" <original-message>"}
    ]]
  }
}
```

The bounded runner calls `spawnProcess` with `shell:false`, argv values, piped UTF-8 stdout/stderr, and `detached:true` on POSIX so the wrapper and native CLI share a new process group. Each stage has a 20-second execution timeout and 1 MiB cap per output stream. Its explicit state is `running → terminating(reason) → settled`:

- the original child’s `exit` event only records exit code/signal; normal success/failure parsing occurs only after that child’s `close`, so stdout/stderr are fully drained. The 20-second execution timer starts at spawn and remains armed through `exit` until original `close`; `exit` never clears it;
- a spawn `error` locks the fixed `unavailable` cause. With no child PID it never attempts tree kill and waits at most 5 seconds for `close` before settling unavailable; with a PID it performs the normal one-shot tree termination, and failure to confirm `close` becomes `termination-unconfirmed`;
- the first timeout or output-overflow cause is immutable, triggers tree termination exactly once, and suppresses later success even if an `exit` races with the timer;
- POSIX termination uses `process.kill(-child.pid, 'SIGKILL')` with direct-child fallback;
- Windows termination uses native `taskkill.exe /PID <pid> /T /F` only while the original wrapper has not emitted `exit`, with `spawnProcessSync`, argv only, a 5-second timeout, `SIGKILL`, and a small output cap. Because taskkill is the native tree terminator rather than the Node wrapper, the sync call reaps taskkill before returning. If the wrapper has already emitted `exit` but not `close`, its PID is no longer a reliable tree root; the runner must not claim tree cleanup and settles `termination-unconfirmed` after local bounded cleanup. Taskkill timeout/error/nonzero has the same category, and no asynchronous taskkill process is left to execute later;
- after a successful kill request, the runner waits up to 5 seconds for the original child’s `close`; taskkill spawn failure/nonzero/timeout, POSIX kill failure, or missing original `close` becomes the fixed `termination-unconfirmed` category, never an ordinary timeout;
- final settle clears execution/termination timers and all listeners exactly once. On `termination-unconfirmed`, it destroys local pipes and unreferences the child so the CLI can return the stronger blocker, and the caller must not retry automatically because an external side effect remains possible.

A test-only dependency may lower timeout/output limits; production CLI exposes no override. Unit tests cover spawn `error` with and without PID, missing close after spawn error, `exit` before `close`, timeout racing with `exit`, overflow racing with timeout, taskkill success/failure/timeout/reap, missing original `close`, and one-settle cleanup. A real early-exit/held-pipe fixture proves the timer remains armed: on POSIX the surviving process group is killed and closes; on Windows the runner returns `termination-unconfirmed` without pretending the extinct wrapper PID can kill its orphan, after which the test harness cleans up the fixture child out of band.

No `sh -c`, `node -e`, command substitution, or text/XML fallback is permitted. A discovery failure must not call send. A send timeout or unconfirmed termination is an ambiguous external result; both return a fixed blocker and never retry automatically.

### DD2 — Stable failure categories without raw diagnostic leakage

The command throws concise fixed errors in these categories: bridge context missing/unbound, invalid argument, target absent or unusable in the current group Bot list, discovery unavailable/timeout/invalid response, send unavailable/timeout/rejected/invalid response, and process-tree termination unconfirmed.

Every category has a stable CLI-visible prefix and action; optional API detail is limited to a numeric code:

| Category prefix | Fixed action |
| --- | --- |
| `at-bot/context-missing` | run only from a bridge-bound Agent |
| `at-bot/context-unbound` | restart the Bridge or run doctor/preflight |
| `at-bot/invalid-argument` | correct the named CLI option |
| `at-bot/target-not-in-group` | verify the target Bot in the current group |
| `at-bot/discovery-unavailable` / `discovery-timeout` / `discovery-invalid` | restore current-profile Bot discovery; do not send |
| `at-bot/send-unavailable` / `send-timeout` / `send-rejected` / `send-invalid` | notification is not confirmed; do not claim success |
| `at-bot/termination-unconfirmed` | a child tree may remain; do not retry automatically |

Tests assert the exact prefix/action pair for every row and permit only an optional numeric `[code=N]` suffix.

Never echo child/API prose. Parsing recognizes both the live success envelope and failure forms including top-level `msg` and nested `error.code` / `error.message`, but uses their text only for internal classification. If stdout, stderr, nested error text, or spawn error contains the exact known “lark-channel context detected but not bound” marker, return one fixed instruction to restart the Bridge or run doctor/preflight. Every other failure returns only a fixed category plus an optional numeric API code; it never includes original stdout, stderr, JSON message, spawn message, stack, token-like fragment, or truncated raw response. This removes dependence on a redactor correctly recognizing arbitrary bare credentials.

Tests place a bare token-like string, JSON credential field, URL token, stderr secret, spawn-error secret, top-level `msg` secret, and nested `error.message` secret in separate fixtures. All must produce fixed output with none of the source text; the unbound marker from any child channel must map to the same fixed doctor/preflight instruction.

The command does not claim the target processed the task. Its only positive claim is that Feishu returned a message ID for the structured send.

### DD3 — Replace the shared Prompt rule, do not add a competing rule

Edit the existing Bot-to-Bot section in `src/agent/bridge-system-prompt.ts`:

- map all explicit Bot handoff phrases (`@`, `mention`, `通知`, `转交`, `Return to`, `完成后回给`) to the single `lark-channel-bridge at-bot` command;
- include the exact three-argument template and parameter mapping:
  - current `bridge_context.chatId → --chat-id`;
  - live-validated target `bot_id → --bot-id`;
  - the current result or blocker → `--message`;
- when returning to the Bot sender, use `senderId` only as a candidate if `senderType=bot`; when targeting a different Bot explicitly present in inbound structured mentions, use that `openId` only as a candidate; otherwise query the current group with the fixed Bot-identity bot-list command and use NFC-normalized unique full-name matching;
- if a sender/explicit-mention candidate ID does not match the current live list, the only fallback is the `senderName` or mention `name` belonging to that same inbound object. NFC-normalize it and require exactly one full-name match in the current list; use only that live item’s `bot_id`. Missing name, zero matches, or multiple matches is a blocker;
- explain that inbound `mentions` normally contains the Bot being awakened, not automatically the Bot that should receive the return message;
- forbid `botOpenId`, the current Bot’s own mention, or `mentions[0]` as an assumed target; self-target requests stop at the Agent layer because v1 deliberately has no CLI-level self identity source;
- remove direct `lark-cli ... +messages-send`, `<at>`, and hand-built post examples. Plain final text containing `@名字` is not notification.

Keep the existing default no-loop rule and blocked behavior. The shared prompt remains the single semantic source consumed by both Claude and Codex; no adapter-specific duplicate text is added.

### DD4 — Companion Harness and Task Brief revision

In a separate sayToLittleP branch/commit:

- change the Harness skeleton and template to `Return to：<目标名> (Bot)`;
- place directly beside it: `完成后必须用 lark-channel-bridge at-bot 回传；普通最终文本不算通知`;
- state that `senderType=bot && Return to is sender` uses `senderId` as the candidate, otherwise the model performs current-group live Bot discovery and unique name matching;
- state that inbound `mentions` describes who the inbound message actually mentioned—normally the current Bot that was awakened—and must not default `mentions[0]` or the current Bot’s mention to the return target. Only a specifically designated different Bot’s mention is a candidate, and every candidate still requires current-list validation;
- state that a sender or explicit-mention candidate ID which misses the current list may fall back only through that same inbound object’s name and a unique NFC-normalized full-name match; use the matched live `bot_id`, and block on a missing/zero/ambiguous name;
- state that a nonzero command result is a notification blocker and cannot be reported as “already notified”.

Update the Feishu Bot interop README, lark-channel-bridge guide, and acceptance checklist so they neither teach a competing hand-built send path nor say that an arbitrary inbound mention is the preferred return target. The guide points to `at-bot` for sending, keeps `chat.members bots --as bot` only for name-to-ID discovery, and retains `+messages-mget --as user` for independent readback. The checklist adds the actual `at-bot` argv and success `messageId` to the evidence record; it continues to require sender `app_id` mapping, mention target mapping, nonce continuity, and target intake/reply.

These are documentation-contract changes only. Do not add Harness state, scripts, initialization commands, validators, or a runtime dependency from Bridge to sayToLittleP.

### DD5 — Self-target remains an explicit v1 upper-layer boundary

The command cannot reliably resolve its own Bot `open_id` through the current standalone CLI: planning-time probes showed `whoami --as bot` exposes profile/App ID, while generic `/open-apis/bot/v3/info` exposes no `bot.open_id`. Therefore:

- Prompt and Harness reject a target equal to `bridge_context.botOpenId`;
- controlled Agent tests include a self-target negative case and require no `at-bot` call;
- the CLI still validates that the requested target is a live Bot in the group, but does not pretend it can distinguish self;
- no daemon IPC, environment expansion, static ID, or fourth parameter is introduced.

This is a documented residual risk for arbitrary manual CLI callers, not an authorization boundary.

## Execution Units

Units 1–4 are implementation units. Each unit must pass its own Gate before the next. After all four units and full self-check, an independent Code Review must return `GO` before Unit 5 live rollout. This direct workflow does not use the sayToLittleP Harness.

### Unit 0 — Freeze reviewed design documents

Bridge files:

- `docs/specs/20260722-bot-at-primitive.md`
- `docs/plans/20260722-bot-at-primitive-plan.md`

After Plan Review `PASS`, set this Plan status to reviewed and commit the two documents on `feat/bot-at-primitive` before production edits. Record that commit as the implementation authority. Do not rewrite confirmed behavior silently during coding; a material requirement change returns to Spec.

Gate:

- Spec says `confirmed — R7 independent review PASS`;
- Plan says independent Plan Review `PASS`;
- `git diff --check` passes;
- bridge branch and clean/owned worktree state are recorded.

### Unit 1 — RED: CLI contract and Prompt contract tests

Bridge test files:

- add `tests/unit/cli/at-bot-process.test.ts`;
- add `tests/unit/cli/at-bot.test.ts`;
- update `tests/unit/cli/index-registration.test.ts`;
- update `tests/unit/agent/bridge-system-prompt.test.ts`;
- update `tests/unit/agent/adapter-system-prompt-wiring.test.ts` only where needed to assert the changed prompt reaches both adapters.

Add failing coverage before production edits:

- three Commander options are required and `at-bot --help` exposes only the intended business parameters;
- missing bridge context, invalid `oc_`/`ou_`, and blank message fail before any child process;
- discovery argv uses current inherited env, `--as bot`, exact `chat_id`, JSON output, and no shell;
- target absent or target item missing a usable name fails without calling send;
- send argv uses fixed Bot identity, post type, canonical content, and no shell;
- quotes, newlines, angle brackets, `</a>`, fake `<at>`, and plain `@name` in the message remain in the sole text element; the payload still has exactly one `at` element and one `text` element;
- discovery/send spawn error, hard timeout, output overflow, nonzero exit, invalid JSON, missing/wrong-type `ok` or `identity`, nonzero/non-numeric API code, wrong `data` shape, and missing `message_id` all fail without success JSON;
- one platform-conditional real regression fixture runs on macOS, Linux, **and Windows** with a wrapper that remains alive while its heartbeat child runs: timeout must remove both PIDs, stop heartbeat, emit one final original `close`, and settle once. Additional abstraction cases verify Windows `taskkill /T /F` spawn/nonzero/timeout or missing original `close` becomes `termination-unconfirmed`. Discovery timeout additionally proves send is never attempted;
- a second three-platform variant makes the wrapper exit immediately while the heartbeat child retains inherited stdout/stderr. POSIX must still kill the surviving process group and close boundedly. Windows must return `termination-unconfirmed`, must not claim ordinary timeout/success, and must not retry; the test then kills its known fixture child out of band and proves the test suite leaves no process behind;
- runner race tests prove normal parsing waits for original `close`, terminal cause is immutable, output is drained before parse, and every path settles/cleans up exactly once;
- live-style top-level and nested failure envelopes are parsed, but bare/JSON/URL credential strings in `msg`, nested `error.message`, stderr, and spawn errors never appear in CLI-visible output; known unbound markers map to one fixed instruction;
- a table-driven failure test covers every DD2 prefix/action pair, including spawn-error unavailable, target absent, discovery/send timeout/invalid/rejected, unbound, and termination-unconfirmed; only an optional numeric API code may vary;
- success returns only `{ok, chatId, botId, messageId}` using the real response ID;
- Prompt contains the six natural-language trigger forms, exact argv template, all three parameter mappings, sender/mentions/name-discovery paths, self-target stop, and plain-text/manual-payload prohibitions;
- Prompt tests cover candidate-ID mismatch fallback for both a Bot sender and an explicitly mentioned target: unique same-object name match uses the current live `bot_id`; missing name, zero match, and duplicate full-name matches block;
- Prompt no longer contains direct `+messages-send`, `<at user_id=`, or hand-built post mention instructions;
- Claude and Codex adapter tests observe the revised shared semantics.

Gate: focused tests fail for the missing command and revised Prompt for the expected reasons; baseline unrelated tests remain unchanged.

### Unit 2 — Implement the `at-bot` primitive

Bridge production files:

- add `src/cli/commands/at-bot-process.ts`;
- add `src/cli/commands/at-bot.ts`;
- update `src/cli/index.ts`.

Implement DD1/DD2 exactly. Keep process-tree lifecycle in `at-bot-process.ts`, and keep parsing, canonical post construction, strict response validation, and stage sequencing in `at-bot.ts`. Use existing argv-based `spawnProcess`; do not refactor project bootstrap discovery or add persistent configuration.

Gate:

```bash
pnpm exec vitest run \
  tests/unit/cli/at-bot-process.test.ts \
  tests/unit/cli/at-bot.test.ts \
  tests/unit/cli/index-registration.test.ts
pnpm typecheck
pnpm build
node dist/cli.js at-bot --help
```

The help output shows the three required options. Unit tests prove no send occurs before live target validation and no success occurs without a real message ID.

### Unit 3 — Update and verify the shared Bridge system prompt

Bridge files:

- `src/agent/bridge-system-prompt.ts`;
- `tests/unit/agent/bridge-system-prompt.test.ts`;
- `tests/unit/agent/adapter-system-prompt-wiring.test.ts` if its existing whole-prompt assertions need stronger semantic checks.

Replace the existing manual send guidance per DD3. Do not append a second Bot-to-Bot protocol and do not alter unrelated OAuth, CardKit, group prompt, or bridge context rules.

Gate:

```bash
pnpm exec vitest run \
  tests/unit/agent/bridge-system-prompt.test.ts \
  tests/unit/agent/adapter-system-prompt-wiring.test.ts \
  tests/process/claude-adapter.test.ts \
  tests/process/codex-adapter.test.ts
```

Assertions prove both adapters receive the same new command mapping and that no old manual mention send example remains.

### Unit 4 — Update sayToLittleP’s contract surfaces

Before editing, verify `/Users/bytedance/repo/sayToLittleP` is clean and create its own `feat/bot-at-primitive` branch from current `main`.

Companion files:

- `HARNESS.md`;
- `templates/task-brief.md`;
- `docs/2026-07-20-harness-core-workflow-spec.md` (confirmed authority referenced by the repository README);
- `foundation/feishu-bot-interop/README.md`;
- `foundation/feishu-bot-interop/lark-channel-bridge飞书群协作接入与行为规则.md`;
- `foundation/feishu-bot-interop/Bot接入验收清单.md`.

Apply DD4 without changing Harness roles, lifecycle, authority, or state. Review the final tree for stale instructions that still tell a model to hand-write `<at>`, post mention JSON, or direct `+messages-send` for Bot handoff.

The active/normative/executable Markdown set is explicit: `README.md`, `AGENTS.md`, `HARNESS.md`, `templates/*.md`, `roles/*.md`, the confirmed `docs/2026-07-20-harness-core-workflow-spec.md`, and all `foundation/feishu-bot-interop/*.md`. `CHANGELOG.md` and `docs/2026-07-20-harness-core-workflow-plan.md` are historical/non-authoritative; any other tracked Markdown discovered during implementation must be classified before review rather than silently omitted.

After the companion edits are committed, record `COMPANION_SHA` and scan **all tracked Markdown at that exact commit**, not only the edited directories, for `Return to[：:]`, `完成后...通知/回给`, `mention`, `<at`, `tag...at`, `messages-send`, `chat.members bots`, and `messages-mget`. Attach a row-for-row inventory to the independent Code Review evidence with commit SHA, `path:line`, classification, owner, and action. Allowed classifications are: `active-at-bot-contract`, `historical-non-authoritative`, or `allowed-discovery/readback`. An unclassified hit or an active hand-built send instruction fails Unit 4. This inventory is review evidence, not new Harness runtime state.

Gate:

- `Return to：<目标名> (Bot)` and the mandatory `at-bot` sentence appear in both Harness and template;
- the confirmed workflow Spec either uses the same skeleton or removes its duplicate skeleton and explicitly delegates to current `HARNESS.md` / `templates/task-brief.md`;
- the foundation guide contains the exact three-parameter command and parameter sources;
- both the interop README and bridge guide state that inbound `mentions` only records accounts actually mentioned, forbid defaulting `mentions[0]`/the current Bot’s own mention to the return target, and allow only a specifically designated different Bot mention as a live-validated candidate;
- direct send commands remain only where they are explicitly independent readback/setup operations, never as the model’s Bot notification path;
- the acceptance checklist records command result, sender mapping, structured mention, nonce, and target receipt;
- `git diff --check` passes in the companion repository;
- neither full-width nor ASCII `Return to` forms in current normative/executable documentation retain a concrete `小P` skeleton without the `(Bot) + at-bot` obligation; any historical hit is labeled non-authoritative in the review inventory;
- every full-repository scan hit is present in the review inventory, and the complete active set (including root `README.md`, `AGENTS.md`, templates, roles, confirmed Spec, and interop docs) contains no `<at>`, hand-built `tag:"at"`, or direct `messages-send` Bot-notification instruction;
- the active set contains no rule equivalent to “目标身份优先取自当前消息的 mentions”; static checks and row-level review evidence confirm sender/explicit-other-Bot/name-discovery semantics match DD3/DD4;
- a separate companion commit SHA is recorded before the scan, and the inventory plus mechanical checks name that same SHA.

### Full Build And Independent Code Review Gate

Bridge self-check:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Then an independent SubAgent that did not implement the code reviews:

- confirmed Spec and reviewed Plan;
- both repository diffs and commit boundaries;
- subprocess argv and environment handling;
- process-tree timeout/kill/output-bound behavior and strict success-envelope parsing;
- canonical post shape and response parser;
- failure/redaction behavior;
- Prompt semantics for weak models;
- absence of stale manual mention guidance;
- targeted and full test results.

Any material finding returns to the owning repository and then to independent re-review. Unit 5 cannot start until Code Review is `GO`.

Because the process-tree contract is OS-specific, Unit 5 also waits for the pushed Bridge revision’s GitHub Actions matrix to pass on `macos-latest` and `ubuntu-latest` at full baseline, and on `windows-latest` with the focused `at-bot` process-tree tests, `typecheck`, and `build`. The full Windows test suite contains pre-existing baseline failures (unchanged files: O_NOFOLLOW, SIGTERM, command fixtures) that are outside this PR’s scope and are tracked as non-blocking evidence. The Windows Gate requires: (a) all focused unit tests in `tests/unit/cli/at-bot-process.test.ts` and `tests/unit/cli/at-bot.test.ts` pass; (b) `tsc --noEmit` passes; (c) `pnpm build` passes. A local macOS pass or mocked Windows taskkill test cannot substitute for the real Windows wrapper→child timeout regression.

**Windows observational boundary**: Node on Windows closes inherited pipes on `process.exit()`, so the held-pipe early-exit scenario (wrapper exits before timeout, child holds pipe, runner timer kills orphan) cannot be reproduced at the process-tree level. The runner’s `close` event fires on the normal `exit→close` lifecycle; at close time there is no portable signal to distinguish "normal completion with no orphans" from "wrapper exited early leaving live descendants." The Windows early-exit real fixture therefore accepts `settled=exit` as the correct runner behaviour on this platform, and instead proves cleanup correctness by: (a) capturing the child PID and verifying it is alive (`!pidDead`) before out-of-band cleanup; (b) killing the child via `taskkill /T /F` in `finally`; (c) asserting the child is dead after cleanup. The mock tests cover the `hasPid=false → killTree → termination-unconfirmed` contract separately. This boundary must be re-evaluated if a future Node or Windows version provides reliable orphan detection at close time.

### Unit 5 — Artifact rollout and controlled weak-model / dual-Bot Gate

Owner: 秦鹏 + 小P. Implementation support may provide builds, entry-path discovery, config readback, and logs, but may not declare live acceptance from unit tests alone.

Preflight:

1. Choose one caller profile and one target profile in a test group; record profile names, Bot open IDs, App IDs, current daemon PIDs/commands, artifact revision, and rollback commands.
2. Read back target group access and `groupResponseMode`. The target group must pass the target profile’s existing `canUseGroup` gate; native mention must be eligible for the existing `mentioned-bot` response path. The pure-text negative control is valid only while the target is in `mention-only`, so choose such a profile or make a recorded temporary mode change and restore it after the test. If the target remains in `all-messages`, `owner-default`, or `owner-allowlist`, do not interpret ordinary-message intake as a mention failure. Do not widen or bypass access policy as an implicit test workaround.
3. Deploy one Bridge artifact containing both `at-bot` and the revised shared Prompt to both participating profiles. Restart/roll each daemon and verify the new PID and actual command line resolve to the expected revision.
4. Verify `lark-channel-bridge at-bot --help` inside the same bridge-bound environment and perform Bot-identity group discovery. CLI availability in an unrelated shell is insufficient.
5. Use a Task Brief produced from the known sayToLittleP companion revision, even though the Harness is not orchestrating this implementation.

Controlled behavior matrix, using unique nonces and preserving Agent tool-call/transcript evidence:

| Instruction to caller Agent | Expected command behavior |
| --- | --- |
| `Return to：<sender> (Bot)` from a Bot sender | calls `at-bot` with current `chatId`, validated sender candidate, and result/blocker |
| `完成后通知 <different Bot>` where the target is explicitly mentioned | calls `at-bot` with that target after live validation |
| `mention <Bot display name>` where target is not in inbound mentions | queries current group Bot list, unique NFC exact match, then calls `at-bot` |
| Bot sender candidate ID misses live list, but the same inbound `senderName` uniquely matches | replaces the candidate with that live item’s `bot_id`, then calls `at-bot` |
| explicitly mentioned target ID misses live list, but that mention’s own name uniquely matches | replaces the candidate with that live item’s `bot_id`, then calls `at-bot` |
| candidate ID misses and the same object has no name, zero name matches, or duplicate matches | reports blocker; no send |
| duplicate/missing target name | reports blocker; no send |
| target equals `bridge_context.botOpenId` | stops; no `at-bot` call |
| plain final text `@BotName` control while target is `mention-only` | target records `mention-required` policy skip and produces no run/reply |

For each positive case, assert the observed tool argv uses the current turn’s `bridge_context.chatId`, the live-validated target `bot_id`, and the requested result/blocker message. No direct `lark-cli ... +messages-send`, hand-built payload, or plain-text-only notification is acceptable.

For at least one positive dual-Bot case, close the message-level evidence chain:

1. record caller profile App ID before send;
2. capture the CLI success JSON and real `messageId`;
3. read back that same message and nonce;
4. prove `sender.id` / `sender.id_type` maps to the caller profile;
5. prove the canonical post’s structured mention maps to the target Bot;
6. prove the target profile receives the same message ID/nonce and enters intake; if a reply is used as proof, map its sender and relation to the sent message.

Runtime `PASS` requires artifact/PID proof, Task Brief revision, actual Agent command selection, message readback, and target intake. A successful send API response alone is not enough.

## Verification Commands

Bridge repository:

```bash
pnpm exec vitest run \
  tests/unit/cli/at-bot-process.test.ts \
  tests/unit/cli/at-bot.test.ts \
  tests/unit/cli/index-registration.test.ts \
  tests/unit/agent/bridge-system-prompt.test.ts \
  tests/unit/agent/adapter-system-prompt-wiring.test.ts \
  tests/process/claude-adapter.test.ts \
  tests/process/codex-adapter.test.ts
pnpm typecheck
pnpm test
pnpm build
node dist/cli.js at-bot --help
git diff --check
```

Companion repository:

```bash
git diff --check
COMPANION_SHA=$(git rev-parse HEAD)
git grep -nE 'Return to[：:]|完成后.{0,24}(通知|回给)|mention|<at|tag.{0,12}at|messages-send|chat\.members bots|messages-mget' "$COMPANION_SHA" -- '*.md'
ACTIVE_DOCS=(
  README.md AGENTS.md HARNESS.md templates/*.md roles/*.md
  docs/2026-07-20-harness-core-workflow-spec.md
  foundation/feishu-bot-interop/*.md
)
if git grep -nE '(<at|tag.{0,12}at|messages-send)' "$COMPANION_SHA" -- "${ACTIVE_DOCS[@]}"; then
  echo 'active manual Bot-send contract remains' >&2
  exit 1
fi
if git grep -nE '目标身份优先.{0,24}(mentions|结构化 mention)|mentions(\[0\]| 第一项).{0,24}(目标|回传)' "$COMPANION_SHA" -- "${ACTIVE_DOCS[@]}"; then
  echo 'unsafe inbound-mention target rule remains' >&2
  exit 1
fi
for REQUIRED_DOC in \
  foundation/feishu-bot-interop/README.md \
  foundation/feishu-bot-interop/lark-channel-bridge飞书群协作接入与行为规则.md; do
  git show "$COMPANION_SHA:$REQUIRED_DOC" | rg -F 'mentions 只描述入站消息实际 @ 到的账号'
  git show "$COMPANION_SHA:$REQUIRED_DOC" | rg -F '不得把 mentions 第一项'
done
```

Runtime readback commands and service operations are resolved from the live profiles at Unit 5; do not hard-code a stale global binary or daemon manager in this Plan.

## Rollback

- **Bridge artifact**: restore the recorded previous artifact/entry path for each participating profile and restart only those profiles. Verify PID, command line, and startup logs after rollback.
- **Prompt**: the previous artifact restores the previous shared prompt with the binary. There is no prompt migration or persistent session state owned by this feature; start a new turn/session when validating the rolled-back prompt.
- **sayToLittleP**: revert the companion documentation commit independently. A Bridge rollback does not require changing Harness state because none was introduced.
- **Messages already sent**: rollback cannot unsend a Feishu message. The feature stores no ledger, Bot ID cache, or config data to clean.

## Known Risks And Explicit Non-Goals

- An arbitrary human shell caller can target the current Bot because the v1 command has no reliable self-open-ID source. The supported Agent path rejects self-target from `bridge_context.botOpenId`; adding IPC or another argument is deferred.
- Prompt compliance is probabilistic. The three-layer wording and controlled behavior Gate reduce weak-model errors but do not claim runtime enforcement that a model must call the command.
- Group Bot list and open IDs remain app/profile-scoped evidence. The primitive validates in the current profile at send time and does not persist IDs.
- A valid structured mention can still be rejected by the target’s existing group access policy. Unit 5 treats target access as an explicit preflight, not a reason to bypass policy.
- v1 does not retry after ambiguous send failures because retrying could duplicate a message. It reports failure and leaves the decision to the visible caller.
- On Windows, if the `lark-cli` wrapper exits before `close` while an orphan request process still owns inherited pipes, plain `taskkill /T` can no longer use the extinct wrapper PID as a tree root. v1 reports `termination-unconfirmed`, never claims cleanup, and forbids automatic retry; adding Job Object/native supervisor ownership is deferred rather than hidden behind a false guarantee. The current installed wrapper uses blocking `execFileSync`, so the ordinary timeout path remains covered by the real Windows tree-kill test.
- No configuration schema, response-mode implementation, session protocol, CardKit behavior, or existing project bootstrap dispatch is changed. Unit 5 may temporarily select an existing `mention-only` mode for the negative control and must restore the recorded prior value.

## Review History

- **R1 `CONDITIONAL`**: (1) the Plan omitted the confirmed Spec’s same-inbound-name fallback when a sender or explicit-mention candidate ID misses the current live Bot list; DD3/DD4, Prompt tests, and Unit 5 now require unique NFC full-name fallback from that same object and block missing/zero/ambiguous matches. (2) the pure-text negative control could legitimately intake under non-mention response modes; Unit 5 now records `groupResponseMode` and runs that control only in `mention-only`, requiring a `mention-required` skip and no run/reply.
- **R2 `CONDITIONAL`**: (1) the confirmed sayToLittleP workflow Spec retained the old `Return to：小P` skeleton; Unit 4 now updates or delegates that authority and inventories all tracked Markdown. (2) the async subprocess wording did not close timeout/settlement lifecycle; the Plan initially changed to `spawnProcessSync`. (3) success envelopes and parsed API error redaction were underspecified; DD1/DD2 and RED tests now require exact `ok:true + identity:bot + optional numeric code 0 + stage data` and redact every child-derived error source before truncation.
- **R3 `BLOCKED`**: (1) live evidence showed `lark-cli` is a Node wrapper around a native child, so sync timeout can kill only the wrapper while the request survives; the R2 runner choice is withdrawn. DD1/Units 1–2 now require an argv-only process-group/tree runner plus a real wrapper→child timeout regression test. (2) the stale-contract scan was only partial and non-enforcing; Unit 4 now scans all tracked Markdown, requires a row-for-row classification in Code Review evidence, and mechanically rejects manual-send instructions in active authority files.
- **R4 `CONDITIONAL`**: (1) the process-tree runner lacked an explicit `exit`/`close`/tree-kill failure state table; DD1 now makes original `close` the only normal settle point, bounds Windows taskkill and close confirmation, preserves the first terminal cause, and adds race/cleanup tests. (2) the active sayToLittleP set omitted root `README.md`/`AGENTS.md` and was not bound to a revision; Unit 4 now defines the full active set and runs both inventory and hard checks against the recorded companion commit SHA. (3) real lark-cli failures may use nested `error.message`, and arbitrary bare secrets are unsafe to echo; DD2 now returns only fixed categories, recognizes unbound markers without echoing source text, and tests top-level/nested/stderr/spawn credential vectors.
- **R5 `CONDITIONAL`**: (1) Windows tree termination was mocked only despite the repository’s three-OS CI; Unit 1 now runs the real wrapper→heartbeat-child timeout regression on macOS, Linux, and Windows, and Unit 5 waits for all three CI jobs. (2) spawn `error` lacked a state transition; DD1 now locks `unavailable`, avoids kill without a PID, bounds missing-close behavior, and routes PID-bearing failures through tree termination. (3) fixed errors were not asserted category by category; DD2 now defines stable prefix/action pairs and table-driven tests, with only optional numeric API code variability and no child prose.
- **R6 `CONDITIONAL`**: (1) an early wrapper `exit` could clear or escape the execution timeout while a descendant held pipes; DD1 now keeps the timer armed until original `close`, reaps bounded native taskkill, and adds a real three-platform early-exit/held-pipe regression. (2) active interop docs still preferred arbitrary inbound mentions as targets; DD4/Unit 4 now require the correct sender/specified-other-Bot/name-discovery semantics and add commit-bound static checks for unsafe `mentions[0]`/“mentions preferred target” rules.
- **R7 `BLOCKED`**: Windows `taskkill /T` cannot use an already-exited wrapper PID to discover orphan descendants, so the previous early-exit test expectation was impossible. The Plan does not add Job Objects or a native supervisor: Windows uses taskkill only while the wrapper is live; early-exit-before-close returns the stronger `termination-unconfirmed`, forbids automatic retry, and never claims cleanup. The real Windows test now proves both the normal live-wrapper tree kill and this honest fail-closed boundary, with fixture cleanup owned by the test.
- **R8 `PASS`**: independent review found no remaining P0/P1/P2. The Reviewer accepted the explicit Windows `termination-unconfirmed` boundary as faithful to the Spec’s nonzero/no-false-success/no-auto-retry contract and confirmed the runner, fixed errors, cross-repository documentation checks, three-OS CI, and dual-Bot live evidence chain are executable.

## Review Gate

This Plan was written by 小P and independently reviewed through R8. R8 returned `PASS` with no remaining P0/P1/P2, so Unit 0 may begin when implementation is authorized. This review does not itself commit files, modify runtime code, deploy artifacts, or start the sayToLittleP Harness.
