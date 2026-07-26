# Implementer Bot Phase 2 Spec Draft

task_id: project-bootstrap-phase2-spec-xiaoc
phase: spec_draft

## Summary

Implementer Bot submitted a Phase 2 implementation spec for `/project start` group collaboration startup.

## Proposed Syntax

```text
@Coordinator Bot /project start /cd lark-channel-bridge-fork
@Coordinator Bot /project start /cd /redacted/local-root/lark-channel-bridge-fork
```

## Proposed Flow

1. Coordinator Bot self setup:
   - `/invite group`
   - `/cd <Coordinator Bot local workspace>`
2. Query group bots:
   - `lark-cli im chat.members bots --params '{"chat_id":"<chatId>"}' --as user --format json`
3. Match known bot registry.
4. Dispatch to bridge bots:
   - `/cd <path>`
   - `/invite group`
5. Dispatch workspace context JSON to non-bridge bots.
6. Return receipt table.

## Proposed Internal Interfaces

- `src/project/bot-registry.ts`
- `src/project/dispatch.ts`
- `src/project/workspace-context.ts`
- `tests/integration/commands/project-bootstrap.test.ts`

## Important Review Point

Implementer Bot's draft says:

```text
src/commands/index.ts 无修改（/project start 语义不变，编排由 agent 完成）
```

This conflicts with Qin Peng's expectation that the optimized project startup capability should
be implemented, not only documented as agent behavior. Review must decide whether Phase 2 is:

1. bridge command implementation, or
2. agent-only orchestration using current bridge primitives.

The current user direction strongly indicates option 1 or at least a concrete bridge-side helper,
because the current implementation was judged incomplete.

## Test Requirements From Draft

- Bot discovery and matching.
- Dispatch instruction generation.
- Structured mention and bot identity dispatch.
- Receipt table.
- Security boundaries: no privilege escalation, no plain text target resolution.
- End-to-end `/project start /cd` flow.
