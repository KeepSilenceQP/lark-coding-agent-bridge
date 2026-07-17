# Codex Bridge Prompt Developer Instructions Implementation Plan

Date: 2026-07-18
Status: merged and deployment scheduled; runtime acceptance pending
Source Spec: `docs/specs/20260718-codex-bridge-prompt-developer-instructions.md`
Spec Review: PASS after independent SubAgent review

## Outcome

Move the existing Codex Bridge Prompt from the stdin user payload to Codex
`developer_instructions`, while preserving the prompt text and bot identity.
Codex stdin must contain only the dynamic bridge envelope. A behavioral
capability preflight must fail closed before execution when the installed Codex
cannot prove the required developer/user role separation.

This is a Codex-only change. Claude's adapter, argv, prompt file, capability
value, configuration, service, process, and runtime behavior must remain
unchanged.

## Non-Negotiable Boundaries

- Do not edit `BRIDGE_SYSTEM_PROMPT`.
- Do not change `buildBridgeSystemPrompt(...)` output or identity behavior.
- Do not edit `src/agent/claude/adapter.ts` or Claude tests to accommodate the
  Codex change.
- Do not use `model_instructions_file`.
- Do not silently fall back to `prefixBridgeSystemPrompt(...)`.
- Do not implement Group Prompt storage or transport in this change.
- Pass prompt values through argv arrays, never shell interpolation, and never
  log prompt bodies or full argv.

## Baseline

Before the first RED test:

1. Record `git status --short` and confirm the only intended starting artifact
   is the reviewed Spec and this Plan.
2. Run the current focused Codex tests and record their baseline result:
   - `pnpm vitest run tests/unit/agent/codex-prepare-run.test.ts`
   - `pnpm vitest run tests/unit/agent/codex-argv.test.ts`
   - `pnpm vitest run tests/unit/agent/capability.test.ts`
   - `pnpm vitest run tests/process/codex-adapter.test.ts`
3. Run the existing Claude process and prompt-wiring tests unchanged to record
   the comparison baseline.
4. Run the real non-model capability command once and retain only redacted
   role evidence, not the full Bridge Prompt.

## TDD Execution Slices

Each slice is completed RED to GREEN before starting the next slice. Do not
write all tests first or refactor while RED.

### Slice 1: capability preflight succeeds and caches verified success

Observable behavior:

- `CodexAdapter.prepareRun(opts)` invokes `codex debug prompt-input` before the
  first bridge execution.
- The probe uses distinct developer and user sentinels and accepts only JSON
  showing the expected `developer` and `user` roles.
- The probe uses the adapter's configured binary, effective `CODEX_HOME`, Lark
  profile environment, and resolved run cwd.
- A verified result is cached by an explicit adapter-local key containing the
  configured binary, resolved cwd, effective `CODEX_HOME`, active Lark profile,
  and the effective Lark environment paths. A different key is probed
  independently.
- Concurrent `prepareRun` calls for the same key share one in-flight Promise.
  Only successful verification remains cached; rejection removes the entry.

Complete three separate RED to GREEN loops:

1. **First successful probe:** extend the fake Codex executable boundary to
   record `debug prompt-input` and emit representative JSON; add one failing
   test that requires a first probe, then implement only enough to pass it.
2. **Same-key reuse:** add one failing test that invokes concurrent and
   sequential `prepareRun` calls for the same key and requires one probe; then
   add only the in-flight/success cache behavior needed to pass it.
3. **Different-key isolation:** add one failing test that changes resolved cwd
   or another key field and requires a second probe; then implement only the
   explicit keying needed to pass it.

For each GREEN step:

- Add the smallest Codex-scoped probe module or adapter helper needed to spawn
  the debug command, parse its JSON, and cache successful verification.
- Call it from the existing `prepareRun` gate after binary availability and
  before thread-state preparation.
- Keep the existing RunExecutor ordering contract: a failed `prepareRun` must
  release the pool slot and prevent `codex exec` from spawning.

Focused proof:

```text
pnpm vitest run tests/unit/agent/codex-prepare-run.test.ts
pnpm vitest run tests/integration/runtime/run-executor-preflight.test.ts
```

### Slice 2: capability preflight fails closed

Add one RED to GREEN cycle for each observable failure:

1. Debug command missing or unsupported.
2. Non-zero exit.
3. Malformed or non-JSON output.
4. Developer sentinel missing or present under the wrong role.
5. User sentinel missing or present under the wrong role.
6. Bounded timeout.
7. Stdout or stderr exceeds its byte cap.
8. Either sentinel is duplicated, appears in multiple roles, or produces an
   otherwise ambiguous match.

Required behavior:

- Return one stable Codex capability diagnostic without echoing sentinels,
  config values, prompt text, or full argv.
- Kill and reap the timed-out probe process.
- Bound stdout and stderr independently. On timeout or output overflow, request
  termination, escalate to a hard kill after a short grace period when needed,
  and wait for `exit`/`close` before rejecting.
- Cache no failed or ambiguous result; a later `prepareRun` may retry.
- Never spawn `codex exec` after a failed probe.

JSON validation must operate on the parsed prompt-input message array, not on
serialized JSON or substring search:

- inspect only each message's `role` and its
  `content[type="input_text"].text` entries;
- use distinct per-probe random sentinels and require exact text equality;
- require exactly one developer sentinel occurrence, only under role
  `developer`;
- require exactly one user sentinel occurrence, only under role `user`;
- treat cross-role, duplicate, missing, extra, or structurally ambiguous
  occurrences as failure.

Refactor only after all failure cycles are GREEN. Keep process execution and
JSON/role validation behind one narrow Codex-scoped interface.

### Slice 3: fresh Codex transport uses developer instructions

Observable behavior:

- `buildCodexArgs(...)` accepts the generated Bridge Prompt as a developer
  instruction and emits a global config override before fresh/resume branching.
- `CodexAdapter.run(...)` writes `opts.prompt` to stdin exactly, without the
  Bridge Prompt or `## user_message` delimiter.
- Decoding the config override yields exactly
  `buildBridgeSystemPrompt(currentIdentity)`.

RED to GREEN sequence:

1. Add an argv contract test for TOML-safe multiline encoding, including
   quotes, backticks, XML-like text, and non-ASCII text; implement the minimal
   argv support.
2. Change the fresh process-contract test to require exact dynamic stdin and
   the complete decoded Bridge Prompt in `developer_instructions`; update the
   adapter minimally to pass.
3. Update only the Codex describe block in
   `tests/unit/agent/adapter-system-prompt-wiring.test.ts`: require exact dynamic
   stdin plus an identity-aware developer override. Leave the Claude describe
   block unchanged.
4. Add a log/error assertion proving prompt bodies and full argv are absent.

Likely production files:

- `src/agent/codex/argv.ts`
- `src/agent/codex/adapter.ts`
- an optional Codex-local encoder/probe module if that keeps the public
  interfaces small

The adapter may import and reuse `buildBridgeSystemPrompt(...)`; it must stop
using `prefixBridgeSystemPrompt(...)` for stdin.

### Slice 4: resume, late identity, and safe replay preserve the contract

Complete one RED to GREEN cycle for each behavior:

1. A resumed invocation places the same developer override in the global argv
   position and writes only the new dynamic prompt to stdin.
2. After `setBotIdentity(...)`, the next fresh or resumed invocation contains
   the exact identity section produced by the unchanged builder.
3. A safe no-output replay receives the same developer instructions and
   dynamic prompt as its original attempt, without duplicating the Bridge
   Prompt into user input.
4. Existing terminal-state recovery and retry-safety behavior remains GREEN.

Process-contract tests prove argv and stdin. They do not claim direct
model-visible resume-role evidence.

The replay assertion must exercise the real `channel.ts` / RunExecutor
`startup-timeout` recovery path, not two manual adapter calls. Add the assertion
to the closest channel run-flow integration suite or a focused new integration
test. Record both spawned Codex invocations and prove their decoded developer
instructions and dynamic stdin are equal. Add a separate executor-boundary
test proving a failed capability probe produces no `codex exec` invocation.

### Slice 5: capability metadata records the new Codex transport

RED:

- Update the Codex capability assertion to expect
  `promptInjection: 'developer-instructions'`.
- Keep the Claude assertion at `append-system-prompt` and prove it is unchanged.

GREEN:

- Extend `PromptInjectionMode` with `developer-instructions`.
- Change only the value returned by `codexCapability(...)`.
- Do not change the Claude capability branch or any consumer behavior unrelated
  to representing the transport accurately.

Focused proof:

```text
pnpm vitest run tests/unit/agent/capability.test.ts
pnpm vitest run tests/integration/session/resume.test.ts
pnpm vitest run tests/integration/commands/resume-command.test.ts
```

## Verification Gates

### Static and automated verification

Run in this order:

```text
pnpm vitest run tests/unit/agent/codex-prepare-run.test.ts
pnpm vitest run tests/unit/agent/codex-argv.test.ts
pnpm vitest run tests/unit/agent/capability.test.ts
pnpm vitest run tests/process/codex-adapter.test.ts
pnpm vitest run tests/process/claude-adapter.test.ts
pnpm vitest run tests/unit/agent/adapter-system-prompt-wiring.test.ts
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Then verify the diff boundary:

- No diff in `src/agent/claude/adapter.ts`.
- No diff in Claude configuration or service files.
- No diff in `BRIDGE_SYSTEM_PROMPT` or the implementation of
  `buildBridgeSystemPrompt(...)`.
- Any `src/agent/capability.ts` diff changes only the type union and Codex
  return value; the Claude return value is byte-for-byte unchanged.
- In `tests/unit/agent/adapter-system-prompt-wiring.test.ts`, only Codex
  expectations change; the Claude describe block remains unchanged.

### Local Codex role proof

Run `codex debug prompt-input` using the same encoding helper and effective
profile environment. Verify from JSON that:

- the Bridge sentinel is role `developer`;
- the task sentinel is role `user`;
- neither sentinel is duplicated into the other role.

This command must not invoke a model.

### Fresh and resume canary

1. Start a new Codex thread with a harmless dynamic sentinel.
2. Resume that exact thread with a second dynamic sentinel.
3. Confirm both turns complete with expected bridge behavior.
4. Inspect local persisted thread/run evidence and confirm neither newly added
   user turn contains the Bridge Prompt.
5. Label resume role evidence as indirect unless Codex gains a resume-aware
   prompt inspector.

Do not use a pre-change thread for acceptance because it may legitimately
contain historical Bridge Prompt copies in earlier user turns.

## Codex-Only Deployment

1. Inspect the live launchd/service definitions, resolved
   `lark-channel-bridge` executable, package/install path, and profile arguments
   for both Codex and Claude. Record whether they share one build artifact.
2. Before deployment, record the running Claude PID, start time, configuration
   target, and resolved executable target.
3. Deploy the verified shared build containing only Codex-branch behavior
   changes. Do not describe it as a Codex-specific artifact unless live
   service evidence proves separate artifacts actually exist.
4. Restart only the Codex bridge profile; do not reload or restart Claude.
5. Start a new group session and exercise normal message, quoted-message,
   CardKit interpretation, bot identity, and one resumed follow-up.
6. Re-read the Claude PID, start time, configuration target, and executable
   target; all must be unchanged.
7. Record automated results, prompt-inspector role proof, fresh/resume canary
   evidence, runtime checks, and the exact deployed commit.

## Rollback

Rollback is code-only:

- Restore Codex stdin construction through `prefixBridgeSystemPrompt(...)`.
- Remove the Codex developer-instruction argv override and capability probe.
- Restore the Codex capability value to `stdin-prefix`.
- Rebuild and restart only the Codex profile.

No session or user-data migration is required. After rollback, use a new Codex
session for clean acceptance; existing sessions may retain their historical
messages.

## Completion Criteria

Implementation is complete only when:

- Every TDD slice is GREEN and all verification gates pass.
- Fresh, resume, identity, replay, probe success, probe failure, and probe cache
  behaviors have automated evidence.
- Real prompt inspection proves fresh developer/user role separation.
- Real fresh plus same-thread resume canaries complete without new Bridge Prompt
  copies in user turns.
- Claude-owned files and runtime process are unchanged.
- Deployment evidence is attached to the implementation handoff; unrun runtime
  checks are reported as `NOT_RUN`, never inferred from unit tests.

## Execution Record

Implementation completed on 2026-07-18 in
`feat/session-aware-bridge-prompt`.

- Independent Plan review: PASS after four review findings were incorporated.
- Independent final code review: PASS after increasing the real capability
  probe default timeout from 5 seconds to 15 seconds.
- Real non-model prompt inspection: exactly one developer sentinel under role
  `developer`, exactly one task sentinel under role `user`, and zero cross-role
  matches.
- Feature-worktree verification: 100 test files and 652 tests passed.
- Combined-main verification after merging the already deployed
  `owner-no-mention` feature: 102 test files and 672 tests passed.
- `pnpm typecheck`, `pnpm build`, and `git diff --check`: PASS.
- Claude adapter and shared Bridge Prompt builder source: no diff.
- Claude process-contract tests: PASS.

Main now contains both the already deployed `owner-no-mention` feature and this
Codex-only change. The global CLI resolves to the main worktree, and a deferred
restart was requested for the Codex profile so the active reply is not cut off.
The Claude process remained running with PID `10050` and was not restarted,
reconfigured, or repointed at service level.

Post-restart verification and the fresh plus same-thread resume canary remain
`NOT_RUN` until the deferred Codex restart completes after this reply.
