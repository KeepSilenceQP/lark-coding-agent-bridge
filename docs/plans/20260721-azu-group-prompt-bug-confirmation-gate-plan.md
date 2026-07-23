# “阿祖起来干活了” Group Prompt 分发与 MemoryData Bug 专属 Agent — Coding Plan

Date: 2026-07-23
Status: Workflow Complete with accepted remaining risks
Source Spec: `docs/specs/20260721-azu-group-prompt-bug-confirmation-gate.md`
Parent authority:

- `docs/specs/20260718-azu-group-prompt-router.md`
- `operator-prompts/README.md`
- current live code and tests

Plan SOP:
`/Users/bytedance/repo/o/memory_workspace/MemoryData/ai_proactive_api/agent_md/sop/plan-before-coding.md`

Workflow authority:
`/Users/bytedance/repo/o/memory_workspace/MemoryData/ai_proactive_api/agent_md/AGENT_LOOP_GUIDE.md`

Current goal: workflow execution is complete; repository submission remains a
separate explicitly authorized action.
has confirmed availability for the three required topic-local `/new` activation
boundaries; he owns opening and posting each required real inbound root-message
probe in the target group and participating in the activation-control topic.
Fresh discovery must first record the admission condition for Qin Peng's exact
sender: a structured @ mention to the target Bot by default, or a live-proven
`all-messages` / eligible `owner-default` exception.

## Outcome

Keep the existing authenticated, general-purpose `@` intake behavior for the
target group and make the Group Prompt a lightweight router. When current
evidence supports a MemoryData Bug classification, the router points the Agent
to a separately reviewed, profile-local, persona-oriented MemoryData Bug SOP.
The issue then remains in its own Feishu topic and Agent Session for diagnosis,
minimal repair, proportionate verification, and explicitly staged Bits
delivery.

The implementation has two reviewed operator inputs:

| Responsibility | Repository source | Live profile path |
| --- | --- | --- |
| General intake and route index | `operator-prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md` | `<profileDir>/prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md` |
| MemoryData Bug persona and working SOP | `operator-prompts/routes/memorydata-bug.md` | `<profileDir>/prompts/routes/memorydata-bug.md` |

The Group Prompt retains common authentication, narrow-context recovery,
general explanation/classification, evidence/authority boundaries, and
non-MemoryData behavior. It contains only the MemoryData Bug route id,
applicability semantics, authoritative live path, and missing-SOP fallback; it
does not duplicate the SOP.

The SOP uses natural language rather than a card or a workflow form. Context
sources are tools for reducing uncertainty, not mandatory gates. It prioritizes
the observable Bug description, affected version/development stage, and correct
code lineage. It references existing named Harness roles and flows that may be
consumed independently when useful; it does not add a `targeted-bugfix`
workflow entry or require a complete Harness run for every Bug.

The only mutation/delivery gates are topic-local text from Qin Peng:

1. `执行` permits the explained local repair and proportionate verification,
   but not commit, push, Bits MR, merge, deployment, or notification.
2. `提交 Bits` permits only a `memory-bits-mr` dry-run and presentation of the
   intended repository, branches, commit/push, and MR parameters.
3. `确认提交` permits the matching commit, push, Bits MR creation, and result
   readback after final diff/parameter recheck.

## Scope And File Boundaries

### In scope

- Re-author the target Group Prompt as a lightweight general router plus
  MemoryData Bug route index.
- Add `operator-prompts/routes/memorydata-bug.md` as an independent,
  persona-oriented SOP.
- Update operator deployment documentation so the latest reviewed Group Prompt
  and SOP are installed together.
- Replace obsolete card/controller-approval contract assertions and scenario
  oracles with the confirmed text-only route, lineage, authorization, Harness
  reuse, and deployment semantics.
- Preserve the parent router's authentication, narrow source readback,
  multi-message degradation, prompt-injection boundary, cross-app identity
  isolation, general non-MemoryData handling, and exact completion-state
  reporting.
- Produce repository verification and guide-owned Whole-Demand Acceptance
  evidence that
  distinguishes authored, tested, deployed, activated, runtime accepted,
  committed, pushed, MR opened, merged, and deployed states.
- Install and validate the reviewed pair in the target Codex profile under the
  confirmed Spec and current Harness execution authority, after live
  current-profile rediscovery and recoverability checks.

### Out of scope

- Any Bridge source, callback chain, session implementation, prompt include
  engine, vector retrieval, profile schema, adapter, or relay-envelope change.
- CardKit approval UI, callback buttons, `__bridge_cb`, `bridge_token`, or
  controller allowlists for this demand.
- Changes to the shared Bridge System Prompt, Claude profiles, other Codex
  groups, p2p, comments, or unrelated operator prompts.
- A new Harness workflow/phase/role/`targeted-bugfix` entry, or changes to the
  MemoryData Harness implementation.
- Version files, SOP/Group Prompt SHA binding, Session-version binding, or hot
  switching an already running topic. Hashes may be used only for deployment
  integrity/readback evidence.
- Automatic GBrain writes, merge, deployment, reviewer changes, source-group
  notification, or reply-as-Qin behavior.
- A production Bits MR created merely for acceptance testing.

### Expected repository files

Owned implementation surfaces:

- `operator-prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md`
- `operator-prompts/routes/memorydata-bug.md`
- `operator-prompts/README.md`
- `tests/unit/operator-prompts/azu-group-prompt-contract.test.ts`
- `tests/fixtures/azu-group-prompt-router/probe-output.schema.json`
- `tests/fixtures/azu-group-prompt-router/scenarios.json`
- `tests/acceptance/azu-group-prompt-router.worker.test.ts`
- `tests/acceptance/azu-group-prompt-router.live.test.ts` only if the
  disposable-runner contract needs a narrow extension
- `docs/agent-context/evidence/20260721-azu-group-prompt-context-guided-bugfix-acceptance.md`

Authority artifacts that must not be rewritten during implementation:

- `docs/specs/20260721-azu-group-prompt-bug-confirmation-gate.md`
- `docs/specs/20260718-azu-group-prompt-router.md`
- `docs/plans/20260718-azu-group-prompt-router-plan.md`
- MemoryData Harness guides and SOPs

Bridge source and callback tests are regression/control surfaces only. They are
not owned implementation files for this demand.

## Existing Dirty State And Protection Contract

At Plan-writing time, the feature worktree contains:

- modified Group Prompt, unit contract, acceptance worker, output schema, and
  scenarios from the superseded card/controller-approval design;
- an untracked old acceptance record based on that design;
- the untracked confirmed Delta Spec and this untracked Plan.

The existing Group Prompt and tests are evidence of attempted implementation,
not authority. The following semantics must be replaced rather than carried
forward: controller-user metadata, investigation cards, callback signing,
`[card-click]`, “继续修改”, `report_for_approval`, and relay-time rules that
prohibit local repair until a card approval.

The parent behavior in the same dirty files must be preserved: authenticated
relay checks, exact/narrow source recovery, multi-message read-only
degradation, evidence-not-authority handling, cross-app `open_id` isolation,
general classification, non-MemoryData handling, lineage safety, dirty/concurrent
worktree protection, and split completion reporting.

Before every unit that owns a currently dirty file, the executor must record
the current path, branch, HEAD, status, staged/unstaged diff, and content
fingerprint for its owned files. It must compare both `HEAD -> current` and
`current -> intended` so that it can deliberately replace only superseded
semantics while retaining still-valid parent behavior. It must not use
`reset`, `clean`, `checkout`, `stash`, or a wholesale file restore to erase the
dirty state.

Files outside the selected unit's ownership are unrelated concurrent state and
must remain byte-identical. An unexpected HEAD/index/status/content change
after dispatch stops the unit for main-session routing; the worker must not
merge or overwrite it by assumption.

## Key Runtime And State Flow

```text
authenticated group @ message
  -> narrow source/reply/thread context when needed
  -> general explanation and classification
     -> non-MemoryData: existing general behavior
     -> MemoryData Bug: read live profile SOP path
        -> SOP missing/unreadable: disclose general-analysis-only limitation
        -> SOP available: remain in this issue topic/session
           -> locate Bug/version-stage/code lineage
           -> ask only the smallest material question, or present plan
           -> wait for "执行"
           -> local fix + proportionate verification
           -> wait for "提交 Bits"
           -> memory-bits-mr dry-run only
           -> wait for "确认提交"
           -> final recheck + commit/push/create MR + readback
```

Context may begin from relay text, direct group text, quoted/thread messages,
Feishu history, GBrain, MR/build/package/version evidence, Git/worktrees, logs,
screenshots, or adjacent repositories. The Agent chooses only what materially
reduces current uncertainty. No source, including GBrain or a collaboration
group, is a required checklist item when the Bug and code lineage are already
well supported.

Deployment copies the latest reviewed Group Prompt and SOP as a pair. `/new`
activates only the new Group Prompt snapshot. A new topic routes to the latest
deployed SOP; an already running topic is not promised a mid-session SOP
switch. No version/SHA/session binding is introduced to change that behavior.

## Execution Unit Plan

- [x] Unit 1: Complete the Router boundary tracer from RED to GREEN
  - Goal: finish one complete TDD vertical slice for the parent/general router
    boundary and the lightweight MemoryData route index.
  - Included tasks / task subset:
    - Snapshot/fingerprint the currently dirty shared contract test and Group
      Prompt before either write.
    - Rework only the Router-boundary assertions in
      `tests/unit/operator-prompts/azu-group-prompt-contract.test.ts` and
      establish one attributable RED covering:
      - retained parent authentication, narrow context/general handling, and
        non-MemoryData behavior;
      - semantic MemoryData Bug routing rather than a product-name keyword
        gate;
      - a lightweight route id and bridge-bound live SOP path;
      - explicit general-analysis-only degradation when the SOP is missing or
        unreadable;
      - absence of card/callback/controller semantics from the Group Prompt.
    - After observing that RED, minimally re-author only
      `operator-prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md`
      until the Router contract and retained parent regressions are GREEN.
  - Excluded tasks:
    - Do not add `operator-prompts/routes/memorydata-bug.md`.
    - Do not edit `operator-prompts/README.md`, fixtures, runtime source, or the
      live profile.
    - Do not add persona/Harness-detail, three-stage authorization,
      unknown-result readback, completion-state, or paired-install contracts.
    - Do not implement any SOP or delivery semantics.
  - Dependencies:
    - Confirmed Delta Spec and unchanged parent Spec are readable.
    - The existing dirty-state protection contract is applied to the shared
      test and Group Prompt.
  - Verification:
    - Record one focused RED attributable only to the Router-boundary contract.
    - After the minimum Group Prompt rewrite, rerun the complete focused
      operator contract and require GREEN.
    - Run existing Group Prompt file/session/adapter, non-MemoryData, and Claude
      control regressions.
    - Run `git diff --check`.
  - Stop point:
    - Stop only when the Router contract is GREEN. The SOP may still be absent;
      the missing/unreadable-SOP public degradation must already be GREEN.
  - Next:
    - After Unit Implementation Review `Continue`, dispatch Unit 2.
  - Execution record:
    - Changed only the shared operator contract and target Group Prompt.
    - Observed one attributable Router RED, then reached GREEN; focused contract
      `3 passed`, parent/control regression `6 files / 49 tests passed`,
      typecheck PASS, and `git diff --check` PASS.
    - Two Fix Loop rounds hardened external-write, missing-SOP, and standalone
      controller deny semantics against reviewer-provided mutations.
    - Reviewer decision: `Continue`.
    - Workflow next state: `Execute Coding Unit` (Unit 2).
  #### Unit Dispatch Facts
  - Source facts: This unit owns only the retained general/non-MemoryData
    router boundary and the lightweight `memorydata-bug` route id/live path.
    The Group Prompt must expose missing-SOP degradation and contain no
    card/controller behavior; SOP and delivery semantics belong to Unit 2.
  - Role-filtered dispatch: Executor owns the shared contract's Router slice and
    the target Group Prompt; reviewer checks the observed RED, minimum GREEN
    implementation, parent regressions, and that no Unit 2 contract leaked in.
  - Quality / stop boundary: This is a complete RED→GREEN tracer, not a
    test-only horizontal layer. Use durable semantic assertions rather than
    exact prose snapshots.
  - Hard gates: A single attributable RED must precede the Group Prompt rewrite;
    the unit cannot stop RED. Unexpected failures or dirty-content drift stop
    the unit.

- [x] Unit 2: Build the MemoryData SOP and delivery semantics through incremental RED→GREEN tracers
  - Goal: complete the independent SOP and deployment documentation in three
    small behavior clusters, with every tracer starting from the previous
    cluster's fully GREEN baseline.
  - Included tasks / task subset:
    - Continue using
      `tests/unit/operator-prompts/azu-group-prompt-contract.test.ts` as the
      shared incremental contract surface. Never delete, weaken, or bypass the
      GREEN Unit 1 Router assertions.
    - Tracer A — persona and investigation mind:
      - add only assertions for second-person identity/goal, optional
        uncertainty-driven context use, Bug version/development stage, correct
        code lineage, responsibility-domain transfer, proportionate
        verification, and named Harness role/flow reuse without a complete
        Workflow or new `targeted-bugfix` entry;
      - observe one attributable RED on the Unit 1 GREEN baseline;
      - add the minimum
        `operator-prompts/routes/memorydata-bug.md` implementation and require
        the complete focused contract to return GREEN.
    - Tracer B — delivery authorization:
      - add only assertions for `执行`, `提交 Bits` dry-run, `确认提交`,
        unknown-result readback before retry, and separate completion states;
      - observe one attributable RED on the Tracer A GREEN baseline;
      - minimally extend the SOP and require all Unit 1 + Tracer A/B assertions
        to be GREEN.
    - Tracer C — paired installation and activation semantics:
      - add only assertions for paired latest Group Prompt + SOP installation,
        `/new` activating the Group Prompt, fresh-topic SOP reads, no old-topic
        hot-switch promise, and no Bridge/version/SHA/session binding;
      - observe one attributable RED on the Tracer B GREEN baseline;
      - minimally update `operator-prompts/README.md` and, only where the
        deployed persona needs the boundary, the SOP; require the entire focused
        contract to be GREEN.
    - Run retained parent and cross-surface regression controls after every
      GREEN tracer, not only at the end.
  - Excluded tasks:
    - Do not edit Bridge/System Prompt/session/callback source or fixtures.
    - Do not copy the full SOP/Harness into the Group Prompt or create a
      workflow state machine, mandatory context form, Harness entry, version
      file, or SHA binding.
    - Treat the Unit 1 Group Prompt as sealed. If a necessary Unit 2 correction
      touches it, explicitly explain why, preserve every Unit 1 assertion, and
      rerun the complete Router and parent/cross-surface regression set.
    - Do not deploy the files.
  - Dependencies:
    - Unit 1 has Unit Implementation Review `Continue`, and its Router contract
      plus retained parent regressions are GREEN.
    - The shared contract test and any currently dirty SOP/README target are
      fingerprinted before each tracer write.
  - Verification:
    - For Tracers A, B, and C in order: record the prior all-GREEN baseline,
      observe one cluster-specific RED, make the minimum implementation, then
      rerun the complete focused contract and retained regressions to GREEN.
    - File size/UTF-8/no-placeholder checks pass for both operator inputs.
    - Existing Group Prompt/session/adapter, non-MemoryData, and Claude-control
      tests remain GREEN after each tracer.
    - Final diff review shows Unit 1 assertions were neither deleted nor
      weakened and no Bridge source or unrelated operator prompt changed.
    - `git diff --check` passes after every tracer and at unit completion.
  - Stop point:
    - Stop only after Tracers A/B/C and the complete Unit 1/2 contract are
      GREEN. Repository operator inputs and README are authored/tested but not
      deployed or activated.
  - Next:
    - After Unit Implementation Review `Continue`, dispatch Unit 3.
  - Execution record:
    - Completed cumulative Tracers A/B/C with one attributable RED and cumulative
      GREEN for persona/investigation, delivery authorization, and paired
      deployment semantics.
    - Added the independent SOP and paired-deployment README without touching
      the sealed Unit 1 Group Prompt.
    - Two Fix Loop rounds added executable Harness paths, MemoryData push safety,
      baseline/dirty-state revalidation, unknown-result branching, and mutation
      resistance for authorization deny semantics.
    - Final focused contract `7 passed`; static/group-file controls `14 passed`;
      typecheck, UTF-8, no-card/no-targeted-entry, and `git diff --check` PASS.
    - Reviewer decision: `Continue`.
    - Workflow next state: `Execute Coding Unit` (Unit 3).
  #### Unit Dispatch Facts
  - Source facts: Unit 1 has sealed the Group Prompt Router boundary. Unit 2
    owns the SOP persona/investigation mind, then text delivery gates, then
    paired-install documentation in that order. Every source is optional
    evidence, lineage determines the code baseline, and Harness roles/flows are
    reusable without inventing a new entry.
  - Role-filtered dispatch: Executor owns the shared contract increment, new
    SOP, and README; reviewer checks each recorded RED→GREEN tracer, cumulative
    Unit 1 preservation, operator-file separation, and no Bridge/Harness scope
    expansion.
  - Quality / stop boundary: Each cluster must fail alone on the prior GREEN
    baseline and be fixed minimally before the next cluster. Repository GREEN
    is not deployment.
  - Hard gates: Unit 2 may not delete/relax Unit 1 assertions. Any necessary
    Group Prompt touch triggers full Router regression. No Bridge source,
    callback mechanism, Harness workflow, or live profile may change.

- [x] Unit 3: Align disposable behavior scenarios with routing, lineage, and text authorization
  - Goal: prove the revised prompt/SOP behavior with deterministic/disposable
    oracles while retaining the parent router's negative and degradation cases.
  - Included tasks / task subset:
    - Replace obsolete `report_for_approval`/card-based fields and oracles in
      `probe-output.schema.json`, `scenarios.json`, and the isolated worker.
    - Cover at least:
      - sufficient first-wave evidence without mandatory GBrain/group/worktree
        enumeration;
      - development/test feedback selecting its feature branch/worktree/MR
        instead of defaulting to main;
      - released/online behavior mapping to release commit/package provenance;
      - insufficient evidence causing autonomous high-value lookup followed by
        one minimal question and no `执行` invitation;
      - a non-MemoryData message staying in general handling;
      - evidence transferring responsibility to host, `memory_package`, or
        another repository;
      - named Harness flow/role reuse without a complete Workflow;
      - `执行` permitting only scoped local changes and verification;
      - `提交 Bits` producing only a dry-run;
      - `确认提交` permitting only the matching formal intent, with readback
        before retry on unknown results.
    - Use only disposable repositories/worktrees and fake Bits/Feishu commands
      for mutation/delivery-gate scenarios. No production MR is created.
    - Preserve parent authentication, forged relay, mixed batch, source
      conflict, prompt injection, dirty-related/unrelated, stale lineage,
      concurrent content change, and cross-app identity cases.
    - Narrowly extend `azu-group-prompt-router.live.test.ts` only if the
      disposable worker needs explicit multi-turn/history fixtures.
  - Excluded tasks:
    - Do not add Bridge session/callback behavior or use real MemoryData
      worktrees for destructive cases.
    - Do not claim that a one-turn isolated model proves real Feishu topic
      continuity, live SOP deployment, or a production Bits MR.
  - Dependencies:
    - Unit 2 has Unit Implementation Review `Continue`; Tracers A/B/C and the
      cumulative Unit 1/2 contract are GREEN, with every Unit 1 Router assertion
      preserved.
    - Existing fixture shims and isolated runner remain the execution boundary.
  - Verification:
    - Fixture JSON/schema parsing passes.
    - Deterministic fixture consistency tests pass.
    - The opt-in isolated worker runs when its Codex/auth prerequisites are
      available; otherwise its status is accurately `NOT_RUN`, not PASS.
    - Git before/after proof shows no forbidden production or external effects.
    - Existing callback tests may run as no-change regression controls but are
      not acceptance evidence for this text-only design.
  - Stop point:
    - Stop when disposable scenarios agree with the operator inputs and every
      unproved live topic/session/router behavior is explicitly reserved for
      the guide-owned Whole-Demand Acceptance phase.
  - Next:
    - After Unit Implementation Review `Continue`, dispatch Unit 4.
  - Execution record:
    - Replaced the obsolete card/`report_for_approval` probe vocabulary with
      text-only plan, local execution, Bits dry-run, matching formal submit,
      responsibility-transfer, and named Harness-reuse semantics across 30
      unique disposable scenarios.
    - Preserved the retained forged-relay, mixed-batch, source-conflict,
      prompt-injection, dirty/stale/concurrent, and cross-app identity cases.
    - Added deterministic isolation contracts plus fake Bits/Git effect proof:
      default-deny delivery shims, per-scenario state snapshots, exact
      intent/repository/source/target/title/diff binding, remote-ref readback,
      and unknown-result readback without duplicate create.
    - Fix Loop separated acceptance metadata from the classified business
      message, added fail-fast scenario selection, and closed all four material
      Unit Review findings without changing the Group Prompt or SOP.
    - Final deterministic worker result `9 passed` with `30` opt-in cases
      skipped by default; operator/parent/session/adapter/Claude controls
      `64 passed`; JSON/schema consistency, typecheck, and
      `git diff --check` PASS.
    - The first retained five-case run was later superseded by a fresh
      repository-readiness run with `1 PASS / 4 FAIL`; Unit 3 was therefore
      reopened for a second Fix Loop instead of selecting only successful
      targeted reruns. The full 30-case live-model matrix remains accurately
      `NOT_RUN`.
    - The second Fix Loop retained one same-batch five-case run (`4 PASS /
      1 FAIL`) and diagnosed the sole failure as an exact bare-intent
      serialization alias after all dry-run authorization/effect checks had
      passed. A canonical exact-token parser and deterministic positive and
      negative tracers closed that acceptance-only defect; the reviewer
      explicitly did not require another random model batch.
    - Delivery proof now requires exactly one create, one or more fully valid
      matching readbacks after create, and no duplicate create on unknown
      results. Failure diagnostics retain only synthetic audit artifacts.
    - A security Fix Loop scrubbed 11 temporary copied `auth.json` files from
      retained acceptance roots, left the source credential unchanged, and
      made future explicit/automatic retention scrub credentials first.
      Path rejection now occurs before any recursive removal, with tests
      proving non-acceptance paths remain untouched.
    - Real MemoryData fingerprints were unchanged; no real Bits MR, Feishu
      write, live-profile mutation, or production external effect occurred.
    - Final reviewer decision: `Continue`.
    - Workflow next state: `Execute Coding Unit` (Unit 4).
  #### Unit Dispatch Facts
  - Source facts: Consume the sealed Unit 1 Router contract and the cumulative
    Unit 2 SOP/delivery contract as GREEN inputs. The required behavior matrix
    is Spec section 10.2 plus the three natural-language authorization gates;
    current scenario changes from the old card design are not authoritative.
  - Role-filtered dispatch: Executor owns fixture schema/scenarios/worker and
    only the narrow live-runner support needed for disposable multi-turn
    inputs; reviewer checks oracle accuracy, write isolation, negative parent
    cases, honest proof boundaries, and that Unit 3 does not weaken or reopen
    the Unit 1/2 contract.
  - Quality / stop boundary: Model prose is not sufficient proof of Git/Bits
    effects; fixture command logs and before/after snapshots are required.
  - Hard gates: No real MemoryData dirty state, real Bits MR, live profile,
    Bridge source, shared operator contract, Group Prompt, SOP, or README may be
    mutated.

- [x] Unit 4: Produce repository-level traceability and verification evidence
  - Goal: establish that the reviewed repository artifacts are internally
    consistent and ready for the paired deployment authorized by the confirmed
    Spec and current Harness execution request.
  - Included tasks / task subset:
    - Replace the superseded acceptance record at
      `docs/agent-context/evidence/20260721-azu-group-prompt-context-guided-bugfix-acceptance.md`
      with current facts.
    - Map Delta Spec sections and retained parent contracts to exact Group
      Prompt/SOP/test evidence.
    - Record branch/worktree/dirty baseline, changed files, both operator file
      byte counts and SHA-256 values for integrity evidence only, focused/full
      tests, typecheck/build, and disposable scenario results.
    - Record callback/Bridge/Harness source as unchanged controls and label live
      profile behavior `NOT_RUN` until Unit 5 and live topic/session/router
      behavior `NOT_RUN` until Whole-Demand Acceptance.
    - Run the full repository verification set proportionate to the final diff.
    - Apply the full-suite instability attribution protocol without removing or
      skipping `pnpm test`:
      1. Record every retained current dirty-worktree full-suite attempt with
         command, HEAD, dirty fingerprint, aggregate result, and exact named
         failures. Retain both failures and intermittent passes; do not
         cherry-pick a favorable run.
      2. Run and record `pnpm test` from a clean detached worktree at the same
         HEAD, including its exact named failures. A different failure may
         support attribution only when it is in the same unmodified
         parallel/timing/temp-file/signal-cleanup class; it is not evidence
         that the current full suite is GREEN.
      3. Run and record focused commands for every named current failure and
         retain all observed focused outcomes, including intermittent PASS and
         FAIL. The current repair input includes the unmodified
         `codex-turn-state-probe` temporary-file `ENOENT`, startup
         `idle_timeout`, and clean-baseline `codex-prepare-run` `SIGTERM`
         timing observations; Unit 4 must preserve the exact commands/results
         rather than treating this summary as proof.
      4. Record `HEAD -> current` changed files and the demand-owned source/test
         allowlist, then prove whether each failing test and its directly
         exercised source are unchanged and outside the demand boundary.
      5. Classify the result as either full-suite `GREEN`, `BLOCKED`, or
         `accepted repository baseline risk`. The last classification is
         available only when every demand-scoped focused/deterministic/operator
         contract and control, fixture/schema check, typecheck, build, and
         diff/changed-file audit is GREEN; every full-suite failure is confined
         to unchanged non-demand parallel/timing/temp-file/signal-cleanup
         coverage; and the same-HEAD clean baseline plus named focused results
         explain that instability class.
      6. Carry an accepted baseline risk verbatim into the evidence record,
         Unit 5 handoff, Whole-Demand Acceptance, Whole-Demand Code Review, and
         final status. Never relabel it as `pnpm test` PASS, stable GREEN, or a
         demand regression disproved.
  - Excluded tasks:
    - Do not deploy, issue `/new`, create topics, or turn missing live proof into
      PASS.
    - Do not treat hashes as a runtime version binding.
  - Dependencies:
    - Units 1-3 have Unit Implementation Review `Continue`.
  - Verification:
    - `git diff --check`
    - focused operator contract
    - fixture/schema checks and applicable isolated acceptance
    - Group Prompt/session/adapter/Claude regression controls
    - `pnpm test` on the current dirty worktree, with every retained attempt
      reported exactly
    - `pnpm test` on a clean detached worktree at the same HEAD
    - focused reruns for every named current full-suite failure, with all
      observed outcomes retained
    - `pnpm typecheck`
    - `pnpm build`
    - final changed-file/demand-source audit proves only owned demand surfaces
      changed and identifies whether each full-suite failure is outside that
      boundary
  - Stop point:
    - Stop at repository-ready status only with either a genuinely GREEN full
      suite or an independently reviewed `accepted repository baseline risk`
      satisfying the complete attribution protocol. In the latter case,
      authored and demand-scoped tested may be ready, but the full suite remains
      non-GREEN and must stay disclosed separately from
      deployed/activated/runtime accepted.
    - Stop as `BLOCKED` if any demand-owned test fails, a new failure is related
      to demand-owned source, a failing test/source changed in this demand, the
      same-HEAD clean baseline and focused results do not explain the
      instability class, or any required attribution evidence is missing.
  - Next:
    - This repaired gate is not effective until a fresh independent
      `plan_reviewer` returns `PASS` on the complete Plan and the post-review
      mechanical check is rerun successfully. A Plan Writer check does not
      approve the exception.
    - After that review gate, dispatch Unit 5 only if Unit 4 is genuinely
      full-suite GREEN or has an explicitly recorded accepted repository
      baseline risk, and the Unit 5
      target/profile/recoverability/environment gates are present. Otherwise
      route the concrete test or environment blocker. Ask for new authorization
      only if the target profile changes, scope expands, or the existing
      confirmed authority does not cover the actual external write.
  - Execution record:
    - Replaced the obsolete card-flow evidence with current traceability,
      operator integrity values, changed-file boundaries, explicit delivery
      states, and static/disposable/live evidence-layer labels.
    - Demand-scoped operator, deterministic/fake-effect, parent-control,
      fixture/schema, typecheck, build, and tracked/untracked patch-integrity
      gates are GREEN. Unit 3's final safety and delivery review is `Continue`.
    - Retained every current full-suite, same-HEAD clean-baseline, and named
      focused outcome. These results vary across invocations and the full suite
      is MIXED/not stably GREEN; it is not reported as PASS.
    - The repaired attribution protocol was independently reviewed `PASS` and
      mechanically validated. The Unit 4 reviewer classified the confined,
      unchanged non-demand parallel/timing/temp-file/signal-cleanup failures as
      `accepted repository baseline risk` and returned `Continue`.
    - Final reviewer checks included operator/worker/retention `21 passed` with
      `31 skipped`, parent controls `6 files / 75 passed`, three named focused
      files `15 passed`, plus typecheck, build, JSON/schema, hashes/bytes, and
      tracked/untracked diff checks PASS.
    - The accepted repository baseline risk must remain verbatim in Unit 5,
      Whole-Demand Acceptance, Whole-Demand Code Review, and final status; it
      cannot excuse any deployment/readback/rollback/live-canary failure.
    - Workflow next state: `Execute Coding Unit` (Unit 5).
  #### Unit Dispatch Facts
  - Source facts: The old evidence record describes a discarded card flow and
    must be replaced; live proof is mandatory for topic/session claims but not
    for repository contract completion.
  - Role-filtered dispatch: Executor owns only the evidence record and
    verification commands; reviewer checks traceability, status accuracy,
    changed-file boundary, and that current results replace rather than append
    misleading old claims.
  - Quality / stop boundary: Every claim names its evidence layer: static,
    disposable model runner, live profile, or external side-effect readback.
  - Hard gates: `pnpm test` must run and its actual result must be disclosed.
    Demand-owned test failure, new demand-source-related failure, changed
    failing test/source, stale fingerprints, unexplained files, incomplete
    current/clean/focused evidence, or instability not explained by the
    same-HEAD clean baseline blocks deployment readiness. Only unchanged
    non-demand parallel/timing/temp-file/signal-cleanup instability satisfying
    the complete attribution protocol may enter Unit 5 as an explicit accepted
    repository baseline risk; it never becomes full-suite GREEN.

- [x] Unit 5: Install the reviewed Group Prompt and SOP as one recoverable profile update
  - Goal: safely place the exact reviewed pair in the currently active target
    Codex profile, activate the Group Prompt with `/new`, and prove immediate
    rollback before business-flow acceptance.
  - Included tasks / task subset:
    - Re-discover the live bridge/profile/install path and confirm the target is
      the intended Codex profile, not a source checkout assumption or Claude
      profile. Accept `chat_mode=group` / `group_message_type=thread` as a
      valid target shape; it is not a pre-write blocker merely because it is
      not a native `chat_mode=topic` group.
    - Before any real root, continuation, or activation-control `/new`, discover
      and record the exact group-response admission condition for Qin Peng's
      sender identity. The default for every such message is a real structured
      @ mention to the target Bot. Omit it only when fresh live evidence proves
      that exact sender is admitted by `all-messages` or eligible
      `owner-default`; record the chosen condition for every canary message.
    - Before copying either reviewed file, Qin Peng opens two fresh harmless
      topics in the target group and posts each first user/root message. These
      must be real inbound events, not synthetic SDK/test injections or Agent
      messages. Each root and harmless continuation uses the recorded admission
      condition above. From each root message, collect redacted Bridge evidence of a
      non-empty `threadId`, a distinct `chatId:threadId` session scope, and a
      same-topic reply (`replyInThread`). Continue one topic with a harmless
      follow-up to show that it retains its own scope. Put a harmless
      authorization marker only in the selected topic and verify it is absent
      from the other topic's observed scope; no mutation is permitted. This
      probe establishes only Bridge topic capability; it does not claim that
      the reviewed prompt/SOP is activated or that Whole-Demand Acceptance
      passed.
    - Treat the confirmed paired-deployment/rollback/live-acceptance Spec and
      the explicit request to execute it through the Harness as the current
      authority for this target-profile update.
    - Back up each live target's exact prior existence, bytes, mode, byte count,
      and hash under `/Users/bytedance/Documents/运维/backup/<timestamp>/` with
      a minimal manifest. Rollback restores those exact per-target states,
      including absence and prior mode.
    - Stage and atomically install the reviewed latest Group Prompt and SOP,
      verify each live file's exact content bytes/SHA-256 against its reviewed
      repository candidate, and enforce secure live mode `0600` for both the
      existing Group Prompt and the new SOP. Repository candidate modes are not
      deployment modes (the reviewed files may be `0644`); never chmod a live
      prompt or SOP to `0644`. Qin Peng issues `/new` inside one designated
      activation-control topic using the recorded admission condition. `/new`
      is topic-scoped: it proves the new Group Prompt snapshot only for that
      topic, not a group-wide refresh.
    - Run a harmless new-Session route-index/missing-SOP-read canary.
    - On any pair-copy, readback, `/new`, canary, or evidence failure, restore
      both prior states as one rollback set and use `/new` to activate the
      restored Group Prompt state.
    - Prove an explicit restore-and-redeploy drill while Qin Peng is available
      for each `/new` activation boundary. The restored-state and final-redeploy
      `/new` commands are also issued in that same activation-control topic
      using the recorded admission condition;
      the later two fresh WDA problem topics naturally start fresh Sessions and
      do not rely on this control topic's `/new`.
  - Excluded tasks:
    - Do not restart or modify Bridge/Claude, add version/SHA/session binding,
      or promise hot switching for an old topic.
    - Do not start if Qin Peng cannot open/post the two real root probes or
      participate in the activation-control topic and required `/new` gates, or
      if neither a structured Bot mention nor live-proven `all-messages` /
      eligible `owner-default` admission is available for his exact sender.
      Route either condition to `Environment setup required`, not Human
      decision, product/Spec re-confirmation, or Bridge compatibility. Also do
      not start if either
      first-message compatibility probe lacks a stable non-empty `threadId`,
      per-topic scope, or same-topic reply.
  - Dependencies:
    - Unit 4 repository verification is current and either genuinely
      full-suite GREEN or explicitly classified as an accepted repository
      baseline risk under the independently reviewed attribution protocol.
      Demand-scoped verification remains fully GREEN in either case.
    - The confirmed Spec and current Harness execution request still cover the
      same paired target-profile deployment/rollback scope.
    - The current profile, target paths, prior file states, target group, Qin
      Peng's root-message/activation-control participation, `/new` availability,
      and the exact sender's recorded message-admission condition are proven
      live. If human operation or admission is unavailable, the Workflow Next
      State is `Environment setup required`.
    - The two first-message topic probes establish that the target's actual
      event stream supplies distinct non-empty `threadId` values, that Bridge
      isolates them as `chatId:threadId`, and that replies remain in their
      originating topic. A missing/unrecoverable root `threadId` is a Bridge
      compatibility finding: stop before write, retain the normal group, and
      route a separately scoped Bridge fix rather than asking Qin Peng to
      recreate the group.
  - Verification:
    - For each pair member, repository and live **content** bytes/SHA-256 match;
      file modes are deliberately different where appropriate: both deployed
      live files are `0600`, while repository candidates may remain `0644`.
    - The backup manifest and rollback readback prove each target returns to its
      exact prior existence, bytes, and mode; no inferred default mode is used.
    - `/new` in the designated activation-control topic creates a Session that
      sees the new Group Prompt index without asserting a group-wide refresh;
      its structured Bot mention or live-proven `all-messages` / eligible
      `owner-default` admission is recorded.
    - Readback and a harmless activation canary prove that the Group Prompt is
      active and its indexed SOP path is readable; business route/topic
      behavior remains for Whole-Demand Acceptance.
    - Restore canary and final redeploy canary both pass.
    - Another Codex group, p2p, comments, and Claude remain unchanged.
  - Stop point:
    - Stop with the reviewed pair deployed and activated, rollback proven, and
      no claim yet that the guide-owned Whole-Demand Acceptance passed.
  - Next:
    - After Unit Implementation Review `Continue`, all required execution units
      are complete and main orchestration enters the guide-owned Whole-Demand
      Acceptance phase.
  - Pre-write discovery record:
    - Live discovery uniquely resolved the current `codex` profile, target
      group `oc_726b2fdea1364b47aab6796ba5c9d764`, reviewed repository pair,
      current live Group Prompt, missing live SOP/routes directory, control
      boundaries, backup root, and recoverable paired-install order.
    - The target reports `chat_mode=group` / `group_message_type=thread`. This
      normal-group shape is accepted by confirmed Spec section 4.3 because
      current Bridge behavior treats an inbound `threadId` as authoritative for
      topic session scope and reply routing. It still needs the two live
      first-message probes above; configuration alone cannot prove root-event
      delivery or scope isolation.
    - Before those probes, fresh live discovery must identify Qin Peng's exact
      sender admission condition. The default is a structured @ to the target
      Bot on every root, continuation, and activation-control `/new`;
      `all-messages` or eligible `owner-default` may replace it only with
      recorded live proof. No available admission condition is an environment
      setup blocker, not a `threadId`/Bridge compatibility result.
    - The existing live Group Prompt is mode `0600`; the newly created live SOP
      must also be installed as `0600`. Candidate repository mode is not a
      live-file permission contract.
    - The rollback drill requires three human topic-local `/new` activations:
      initial install, restored prior state, and final redeploy. Qin Peng has
      confirmed availability for all three. They occur in the designated
      activation-control topic and do not stand in for WDA's two fresh topics.
    - A restart occurred between discovery attempts. Fresh repeated discovery
      is stable at PID `64361`, with running and installed versions both
      `0.5.9-qp.3`; the independent reviewer accepted this as the new
      pre-write runtime baseline. Any later restart still requires another
      complete discovery.
    - No backup, live file write, message, `/new`, restart, or repository change
      occurred during discovery. Unit 5 remains unchecked.
    - The latest read-only executor rediscovery reconfirmed the `codex` profile,
      target group mode, running `0.5.9-qp.3` Bridge, candidate/live hashes,
      live Group Prompt mode `0600`, and missing live SOP/routes directory.
      Group admission is `owner-default`, but the prepared probes deliberately
      use structured `@小P` mentions rather than relying on a no-mention
      exception.
    - Workflow is now `Environment setup required`: Qin Peng must open two
      fresh target-group topics, post the prepared structured-mention roots,
      and post the prepared continuation in Topic A. No backup or profile write
      is permitted until privacy-safe metadata proves both admitted roots,
      distinct non-empty `threadId`/scope, same-topic replies, and Topic A
      continuation/isolation.
    - The real pre-write probes passed: both roots were admitted, produced
      distinct non-empty topic scopes, and received same-topic replies; the
      Topic A continuation retained A's scope and its isolation marker was
      absent from Topic B.
    - Recovery material was created at
      `/Users/bytedance/Documents/运维/backup/20260723-174001-unit5-group-prompt-install`.
      It records the exact prior Group Prompt existence/bytes/mode/hash and the
      prior absence of the SOP route.
    - The reviewed pair is now installed but not activated: live Group Prompt
      hash `4c5d9467fd80a73fa26533b2243f97010ed2887dac811d80a130abd3c910e26f`
      and live SOP hash
      `29974fd0074652128e001064f251ee35cf984249dd868addc525bf6691e3aa0e`;
      both files are mode `0600`. Exact readback passed, no rollback was needed,
      no `/new` was issued, and Bridge was not restarted.
    - Qin Peng's first no-mention `/new` was admitted by the live-proven
      `owner-default` policy and correctly reset only its own topic scope, but
      it was posted in a different topic rather than the designated Topic A.
      Topic A remains pinned to the prior Group Prompt snapshot, so activation
      is not yet claimed and no activation canary has run.
    - Qin Peng then issued `/new` inside Topic A. Live logs, the reset tombstone,
      session catalog, and reply metadata prove that Topic A alone was reset,
      its prior Session was archived, and the acknowledgement remained in
      Topic A; Topic B was unaffected. The installed pair still has the
      reviewed hashes and mode `0600`. Activation now awaits the Topic A
      read-only route-index/SOP canary.
    - The Topic A activation canary passed: a fresh Session bound the reviewed
      Group Prompt hash, the Agent returned route id `memorydata-bug`, the exact
      live SOP path and readable status, explicitly declined repair, and
      actually performed a read-only SOP read. The reply remained in Topic A
      and no unauthorized side effect occurred.
    - The explicit restore drill then restored the prior Group Prompt hash
      `03656a2eb205237710f9d8a4bcf88f49c44cb7b83dea2c24fa64ff6477df1037`,
      bytes, and mode `0600`; removed the exact SOP whose prior state was
      absent; and removed only the newly created empty `routes/` directory
      after proving it contained no entries. Post-fix readback and backup
      integrity passed. No second `/new` has yet been issued.
    - Qin Peng's second Topic A `/new` passed: it was admitted through
      `owner-default`, archived the new-version Topic A Session, updated only
      Topic A's reset tombstone, and acknowledged inside Topic A. Topic B
      remained active and unaffected. The restored old Group Prompt hash/mode,
      SOP absence, and routes-directory absence remained exact.
    - The neutral rollback canary passed: a fresh active Topic A Session bound
      the restored old Group Prompt hash/byte count and returned the expected
      neutral reply without tool calls or task side effects; Topic B remained
      active on the old binding.
    - Final paired redeploy then passed preflight and exact readback. The live
      Group Prompt again matches reviewed hash
      `4c5d9467fd80a73fa26533b2243f97010ed2887dac811d80a130abd3c910e26f`
      and the live SOP matches
      `29974fd0074652128e001064f251ee35cf984249dd868addc525bf6691e3aa0e`;
      both are mode `0600`, the routes directory is mode `0700`, backup
      material remains intact, and no third `/new` has yet been issued.
    - Qin Peng's third/final Topic A `/new` passed: it was admitted and
      acknowledged in Topic A, archived the rollback-canary Session that was
      bound to the old prompt, and did not affect Topic B. The final live pair
      hashes and secure modes remained unchanged. Final activation now awaits
      the last Topic A read-only canary.
    - The final Topic A activation canary passed. A fresh active Session bound
      the reviewed Group Prompt hash/byte count, returned route id
      `memorydata-bug`, the exact readable live SOP path and an explicit
      no-repair boundary, and remained in Topic A. Topic B stayed separate on
      its existing binding; final live pair and backup integrity remained
      exact. Redacted Unit 5 evidence was appended to the demand acceptance
      record. WDA and whole-demand review remain `NOT_RUN`.
  - Execution record:
    - Pre-write compatibility proved two admitted, distinct root topic scopes,
      same-topic replies, Topic A continuation, and no context/authorization
      marker bleed into Topic B.
    - Backed up the exact prior live pair state, atomically installed the
      reviewed Group Prompt/SOP with secure modes, proved first activation,
      restored the exact prior Group Prompt/SOP/routes state, proved restored
      activation, redeployed the reviewed pair, and proved final activation.
    - Final live Group Prompt/SOP match reviewed hashes and modes; recovery
      material remains intact. Bridge was not restarted and no commit, push,
      MR, WDA, or unrelated profile mutation occurred.
    - Unit-owned redacted runtime evidence was appended to the acceptance
      record. The repository full suite remains `MIXED / not stably GREEN` as
      an accepted baseline risk.
    - Independent Unit Implementation Review found no P0/P1/P2 findings and
      returned `Decision: Continue`.
    - Workflow next state: `Whole-Demand Acceptance`.
  #### Unit Dispatch Facts
  - Source facts: Deployment is a paired file install; `/new` activates only
    the Group Prompt snapshot for the topic in which it is issued, while new
    topics read the live SOP. Existing topics have no hot-switch guarantee.
    Exact reviewed content bytes/SHA-256 must be read back from live files, but
    live Group Prompt and SOP modes are both `0600` even when repository
    candidates are `0644`; rollback restores exact prior existence/bytes/mode.
    A normal `group` with `group_message_type=thread` is in scope only after
    Qin Peng's root/continuation/activation-control messages have proven
    group-response admission: a structured @ mention of the target Bot, or a
    live-recorded `all-messages` / eligible `owner-default` condition for his
    exact sender. Only then may real inbound root events be evaluated for
    `threadId`; main-branch Bridge then uses `chatId:threadId` and
    `replyInThread`.
  - Role-filtered dispatch: Executor owns current-profile discovery, minimal
    backup, atomic paired install, activation canaries, rollback drill, and
    evidence update; reviewer checks exact target identity, recoverability,
    isolation, and truthful activation status.
  - Quality / stop boundary: Hashes are integrity evidence only. A successful
    copy without `/new` and canary is not activation.
  - Hard gates: Complete prior-state recovery material, exact current target
    profile/path confirmation, Qin Peng's availability to create/post the two
    root probes and participate in the activation-control topic, confirmed
    `/new` availability, a recorded admission condition for every real canary
    message, and two distinct non-empty first-message `threadId` probes are
    required. Missing human operation or admission routes to `Environment setup
    required`, not Human decision or Bridge compatibility. Only after admission
    is proven may root-scope, partial-pair, non-`0600` live-mode, live
    activation, or canary failure be evaluated; a root-scope failure is then
    reported as Bridge compatibility and does not become a request to
    convert/recreate the group. Unit 4's repository baseline-risk exception
    cannot excuse, mask, or downgrade a Unit 5 live failure. Request new
    authorization only if the verified target/scope differs from the confirmed
    authority or the real external write is not covered by it.

## Whole-Demand Acceptance Scope

This section defines what the guide-owned Whole-Demand Acceptance phase must
accept; it is not a Plan-local phase or a worker prompt.

- The parent general `@` intake, trusted relay authentication, narrow context
  recovery, evidence boundary, mixed-batch degradation, cross-app identity
  isolation, and non-MemoryData behavior remain intact.
- The Group Prompt contains a lightweight MemoryData route index and does not
  duplicate the persona SOP or Harness.
- The independent SOP expresses the required identity, goal, MemoryData
  engineering map, uncertainty-driven context use, correct-lineage
  responsibility, named Harness reuse, verification judgment, and safety
  boundaries without becoming a state machine or mandatory field list.
- All seven behavior scenarios in Delta Spec section 10.2 are backed by
  repository/disposable evidence. Whole-Demand Acceptance does not rerun them
  as a separate fake-effect unit.
- `执行`, `提交 Bits`, and `确认提交` authorize exactly their stated effects;
  unknown formal results use readback before retry. Their mutation boundaries
  are consumed from Unit 3 disposable proof rather than recreated against
  production effects during Whole-Demand Acceptance.
- The latest reviewed Group Prompt and SOP were installed together; `/new`
  activated only the Group Prompt; fresh topics read the latest SOP; no old
  topic hot-switch or SHA/session binding is claimed.
- Live Whole-Demand Acceptance covers Delta Spec section 10.4 plus retained
  Parent Spec live obligations:
  - Delta Spec 10.4:
    - Prompt activation and the deployed SOP being used by fresh topics;
    - in the accepted `chat_mode=group` / `group_message_type=thread` target,
      Qin Peng opens and posts the two fresh harmless problem-topic root
      messages as real inbound user events, then participates in their
      continuations. Before sending them, fresh live discovery records Qin
      Peng's exact admission condition. Every root and continuation uses a
      structured @ mention to the target Bot unless that exact sender is proven
      admitted by `all-messages` or eligible `owner-default`; record the
      condition used for each message. Capture redacted Bridge evidence from
      each root message: non-empty and mutually distinct `threadId` values, two
      distinct `chatId:threadId` scopes, and replies posted with
      `replyInThread` to the originating topic. Synthetic SDK/test injection
      and Agent-created roots are not WDA evidence;
    - give the two topics intentionally different, harmless context. Continue
      each in turn and prove the original context remains topic-local without a
      full restatement. Put a topic-local authorization phrase only in the
      selected canary topic and prove the other topic neither receives that
      context nor inherits permission. This is a no-effect authorization
      isolation check; it must not create a source write, commit, push, Bits
      MR, or other production effect;
    - only after the recorded admission condition is proven, any root message
      that lacks a stable recoverable `threadId`, collapses to chat scope, or
      receives a top-level reply is a fail-closed Bridge compatibility finding.
      Stop acceptance and route a separate Bridge fix; do not require a native
      topic group or silently add a Bridge change to this demand;
    - one live MemoryData route and one live non-MemoryData general route;
  - retained Parent read-only live canaries:
    - an unrelated attachment is not downloaded;
    - when classification genuinely depends on an attachment, only the named
      required resource is read;
    - source-app sender/mention IDs are not reused for any current-app
      mention/send and do not trigger an unauthorized outbound action.
- If Qin Peng cannot open/post the required real WDA roots or participate in
  their continuations, or neither a structured Bot mention nor live-proven
  `all-messages` / eligible `owner-default` admission is available for his
  exact sender, route to `Environment setup required`; this is not a Human
  decision, product re-confirmation, permission to replace events with
  synthetic traffic, or Bridge compatibility. If another required live canary
  cannot be safely constructed in the current environment, Whole-Demand
  Acceptance must route the concrete environment blocker or record an
  explicitly accepted remaining risk through the guide's human/environment
  boundary. An unobserved required canary cannot be reported as runtime PASS.
- Unit 4's accepted repository baseline risk, if used, remains disclosed in
  Whole-Demand Acceptance and final status with the current full-suite,
  same-HEAD clean-baseline, named focused, and changed-file/demand-source
  attribution boundary. It cannot convert a failed or unobserved live canary
  into PASS and cannot be described as a stable/full-suite GREEN repository.
- Whole-Demand Acceptance finalizes the evidence record with redacted live
  message/topic identifiers, each real canary's recorded admission condition
  (structured target-Bot mention or live-proven `all-messages` / eligible
  `owner-default`), first-message `threadId`/`chatId:threadId` scope evidence,
  same-topic reply evidence, per-topic authorization-isolation outcome, pair
  integrity/readback, rollback status, control-surface isolation, and separate
  delivery states. It does not create a production code fix, fake-effect unit,
  or Bits MR merely for acceptance.
- Rollback restores the prior pair/existence states and uses `/new` for the
  restored Group Prompt activation.
- Another Codex group, p2p, comments, Claude, Bridge source, MemoryData Harness,
  and production Bits state are unchanged except for separately authorized
  effects explicitly recorded in evidence.
- Final status reporting separates authored, tested, deployed, activated,
  runtime accepted, committed, pushed, MR opened, merged, and deployed.

## Whole-Demand Acceptance Result

- Decision: `Pass with explicit accepted remaining risks`.
- Fresh deployed MemoryData and general business topics, same-topic
  continuation, topic/session/marker isolation, no-effect boundaries, final
  live pair integrity, Unit 5 activation, rollback, and recoverability passed.
- Attachment model behavior passed: the unrelated and decoy attachments did
  not enter model context, and only the named required file was read. Bridge
  transport eagerly downloaded/cached all uploaded attachments before
  selection; Qin Peng explicitly accepted this remaining risk and the demand
  did not expand into a Bridge source fix.
- A live trusted source-app relay canary was not available. Qin Peng accepted
  Unit 3 disposable source-app/current-app identity-isolation evidence as the
  substitute for this demand.
- The full repository suite remains `MIXED / not stably GREEN` as the
  independently reviewed accepted baseline risk. It is not reported as stable
  GREEN and does not erase any live observation.
- Redacted final evidence is recorded in
  `docs/agent-context/evidence/20260721-azu-group-prompt-context-guided-bugfix-acceptance.md`.
- No commit, push, MR, merge, Bridge restart/source deployment, or production
  business deployment is claimed.

## Whole-Demand Code Review Scope

This section defines what the guide-owned Whole-Demand Code Review phase must
review; it is not a Plan-local phase or a reviewer prompt.

- Review the complete final diff against the confirmed Delta Spec and retained
  parent contracts.
- Confirm the Group Prompt/SOP responsibility split, the live path/fallback,
  and the absence of duplicated SOP/Harness content.
- Confirm the SOP is persona-oriented and autonomous without weakening
  dirty-state, lineage, authorization, privacy, external-effect, or result
  readback boundaries.
- Confirm contract tests and scenario oracles are semantic, non-brittle, retain
  parent negative cases, and do not mistake model prose for command/effect
  proof.
- Confirm obsolete controller/card/callback/`report_for_approval` semantics are
  fully removed from demand-owned files without changing Bridge callback
  infrastructure.
- Confirm no Bridge/System Prompt/session/profile-schema/Harness source,
  version/SHA binding, unrelated prompt, or unrelated dirty file was changed.
- Confirm deployment/rollback/evidence logic protects both live files,
  preserves exact prior existence/bytes/mode, and reports partial or unknown
  states honestly.
- Confirm logs/evidence contain no secrets, raw private transcripts, or
  unnecessary identifiers.
- Consume the Whole-Demand Acceptance result and residual risks before deciding
  whether the final repository state can continue.

## Agent Review Loop Execution Contract

This Plan owns execution units, unit facts, dependencies, verification targets,
and dispatch material only. Execution returns to the current
`AGENT_LOOP_GUIDE.md` for executor self-check, Unit Implementation Review, Fix
Loop, Coding Plan Repair, Whole-Demand Acceptance, Whole-Demand Code Review,
Workflow Next State, and Exit Guard.

Each unit is dispatched to a fresh role-filtered executor and then to an
independent unit reviewer. Findings are routed through the guide-owned Fix Loop
and back to the affected review boundary. A unit checkbox is updated only after
the main session consumes its review decision and records changed files,
commands/results, remaining risk, reviewer decision, and Workflow Next State.

This demand has no UI/Figma unit and does not introduce Capture or Visual Delta
Review work. Live Feishu/profile evidence is normal non-UI runtime acceptance,
not a replacement or renamed Harness phase.

## Spec Coverage

| Spec area | Planned coverage |
| --- | --- |
| General router preserved; semantic MemoryData route indexed | Unit 1 GREEN tracer, Unit 3 scenarios, WDA scope |
| Independent persona SOP and knowledge map | Unit 2 Tracer A |
| Optional context expansion and correct code lineage | Unit 2 Tracer A, Unit 3 |
| Named Harness roles/flows independently consumable | Unit 2 Tracer A, Unit 3 |
| Text-only `执行` / `提交 Bits` / `确认提交` | Unit 2 Tracer B, Unit 3 disposable proof |
| Dirty/concurrent worktree protection | Existing-dirty contract, Units 1-4 |
| Paired deployment and activation semantics | Unit 2 Tracer C, Unit 5 |
| Secure paired live install: exact content hash with live `0600`, plus exact prior existence/bytes/mode rollback | Unit 5 deployment/readback/rollback gates |
| Group-response admission before real topic evidence: structured target-Bot mention by default, or recorded `all-messages` / eligible `owner-default` for the exact sender | Unit 5 admission gate; WDA scope/evidence |
| Thread-message target compatibility: two root `threadId`s, `chatId:threadId` isolation, same-topic replies/continuity, authorization isolation, and live MemoryData/non-MemoryData routes | Unit 5 root-scope gate; WDA scope |
| Parent attachment minimization and source-app/current-app identity isolation live canaries | WDA scope; environment blocker or accepted remaining risk if unavailable, never unobserved runtime PASS |
| Rollback and truthful status | Units 4-5, WDA evidence finalization |
| No cards, Bridge changes, version/SHA binding, auto merge/deploy/notification | All units and final review scope |

No confirmed Spec item requires a product/design decision before implementation.
The confirmed Spec plus explicit Harness execution request already authorizes
Unit 5's paired target-profile deployment/rollback/live-acceptance scope.
Current target/path/recovery, confirmed topic-local `/new` availability,
per-message group-response admission, and the two first-message `threadId`
compatibility probes remain pre-write or environment gates. The normal
thread-message group shape is accepted; a new authorization is needed only if
live discovery changes the target, expands scope, or exposes an external write
not covered by the confirmed authority.

## Plan Review Result

- Status: `PASS`
- Latest independent review result: `PASS`. A fresh `plan_reviewer` reviewed
  the complete repaired Plan after the live-mode/content, real-inbound
  human-operation, and group-response-admission repairs. It confirmed that
  admission precedes topic classification, environment and Bridge failures
  remain distinct, the secure `0600` install/rollback contract is executable,
  Unit 5 remains separate from guide-owned WDA, and Units 1-4 plus the accepted
  repository baseline risk remain intact.
- Residual execution risks:
  - Without fresh exact-sender `all-messages` / eligible `owner-default`
    evidence, every real canary message must carry a structured target-Bot
    mention; missing admission is `Environment setup required`.
  - An admitted first root may still expose a missing/unrecoverable
    `threadId`, chat-scope collapse, or top-level reply. Stop before live writes
    and route that as a separately scoped Bridge compatibility finding.
  - Repository/live content must match exactly while both live files remain
    `0600`; rollback restores exact prior existence, bytes, and mode.
  - `/new` proves only the activation-control topic snapshot. WDA still owns
    fresh deployed-topic continuity, isolation, and route proof.
- Current repair summary:
  - Removed the false prerequisite that Qin Peng convert the target into a
    native `chat_mode=topic` group. The accepted normal-group target is
    `chat_mode=group` / `group_message_type=thread`.
  - Added a fail-closed Unit 5 pre-write compatibility gate: two new-topic root
    messages must provide different non-empty `threadId` values, yield distinct
    `chatId:threadId` scopes, and receive same-topic replies before either
    profile file is copied.
  - Made all three confirmed `/new` activations explicitly topic-local in one
    activation-control topic. They prove that topic's prompt snapshot during
    install/rollback/redeploy and do not imply a group-wide refresh or replace
    fresh-topic WDA evidence.
  - Expanded WDA, coverage, resume state, and reviewer handoff to prove two
    fresh topics, root scope, continuation, reply placement, and no
    context/authorization bleed without manufacturing a production effect.
  - Repaired Unit 5 deployment semantics: repository and live content
    bytes/SHA-256 must match, but both live prompt files are secure `0600`.
    Backup/rollback restores each target's exact prior existence, bytes, and
    mode; repository `0644` never authorizes a live `chmod 0644`.
  - Assigned Qin Peng the required real root-topic creation/posting and
    activation-control participation for Unit 5 and WDA. Its absence routes to
    `Environment setup required`, never Human decision or synthetic traffic.
  - Added an admission gate ahead of all real roots, continuations, and
    topic-local `/new` commands: structured @ mention of the target Bot by
    default, or fresh recorded `all-messages` / eligible `owner-default` for
    Qin Peng's exact sender. Missing admission is `Environment setup required`;
    only admitted messages may produce a Bridge compatibility finding.
- Prior review history (not current approval):
- Status: `PASS`
- Reviewed scope: Unit 4 full-suite attribution repair.
- A fresh independent `plan_reviewer` reviewed the complete Plan and confirmed
  the repaired gate is fail-closed: current/clean/focused/boundary evidence is
  mandatory, demand failures still block, and accepted baseline risk cannot
  become full-suite GREEN or excuse Unit 5/WDA live failures.
- Prior status: `PASS` applied to the pre-repair Plan only and does not approve
  this new gate.
- Prior reviewer conclusion: the TDD repair closed the horizontal-slice gap.
  Unit 1 is a complete Router RED→GREEN tracer; Unit 2 Tracers A/B/C are
  cumulative, attributable, preserve the sealed Unit 1 contract, and hand a
  fully GREEN operator contract to Unit 3.
- Review round 3 material finding:
  1. The previous Unit 1 was a horizontal RED-only contract layer and Unit 2
     implemented all operator artifacts at once, so Unit 1 could not complete a
     reviewable RED→GREEN product slice and Unit 2 failures were not narrowly
     attributable.
- Review round 2 material finding:
  1. The previous repair moved Delta Spec 10.4 live checks into WDA but omitted
     retained Parent live-smoke coverage for attachment minimization and
     source-app/current-app identity isolation.
- Review round 1 material findings:
  1. The removed live-acceptance unit duplicated and preceded the guide-owned Whole-Demand Acceptance
     phase.
  2. Unit 5 incorrectly required unconditional separate deployment
     authorization despite the confirmed deployment/rollback/live-acceptance
     Spec and explicit Harness execution request.
- Repairs applied:
  - Rewrote Unit 1 as a complete Router-boundary RED→GREEN tracer that seals
    retained parent/general/non-MemoryData behavior, semantic routing, the
    lightweight route id/live path, missing-SOP degradation, and Group Prompt
    card/controller absence. The SOP may remain absent at this stop point.
  - Rewrote Unit 2 as cumulative Tracers A/B/C for persona/investigation mind,
    text delivery authorization, and paired-install/activation semantics. Each
    tracer starts on the previous all-GREEN baseline, observes one attributable
    RED, applies the minimum implementation, and returns the full contract and
    regressions to GREEN.
  - Made the focused contract a shared incremental surface: Unit 2 cannot
    delete or relax Unit 1 assertions, and any necessary Group Prompt touch
    triggers the complete Router regression.
  - Synchronized Unit 3 dependencies/dispatch gates and Spec Coverage with the
    cumulative Unit 1/2 GREEN contract.
  - Added the three retained Parent read-only live canaries to
    `Whole-Demand Acceptance Scope`: skip unrelated attachments, read only the
    named classification-dependent resource, and prohibit source-app IDs from
    current-app mention/send or unauthorized outbound action.
  - Added the environment/accepted-remaining-risk boundary and prohibited
    runtime PASS for any unobserved required live canary.
  - Updated coverage, Workflow Resume Snapshot, and re-review handoff to use
    `Delta Spec 10.4 + retained Parent live obligations`.
  - Deleted that Plan-local live-acceptance unit and moved Delta Spec section 10.4 live
    topic/session/router checks plus evidence finalization into
    `Whole-Demand Acceptance Scope`.
  - Kept three-stage side-effect proof in Unit 3 disposable acceptance and
    removed any WDA fake-effect unit.
  - Changed Unit 5 `Next` to enter Whole-Demand Acceptance directly.
  - Made the confirmed Spec and current Harness request Unit 5 authority while
    retaining exact target/profile/path, recovery material, and `/new`
    availability gates.
  - Synchronized Unit 3/4 reservations, coverage, dependencies, stop points,
    next-state references, and reviewer handoff.
- Reviewer residual risks:
  - Execution must fingerprint and protect the existing dirty files before
    replacing superseded card/controller semantics.
  - The opt-in isolated model worker may remain `NOT_RUN` when its Codex/auth
    prerequisites are unavailable; this cannot be promoted to PASS.
  - Unit 5 still depends on exact live profile/path discovery, complete
    rollback material, and `/new` operator availability.
  - Whole-Demand Acceptance live canaries may expose an environment blocker or
    explicitly accepted remaining risk; an unobserved required canary cannot be
    reported as runtime PASS.
- Prior required next action: the pre-repair mechanical check was completed;
  it is superseded by the current repair's independent review and post-review
  rerun requirement.

## Historical Pre-Repair Mechanical Check Result

- Status: `PASS`
- Review boundary: fresh independent Plan Review completed before the current
  confirmed-Spec amendment repair; this is retained only as history.
- Prior status: `PASS` applied to the pre-repair Plan.
- Command:

  ```text
  python3 /Users/bytedance/repo/o/memory_workspace/MemoryData/ai_proactive_api/agent_md/tools/validate_coding_plan_contracts.py \
    --plan /Users/bytedance/repo/lark-coding-agent-bridge-worktrees/azu-group-prompt-router-optimization/docs/plans/20260721-azu-group-prompt-bug-confirmation-gate-plan.md
  ```

- Prior result: the pre-repair plan was reported structurally valid.
- Historical result:
  `PASS: Coding Plan unit dispatch facts are structurally valid`.
- The historical structural PASS does not approve the current repair.

## Post-Review Mechanical Check Result

- Status: `PASS`
- Review boundary: the fresh independent Plan Review returned `PASS` before
  this final rerun.
- Latest rerun after the admission-gate repair and independent review:
  `PASS: Coding Plan unit
  dispatch facts are structurally valid`; `git diff --check` and the untracked
  Plan's standalone no-index whitespace check also passed.
- Command:

  ```text
  python3 /Users/bytedance/repo/o/memory_workspace/MemoryData/ai_proactive_api/agent_md/tools/validate_coding_plan_contracts.py \
    --plan /Users/bytedance/repo/lark-coding-agent-bridge-worktrees/azu-group-prompt-router-optimization/docs/plans/20260721-azu-group-prompt-bug-confirmation-gate-plan.md
  ```

- Result: `PASS: Coding Plan unit dispatch facts are structurally valid`.
- `git diff --check` passed. The Plan is untracked, so its standalone
  no-index whitespace check also passed.

## Whole-Demand Code Review Result

- Initial decision: `Fix`.
- Accepted finding: the worker-test oracle used simple substring matching for
  forbidden Git commands and could miss valid `git -C <repo> push/commit/worktree
  add` forms.
- Fix Loop: forbidden commands now reuse the existing Git token-order matcher;
  a regression test covers `git -C` commit, push, worktree add, and a permitted
  status command.
- Focused verification: the three demand test files passed with `22 passed /
  31 skipped`; `pnpm typecheck`, `pnpm build`, `git diff --check`, and the Plan
  contract validator passed.
- Independent re-review decision: `Continue`; no remaining P0-P2 finding.
- Accepted remaining risks are unchanged: Bridge transport eagerly
  downloads/caches attachments before Agent selection; the live trusted-relay
  canary remains `NOT_RUN` with the disposable identity substitute accepted;
  the full repository suite remains `MIXED / not stably GREEN`.

## Workflow Resume Snapshot

- Spec gate: PASS (`status: confirmed`, `authority: true`, no blocking
  questions)
- Coding Plan state: reviewed; Units 1-5, Whole-Demand Acceptance, and
  Whole-Demand Code Review are complete.
- Computed Workflow Next State: `Workflow Complete`.
- Current blocker status: `chat_mode=group` / `group_message_type=thread` is an
  accepted target shape. The real admitted root probes, distinct topic scopes,
  same-topic replies, continuation, and isolation checks passed; the reviewed
  pair is backed up and installed with exact content readback and mode `0600`.
  Unit 5 executor self-check and independent Unit Review passed paired install,
  first activation, exact restore, restored activation, final redeploy, final
  activation, recoverability, and Topic B isolation. No execution-unit gate
  remains. Fresh deployed MemoryData/non-MemoryData business topics and
  same-topic/isolation behavior passed WDA. Attachment model behavior also
  selected correctly, but Bridge eagerly downloaded unrelated and decoy files
  before selection. Qin Peng accepted that transport-layer behavior as an
  explicit remaining risk and accepted Unit 3 disposable source-app identity
  evidence in lieu of a live relay canary; WDA then returned Pass with those
  risks named.
  The full suite remains MIXED/not stably GREEN and is carried as the
  independently reviewed `accepted repository baseline risk`; it cannot mask a
  later live failure. The final independent Whole-Demand Code Review returned
  `Continue` after its only P2 finding was fixed and re-reviewed.
- Required next action: none inside this workflow. Commit, push, MR, merge, and
  production deployment remain separate actions requiring their own
  authorization.

## Independent Plan Reviewer Handoff

Review this Plan against:

- `docs/specs/20260721-azu-group-prompt-bug-confirmation-gate.md`
- `docs/specs/20260718-azu-group-prompt-router.md`
- `operator-prompts/README.md`
- current dirty diff in the worktree
- `plan-before-coding.md`
- `AGENT_LOOP_GUIDE.md`

Priority concerns:

1. Verify Unit 1 is a complete Router RED→GREEN tracer and Unit 2 Tracers A/B/C
   each observe one attributable RED on the previous cumulative GREEN baseline,
   implement minimally, and preserve all earlier assertions.
2. Verify that the old card/controller lifecycle is replaced rather than merely
   moved into the SOP.
3. Verify that general/non-MemoryData parent behavior remains explicit and
   testable.
4. Verify that the five units naturally progress from Router tracer, SOP
   tracers, disposable behavior, repository proof, and paired deployment
   directly into Whole-Demand Acceptance.
5. Verify that the confirmed Spec/current Harness request is sufficient Unit 5
   authority while changed target/scope and uncovered external effects still
   require new authorization.
6. Verify that Delta Spec section 10.4, retained Parent attachment/identity
   read-only canaries, and evidence finalization belong only to Whole-Demand
   Acceptance; unavailable required live canaries must not become runtime PASS,
   while three-stage effect boundaries remain Unit 3 disposable proof.
7. Verify that Whole-Demand Acceptance and Whole-Demand Code Review remain
   guide-owned phases represented here only as scopes.
8. Verify that Unit 4 always runs and truthfully reports `pnpm test`; that the
   current/same-HEAD-clean/named-focused/changed-boundary attribution protocol
   permits only unchanged non-demand timing/parallel instability to enter Unit
   5 as a disclosed repository baseline risk; and that demand-owned or
   unexplained failures still block.
9. Verify that the Unit 4 exception cannot excuse any Unit 5 or Whole-Demand
   Acceptance live canary failure and cannot be reported as full-suite GREEN.
10. Verify the confirmed section 4.3 amendment is reflected throughout: the
    `chat_mode=group` / `group_message_type=thread` target is acceptable, but
    Unit 5 fails closed before writes unless two fresh-topic root messages
    provide distinct non-empty `threadId` values, distinct `chatId:threadId`
    scopes, and same-topic replies.
11. Verify `/new` is described as topic-scoped in the designated
    activation-control topic for initial install, rollback, and final redeploy;
    it must not be used to claim a group-wide refresh or replace WDA's two
    fresh-topic Session/context/authorization-isolation proof.
12. Verify Unit 5 compares repository and live files by exact content
    bytes/SHA-256, enforces live Group Prompt and SOP mode `0600` rather than
    repository mode, and restores each target's exact prior
    existence/bytes/mode on rollback.
13. Verify Qin Peng is explicitly responsible for opening/posting the two real
    inbound Unit 5 roots and two real inbound WDA roots, and for participating
    in the activation-control topic. Verify unavailable human operation routes
    to `Environment setup required`, never Human decision, re-confirmation, or
    synthetic event substitution.
14. Verify every real root, continuation, and activation-control `/new` proves
    group-response admission before topic evidence: structured @ mention to the
    target Bot by default, or fresh recorded `all-messages` / eligible
    `owner-default` for Qin Peng's exact sender. Verify no admission is
    `Environment setup required`, and only an admitted message with missing
    thread scope/reply becomes a Bridge compatibility finding.

Requested output: `Status: PASS / REPAIR`, concrete issues and suggested Plan
repairs if needed, or residual execution risks if PASS. Do not implement code,
run deployment, or replace the required fresh independent review with structural
judgment.
