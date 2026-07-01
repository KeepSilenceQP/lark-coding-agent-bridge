# 云上C总 PRD Review

task_id: project-bootstrap-phase2-prd-review-yunshangcz
phase: prd_review
source_message_id: om_x100b6d88d82434bcc2ddaaf9bcc0645
result: GO-with-followups

## Summary

PRD scope, security boundaries, and non-goals are accepted. It can move into spec,
but D1-D4 must be resolved before spec freeze.

## D1 Command Syntax Conflict

`/project start /cd <name>` conflicts with existing `/project start <path>` parsing.
`handleProjectStart` checks the entire rest as absolute-or-tilde path, so `/cd <slug>`
is misread as a path-like argument and fails as a bad directory instead of a subcommand.

Required change:

```text
/project bootstrap <workspace-slug>
```

Slug must be validated with `[A-Za-z0-9._-]+` because it is later interpolated into
dispatched `/cd` command text.

## D2 Registry Management Boundary

The open_id -> role -> machine -> workspace-root mapping is a new configuration surface.
It must be human-admin gated. Bot admins must not edit the registry because that would let
them indirectly change dispatch targets and escalate authority.

Phase 2 may use hardcoded defaults plus a config file, but the management boundary must be in
the spec.

## D3 Verified Semantics

The checklist distinguishes sent / acknowledged / verified / blocked, but verified needs a
defined source:

- `sent`: local send API succeeded and message object has structured mention.
- `acknowledged`: receiving bot replies with structured @ 小P and matching task id.
- `verified`: receiving bot reports command/context application success in a structured receipt.
- `blocked`: discovery, dispatch, permission, path, or execution failed with explicit reason.

## D4 Receiver Authorization Prerequisite

Dispatch depends on target bridge bot having already added 小P as botAdmin. If a target rejects
the command because 小P is not authorized, bootstrap must mark that bot
`blocked(denied)` and must not fail silently.

## Scope Recommendation

Phase 2 should configure only bots already in the group. It should not implement actual chat
member invite. Missing bot should be `blocked(bot_not_in_group)` with a clear manual action.
True invite should be Phase 3.

## Required Tests

1. Non-admin trigger is rejected.
2. Target bot missing from group -> blocked, no fake delivery.
3. Receiver has not authorized 小P -> blocked(denied).
4. Plain text @ does not count as mention.
5. Invalid slug with spaces, `..`, or special chars is rejected.
6. Machine path mapping is correct.
7. Non-bridge bot receives context packet instead of `/cd`.
8. Same group + slug bootstrap is idempotent.
9. State transitions and blocked reasons are visible.
10. Existing `/project start <absolute-path>` still works.
11. Bot discovery has a mockable seam.
12. Send API failure is retryable and does not wedge state.

## Infra Followup

For devbox spec/code review, either publish the fork to GitHub and grant the existing deploy
key, or reuse an existing accessible repository/branch. The devbox path
`/home/qinpeng.bobo/repo/lark-channel-bridge-fork` does not currently exist.
