# Group-scoped System Prompt Implementation Plan

Date: 2026-07-18
Status: implemented and verified; main deployment pending
Source Spec: `docs/specs/20260718-group-scoped-system-prompt.md`
Spec Review: PASS after iterative independent SubAgent review
Plan Review: PASS after iterative independent SubAgent review

## Outcome

Add a profile-and-group-scoped operator instruction layer that is pinned to a
logical Claude Session or Codex thread. The target Codex profile and group are
the first rollout. A configured group receives the pinned content through the
existing system/developer instruction transport; user stdin remains the dynamic
Feishu/Lark turn envelope.

The implementation must preserve these observable semantics:

- configuration lives at `<profileDir>/prompts/groups/<chatId>.md`;
- editing the Markdown does not change an active Session;
- `/new` is the activation boundary for a changed file beside an existing
  Session;
- restart and startup retry retain the pinned version;
- other groups, p2p, comments, and other profiles never receive the content;
- a profile with no activation files and no valid Group Prompt remains on the
  old Session path without creating new state;
- once a profile is activated, the versioned Sidecar is authoritative and
  failure is closed rather than silently dropping the group instruction.

## Non-Negotiable Boundaries

- Do not change the text or standalone output of `BRIDGE_SYSTEM_PROMPT` or
  `buildBridgeSystemPrompt(...)`.
- Do not put Group Prompt content in `user_input`, `bridge_context`,
  `bridge_instructions`, quoted/card payloads, logs, errors, or full argv.
- Do not use the live Markdown as the source for an existing Session.
- Do not add binding fields to the existing Session Catalog JSON; its current
  normalizer strips unknown fields.
- Do not treat `SessionCatalog` or Claude `SessionStore` as commit authorities
  after profile activation.
- Do not infer p2p/group provenance or a policy fingerprint that legacy state
  cannot prove.
- Do not add a V1 manual-resume path for pinned group/topic Sessions.
- Do not alter dormant Claude profile behavior. Shared lifecycle code may
  support a deliberately activated Claude profile, but the first deployment
  creates configuration only for the target Codex profile.
- Do not start an older, Sidecar-unaware binary against a profile after its
  activation marker commits. Post-activation recovery is roll-forward.
- Do not weaken path validation to ordinary check-then-read filesystem calls.

## Live Baseline And Source Boundaries

Record these before the first RED test:

1. `git status --short` must show only the reviewed Spec and this Plan.
2. `git log -1 --oneline` must identify the worktree baseline.
3. Run focused existing tests for Session, IM, commands, comments, and both
   adapters:

   ```text
   pnpm vitest run tests/unit/session/catalog.test.ts
   pnpm vitest run tests/integration/session/resume.test.ts
   pnpm vitest run tests/integration/bot/im-run-flow.test.ts
   pnpm vitest run tests/integration/commands/claude-commands.test.ts
   pnpm vitest run tests/integration/commands/resume-command.test.ts
   pnpm vitest run tests/integration/comments/comment-lifecycle.test.ts
   pnpm vitest run tests/unit/agent/adapter-system-prompt-wiring.test.ts
   pnpm vitest run tests/process/codex-adapter.test.ts
   pnpm vitest run tests/process/claude-adapter.test.ts
   ```

Current code seams to preserve unless a slice explicitly changes them:

- `src/bot/run-flow.ts` owns IM policy evaluation, automatic resume lookup,
  RunExecutor submission, and identifier recording.
- `src/bot/comments.ts` is the second Session-bearing direct production
  execution path.
- `src/commands/index.ts` owns `/new`, `/reset`, `/resume`, resume candidates,
  and the direct sessionless `/doctor` echo submit. Doctor remains explicitly
  exempt from Group Prompt binding and migration drainage.
- `src/session/catalog.ts` and `src/session/store.ts` are current persistence
  surfaces and become compatibility mirrors only for activated profiles.
- `src/runtime/run-executor.ts` constructs `AgentRunOptions` and is the narrow
  adapter boundary.
- `src/agent/claude/adapter.ts` transports system instructions through
  `--append-system-prompt-file`.
- `src/agent/codex/adapter.ts` transports them through
  `developer_instructions`.
- `src/config/app-paths.ts` exposes the trusted active `profileDir` and current
  runtime profile lock path.
- `src/cli/commands/start.ts` owns the outer profile runtime-lock lifetime and
  connect-before-disconnect reconnect; Prompt lifecycle state must live at this
  level rather than inside one channel instance.

## Planned Module Shape

Use narrow Session-owned modules instead of spreading filesystem and Sidecar
logic across channel, commands, comments, and adapters. Exact filenames may be
adjusted during implementation if tests show a cleaner boundary, but the
responsibilities must stay separated:

- `src/session/group-prompt-files.ts`
  - safe live-file lookup and chatId validation;
  - bounded no-follow read and SHA-256 calculation;
  - immutable snapshot create/revalidation/read/delete;
  - no Session policy or adapter logic.
- `src/session/prompt-binding-ledger.ts`
  - strict V1 schema, phase/marker health state, immutable records and indexes;
  - profile-serialized transactions, `ledgerRevision`, atomic persistence,
    activation recovery, retention and GC metadata;
  - no Feishu message parsing or prompt composition.
- `src/session/prompt-session-service.ts`
  - dormant/activated orchestration, first-install migration, identity lookup,
    fresh/resume/reset/manual-resume decisions, mirror repair, and comment
    `none` bindings;
  - the only production API used by run flow and commands.
- `src/agent/bridge-system-prompt.ts`
  - keep `buildBridgeSystemPrompt(...)` unchanged;
  - add one deterministic composition helper that wraps an optional validated
    group addendum after the shared protocol and before runtime identity.

Construct and load one profile-scoped `PromptSessionService` inside
`src/cli/commands/start.ts` after the outer profile runtime lock is acquired and
before the first channel is started. Pass that same instance into the initial
channel and every connect-before-disconnect replacement channel, then into IM
flow, comment flow, and command context. Do not create a service inside
`startChannel(...)` or independent instances with separate in-memory ledgers,
transaction queues, admission controllers, or dormant-run registries. Every IM
and comment run registers with this shared admission controller before
`RunExecutor.submit(...)`; per-channel `ActiveRuns` continues to own only local
scope/process handles.

## TDD Execution Slices

Each slice is completed RED to GREEN before the next begins. Refactor only
after the slice is GREEN. Every persistence test uses temporary profile paths
and an injectable clock/ID source; no test reads the operator's real profile.

### Slice 1: strict model, paths, and dormant invariance

RED:

- Add schema tests for `session-bindings.v1.json` records, origin provenance,
  `activeByIdentity`, `legacyActiveByScopeCwd`, reset tombstones, retirement,
  unreferenced snapshots, install/activation metadata, phase, and
  `ledgerRevision`.
- Reject unknown versions, duplicate/conflicting agent IDs, invalid hashes,
  mutable-record rewrites, cross-profile records, malformed identity keys, and
  inconsistent indexes.
- Add path tests proving the three approved profile-relative locations are
  derived only from trusted `profileDir`.
- Add dormant regression tests: marker absent plus Sidecar absent and no valid
  live prompt causes no migration, no Prompt directories/files, and exactly
  the old Catalog/SessionStore result for p2p, group resume, and comments.

GREEN:

- Add the strict data types and path resolver.
- Add a lightweight service health probe returning `dormant`, `activating`,
  `healthy`, `incomplete-initialization`, or `corrupt` without activating a
  dormant profile.
- Keep existing Session lookup untouched while the service reports dormant.

Focused proof:

```text
pnpm vitest run tests/unit/session/prompt-binding-ledger.test.ts
pnpm vitest run tests/integration/session/group-prompt-dormant.test.ts
```

### Slice 2: secure live-file and snapshot I/O

Complete separate RED-to-GREEN loops for:

1. chatId component validation and containment beneath the canonical profile;
2. missing directory/file resolving to `none` without canonicalizing a missing
   final path;
3. parent symlink/reparse rejection and final-file no-follow open;
4. same-descriptor regular-file validation, 64 KiB plus sentinel bounded read,
   fatal UTF-8 decode, empty/oversize rejection, and changed-during-read
   detection;
5. SHA-256 over the exact accepted bytes;
6. exclusive `0600` snapshot create plus file/directory fsync;
7. collision reuse only after no-follow type, byte-count, and hash
   revalidation;
8. pinned snapshot read and GC deletion with the same no-follow guarantees.

Use controllable filesystem seams for race tests rather than timing-dependent
sleep. Include final-file substitution, parent substitution, concurrent
exclusive create, malicious pre-existing symlink/non-regular snapshot, and
content mutation between reads.

Focused proof:

```text
pnpm vitest run tests/unit/session/group-prompt-files.test.ts
```

### Slice 3: serialized authoritative ledger transactions

RED:

- Prove one transaction reads the latest committed state inside a profile-wide
  queue, increments `ledgerRevision`, persists/fsyncs, and publishes memory
  only after success.
- Prove a persist failure leaves the previous in-memory and on-disk revision
  authoritative.
- Prove stale expected/on-disk revision fails closed and triggers reload rather
  than overwriting newer state.
- Run deterministic interleavings for record-versus-record, `/new` versus
  identifier commit, legacy promotion versus reset, and GC versus
  re-reference; require no lost update.
- Prove separate service instances cannot write the same profile unless the
  existing profile runtime lock establishes one writer.
- Prove connect-before-disconnect reconnect passes the same loaded service,
  transaction queue, and admission controller to both temporarily overlapping
  channels; writes from each channel serialize without lost update and neither
  channel can bypass a profile activation pause.

GREEN:

- Implement the profile-scoped transaction queue and strict atomic writer.
- Move service construction to the `withProfileAndAppLocks(...)` lifetime in
  `src/cli/commands/start.ts` and reuse it across reconnect. Reuse the runtime's
  existing profile lock ownership; add a narrower ledger lock only if live
  evidence proves transactions can execute outside that ownership. Do not
  create a second lock-order cycle.
- Expose mutation methods instead of raw mutable ledger access.

Focused proof:

```text
pnpm vitest run tests/unit/session/prompt-binding-ledger.test.ts
pnpm vitest run tests/integration/session/group-prompt-concurrency.test.ts
pnpm vitest run tests/integration/commands/reconnect-group-prompt-service.test.ts
```

### Slice 4: activation, interrupted migration, and compatibility mirrors

RED:

- Cover the full marker/Sidecar matrix:
  - absent/absent = dormant;
  - migrating/no marker = re-enumerate and rebuild/supplement;
  - migrating/matching marker = finish validation and active commit;
  - active/no marker, marker/no Sidecar, ID/version mismatch, malformed state =
    corrupt and blocked.
- Import every active Catalog entry and complete independent Claude
  SessionStore entry as immutable `legacy-none`; classify `doc:` as comment and
  unknown old IM chat type as `legacy-unknown`.
- Put fingerprinted entries in `activeByIdentity`; put independent Claude
  entries in `legacyActiveByScopeCwd`; reject conflicting origin/cwd/session
  evidence.
- Promote a transitional Claude pointer only on the first legal run with the
  real current policy identity.
- Repair Catalog and parseable SessionStore mirrors from Sidecar while
  preserving `idleTimeoutMinutes`; block when whole-store corruption makes
  that preference unknowable.
- Prove no run is accepted before `phase: active` commits.
- Exercise activation while different IM, topic, and comment scopes have
  dormant runs already admitted. New run admission pauses profile-wide;
  activation waits for each prior run to durably record its identifier and
  mirrors or terminate without one, then enumerates stores. A deadline aborts
  activation and releases the pause without marker creation or stopping those
  unrelated runs.
- Prove a prior dormant run cannot surface an unknown post-activation agent ID.
- During connect-before-disconnect overlap, trigger activation through one
  channel while the other attempts IM and comment admission; require both to
  observe the same pause and prove no run enters after the migration snapshot.
- Run the explicitly sessionless `/doctor` echo concurrently with activation;
  prove it receives no Group Prompt or record and is not mistaken for a dormant
  Session that migration must drain.

GREEN:

- Implement activation as migrating Sidecar persist, exclusive matching marker
  persist, then final active-phase transaction.
- Add a runtime-lock-scoped dormant-run registry and admission controller owned
  by `PromptSessionService`, shared by IM/comment execution and every
  overlapping channel. Register admission before `RunExecutor.submit`, mark
  identifier durability only after mirror flush, mark identifier-free
  termination during cleanup, and hold the shared controller's exclusive
  activation gate until migration commits or aborts. Do not use per-channel
  `ActiveRuns.pauseNewRuns(...)` as the profile-wide barrier.
- Add awaited mirror operations or explicit mirror-repair APIs; do not rely on
  the existing fire-and-forget mutation methods for authoritative sequencing.
- Keep mirror repair one-way from healthy Sidecar.

Focused proof:

```text
pnpm vitest run tests/integration/session/group-prompt-migration.test.ts
pnpm vitest run tests/integration/session/group-prompt-mirror-repair.test.ts
pnpm vitest run tests/integration/session/group-prompt-activation-barrier.test.ts
pnpm vitest run tests/unit/session/catalog.test.ts
```

### Slice 5: fresh IM pinning, automatic resume, restart, and retry

RED:

- A fresh eligible group Session securely resolves the live file, completes
  activation if needed, creates/revalidates the snapshot, and registers
  `unreferencedAt` before agent dispatch.
- A fresh activated p2p Session binds explicit `none`; a fresh activated group
  with no file also binds `none`; an invalid present file rejects before spawn.
- The first Claude `sessionId` or Codex `threadId` event commits immutable
  record plus active pointer, clears reset tombstone and snapshot GC marker,
  then awaits compatibility mirrors.
- Identifier/persist failure never exposes resumable state.
- Before identifier persistence succeeds, substantive events are not delivered
  to cards, Markdown, or comment replies. Commit/required mirror failure stops
  and reaps the run, disables Codex startup retry, discards later events,
  releases the active scope, and emits one stable content-free IM/comment
  failure.
- Automatic resume requires the exact record/profile/origin/identity and reads
  only the pinned snapshot; missing/hash-mismatched snapshots reject without
  live-file fallback.
- Two topic scopes under one parent chat may pin different versions.
- Restart reloads the exact version.
- Codex startup retry for one Feishu turn reuses one immutable live resolution
  and snapshot, not a reread after an operator edit.

GREEN:

- Extend run-flow inputs with trusted origin metadata and one memoized
  per-turn Prompt resolution reused by the startup-retry closure.
- Resolve authoritative resume/fresh state after policy/cwd identity is known.
- Extend `AgentRunOptions` and RunExecutor with optional
  `systemPromptAddendum`; `undefined` must preserve the old adapter input.
- Make identifier recording async/awaited and turn the system event into an
  explicit stream delivery barrier. Extend the IM and comment stream consumers
  so persistence failure propagates through normal executor cleanup rather than
  escaping a synchronous callback or leaving the child/fanout alive.

Focused proof:

```text
pnpm vitest run tests/integration/session/group-prompt-lifecycle.test.ts
pnpm vitest run tests/integration/bot/im-run-flow.test.ts
pnpm vitest run tests/integration/runtime/codex-startup-retry-prompt.test.ts
pnpm vitest run tests/integration/session/resume.test.ts
pnpm vitest run tests/integration/runtime/group-prompt-commit-failure.test.ts
```

### Slice 6: `/new`, reset, and manual-resume safety

RED:

- Dormant `/new` with no live file follows the old path and creates no Prompt
  state; invalid file reports failure without clearing the current Session.
- Dormant eligible `/new` with a valid file completes migration and atomically
  commits active phase plus current-identity reset tombstone before reply.
- Activated `/new` retires the old record, removes the active pointer, and
  writes a reset generation before mirror clear/archive; crash injection at
  every boundary never revives the old Session.
- Replies occur only after mirrors are durably reset or durably marked degraded
  for repair.
- p2p `/resume` hides/rejects pinned group/topic records.
- A pre-activation vendor candidate may be adopted once as `legacy-none` only
  when trusted history time is before `activatedAt`; post-activation unknowns
  and cross-identity re-adoption reject.

GREEN:

- Inject `PromptSessionService` into `CommandContext` and route `/new`, reset,
  history filtering, and resume application through it when activated.
- Preserve the existing dormant command path and visible replies.
- Keep V1 pinned group/topic history automatic-resume-only.

Focused proof:

```text
pnpm vitest run tests/integration/commands/group-prompt-new.test.ts
pnpm vitest run tests/integration/commands/resume-command.test.ts
pnpm vitest run tests/integration/commands/claude-commands.test.ts
```

### Slice 7: comment Sessions participate without receiving group content

RED:

- Dormant comment fresh/resume behavior remains byte-for-byte equivalent and
  creates no Prompt state.
- Activated comment fresh Sessions commit explicit `none` with comment origin,
  document/comment scope, and exact policy identity.
- Activated comment resume, restart, reset, migration, mirror repair, and
  concurrent comment runs use the authoritative Sidecar.
- No comment adapter invocation ever receives a group addendum.
- The sessionless `/doctor` echo receives no group addendum, creates no Sidecar
  record, and can run without being misclassified as a dormant resumable run.

GREEN:

- Route comment Session identity resolution and event recording through the
  shared service while retaining the current comment execution scope and
  document Session scope distinctions.
- Preserve existing comment timeout and parallel-run behavior.

Focused proof:

```text
pnpm vitest run tests/integration/comments/group-prompt-comment-session.test.ts
pnpm vitest run tests/integration/comments/comment-run-flow.test.ts
pnpm vitest run tests/integration/comments/comment-lifecycle.test.ts
pnpm vitest run tests/integration/comments/claude-comments.test.ts
```

### Slice 8: deterministic composition and adapter transport

RED:

- The composition helper emits layers in this order: shared bridge protocol,
  lower-priority wrapped `group_system_prompt`, runtime bot identity.
- With no addendum, output equals the current
  `buildBridgeSystemPrompt(identity)` byte-for-byte.
- Group text containing Markdown, XML-like content, quotes, backticks, and
  non-ASCII survives exact transport without entering stdin or logs.
- Claude receives the complete composed string through its existing append
  system-prompt file on fresh and resume.
- Codex receives it through the existing `developer_instructions` override on
  fresh, resume, and safe startup replay.

GREEN:

- Add only the composition helper and the optional run option.
- Keep each adapter's existing transport mechanism, capability metadata,
  command ordering, and dynamic stdin path unchanged.
- Extend redaction inputs to cover the composed string without logging it.

Focused proof:

```text
pnpm vitest run tests/unit/agent/bridge-system-prompt.test.ts
pnpm vitest run tests/unit/agent/adapter-system-prompt-wiring.test.ts
pnpm vitest run tests/process/codex-adapter.test.ts
pnpm vitest run tests/process/claude-adapter.test.ts
pnpm vitest run tests/integration/runtime/codex-startup-retry-prompt.test.ts
```

### Slice 9: retention, orphan snapshots, and observability

RED:

- Active records never retire; replaced/reset records remain 90 days.
- Eligible record removal atomically registers newly unreachable hashes.
- Snapshot creation before agent dispatch registers `unreferencedAt`; record
  commit within seven days clears it; still-orphaned data is removed only after
  seven continuously unreferenced days.
- Crash-gap snapshots absent from the complete healthy ledger receive a fresh
  seven-day window from detection; file mtime cannot shorten it.
- GC versus re-reference interleavings cannot delete reachable snapshots.
- Successful deletion clears metadata; interrupted deletion may leak but never
  deletes a referenced file.
- Logs expose profile/scope/origin, binding state, and hash only. Prompt bodies,
  snapshot contents, full developer instructions, and full argv remain absent.

GREEN:

- Run retention/GC only after healthy ledger load and mirror reconciliation.
- Use ledger reachability plus no-follow snapshot verification for deletion.
- Add stable degraded/corrupt diagnostics suitable for `/doctor` or startup
  logs without adding a new user command unless implementation needs one.

Focused proof:

```text
pnpm vitest run tests/unit/session/prompt-binding-ledger.test.ts
pnpm vitest run tests/integration/session/group-prompt-gc.test.ts
pnpm vitest run tests/integration/commands/doctor-redaction.test.ts
pnpm vitest run tests/integration/observability/run-events.test.ts
```

## Verification Gates

### Focused gate

Run every new suite plus the existing suites named in the slices. Then run:

```text
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

### Diff-boundary gate

- `BRIDGE_SYSTEM_PROMPT` and the existing no-addendum output of
  `buildBridgeSystemPrompt(...)` are unchanged.
- Claude still uses `--append-system-prompt-file`; Codex still uses
  `developer_instructions`.
- No prompt body or snapshot content appears in logs, user prompts, command
  replies, fixtures that mimic production telemetry, or error messages.
- Existing Catalog JSON shape remains unchanged.
- Dormant profiles create no marker, Sidecar, snapshot directory, or altered
  mirror state.
- The deployment/config diff creates a live Markdown only under the explicitly
  selected target Codex profile, never under Claude or another profile.

### Crash and concurrency gate

Use fault injection around every authoritative boundary:

1. migrating Sidecar persist;
2. activation marker create;
3. final active-phase commit;
4. activation barrier while dormant runs are admitted or completing;
5. snapshot create and orphan-marker commit;
6. record/active-pointer commit while output is waiting behind the delivery
   barrier;
7. mirror update;
8. reset tombstone/retirement commit;
9. retired-record removal and snapshot GC;
10. reconnect overlap while both channel instances submit lifecycle work.

For each boundary, restart from disk and prove the state is either recoverable
under the Spec or explicitly corrupt/degraded and blocked. No case may silently
resume with a missing or newer Group Prompt.

## Rollout And Runtime Acceptance

Implementation rollout and content activation are separate gates.

1. Build and run all verification gates from this feature worktree.
2. Merge the reviewed implementation to main and deploy the main build.
3. Before adding any live Group Prompt, verify the deployed target Codex
   profile and a Claude control profile remain dormant and unchanged.
4. Create only the approved target file:

   ```text
   <target-codex-profile-dir>/prompts/groups/<target-chatId>.md
   ```

   Its operator-authored body is a deployment input, not hard-coded source.
5. In the target group, run `/new`; require successful activation/reset before
   sending the canary turn.
6. Verify with redacted evidence:
   - target group receives the intended role behavior;
   - another group on the same profile does not;
   - p2p and comments do not;
   - the Claude control profile does not activate;
   - Sidecar record/hash and adapter transport are correct without reading
     prompt content into logs.
7. Edit the Markdown and prove the active Session remains on the old hash.
8. Run `/new` and prove the next Session pins the new hash without restarting
   the bridge.
9. Restart the bridge and prove automatic resume retains that new pinned hash.

If runtime acceptance fails before activation, remove the live file and roll
back the binary normally. If it fails after activation, keep the marker,
Sidecar, and snapshots, stop the bridge, and deploy a Sidecar-aware roll-forward
fix. Do not run the old binary against that profile.

## Execution Record

Implementation completed in `feat/group-scoped-system-prompt` on 2026-07-18.
Three iterative independent SubAgent review rounds were resolved; the final
review reported PASS with no P0/P1 blockers. The final feature-worktree gate
passed:

- `pnpm test`: 108 files, 737 tests passed;
- `pnpm typecheck`: passed;
- `pnpm build`: passed;
- `git diff --check`: passed.

The implementation includes secure live/snapshot file IO, strict versioned
Sidecar persistence, dormant activation and roll-forward recovery, finite
profile-wide activation drainage, fresh/resume/retry/reset lifecycle handling,
connect-before-disconnect sharing, comment isolation, mirror repair,
retention/GC, adapter transport, and prompt redaction. The `/new` path cancels
pre-submit reservations, holds a same-channel reset reservation, closes the
shared admission gate, and commits first activation plus the reset tombstone in
one ledger transaction.

No operator-authored Group Prompt body was available during implementation, so
no live `<profileDir>/prompts/groups/<chatId>.md` file was created. Content
activation, group behavior canary, version-edit `/new`, and post-restart
runtime acceptance remain deliberately NOT_RUN until that deployment input is
approved.

## Completion Criteria

- All Spec acceptance criteria map to a named automated or runtime proof above.
- Every new persistence mutation is awaited, serialized, revisioned, and
  restart-tested.
- One runtime-lock-scoped service/queue/admission controller survives channel
  reconnect overlap, and activation cannot miss an already-admitted dormant
  run or accept a new run through the overlapping channel.
- Identifier commit failure has verified stop/reap, no-retry, output-discard,
  scope-release, and redacted user-error behavior on IM and comments.
- Fresh, resume, retry, restart, `/new`, migration, comments, retention, and GC
  paths are covered for both agent identifier forms where applicable.
- Dormant Claude and unconfigured profiles pass unchanged regression tests.
- Target Codex canary passes isolation and version-pinning checks.
- Deployment and rollback evidence clearly distinguish code deployed, profile
  activated, and runtime behavior accepted.
