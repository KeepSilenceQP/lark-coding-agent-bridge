# Azu Group Prompt Context-Guided Bugfix — Repository Evidence

Date: 2026-07-23

## Unit 4 Repository Result (Historical Snapshot)

This section records the repository state at the end of Unit 4, before Unit 5
deployment/activation and Whole-Demand Acceptance. It is retained as historical
evidence; the current delivery state is the final table under
`Whole-Demand Acceptance Finalization`.

Repository evidence at that point was **authored and tested with a mixed
outcome**:

- the demand-scoped operator, schema, deterministic/fake-effect, retained
  parent-control, typecheck, build, and patch-integrity gates pass;
- Unit 3 completed its second Fix Loop and received final reviewer
  `Continue`;
- repeated full-suite and focused runs disagree across invocations, including
  on a clean detached baseline. The full repository suite is not stably GREEN.

Unit 4 reviewer decision is **`Continue`** with classification exactly
**`accepted repository baseline risk`**. Unit 5 may enter with this accepted
risk, but the risk and the full-suite `MIXED / not stably GREEN` result must
remain explicit in the Unit 5 handoff, Whole-Demand Acceptance, Whole-Demand
Code Review, and final status. This classification does not excuse any later
live or code-review failure and does not turn the full suite GREEN.

At this Unit 4 boundary, no profile deployment, activation, live topic/session
acceptance, commit, push, MR, merge, or production deployment had been
performed.

## Baseline And Changed-File Boundary

- Worktree:
  `/Users/bytedance/repo/lark-coding-agent-bridge-worktrees/azu-group-prompt-router-optimization`
- Branch: `feat/azu-group-prompt-guided-bugfix`
- HEAD at Unit 4 start and final audit:
  `c70be349a7f8107e9402a6925ca7b8c5d0d4bc82`
- Index: no staged demand changes.
- Dirty baseline: seven tracked unstaged modifications and four untracked
  files. This is observed worktree state; it does not attribute every dirty
  path to Unit 4 or claim that Unit 4 created it.
- Unit 4 authored only this evidence file. It did not edit the Spec, Plan,
  operator inputs, tests, Bridge, callback, or Harness source.

The initial and final changed-file audits contained exactly these 11 paths:

| Status | Path |
| --- | --- |
| modified | `operator-prompts/README.md` |
| modified | `operator-prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md` |
| modified | `tests/acceptance/azu-group-prompt-router.live.test.ts` |
| modified | `tests/acceptance/azu-group-prompt-router.worker.test.ts` |
| modified | `tests/fixtures/azu-group-prompt-router/probe-output.schema.json` |
| modified | `tests/fixtures/azu-group-prompt-router/scenarios.json` |
| modified | `tests/unit/operator-prompts/azu-group-prompt-contract.test.ts` |
| untracked | `docs/agent-context/evidence/20260721-azu-group-prompt-context-guided-bugfix-acceptance.md` |
| untracked | `docs/plans/20260721-azu-group-prompt-bug-confirmation-gate-plan.md` |
| untracked | `docs/specs/20260721-azu-group-prompt-bug-confirmation-gate.md` |
| untracked | `operator-prompts/routes/memorydata-bug.md` |

The corrected allowlist audit passed with 11 paths. An earlier local audit
script incorrectly trimmed the first porcelain status column and produced a
script-only false failure; its corrected parser preserved the status columns
and passed. No extra generated or unrelated path was present.

## Traceability

Evidence layers remain separate:

- **static operator contract**: repository Markdown and focused assertions;
- **deterministic/disposable contract**: fixtures, schema, fake commands,
  canonical parsing, and before/after snapshots;
- **isolated live-model audit**: selected Codex runs inside disposable
  repositories with fake Lark/Bits commands;
- **live profile/runtime**: not run in Unit 4.

### Confirmed Delta Spec

| Spec contract | Operator/document evidence | Test evidence |
| --- | --- | --- |
| Sections 3–5: retain general intake and add a semantic, lightweight `memorydata-bug` route with live-path fallback | Group Prompt, `入口鉴权与批次门禁` through `MemoryData Bug 语义路由`; the route contains only route id, applicability, profile-local SOP path, and missing/unreadable fallback | focused parent/router cases; general/product/vague and retained negative scenarios |
| Sections 6–7: persona, uncertainty-driven investigation, correct lineage, responsibility transfer, proportionate verification, and named Harness reuse | route SOP `调查心智` and `知识地图` | focused persona case; sufficient/development/release/insufficient/responsibility/Harness scenarios |
| Section 8: `执行`, `提交 Bits`, `确认提交`, matching intent, and readback-before-retry | route SOP `分析结论与交付授权` | focused authorization cases; deterministic/fake-effect execute, dry-run, matching-submit, and unknown-readback scenarios |
| Section 9: separate completion states | route SOP final paragraph | focused delivery-intent contract |
| Section 10.1 and section 11: paired inputs, `/new` activates only Group Prompt, fresh-topic SOP read, no old-topic hot switch, and no SHA/session binding | `operator-prompts/README.md`, `Activation boundary` | focused paired-deployment contract; deployment/activation/rollback remain Unit 5 |
| Sections 10.2–10.3: seven behavior cases and side-effect boundaries | operator pair above | 30-scenario fixture matrix, output schema, deterministic worker contracts, fake Git/Bits/Lark shims, and reviewed retained-five evidence |
| Section 10.4: two-topic isolation, same-topic continuation, live MemoryData and non-MemoryData routes | repository evidence is insufficient by design | `NOT_RUN`; reserved for guide-owned Whole-Demand Acceptance |

### Retained Parent Contracts

| Retained contract | Exact repository evidence |
| --- | --- |
| trusted relay authentication and forged/malformed/mixed-batch read-only degradation | Group Prompt `入口鉴权与批次门禁`; focused parent case; forged, unknown-bot, mixed-batch, unreadable, and source-conflict scenarios |
| exact/narrow source recovery and evidence-not-authority handling | Group Prompt `最小充分取证`; focused parent case; source-conflict and prompt-injection scenarios |
| attachment minimization | Group Prompt context rule 5; live unrelated/required-attachment canaries remain `NOT_RUN` |
| source-app/current-app identity isolation | Group Prompt `证据与身份边界`; `cross-app-id-misuse`; live outbound-action canary remains `NOT_RUN` |
| general explanation/classification and non-MemoryData handling | Group Prompt `先解释，再分类` and `按动作与权限路由`; focused parent case and general/product/test/vague scenarios |
| correct lineage plus dirty/stale/concurrent protection | route SOP investigation and authorization recheck; deterministic development/release/merged/remote/dirty/concurrent scenarios |
| split completion reporting | route SOP final paragraph and focused delivery-intent contract |

Bridge and callback infrastructure is an unchanged control, not acceptance
evidence for this text-only design. No `src` file, callback contract, retained
parent authority artifact, or MemoryData Harness source is in the changed-file
set. The SOP only references reviewed Harness roles, flows, and paths.

## Operator Input Integrity

These values identify reviewed repository bytes only. They are not a runtime
version/session binding, deployment readback, or proof that a profile contains
the files.

| Repository input | Bytes | SHA-256 |
| --- | ---: | --- |
| `operator-prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md` | 7,042 | `4c5d9467fd80a73fa26533b2243f97010ed2887dac811d80a130abd3c910e26f` |
| `operator-prompts/routes/memorydata-bug.md` | 3,929 | `29974fd0074652128e001064f251ee35cf984249dd868addc525bf6691e3aa0e` |

## Unit 3 Reviewed Closure

The first Unit 4 repository-readiness sample (`1 PASS / 4 FAIL`) reopened Unit
3 instead of selecting only successful targeted reruns. Unit 3 then retained
one fresh, same-batch five-case audit:

- result: `4 PASS / 1 FAIL`;
- the only failure was the dry-run case serializing the synthetic intent as
  the exact bare alias `discount-fix-246`;
- dry-run authorization, `bits_dry_run` action/write intent, fake dry-run call,
  and no-Git-effect checks all passed before that comparison;
- the accepted semantic was correct, while the prior lineage comparator did
  not canonicalize that exact bare-intent serialization.

The Fix Loop added a canonical exact-token lineage parser plus deterministic
positive and negative tracers: accepted combined/bare branch/bare-intent forms
pass, while wrong extra lineage, substring, prefix, and suffix forms fail.
The final Unit 3 reviewer decided `Continue` and explicitly required no further
random model batch. This closes the identified acceptance-parser defect; it
does not convert the unrun full 30-case live-model matrix into PASS.

All selected model cases ran at the **isolated live-model +
disposable/fake-effect** layer. The runner uses disposable Git
repositories/remotes, fake Lark/Bits commands, before/after fingerprints, and
real-MemoryData no-change checks. It created no real Feishu write, Bits MR,
profile mutation, or production effect.

## Authentication Retention Safety

Eleven temporary copied authentication files from retained acceptance roots
were deleted. Source authentication metadata remained unchanged. No
credential content, source path, or derived secret is recorded here.

Future explicit and automatic evidence retention now:

1. validates that the target is an acceptance-owned temporary root before any
   recursive removal;
2. scrubs the copied credential before retaining synthetic evidence;
3. removes the entire acceptance root if scrub fails;
4. preserves unrelated paths when the path guard rejects them.

The final relevant operator/worker/retention run passed
`21 tests` with `31 opt-in tests skipped`.

## Repository Verification

### Stable demand-scoped gates

| Command / layer | Result | Detail |
| --- | --- | --- |
| focused operator contract | PASS | 1 file, 7 tests |
| fixture/schema JSON parsing and deterministic consistency | PASS | JSON/schema and current action/write vocabulary agree |
| operator + worker + retention/live-runner default set | PASS / SKIP | 21 passed; 30 worker opt-in cases plus 1 outer live-model test skipped |
| parent Plan six-file control set | PASS | 6 files, 75 tests |
| final reviewer named focused set | PASS | 3 files, 15 tests |
| `pnpm typecheck` | PASS | `tsc --noEmit` exited 0 |
| `pnpm build` | PASS | ESM CLI/index and declaration build completed |
| tracked `git diff --check` | PASS | tracked patch whitespace valid |
| four untracked-file `git diff --no-index --check` checks | PASS | Delta Spec, Plan, route SOP, and this evidence record |
| changed-file allowlist | PASS | exactly the 11 paths listed above |

The parent Plan six-file control set is:

- `tests/unit/session/group-prompt-files.test.ts`
- `tests/unit/session/prompt-session-service.test.ts`
- `tests/integration/session/group-prompt-migration.test.ts`
- `tests/integration/bot/bot-at-bot-context.test.ts`
- `tests/process/codex-adapter.test.ts`
- `tests/process/claude-adapter.test.ts`

### Full-suite and focused results: mixed, not stably GREEN

Every observed result is retained:

| Invocation | Result |
| --- | --- |
| Unit 4 executor, current dirty worktree, full suite | **FAIL** — 108 files passed, 1 skipped, 2 failed; 752 tests passed, 31 skipped, 2 failed. Failures: turn-state probe temporary record `ENOENT`; startup-retry expected `done`, received `idle_timeout`. |
| Unit 4 reviewer, current dirty worktree, full suite | PASS — 110 files passed, 1 skipped; 754 tests passed, 31 skipped. |
| Unit 4 reviewer, immediate focused two-file run | **FAIL** — turn-state probe `ENOENT`; startup-retry passed. |
| root, focused two-file run | PASS — both files, 2/2 tests. |
| root, current dirty worktree, full rerun | **FAIL** — same two failures as the Unit 4 executor full run. |
| clean detached `c70be349` temporary worktree, full baseline | **FAIL** — one unchanged `codex-prepare-run` SIGTERM timing test failed; 108 files passed, 2 skipped; 738 tests passed, 1 skipped. |
| Unit 4 final reviewer, named focused three-file run | PASS — `codex-turn-state-probe`, `codex-startup-retry-prompt`, and `codex-prepare-run`; 3 files, 15 tests. |

The results vary across full and focused invocations, and the clean baseline
failed in a different unchanged timing-sensitive test. The defensible
conclusion is only that the full-suite parallel/timing result is inconsistent
and has not reached stable GREEN. No causal stability label is assigned, and
no single passing run is selected as the repository verdict.

### Reproduction commands

```text
pnpm exec vitest run tests/unit/operator-prompts/azu-group-prompt-contract.test.ts
jq empty tests/fixtures/azu-group-prompt-router/scenarios.json tests/fixtures/azu-group-prompt-router/probe-output.schema.json
pnpm exec vitest run tests/unit/operator-prompts/azu-group-prompt-contract.test.ts tests/acceptance/azu-group-prompt-router.worker.test.ts tests/acceptance/azu-group-prompt-router.live.test.ts
pnpm exec vitest run tests/unit/session/group-prompt-files.test.ts tests/unit/session/prompt-session-service.test.ts tests/integration/session/group-prompt-migration.test.ts tests/integration/bot/bot-at-bot-context.test.ts tests/process/codex-adapter.test.ts tests/process/claude-adapter.test.ts
pnpm exec vitest run tests/process/codex-turn-state-probe.test.ts tests/integration/runtime/codex-startup-retry-prompt.test.ts tests/unit/agent/codex-prepare-run.test.ts
pnpm test
pnpm typecheck
pnpm build
git diff --check --
git diff --no-index --check /dev/null <untracked-file>
```

The full 30-case opt-in live-model command is intentionally not run in Unit 4:

```text
RUN_AZU_GROUP_PROMPT_ACCEPTANCE=1 pnpm exec vitest run tests/acceptance/azu-group-prompt-router.live.test.ts
```

## Unit 4 Repository Gate And Delivery State (Historical Snapshot)

| Gate/state | Value | Evidence boundary |
| --- | --- | --- |
| demand-scoped repository contracts | PASS | operator, schema, deterministic/fake-effect, retained parent controls |
| Unit 3 review | `Continue` | canonical parser/tracers and auth-retention safety reviewed |
| full repository suite | MIXED / not stably GREEN | mutually inconsistent full/focused runs retained above |
| Unit 4 review | `Continue` | classification: `accepted repository baseline risk` |
| Unit 5 readiness | may enter with accepted risk | risk must be carried into Unit 5, WDA, code review, and final status |
| authored | yes | repository operator pair, docs, fixtures, and tests exist in the dirty worktree |
| tested | yes | outcome is mixed; tested does not mean every gate passed |
| deployed (profile pair) | no | Unit 5 `NOT_RUN` |
| activated | no | `/new` `NOT_RUN` |
| runtime accepted | no | live topic/session/router/WDA `NOT_RUN` |
| committed | no | HEAD unchanged; demand files remain dirty/untracked |
| pushed | no | no push performed |
| MR opened | no | no production MR operation |
| merged | no | no merge performed |
| deployed-to-prod | no | no production deployment performed |

Additional `NOT_RUN` boundaries:

- current profile discovery, backup, paired install, readback, rollback drill,
  and activation canary;
- live MemoryData route and non-MemoryData route;
- two-topic isolation and same-topic continuation;
- live attachment-minimization and cross-app identity canaries;
- full 30-case opt-in live-model matrix.

No secret, raw private transcript, verification code, auth content, or
unnecessary live message/topic identifier is recorded here.

## Unit 5 Runtime Deployment And Activation Evidence

Date: 2026-07-23

Unit 5 performed the profile-local paired install, activation canaries,
rollback drill, restored activation, final redeploy, and final activation
canary for the codex profile. This section records only redacted, non-secret
runtime facts; it is not Whole-Demand Acceptance and does not change the Unit 4
repository verdict.

### Profile pair and backup integrity

| Runtime artifact | Expected / observed result |
| --- | --- |
| live Group Prompt | sha256 `4c5d9467fd80a73fa26533b2243f97010ed2887dac811d80a130abd3c910e26f`, bytes `7042`, mode `0600` |
| live MemoryData Bug SOP | sha256 `29974fd0074652128e001064f251ee35cf984249dd868addc525bf6691e3aa0e`, bytes `3929`, mode `0600` |
| live routes directory | exists, mode `0700` |
| backup root | `/Users/bytedance/Documents/运维/backup/20260723-174001-unit5-group-prompt-install` retained |

Final readback after the third `/new` and final canary still matched the live
pair above. The backup manifest and prior Group Prompt backup remained present
and readable.

### Activation and rollback sequence

| Step | Runtime result |
| --- | --- |
| first Topic A `/new` | established a fresh Topic A session and bound the installed Group Prompt bytes |
| first activation canary | admitted in Topic A, replied in the same topic, resolved route id `memorydata-bug`, used the live SOP path, reported SOP readable, and did not execute a repair |
| exact restore | restored the prior Group Prompt and removed the new SOP; recoverability proven |
| second Topic A `/new` | archived the installed-session and established a restored-session bound to the restored Group Prompt |
| rollback canary | replied in Topic A with the expected no-op rollback text |
| final paired redeploy | restored the reviewed Group Prompt/SOP pair with the final hashes, sizes, and modes above |
| third Topic A `/new` | archived the rollback-session and established a fresh final Topic A session |
| final activation canary | admitted in Topic A, replied in the same topic, bound Group Prompt sha256 `4c5d9467fd80a73fa26533b2243f97010ed2887dac811d80a130abd3c910e26f` with byte count `7042`, resolved route id `memorydata-bug`, used the exact live SOP path, reported SOP readable, and did not execute a repair |

The final canary card visibly contained only the requested route id, live SOP
path, readable status, and explicit no-repair statement plus the read-only local
SOP check. No business data read, file fix, Git write, Bits action, deployment,
rollback, restart, or WDA/final-review action was performed by the canary.

### Isolation and current gate

Topic B stayed unaffected by the three Topic A `/new` operations: its thread
still contained only the initial no-op B probe and reply, and its session
catalog/ledger entry remained separate from Topic A.

Unit 5 executor snapshot before Unit Review and Whole-Demand Acceptance:

- deployed (profile pair): `PASS`
- activated (Topic A canaries): `PASS`
- rollback/recoverability: `PASS`
- runtime WDA / fresh deployed business topics: `NOT_RUN`
- whole demand accepted: `NO`
- next state: `Unit Implementation Review`

The accepted repository baseline risk remains **MIXED / not stably GREEN** and
must continue into Unit Implementation Review, WDA, code review, and final
status.

## Whole-Demand Acceptance Finalization

Date: 2026-07-23

Decision: **Pass with explicit accepted remaining risks**.

This finalization is based on the converged Unit 1–5 evidence, the fresh
runtime WDA evidence, and Qin Peng's explicit human decision to continue
without expanding this prompt/SOP demand into Bridge attachment-intake source
changes.

### Final live pair drift check

The codex profile live prompt pair was re-read after the final WDA discussion
and still matched the Unit 5 final deployed pair:

| Runtime artifact | Final observed result |
| --- | --- |
| live Group Prompt | sha256 `4c5d9467fd80a73fa26533b2243f97010ed2887dac811d80a130abd3c910e26f`, bytes `7042`, mode `0600` |
| live MemoryData Bug SOP | sha256 `29974fd0074652128e001064f251ee35cf984249dd868addc525bf6691e3aa0e`, bytes `3929`, mode `0600` |
| live routes directory | exists, mode `0700` |

No post-canary prompt-pair drift was observed. This is only a profile-local
readback of the installed prompt files; it is not a commit, push, MR, merge,
restart, Bridge source deployment, or production deployment claim.

### Fresh deployed business WDA

Fresh deployed business-topic evidence passed:

- fresh MemoryData Bug topic: the live SOP was actually read; the response
  followed the new route by asking the minimal uncertainty/lineage question
  instead of executing a repair;
- same-topic continuation: remained in the same deployed business session;
- fresh non-MemoryData/general topic: stayed on the general route, performed
  zero MemoryData SOP/tool read, and produced no MemoryData side effect;
- topic/session/marker isolation: fresh topics, sessions, markers, and effect
  boundaries stayed separated;
- no business data read, file fix, Git write, Bits action, deployment,
  rollback, restart, commit, push, MR, merge, or production effect was claimed
  from these WDA canaries.

### Attachment evidence and accepted transport risk

Attachment minimization is split by layer:

- model/agent layer: `PASS` — setup wait was respected; the unrelated
  attachment was not read and its model-context marker was absent; when a
  required attachment and decoy were both present, only the named required
  attachment was read, the decoy was not read, and the decoy model-context
  marker was absent; no business side effect occurred;
- Bridge transport/cache layer: `FAIL / accepted remaining risk` — Bridge
  eagerly downloaded/cached unrelated, required, and decoy attachments on
  arrival before START.

This transport behavior is recorded as an existing Bridge behavior and not
reinterpreted as fixed or disproven by this prompt/SOP demand. Qin Peng
explicitly accepted this boundary in the group conversation with:
`继续吧，bridge提前下载附件也没什么`. Therefore WDA does not expand scope into
Bridge attachment-intake source changes.

### Source-app/current-app identity boundary

No live trusted-relay fixture was available for a fresh relay canary in this
final WDA pass. The accepted substitute is the Unit 3 disposable
live-model/fake-effect evidence, which covered current-app/source-app ID
non-reuse and no outbound effect. This remains:

- live trusted relay canary: `NOT_RUN`;
- disposable source-app/current-app identity substitute: `ACCEPTED BY HUMAN`;
- outbound live effect from this WDA finalization: `none`.

### Repository baseline risk carried forward

The full repository suite remains **MIXED / not stably GREEN** as recorded
above. Demand-scoped gates, reviews, deployment/activation/rollback, and
business WDA passed, but this does not convert the full suite to GREEN. The
baseline risk must remain visible in Whole-Demand Code Review and final
delivery status.

### Final delivery state

| Gate/state | Final WDA value |
| --- | --- |
| Units 1–5 | `PASS / Continue`, with Unit 5 deployed/activated/rollback `PASS` |
| final live prompt pair | `PASS`, no drift observed |
| fresh business WDA | `PASS` |
| attachment model/agent behavior | `PASS` |
| attachment Bridge transport/cache behavior | `FAIL / accepted remaining risk` |
| source-app live relay canary | `NOT_RUN / disposable substitute accepted` |
| full repository suite | `MIXED / not stably GREEN` accepted baseline risk |
| whole demand accepted | `YES, with explicit accepted remaining risks` |
| commit / push / MR / merge / production deploy | `NOT_DONE / NOT_CLAIMED` |
| next state | Whole-Demand Code Review handoff |

## Whole-Demand Code Review Finalization

Date: 2026-07-23

The fresh independent Whole-Demand Code Review covered all 11 demand files.
Its initial decision was `Fix` for one P2 test-validity issue: forbidden Git
commands were checked by simple substring matching, which could miss
`git -C <repo> push/commit/worktree add` forms.

The Fix Loop changed the forbidden-command oracle to reuse the existing Git
token-order matcher and added regression coverage for the three `git -C`
forms plus a permitted `git -C <repo> status --short` command. Focused
re-verification passed:

- demand tests: `22 passed / 31 skipped`;
- `pnpm typecheck`: `PASS`;
- `pnpm build`: `PASS`;
- `git diff --check`: `PASS`;
- Coding Plan contract validator: `PASS`.

The same independent reviewer re-reviewed the fix and returned `Continue`,
with no remaining P0-P2 finding. Workflow state is now `Workflow Complete`.

The accepted remaining risks are unchanged: eager Bridge attachment
download/cache behavior, the accepted disposable identity substitute for the
`NOT_RUN` live trusted-relay canary, and the full repository suite remaining
`MIXED / not stably GREEN`. Commit, push, MR, merge, and production deployment
remain `NOT_DONE / NOT_CLAIMED`.
