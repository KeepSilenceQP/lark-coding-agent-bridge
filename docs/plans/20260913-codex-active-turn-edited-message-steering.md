# Codex Edited-Message Correct-and-Restart Implementation Plan

Date: 2026-09-14

Spec authority: `docs/specs/20260913-codex-active-turn-edited-message-steering.md`

Workspace: `/Users/bytedance/repo/lark-coding-agent-bridge`

Baseline: `main@c8aa2f4`

Plan status: **Independent Plan Review `GO`**

Implementation status: **Code Review `GO`; automated regression PASS; privacy/live gates pending**

## 1. Outcome

Implement the confirmed Codex-only flow for exact Feishu Reaction
`emojiType=Loudspeaker`:

1. resolve the accepted message that solely owns the current active Codex exec
   run;
2. fetch and normalize its latest revision exactly once;
3. reserve the scope for a direct replacement and revalidate exact run
   ownership;
4. stop that run and confirm the process exited;
5. bypass `PendingQueue` and start the corrected full text as a new turn on the
   exact same Codex thread;
6. keep ordinary pending input behind the corrected turn, then resume normal
   draining when the corrected run finishes.

This plan contains no Codex App Server migration and no `turn/steer` path. It
uses the existing `codex exec` adapter. It does not promise or implement
rollback of effects already produced by the stopped run.

## 2. Progress ledger

The Coordinator owns checkbox updates after Plan Review `GO`. A change to unit
scope or completion criteria returns to the Plan Writer and requires another
independent review.

- [x] Confirmed revised Spec identified as the sole requirements authority.
- [x] Gate 0 live evidence recorded in the Spec: `[喇叭]` maps to exact
  `emojiType=Loudspeaker`.
- [x] Current execution, queue, reaction, normalization, prompt, and session
  seams inspected at baseline `c8aa2f4`.
- [x] Independent Plan Review returns `GO`.
- [x] Unit 1 complete: feature boundary and replacement primitives.
- [x] Unit 2 complete: active-message ownership and pinned corrected-run path.
- [x] Unit 3 complete: Loudspeaker transaction and user feedback.
- [ ] Unit 4 complete: regression, canary, and rollback evidence.
- [x] Independent final Code Review complete.

Gate 1 from the superseded App Server investigation is historical evidence
only. It is not an entry criterion or dependency for any unit below.

## 3. Baseline findings that constrain the implementation

| Seam | Current behavior | Required consequence |
| --- | --- | --- |
| `src/bot/active-runs.ts` | `interrupt(scope)` removes the handle and calls `stop()` fire-and-forget. | The edit flow must not reuse `interrupt()`. It needs an exact-handle replacement reservation and confirmed-exit operation. |
| `src/bot/pending-queue.ts` | Blocking is a single per-scope `Set`; one `unblock()` clears it. | A separately owned replacement hold must survive the old flush owner's `unblock()`. |
| `src/runtime/run-executor.ts` | A normal reservation cannot coexist with an active handle; `RunExecution.stop()` does not expose whether `waitForExit()` succeeded. | Add a typed replacement reservation state and an exit-confirming stop result. Never register the corrected run if exit is unconfirmed. |
| `src/bot/run-flow.ts` | Codex resume is selected from the current session catalog. | Replacement startup must pin the exact thread reported by the stopped run and fail closed on cwd/policy/session mismatch. |
| `src/bot/channel.ts` | Ordinary input reaches `PendingQueue`; queue cleanup unblocks after the whole batch finishes. Tool flight is local to stream rendering. | Eligibility must be registered against the exact started run; the corrected start must bypass the queue; `toolStartedEver` must be observable by the transaction. |
| `src/bot/reaction/pipeline.ts` | The generic pipeline fetches the target route before classifying ordinary Reactions and treats unknown emoji as agent input. | When the feature is enabled, exact `Loudspeaker` needs an earlier control branch so an eligible target is fetched only once and never becomes a reaction barrier. |
| `src/bot/quote.ts` | `fetchQuotedContext()` owns its fetch and its normalizer is private. | Expose a narrow normalizer for an already-fetched `text`/`post` item; the edit controller owns the single fetch. |
| `src/agent/prompt.ts` | Prompt source excludes edit restart; all sections already use escaped JSON. | Add a typed `message_edit_restart` source/corrected-message section and reuse `safeJsonStringify`. |
| `src/config/profile-schema.ts` | No flag exists for this behavior. | Add one profile-scoped, Codex-only preference, normalized to disabled unless explicitly true. No transport/auth/sandbox flag is added. |

## 4. Non-negotiable invariants

Use these identifiers in tests and logs even if concrete type names differ.

### I1. Exact ownership

An editable-message record identifies all of:

- target `messageId` and original author;
- exact chat/topic scope and route;
- sole accepted inbound batch membership;
- exact `RunExecution`/`RunHandle` generation;
- latest delivered normalized-text fingerprint;
- exact durable Codex `threadId`;
- original run's work-chain/lifecycle unit;
- monotonic `toolStartedEver`.

The controller compares handle identity, not merely `scope` or a string run ID,
before fetch and again after the replacement reservation is held. A newer run
must never be stopped.

### I2. Single fetch and supported body

After silent identity/access prechecks, one `channel.fetchRawMessage(messageId)`
call supplies route, sender, message type, revision metadata, normalized body,
and resource information. The implementation must not call the generic
reaction route fetch or `fetchQuotedContext()` for the same event. Only one
non-deleted, attachment-free `text` or `post` parent from the expected
chat/topic is accepted.

The logical correction key is:

```text
messageId + canonical latest revision
```

Use the API revision/update value when present and always retain a canonical
fingerprint of the normalized full text. The fingerprint is the fallback
revision and the equality check against the last delivered body. Do not log
the body or prompt.

### I3. Replacement is control-plane state

The corrected message never calls `pending.push()` or `pending.pushBarrier()`.
A replacement reservation is distinct from an ordinary `RunReservation` until
the old process has confirmed exit. It:

- is acquired for one exact expected handle;
- makes ordinary `ActiveRuns.reserve(scope)` fail;
- owns an additive `PendingQueue` hold;
- transitions to “ready to register replacement” only after confirmed exit;
- is consumed only by one direct corrected submission;
- is released idempotently on every failure path.

Acquiring the ActiveRuns reservation and queue hold must happen synchronously
without an `await` between them. A timer must not dequeue and discard ordinary
pending input in the gap.

### I4. Queue order

The replacement queue hold is independently owned from the old queue-flush
block. When the old run's outer `finally` unblocks its own work, the replacement
hold remains. On successful corrected startup, that hold transfers to the
corrected run lifecycle and is released only when the corrected run is
terminal/cleaned up. Pending units accumulated before or during correction
retain relative FIFO order and start only afterward.

### I5. Stop before start

The exact old run receives `stop()`, then `waitForExit(timeout)` must return
`true`, then its exact handle/pool ownership is cleaned up, and only then may
the corrected `agent.run()` occur. A stop error, timeout, or ownership loss
prevents corrected startup. No failure is converted into an ordinary queued
turn.

### I6. Same session, never a fresh thread

The corrected run uses the exact Codex `threadId` observed from the old run's
`system` event and durably accepted by the existing session seam. The direct
flow re-evaluates current access, workspace, and run policy, and requires the
same cwd/policy identity. Catalog lookup may validate the pin but may not
substitute another thread. If the thread is not yet known/durable or the prompt
session service would select fresh/different state, fail before stop.

### I7. Idempotency and lifecycle

Only one transaction can own a scope. Duplicate deliveries for the same
correction key join/observe the same in-flight outcome. A completed correction
key is consumed for the Bridge process lifetime (bounded in-memory retention),
so removal/re-addition without another edit cannot stop again. A later genuine
edit may become eligible against the corrected active run and its new delivered
fingerprint.

Active records use compare-and-delete generation checks. Old-run terminal
cleanup cannot delete a claimed transaction or the corrected successor record.
Restart loses eligibility and fails closed, as required by the Spec.

### I8. Side effects and feedback

Set `toolStartedEver=true` at the first `AgentEvent.type === 'tool_use'`; never
reset it on `tool_result`. Capture it before stopping. A successful correction
always says the old run stopped and the corrected full message started. Add the
side-effect warning only when that captured bit is true. Never state that files,
commands, messages, or other effects were rolled back.

### I9. Failure release matrix

| Failure point | Old run | Replacement reservation/hold | Pending behavior | Reply |
| --- | --- | --- | --- | --- |
| unregistered target / other author / denied access | unchanged | never acquired | unchanged | silent |
| active-ended tombstone / not sole trigger / unsupported original | unchanged | never acquired | unchanged | authorized author gets specific failure |
| fetch/read/parse/route/type/resource/revision failure | unchanged | never acquired | unchanged | specific read/type failure |
| no text change / consumed correction key | unchanged | never acquired | unchanged | no-edit result; no stop |
| ownership lost before final check | never stop newer run | release immediately | ordinary handling resumes | correction window closed |
| `stop()` fails or exit unconfirmed | no concurrent replacement | release immediately; active lifecycle remains authoritative | no corrected enqueue | stop-not-confirmed |
| old exited, corrected policy/session/spawn fails | remains stopped | release immediately | existing pending may resume in FIFO order | corrected-start-failed |
| corrected run starts | old exited | ActiveRuns reservation consumed; queue hold transferred to corrected lifecycle | drain only after corrected terminal | success, plus conditional warning |

## 5. Target design

### 5.1 In-memory edit registry

Add a focused module under `src/bot/` (suggested:
`src/bot/edited-message-restart.ts`) rather than extending
`ReactionRunTracker`. The existing tracker describes model-visible reaction
turns; this feature is a separate control transaction.

The registry must represent:

- eligible active single-message records;
- active but author-visible ineligibility (`not-sole-trigger`, unsupported
  type/resources, thread not ready);
- recently ended tombstones needed to distinguish a completion race from an
  unregistered target;
- one in-flight Promise/outcome per correction key and per scope;
- bounded consumed-key/tombstone retention.

Register records only for human messages actually accepted into a run. Do not
make ignored/no-mention/denied input eligible. For merged batches, record each
accepted human target as author-visible `not-sole-trigger`, associated with the
exact run, but never allow it to stop that run.

### 5.2 Run and pending primitives

Extend `ActiveRuns` with a replacement-specific compare-and-swap contract. The
implementation may choose exact method names, but tests must exercise these
transitions:

```text
active(expected handle)
  -> replacement-held(expected handle)
  -> old-exit-confirmed
  -> replacement-registered(new handle)
```

Normal `reserve`, `/stop`, reconnect pause, `stopAll`, and cleanup must remain
compatible. `/stop` may abort a replacement that has not registered its new
run, but must not cause a second corrected start.

Add a separately releasable PendingQueue hold (token/lease or equivalent).
Do not convert the existing idempotent `block/unblock` API into naive reference
counting: many current callers assume duplicate `block()` is idempotent. The
new hold and legacy block can coexist; `isBlocked` is true while either exists.

### 5.3 Corrected direct run

Refactor only enough of the post-`startRunFlow` IM lifecycle to let an already
validated direct replacement reuse the existing:

- run policy and prompt-session admission rules;
- Codex exec adapter and `RunExecutor`;
- session event durability;
- card/markdown/text rendering and reply routing;
- work-chain/output correlation and terminal cleanup;
- route lease/deferred-restart accounting;
- run observability.

The direct path receives a replacement reservation, a queue hold, a manually
acquired work-chain lifecycle unit, the exact pinned thread, and a prebuilt
corrected prompt. It does not synthesize an ordinary `NormalizedMessage` and
push it through the queue.

The corrected successor becomes the current editable record for the same
target only after startup succeeds and the exact same thread is known. Its
delivered fingerprint is the accepted latest fingerprint, enabling a later
genuine second correction while rejecting a duplicate Reaction.

### 5.4 Prompt contract

Extend `BridgePromptSource` with `message_edit_restart` and add a typed escaped
`corrected_message` section containing at least:

```text
messageId
revision/fingerprint
full normalized text
supersedesEarlierAsr=true
priorEffectsRolledBack=false
oldRunStartedTool=<boolean>
```

The fixed instruction tells Codex to re-evaluate from the full corrected text,
while checking current workspace state if a tool had started. Use
`buildAgentPrompt()`/`safeJsonStringify()` so hostile Feishu text cannot close
metadata tags. Keep all Bridge policy/system instructions on their existing
developer/system path; do not embed new authority in raw user text.

## 6. Execution units

One Implementer owns all units sequentially. Do not split runtime ownership
across parallel implementations because Units 1–3 modify the same scheduling
state machine.

### Unit 1 — Feature boundary and replacement primitives

Dependencies: independent Plan Review `GO`.

Owned files:

- `src/config/schema.ts`
- `src/config/profile-schema.ts`
- `src/bot/active-runs.ts`
- `src/bot/pending-queue.ts`
- `src/runtime/run-executor.ts`
- `tests/unit/config/profile-schema.test.ts`
- `tests/unit/bot/active-runs.test.ts` (new if no focused file exists)
- `tests/unit/bot/pending-queue-edit-hold.test.ts` (new)
- `tests/integration/executor/run-executor.test.ts`

RED:

1. Flag is false when absent, true only when explicitly enabled, and cannot
   enable behavior for `agentKind=claude`.
2. Normal reservation cannot take a replacement-held scope.
3. A replacement reservation rejects a different/stale handle.
4. Old handle remains identifiable until exit is confirmed.
5. Corrected spawn is impossible when stop throws or `waitForExit` is false.
6. Old legacy `unblock()` cannot release the additive edit hold.
7. All pre-start failures release pool slot, reservation, and edit hold once.

GREEN:

- Add one hidden profile preference (suggested
  `preferences.codexEditedMessageRestart`) with explicit-true normalization and
  a resolver that also checks `agentKind === 'codex'`.
- Implement the typed replacement reservation/CAS lifecycle and an
  exit-confirming `RunExecution` operation.
- Implement additive PendingQueue holds without changing ordinary FIFO,
  debounce, barrier, or legacy block idempotency.
- Add bounded reason-code logs; no prompts/bodies.

Focused verification:

```bash
pnpm vitest run \
  tests/unit/config/profile-schema.test.ts \
  tests/unit/bot/active-runs.test.ts \
  tests/unit/bot/pending-queue-edit-hold.test.ts \
  tests/integration/executor/run-executor.test.ts
pnpm typecheck
```

Completion evidence: RED commit/test output, GREEN output, and a short state
transition table showing reservation and hold release on every branch.

### Unit 2 — Active-message ownership, single-fetch snapshot, and pinned restart

Dependencies: Unit 1 GREEN.

Owned files:

- `src/bot/edited-message-restart.ts` (new registry/contracts)
- `src/bot/quote.ts`
- `src/agent/prompt.ts`
- `src/bot/run-flow.ts`
- `src/bot/channel.ts` (registration, session/tool observations, shared started-run lifecycle)
- `tests/unit/bot/edited-message-restart.test.ts` (new)
- `tests/unit/agent/prompt-builder.test.ts`
- `tests/integration/bot/im-run-flow.test.ts`
- `tests/integration/session/resume.test.ts`

RED:

1. Only a sole accepted human `text`/`post` message with no resources can own
   an eligible active record; batch and attachment cases retain visible
   ineligibility for that author.
2. Terminal cleanup uses exact generation and cannot erase a claimed or newer
   record.
3. One already-fetched item normalizes full `text` and `post` bodies/resources
   without another API request; malformed/deleted/unsupported items fail.
4. First `tool_use` makes `toolStartedEver` permanently true.
5. Corrected prompt escapes closing tags, carries full text once, declares
   supersession/no rollback, and reports source `message_edit_restart`.
6. Direct flow submits the pinned old `threadId`; missing, non-durable,
   different catalog/prompt-session thread, cwd change, or policy change fails
   before stopping.
7. Corrected execution uses no `PendingQueue` push/barrier and reuses ordinary
   rendering/session cleanup after start.

GREEN:

- Add the bounded, compare-by-generation registry and correction-key outcome
  tracking.
- Expose a narrow normalizer that accepts the result of the controller's one
  fetch; do not broaden merge-forward/card support.
- Capture exact Codex thread durability in the editable record from the
  existing awaited session event path.
- Add a pinned-Codex-resume option/path that cannot silently select fresh or a
  different thread.
- Extract/reuse the minimum started-run lifecycle needed by the direct path;
  preserve ordinary IM behavior byte-for-byte where practical.
- Add monotonic tool-start tracking on the exact handle/record.

Focused verification:

```bash
pnpm vitest run \
  tests/unit/bot/edited-message-restart.test.ts \
  tests/unit/agent/prompt-builder.test.ts \
  tests/integration/bot/im-run-flow.test.ts \
  tests/integration/session/resume.test.ts
pnpm typecheck
```

Completion evidence: tests proving the same concrete thread ID reaches the
Codex adapter, the normalizer's fetch spy is called once by its owner, and the
prompt escaping snapshot contains no raw boundary break.

### Unit 3 — Loudspeaker control transaction and feedback

Dependencies: Unit 2 GREEN.

Owned files:

- `src/bot/edited-message-restart.ts`
- `src/bot/channel.ts`
- `src/bot/reaction/semantics.ts` (exact helper/constant only; do not add
  Loudspeaker to model-visible predefined semantics)
- `src/bot/reaction/pipeline.ts` only if a narrow dispatch seam is required
- `tests/unit/bot/reaction-semantics.test.ts`
- `tests/integration/bot/edited-message-restart.test.ts` (new)
- `tests/integration/bot/reaction-pipeline-wiring.test.ts`
- `tests/integration/bot/reaction-stop-control.test.ts`

RED scenarios, using controllable deferred Promises to assert order:

1. Only exact, case-sensitive `added + Loudspeaker` enters control handling;
   removal is a no-op and never cancels an accepted correction.
2. Self, other author, denied access, and unregistered target are silent and
   perform zero fetches/stops/replies.
3. Authorized eligible target performs exactly one fetch and validates author,
   chat/topic, type/resources, and changed fingerprint before reservation.
4. No edit and same consumed correction key perform no stop/start.
5. `replacement-held < final ownership check < stop < confirmed exit < direct
   spawn` is the observed order.
6. Completion before final CAS never restarts; a newer scope owner is untouched.
7. Duplicate events while the transaction is active share one outcome and
   cause one fetch, one stop, and one corrected spawn.
8. Ordinary pending units already present cannot flush between old exit and
   corrected registration, are not deleted, and drain FIFO after corrected
   terminal.
9. Old exit plus corrected startup failure releases reservation/hold and does
   not enqueue the correction.
10. Success and each required visible failure use distinct reason messages;
    side-effect warning appears iff the stopped handle had started a tool.
11. With flag off, ordinary reaction behavior remains unchanged. Claude never
    creates edit eligibility or enters the controller.

GREEN transaction order:

```text
exact Loudspeaker dispatch
  -> silent registry/author/access precheck
  -> one latest-message fetch + snapshot validation
  -> correction-key dedupe/join
  -> synchronous queue-hold + exact replacement reservation
  -> exact-handle final CAS
  -> stop and confirmed exit
  -> direct pinned-thread corrected start
  -> transfer hold/lifecycle ownership
  -> outcome reply and eventual ordinary drain
```

Reply in the original chat/topic against the edited message. Logs include only
scope-safe/redacted IDs, correction-key hash, phase, result code, stop-confirmed
bit, same-thread bit, pending count, and tool-started bit.

Focused verification:

```bash
pnpm vitest run \
  tests/unit/bot/reaction-semantics.test.ts \
  tests/integration/bot/edited-message-restart.test.ts \
  tests/integration/bot/reaction-pipeline-wiring.test.ts \
  tests/integration/bot/reaction-stop-control.test.ts \
  tests/integration/bot/reaction-batch-barrier.test.ts
pnpm typecheck
```

Completion evidence: one ordered trace from the deterministic integration
harness plus spy counts for fetch, stop, wait, spawn, and pending push/barrier.

### Unit 4 — Full regression, live canary, and rollback

Dependencies: Units 1–3 GREEN and Implementer self-review complete.

No new feature scope is allowed in this unit. Fixes found here return to the
owning earlier unit and rerun its RED/GREEN evidence.

Automated verification:

```bash
git diff --check
pnpm test
pnpm typecheck
pnpm build
node tools/check-privacy-denylist.mjs --tree --root .
```

Post-review frozen-worktree result: `git diff --check`, `pnpm test` (149 files,
1525 passed, 33 skipped), `pnpm typecheck`, and `pnpm build` passed. The privacy
tree command remained `NOT_RUN`/fail-closed because neither a formal
`--patterns-file` nor `LARK_BRIDGE_PRIVACY_DENYLIST_FILE` was available. No
source change occurred during this verification, so Code Review `GO` remains
applicable.

Also preserve focused coverage for:

- ordinary Codex exec and startup retry;
- Claude run flow;
- stop Reaction and `/stop` behavior;
- reaction buffering/barriers/work-chain cleanup;
- all reply render modes;
- session catalog/prompt-session durability;
- PendingQueue FIFO/debounce/block semantics;
- reconnect/deferred restart and process-pool release.

Live canary prerequisites:

- enable the single edit-restart flag on one non-critical Codex profile only;
- use a dedicated chat/topic and a reversible test workspace;
- record Bridge version/commit and sanitized timestamps/run/thread hashes;
- do not use real external side effects for the initial canary.

Live canary checklist:

- [ ] Start a deliberately long-running Codex turn from one attachment-free
  text/post message.
- [ ] Edit the message, then add `[喇叭]`; observe inbound
  `emojiType=Loudspeaker`.
- [ ] Prove old process exit timestamp precedes corrected process start.
- [ ] Prove old and corrected runs use the same redacted/thread hash.
- [ ] Prove the corrected prompt contains the latest full text and supersession
  marker, without logging the prompt itself.
- [ ] Queue two ordinary messages before/during replacement; prove neither
  starts in the stop/start gap and their relative order is preserved afterward.
- [ ] Repeat/re-add without editing; prove no extra stop or turn.
- [ ] Exercise a completion race; prove no restart/newer-run stop.
- [ ] Start a harmless local read-only tool, then correct; prove the visible
  side-effect warning appears.
- [ ] Exercise unsupported batch/attachment cases and confirm the active run is
  unchanged.

Rollback:

1. disable the single profile feature flag;
2. restart that Bridge profile through the normal supported operator path if
   required for config reload;
3. verify new `Loudspeaker` events no longer enter the edit controller and
   ordinary queue/Codex exec behavior remains healthy.

Rollback does not undo already stopped turns or prior tool effects. There is no
App Server/profile conversion to reverse and no automatic data migration.

## 7. Review gates

### Plan Review gate

The independent Plan Reviewer must specifically verify:

- the plan matches the revised confirmed Spec and contains no steer/App Server
  dependency;
- replacement reservation and queue hold have exact, failure-safe ownership;
- old exit is positively confirmed before corrected spawn;
- exact Codex thread identity is pinned rather than looked up opportunistically;
- single-fetch, silent-denial, no-queue, dedupe, tool-warning, and failure
  semantics are all testable;
- the implementation remains one-owner and units are sequential.

Only an independent `GO` permits Unit 1 to begin.

### Final Code Review gate

The original Plan Writer changes role to Code Reviewer after implementation.
Review the full diff against the Spec and this Plan, with special attention to
race behavior and failure cleanup. Final approval requires automated evidence,
the sanitized live canary, explicit residual `NOT_RUN` items (if any), and a
working flag-only rollback.

## 8. Deliverables

- updated source and focused tests owned by Units 1–3;
- RED/GREEN command output per unit;
- full regression/typecheck/build/privacy output;
- replacement reservation/hold failure matrix evidence;
- sanitized live canary timeline and same-thread proof;
- rollback verification;
- independent Plan Review and final Code Review decisions.
