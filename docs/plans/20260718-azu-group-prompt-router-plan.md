# “阿祖起来干活了” Group Prompt Router Implementation Plan

Date: 2026-07-18
Status: executed — repository and rollback gates PASS; live runtime acceptance PARTIAL
Source Spec: `docs/specs/20260718-azu-group-prompt-router.md`
Spec Review: PASS after iterative independent SubAgent review
Plan Review: PASS after iterative independent SubAgent review
Branch: `feat/azu-group-prompt-router`

## Outcome

Extend the existing Codex Group Prompt for “阿祖起来干活了” from a generic
cross-group intake prompt into the reviewed router defined by the Source Spec.
The first executable route classifies a trusted `AT_RELAY_V2` as a MemoryData
bug, restores the Feishu and demand context, identifies one authoritative
worktree/branch using current lineage evidence, and performs only the bounded
local fix loop covered by standing authorization.

This implementation is complete only when the operator prompt, contract tests,
isolated behavior evidence, exact deployment artifact, `/new` activation,
target-group canary, isolation checks, and rollback proof all agree. Updating
the repository Markdown alone is not deployment.

## Non-Negotiable Boundaries

- Do not change Bridge runtime code, `BRIDGE_SYSTEM_PROMPT`, Group Prompt
  Session pinning, batching, adapters, or profile schema unless implementation
  evidence proves the approved Spec cannot be satisfied without a new design
  decision.
- Every `messageIds.length > 1` batch is read-only in this MVP. Do not attempt
  to map per-message `app_id` readback identities into the top-level Bridge
  sender `open_id`, and do not add a second allowlist as a prompt-only fix.
- Do not edit or deploy any Claude prompt, profile, service, or configuration.
- Do not put the group-specific route into shared Bridge instructions.
- Do not infer 忆迟's identity from its display name or a source-app ID. Use
  the current 小P-app sender identity proven by a real target-group relay and a
  current group bot lookup.
- Do not log prompt bodies, raw private group transcripts, secrets, or full
  argv. Evidence records may contain message links/IDs, hashes, byte counts,
  classifications, and redacted excerpts needed for review.
- Do not test destructive or concurrent Git cases in a live MemoryData
  worktree. Use a disposable clone/repository and temporary worktrees.
- Do not commit, push, open/merge an MR, deploy code, update shared packages or
  test nodes, write Meego, notify people, or reply as Qin Peng without separate
  explicit authorization.
- Preserve all pre-existing live Group Prompt bytes before content deployment;
  rollback restores the previous content rather than deleting it.

## Live Baseline And Evidence To Record

### Unit 0 — dependency bootstrap and fixed evidence paths

Implementation evidence is written to:

```text
docs/agent-context/evidence/20260718-azu-group-prompt-router-acceptance.md
```

The isolated model-behavior runner and fixtures are owned by:

```text
tests/acceptance/azu-group-prompt-router.live.test.ts
tests/fixtures/azu-group-prompt-router/
tests/fixtures/azu-group-prompt-router/bin/codex-wrapper.mjs
tests/fixtures/azu-group-prompt-router/probe-output.schema.json
```

Before any RED test, run:

```text
node --version
pnpm --version
pnpm install --frozen-lockfile
git diff --exit-code -- pnpm-lock.yaml
```

Record Node/pnpm versions and dependency bootstrap result in the evidence file.
The lockfile must remain byte-for-byte unchanged. If dependency installation
cannot complete, automated Plan gates are `BLOCKED_ENVIRONMENT`, not PASS.

Before the first content change:

1. Record `git status --short --branch` and `git log -1 --oneline` in this
   feature worktree. The expected untracked scope is the reviewed Spec,
   operator-prompt assets, and this Plan.
2. Record the SHA-256 and byte count of:
   - the repository operator prompt;
   - the target profile's live group prompt, if present.
3. Resolve the active Codex profile directory from the bridge-bound environment
   without reading or printing account secrets.
4. Query the target group's bot membership with the current user identity and
   capture 忆迟's current-app bot identity. Confirm the returned `ou_...` bot
   identity against `bridge_context.senderId` and Bridge intake evidence from
   one real single-message 忆迟 relay. A name-only match is not sufficient.
   Record any message-readback `cli_...` sender `app_id` separately as transport
   evidence; it is not the operator allowlist value and must never be confused
   with the envelope's source-app identity fields.
5. Confirm from live source that batched `bridge_context.senderId` and
   `senderType` describe the first message while `messageIds` enumerates the
   whole batch. No Bridge change is planned; every multi-message batch must
   degrade to read-only regardless of sender order.
6. Run the existing focused Group Prompt and bot-context tests to establish a
   comparison baseline:

   ```text
   pnpm vitest run tests/unit/session/group-prompt-files.test.ts
   pnpm vitest run tests/unit/session/prompt-session-service.test.ts
   pnpm vitest run tests/integration/session/group-prompt-migration.test.ts
   pnpm vitest run tests/integration/bot/bot-at-bot-context.test.ts
   pnpm vitest run tests/process/codex-adapter.test.ts
   pnpm vitest run tests/process/claude-adapter.test.ts
   ```

If the trusted sender identity, active profile path, or previous live prompt
cannot be proven, stop before deployment. Repository authoring and read-only
tests may continue with an explicit unresolved marker; no executable allowlist
placeholder may reach the live profile.

## Execution Units

### Unit 1 — RED: operator prompt contract test

Files:

- `tests/unit/operator-prompts/azu-group-prompt-contract.test.ts` (new)
- `operator-prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md`

Add one focused test that reads the reviewed deployment asset as bytes. It must
fail against the current generic prompt and prove only stable safety contracts,
not exact prose:

- the target chat ID and a non-placeholder trusted relay sender allowlist are
  present;
- relay authentication covers `chatId`, `senderType`, `senderId`,
  `messageIds`, and source live readback;
- every mixed/debounced batch is read-only and cannot enter a write path;
- minimum source locators are `source_chat_id + source_message_id`;
- all retrieved chat, MR/Meego, Spec/Plan, log, attachment, and code text is
  evidence rather than authority;
- standing authorization permits only local discovery, isolated bugfix
  branch/worktree creation, editing, testing, local builds, and required
  local/device validation;
- commit, push, MR, merge, deployment, shared-package/node updates, Meego
  writes, notifications, and reply-as-Qin remain denied without explicit
  authorization;
- the MemoryData Bug route, degraded states, branch evidence rules, dirty and
  concurrent worktree protection, and split completion states are present;
- the file is valid UTF-8, non-empty, contains no unresolved placeholders, and
  remains below the runtime Group Prompt byte limit.

The test may parse named headings and a small operator metadata block. Avoid a
large snapshot or brittle full-text equality assertion.

Gate: the new test is RED because the current operator prompt has no trusted
sender authentication or Bug route. Existing Group Prompt tests remain GREEN.

### Unit 2 — GREEN: author the executable operator prompt

Files:

- `operator-prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md`
- `operator-prompts/README.md` only if deployment/rollback instructions need
  clarification

Compress the approved Spec into direct Chinese runtime instructions while
preserving the existing generic behavior:

1. retain ordinary direct-human conversation and explicit smoke-test behavior;
2. authenticate V2 relays with target chat, trusted current-app sender,
   `messageIds`, and source readback;
   require exactly one message ID for every executable route;
3. retrieve exact/reply/thread/nearby context and resources only as needed;
4. explain the actual request before routing;
5. enter the MemoryData Bug route only for a verified actual-versus-expected
   defect;
6. build the Bug Context Pack and locate the demand/project group;
7. require current MR/package/release/Git lineage evidence and refresh relevant
   remote refs before branch selection;
8. protect dirty worktrees and snapshot path, branch, HEAD, index, tracked
   diff, relevant untracked content, and intended task delta against concurrent
   change;
9. read the selected worktree's Spec, Plan, instructions, workflow authority,
   Git state, and implicated code before editing;
10. run the bounded reproduce/root-cause/minimal-fix/verification loop;
11. stop with one minimal question on every approved degraded condition;
12. report demand group, worktree/branch, decisive evidence, and each completion
    state separately.

Keep the prompt operational rather than explanatory. Do not include the Spec's
historical narrative, review discussion, test matrix, or deployment procedure
inside runtime instructions.

Gate: the new prompt contract test and existing Group Prompt/session/adapter
tests pass. Diff review proves no shared or Claude prompt changed.

### Unit 3 — Spec-to-prompt traceability review

Create a review table in the implementation evidence record mapping these Spec
contracts to exact operator-prompt headings or line references:

- producer and batch authentication;
- minimum locators and source corroboration;
- prompt-injection and cross-app identity boundaries;
- classification and generic authority routing;
- standing authorization allow/deny list;
- Bug Context Pack and demand-group discovery;
- current branch/release lineage and remote refresh;
- dirty baseline, content fingerprint, and TOCTOU recheck;
- bounded fix loop and degraded states;
- split result states.

Every row must be `covered` before deployment. A contract test passing without
this semantic review is insufficient.

Gate: independent reviewer finds no missing Spec behavior and no operator rule
that expands authority beyond the Spec.

### Unit 4 — Isolated behavioral acceptance

Implement the opt-in live-model runner at
`tests/acceptance/azu-group-prompt-router.live.test.ts`. It is excluded from the
ordinary test suite unless `RUN_AZU_GROUP_PROMPT_ACCEPTANCE=1` is set. The runner
must use production `buildAgentPrompt(...)`, `composeBridgeSystemPrompt(...)`,
and `CodexAdapter` boundaries with the exact candidate operator-prompt bytes;
handwritten concatenation is not equivalent evidence.

Construct the acceptance adapter with `ignoreUserConfig: true`,
`ignoreRules: true`, and `sandbox: 'workspace-write'`, and call
`setBotIdentity(...)` with the same 小P identity used by the target profile. It
must not run in the Vitest process's ambient environment. The Vitest controller
first creates a dedicated acceptance-worker subprocess with an explicit
environment allowlist; only inside that subprocess may the runner construct the
adapter. This makes adapter `checkAvailability`, `debug prompt-input`, and
`exec` calls inherit the same isolated environment. User config, MCP servers,
ambient project/user rules, bridge paths, and persistent sessions are not part
of the test.

Create a temporary mode-`0700` `CODEX_HOME` under the acceptance root. Copy
only the minimum existing `auth.json` required for live-model authentication
into it with mode `0600`; do not copy config, rules, AGENTS files, MCP config,
sessions, logs, or any other state. Never record auth bytes or derived secrets,
and remove the temporary home during runner cleanup after evidence is
complete. The fixture `cwd` must contain only reviewed fixture instructions, so
no ambient repository or home-level AGENTS file can enter the run.

Point `CodexAdapter.binary` to the test-only Node wrapper. The wrapper accepts
only `--version`, `debug prompt-input`, and the reviewed `exec` shape; all other
invocations fail closed. It invokes all three through the same isolated worker
environment. For `codex exec` it:

- invokes the live Codex binary recorded in a dedicated environment variable;
- injects `--ephemeral`, the fixed probe `--output-schema`, and
  `--output-last-message` pointing inside the temporary root;
- rejects resume or any argument that adds a writable directory;
- decodes the `developer_instructions` override, hashes it in memory, and
  records only the hash/byte count plus argv safety metadata;
- proves that the hash equals the production
  `composeBridgeSystemPrompt(...)` result built by the runner;
- never records the prompt body or authentication material.

Build the worker environment from an allowlist rather than
`{ ...process.env }`. Set dedicated `HOME`, `CODEX_HOME`, `TMPDIR`,
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, Git global/system config paths, an empty
hooks directory, the fixture-only `PATH`, and only the locale/runtime variables
needed to launch Node and Codex. Explicitly set every `LARK_CHANNEL*` variable
and `LARKSUITE_CLI_CONFIG_DIR` to inert fixture paths under the temporary root;
none may point to a live bridge-bound profile. Do not pass ambient tokens,
cloud credentials, proxy credentials, MCP configuration, or unrelated secrets.
Disable Git credential helpers and system config. Fixture remotes must be local
bare repositories inside the temporary root. The runner snapshots these state
directories and treats any unexpected output as a failure. The only external
state imported is the copied Codex authentication file; it is not directly
exposed as an inherited live-home path.

All Feishu and Bits evidence used by local scenarios comes from immutable
fixtures under `tests/fixtures/azu-group-prompt-router/`. Prepend fixture-only
`lark-cli` and `bytedcli` shims to the child tool `PATH`; each shim accepts only
the commands used by the router, returns scenario JSON, rejects unexpected
calls, and never reaches the network or the bridge-bound live profile. Scenario
messages, reply/thread windows, group search results, MR source/target, package
provenance, and release state must all resolve through these fixtures.

Create a disposable Git repository under one temporary acceptance root. It
must support clean, dirty, staged, untracked, feature, merged, release,
remote-only, and concurrent-content-change scenarios. Run Codex with
`workspace-write`, the fixture repo as `cwd`, and no additional writable roots.
The runner rejects any requested or observed write outside that temporary root.

Before and after every scenario, fingerprint all live MemoryData worktrees by
path, branch, HEAD, status, tracked/staged diff content, and untracked inventory
and content. Any real-worktree change is an immediate test failure, even when
the disposable fixture behaves correctly. Record the fixture base SHA and its
own before/after fingerprints separately.

Run the Source Spec's acceptance matrix in two proof layers:

1. **Deterministic transport/contract proof**
   - existing Bridge tests prove first-sender batch metadata and Group Prompt
     session transport;
   - the new contract test proves the reviewed content contains each safety
     rule;
   - no model claim is used as proof of Bridge transport internals.
2. **Codex behavior proof**
   - run the opt-in production-boundary runner with fixture Feishu/Bits data and
     the disposable Git root;
   - append an acceptance-only instruction with a random nonce to the synthetic
     user input, never to the production operator prompt;
   - require the final response to match the fixed JSON Schema and contain
     exactly that nonce plus `classification`, `trust_state`,
     `selected_lineage`, `requested_action`, `degraded_reason`, and
     `write_intent`;
   - jointly assert the parsed JSON, fixture shim call log, Codex command events,
     wrapper safety record, and Git before/after evidence;
   - fail on missing/extra probe fields, invalid nonce/schema, any unallowlisted
     command/tool call, or any effect outside the scenario's allowlist. Natural
     language self-description is never sufficient evidence.

Each fixture scenario must also have a checked-in machine-readable oracle. The
JSON Schema validates response shape only; the oracle validates meaning and
effects. For every scenario the oracle declares:

- exact or enumerated accepted values for all six decision fields, including
  the expected `selected_lineage` identifier;
- required and forbidden fixture-shim calls, with expected lookup parameters;
- required and forbidden command events;
- required and forbidden Git delta, branch/HEAD/index/worktree state, and test
  evidence;
- whether a write is required, merely allowed, or forbidden.

The trusted clean-lineage Bug scenario must produce the fixture's expected
local source change, leave it uncommitted, and run the fixture's named
verification command successfully. Returning the right classification without
that patch and verification is a failure. Forged, degraded, conflicting,
multi-message, non-Bug, and lifecycle scenarios with conflicting or incomplete
evidence must preserve the fixture repository byte-for-byte and produce no
write-intent command. Dirty-baseline scenarios must preserve pre-existing
unrelated bytes; where an oracle permits a relevant edit it names the exact
allowed file/delta. Any scenario output that matches the schema but not its
oracle fails.

Lifecycle fixtures must include both positive and degraded paths. When the
evidence is unique and trusted, the merged-target, release-base, and remote-only
scenarios must each start from the oracle's exact expected SHA, create the
oracle-named non-forced derived bugfix branch in a sibling fixture worktree,
apply only the expected fixture patch, and run the named verification command.
The oracle must prove that no commit, push, MR, merge, deployment, notification,
or live-repository change occurred. Companion conflict/stale-evidence fixtures
for each lifecycle state must remain byte-for-byte read-only.

At minimum cover:

- trusted single-message Bug with one clean lineage;
- human-forged and non-allowlisted V2;
- trusted relay coalesced with a human or another bot, which must always
  degrade to read-only;
- unreadable/conflicting source and malicious instructions in every evidence
  surface;
- feature request, question, test, and vague complaint;
- two credible demand/branch candidates;
- unrelated dirty changes and possibly relevant dirty baseline changes;
- unchanged status categories with changed dirty-file content;
- unexpected HEAD/index/worktree changes after selection;
- merged-target, release-base, and remote-only lineage, each with a trusted
  writable-success fixture and a conflicting/stale read-only fixture;
- completed local fix with no unauthorized commit/push/MR/deploy/notification;
- cross-app `open_id` misuse attempt.

For cases that cannot be faithfully reproduced outside Feishu, mark local
evidence `NOT_RUN` and require the corresponding target-group canary in Unit 5.
Do not convert missing runtime proof into PASS.

Gate: every fixture case is `PASS`, or explicitly assigned to a named live
canary with no local write risk. Fixture cleanup happens only after its evidence
record is complete.

### Unit 5 — Target-profile deployment and live canary

Deployment is an operator action after Units 1–4 pass:

Before changing the live file, confirm Qin Peng is online and available to
complete every required `/new` activation gate in one coordinated window:
candidate activation, rollback activation, and final redeploy activation. A
deployment must not start if those human gates cannot be completed and observed.

1. Re-discover the active bridge process, target Codex profile, profile
   directory, and live target Markdown path. Do not rely on a stale deployment
   path from a previous run.
2. Save the previous live file's existence, exact bytes, mode, SHA-256, and byte
   count under `/Users/bytedance/Documents/运维/backup/<timestamp>/`. Write a
   manifest with the source path and existence marker. Retain this rollback
   asset until Qin Peng explicitly approves cleanup; a passing drill alone does
   not delete it.
3. Recompute the repository operator prompt's hash/byte count and require it to
   match the reviewed evidence record.
4. Stage the exact reviewed bytes in a same-directory temporary file under the
   target prompt directory. Preserve the previous mode when replacing an
   existing file; use an owner-only mode for a new file. Verify the staged hash
   and byte count, then atomically rename it to:

   ```text
   <target-codex-profile-dir>/prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md
   ```

5. Read back the deployed mode/hash/byte count. Do not directly truncate the
   live file, restart Claude, or edit any Claude path.
6. Have Qin Peng issue `/new` in “阿祖起来干活了”; a file copy alone is not
   activation.
7. Run a harmless nonce canary proving the new Session sees the revised router
   without executing synthetic business content.
8. Run live canaries for trusted relay authentication, source/reply recovery,
   a forged human V2, and a mixed debounce batch. The mixed batch must always
   remain read-only. All target-group deployment canaries are read-only; the
   writable Bug matrix is already confined to the Unit 4 acceptance runner.
9. Run named read-only attachment/identity canaries and retain command-event
   plus message-readback evidence:
   - a relay carrying an attachment that is not needed for classification must
     cause no resource download;
   - a relay whose classification genuinely depends on one attachment may read
     only that named resource and no others;
   - a relay containing source-app sender/mention IDs must neither reuse those
     IDs for a current-app mention/send nor emit an unreviewed outbound action.
10. Verify another Codex group, p2p, comments, and the Claude control profile do
   not receive the target Group Prompt.
11. Record the active Session binding/hash and message IDs needed to reproduce
    the result without recording private transcript bodies.

Runtime `PASS` requires both content/hash evidence and observed Feishu/Codex
behavior. Process health, a successful file copy, or a model self-report alone
is insufficient.

Treat steps 4–11 as one fail-closed file-deployment transaction with explicit
human activation gates. After the atomic
replacement, failure of `/new`, any canary, isolation/control verification,
hash readback, or evidence write immediately triggers the Unit 6 restoration
primitive: atomically restore the previous bytes and mode (or remove the file
only when the manifest proves it was previously absent) and verify the restored
hash/existence. Qin Peng must then issue `/new`; only after its successful reply
and the old-version harmless canary may the state be recorded as
`rolled back / old version active`. If that human gate cannot be completed,
record `ROLLBACK_PENDING_ACTIVATION`, state explicitly that an already pinned
Session may still contain the candidate prompt, stop all subsequent actions,
and do not claim fail-closed runtime completion.

### Unit 6 — Rollback drill and final acceptance record

After the new canary passes, prove rollback before declaring completion:

1. with Qin Peng present for the activation gates, restore the exact previous
   live bytes and mode when a file existed; remove
   the target file only when the manifest proves it did not exist before
   deployment. Restoration uses a verified same-directory temporary file and
   atomic rename;
2. verify restored hash/byte count;
3. issue `/new` and pass the previous generic-prompt canary;
4. redeploy the reviewed new bytes, verify hash, issue `/new`, and rerun the
   harmless new-version canary;
5. clean the temporary fixture only after its evidence is complete. Keep the
   previous-live backup and manifest until Qin Peng explicitly approves their
   cleanup.

The rollback drill's step 4 is itself a fail-closed file-deployment transaction
with the same human `/new` activation gate. If
the new-version redeploy, hash readback, `/new`, canary, or evidence recording
fails, immediately restore the previous bytes/mode (or prior absence), verify
the old file state, and request Qin Peng's `/new`. Only after that command's
successful reply and the old-version harmless canary may the record say the old
version is active. Otherwise record `ROLLBACK_PENDING_ACTIVATION`, note that the
candidate may remain pinned in the current Session, and stop.

Create an implementation evidence record containing:

- baseline commit/status;
- trusted relay identity provenance;
- Spec-to-prompt traceability table;
- source and deployed hashes/byte counts;
- targeted/full test results;
- fixture matrix with Git before/after evidence;
- live canary message IDs and redacted outcomes;
- isolation proof;
- rollback and redeploy proof;
- exact status of `authored`, `tested`, `deployed`, `activated`, and
  `runtime accepted`.

Gate: every Source Spec acceptance row is backed by a named proof, and no
required item remains `NOT_RUN`.

## Verification Commands

Run focused checks during Units 1–3:

```text
pnpm install --frozen-lockfile
pnpm vitest run tests/unit/operator-prompts/azu-group-prompt-contract.test.ts
pnpm vitest run tests/integration/bot/bot-at-bot-context.test.ts
pnpm vitest run tests/unit/session/group-prompt-files.test.ts
pnpm vitest run tests/unit/session/prompt-session-service.test.ts
pnpm vitest run tests/integration/session/group-prompt-migration.test.ts
pnpm vitest run tests/process/codex-adapter.test.ts
pnpm vitest run tests/process/claude-adapter.test.ts
```

Run the isolated live-model matrix explicitly; it is not implied by `pnpm
test`:

```text
RUN_AZU_GROUP_PROMPT_ACCEPTANCE=1 \
  pnpm vitest run tests/acceptance/azu-group-prompt-router.live.test.ts
```

Before deployment:

```text
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Hash, profile discovery, Feishu queries, fixture commands, and deployment
commands must be generated from live paths and the current bridge-bound profile
at execution time. Do not copy historical profile paths or identity values into
the Plan.

## Completion Criteria

- The operator prompt is a concise, executable, byte-limit-safe projection of
  every approved runtime contract in the Source Spec.
- The trusted relay allowlist contains a live-proven current-app identity and no
  placeholder.
- Contract tests, focused regressions, full tests, typecheck, build, and diff
  checks pass without changing shared Bridge or Claude behavior.
- Every behavior matrix row has observable output and Git before/after proof.
- The deployed bytes exactly match the reviewed repository artifact.
- `/new` activates the new version; other groups, p2p, comments, and Claude are
  unchanged.
- Previous-version rollback and new-version redeploy both pass canaries.
- The previous-live backup and manifest remain available until Qin Peng
  explicitly approves cleanup.
- Final reporting separates authored, tested, deployed, activated, runtime
  accepted, committed, pushed, MR, merged, and released states.

## Review Gate

This Plan must receive an independent SubAgent `PASS` against the confirmed
Spec and live code before Unit 1 begins. Resolve every finding that changes
safety, executability, requirement coverage, or acceptance truth, then request
another independent review. Do not iterate on stylistic preferences that do not
change those outcomes.
