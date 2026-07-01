# Context Pack: lark-channel-bridge-fork / lark-channel-bridge-project-bootstrap-phase2

updated: 2026-06-12 16:49:05 +0800

## Project

- name: lark-channel-bridge-fork
- chat_id: oc_c1a30ba2d2692138047f5ea2b5bf8c92
- flow_level: heavy
- source_of_truth: /Users/bytedance/repo/lark-channel-bridge-fork
- local_workspace: /Users/bytedance/repo/lark-channel-bridge-fork
- devbox_workspace: 

## PRD

### Background

Yesterday's approved design for `lark-channel-bridge` project bootstrap was broader than the
current implementation. The current bridge code has:

- `/botAdmin add/remove/list @Bot` for profile-scoped bot-to-bot operational trust.
- `/project bootstrap <workspace> <targetBot>` for project-group
  implementation bootstrap.

The agreed project-group bootstrap flow requires more: 小P should coordinate a new project
group, prepare context, discover bot identities, dispatch native-mention task packets, and
bring participating bridge bots into the project workspace.

### Goals

- Add a project bootstrap command so 小P can dispatch bootstrap setup to 云上C总 and the
  human-selected implementer from the human-provided workspace.
- Keep `botAdmin` as a least-privilege operational role, not owner/admin equivalence.
- For bridge bots in the group, send native-mention instructions to run:
  - `/cd <machine-specific-workspace>`
  - `/invite group`
- Default R&D bootstrap targets are 小C, 云上C总, and 云上小C; 小P is the
  coordinator and is not dispatched to itself.
- Keep non-bridge workspace-context support as an explicit custom-registry extension, not as
  part of the default R&D bootstrap list.
- Generate and maintain a visible state machine for project startup.
- Return a startup acceptance checklist that distinguishes sent, acknowledged, verified, and
  blocked states.
- Preserve all existing safety boundaries: no plain-text `@Name` target resolution, no bot
  privilege escalation, no silent failure when target bot open_id is unknown.

### Non Goals

- Do not make `botAdmins` equivalent to human admins.
- Do not let bot admins modify human users/admins or botAdmins.
- Do not pretend a bot was mentioned if the message lacks a structured mention.
- Do not assume a bot can be contacted in a project group if it is not a group member.
- Do not include 小A or 小小P in the default R&D bootstrap list.
- Do not rely on CardKit display mentions as bot-deliverable handoff.

### Constraints

- Feishu bots only receive group messages when structurally mentioned.
- Bot-to-bot task dispatch must use bot identity (`lark-cli ... --as bot`).
- Bot discovery must use current group bot membership, not text names or user search.
- Receiving bridge bots must have 小P in their own `botAdmins` list before they can accept
  小P-dispatched `/cd <workspace>` and `/invite group` commands. The permission direction is
  "小P is botAdmin of the receiving bot", not "receiving bots are botAdmins of 小P".
- This botAdmin grant is a one-time receiving-profile setup, not a per-project or per-group
  step. Re-apply it only when adding a new receiving bot, changing/resetting its profile, or
  when 小P's sending identity/open_id changes.
- `/invite group` means "add current chat to the receiving bot's allowedChats"; it does not
  invite a bot into the chat.
- Current group bot membership can be queried with:
  `lark-cli im chat.members bots --params '{"chat_id":"<chatId>"}' --as user --format json`
- Missing registered bots should be invited with:
  `lark-cli im chat.members create --params '{"chat_id":"<chatId>","member_id_type":"app_id","succeed_type":1}' --data '{"id_list":["<cli_app_id>"]}' --as user --format json`
  and then re-discovered before any native mention dispatch. The invite input is app_id; native
  mentions still use the live `bot_id/open_id` returned by the second discovery.
- Bootstrap workspace is human-provided and may be relative. Qin Peng guarantees the same
  relative workspace exists in the relevant local/devbox runtimes; 小P forwards it as the
  workspace command argument without inferring implementation location.
- Local workspace:
  `/Users/bytedance/repo/lark-channel-bridge-fork`
- Devbox workspace convention:
  `/home/qinpeng.bobo/repo/lark-channel-bridge-fork`

### Acceptance

- PRD/spec/plan are reviewed before implementation.
- `/project bootstrap <workspace> <小C|云上小C>` behavior is specified and tested.
- Legacy `/project start <absolute-or-tilde-path>` behavior is removed.
- Current group bot discovery is covered by tests or a seam that can be mocked.
- Native mention dispatch uses bot identity and structured mentions.
- Bridge bot startup dispatch sends machine-appropriate `/cd` and `/invite group` commands.
- Default bootstrap does not invite or dispatch to 小A or 小小P.
- Startup receipt reports each target bot state and blocked reason.
- Focused tests pass; known unrelated failures are called out separately.

## Roles

- coordinator: 小P
- prd_reviewers: 云上C总
- spec_author: 小C
- spec_reviewer: 云上C总
- plan_author: 云上小C
- plan_reviewer: 小P
- implementer: 小C
- code_reviewer: 云上C总

## Handoff

- next_receiver: 云上C总, 小C, 云上小C
- required_native_mentions: 小P
- response_format: independent text/post + native mention
- evidence_package: docs/agent-context/evidence/20260612-lark-channel-bridge-project-bootstrap-phase2-evidence-template.yaml

## State

- current_phase: prd_review
- blocked_nodes: []
- open_questions: []

## Current R&D Bootstrap Registry

| Bot | open_id | Role In This Flow |
| --- | --- | --- |
| 小P | ou_cc7a2bbc1be9e7f6054282ae918b9249 | coordinator |
| 小C | ou_324e9fce8ef80022821ca29ae594e45c | spec author and implementer |
| 云上C总 | ou_a73add268438eb388b31e559a4fa846f | PRD/spec/code reviewer |
| 云上小C | ou_f017ffff038aa3c6a4e5beb711be495d | plan author/devbox feasibility |

Excluded from R&D bootstrap defaults: 小A, 小小P.

## Phase 2 Bootstrap Target Behavior

When a human admin sends:

```text
@小P /project bootstrap lark-channel-bridge-fork 小C
```

小P should:

1. Parse the human-provided workspace and target implementer.
2. Add the current group to 小P's own `allowedChats`.
3. Discover group bot members with the current dispatching profile.
4. For 云上C总 and the registered target implementer missing from the group, invite by app_id with
   `chat.members create`, then re-run bot discovery.
5. Match 云上C总 and the target implementer from registry metadata.
6. Dispatch bridge-bot setup messages to 云上C总 and the selected implementer:
   - `/cd <human-provided-workspace>`
   - `/invite group`
   - task metadata containing `target_bot`
7. Produce a startup checklist with per-bot status.

If a target bot cannot be invited or is still missing after invite + re-discovery, the receipt
must report it as blocked and must not claim a native mention was delivered.

## Reviewer Followups Before Spec Freeze

Cloud reviewer result: `GO-with-followups`.

Required spec changes:

1. Replace `/project start` with `/project bootstrap <workspace> <targetBot>`.
2. Derive task ids from a sanitized workspace basename; workspace itself is the source of truth.
3. Define the bot registry management boundary. Registry edits must be human-admin gated;
   botAdmins must not mutate dispatch targets. Feishu open_ids are app/profile scoped, so
   live discovery for the current dispatching profile must provide delivery open_ids; static
   registry must not be treated as globally valid open_id truth.
4. Define status semantics:
   - `sent`: send API succeeded and fetched message has structured mention.
   - `acknowledged`: target bot replies with structured @ 小P and matching task id.
   - `verified`: target bot reports command/context application success.
   - `blocked`: discovery, dispatch, permission, path, or execution failed with explicit reason.
5. Define receiver authorization failure as `blocked(denied)`.
6. Remove existing `/project start <absolute-or-tilde-path>` behavior.

## Registry And Open ID Scope

Feishu `open_id` values are app/profile scoped. The same visible bot can have different
`open_id` values when discovered from 小P, 云上小C, or 云上C总 profiles.

Concrete observed case: 云上C总's first review reply used 小P's Context Pack `open_id`
(`ou_cc7a...`), which is valid from 小P's app perspective but not from 云上C总's app
perspective. 云上C总 had to re-send using its own live view of 小P's `open_id`. Therefore,
delivery mentions must always be constructed from the sending app/profile's live identity
resolution. Registry `open_id` values, if present, are metadata/cache only and must not be
treated as cross-app delivery truth.

Phase 2 registry rule:

- Run live `chat.members bots` discovery from the dispatching profile before dispatch.
- Use the live discovery `open_id` to construct the structured mention.
- Static registry stores role and workspace metadata, not globally valid delivery `open_id`.
- Evidence and receipts should record the dispatching profile or open_id source profile.

Open review item: the proposed metadata match key is currently bot display name. This may need
canonical names plus aliases because display names can contain spacing variants such as
`小 A` vs `小A`.

Final spec review decision: display-name-only matching is not sufficient. Implementation must
use the following identity rules:

- Registry metadata includes `canonical_name` and `aliases[]`.
- Matching uses NFC-normalized exact equality only.
- No substring matching and no fuzzy matching.
- If `chat.members bots` exposes a stable app id such as `cli_...`, prefer it as the anchor.
- Otherwise use pin-on-first-verify:
  - first successful verified receipt persists the live `open_id` as a pinned binding;
  - pinned binding is a dispatcher-profile-scoped cache, not global source of truth;
  - future bootstrap tries pinned binding first.
- If a future name match resolves to a different `open_id` than the pinned binding, do not
  auto-rebind. Mark `blocked(identity_changed)` and require human-admin confirmation.
- Zero matches or multiple matches are hard failures: `blocked(ambiguous_name)`.
- Verified status must come from a structured target-bot receipt with native @ 小P, matching
  `task_id`, and fixed status/execution fields. 小P must not infer verified from free-form chat
  history.
