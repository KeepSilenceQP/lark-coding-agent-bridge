# 小C Phase 2 Revised Spec

task_id:
  - project-bootstrap-phase2-spec-revision-xiaoc
  - project-bootstrap-phase2-openid-scope-correction
phase: spec_revision
source_message_ids:
  - om_x100b6d88ec24ecf4c49e00483b91618
  - om_x100b6d88eb2058a0c4326499a505ff6

## Result

小C submitted a revised Phase 2 spec addressing D1-D4 and the open_id scope correction.

## D1 Command Surface

- Add `/project bootstrap <workspace-slug>`.
- Preserve `/project start <absolute-or-tilde-path>`.
- Validate slug with `/^[A-Za-z0-9._-]+$/`.
- Reject whitespace, `..`, path separators, shell metacharacters, brackets, and quotes.

## D2 Registry Boundary

- New registry metadata surface under `src/project/bot-registry.ts`.
- Registry reads/writes are human-admin gated.
- botAdmin cannot mutate registry.
- Phase 2 does not expose `/botRegistry` CRUD; config/manual edit only.

## D3 Status Semantics

- `sent`: send API returned `ok=true` and a non-empty message id.
- `acknowledged`: target replies with structured @ 小P and matching task id.
- `verified`: target replies with structured execution report.
- `blocked`: explicit reason such as `bot_not_in_group`, `open_id_unknown`,
  `dispatch_failed`, `denied`, or `no_response`.

## D4 Receiver Authorization

If a target bridge bot has not added 小P as botAdmin, bootstrap must show
`blocked(denied)` in the receipt. Phase 2 assumes human pre-authorization rather than adding a
direct cross-profile authorization API.

## Non-Bridge Workspace Packet

小C incorporated 小A's schema requirements:

- `primary_workspace_kind: local`
- `local_workspace: /Users/bytedance/repo/lark-channel-bridge-fork`
- `devbox_usage: reference_only`
- `must_not_run: ["/cd", "/invite group"]`

## Open ID Scope Revision

小C accepted that Feishu open_ids are app/profile scoped.

Revised registry design:

- Live discovery first with `chat.members bots`.
- Static registry stores role/workspace metadata, not hardcoded open_id.
- Dispatch uses live discovery open_id for the current dispatching profile.
- Registry matching currently proposed by bot name.

## Coordinator Review Note

The name-based matching proposal needs reviewer attention. Bot display names may vary
(`小 A` vs `小A`, spacing, aliases) or collide. Spec review should decide whether Phase 2
requires:

- canonical name + aliases,
- explicit per-profile live discovery cache,
- or another stable local matching rule.

## Proposed Files

- `src/project/bot-registry.ts`
- `src/project/dispatch.ts`
- `src/project/workspace-context.ts`
- `src/project/bootstrap-coordinator.ts`
- tests under `tests/unit/project/`
- integration tests for `/project bootstrap`

## Scope Decision In Draft

Phase 2 configures only bots already in the group. True chat-member invite moves to Phase 3.
