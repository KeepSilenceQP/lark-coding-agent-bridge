# Project Bootstrap Phase 2 — Code Review Fix2 Local Review

Date: 2026-06-12
Reviewer: 小P
Branch: feat/project-bootstrap-phase2

## Verdict

CHANGES_REQUESTED.

小C这轮返工修正了 B1/B3/B5 的主要方向，但集成层仍不能交给云上C总复审。

## Verified Locally

- `npm test -- --run tests/unit/project/bot-registry.test.ts tests/unit/project/dispatch.test.ts tests/integration/commands/commands-v1.test.ts`
- Result: 53/53 passed.

## Findings

### F1 — public command gate reason was regressed

`resolveCommandGate()` accidentally changed public commands from `allowed-public` to `allowed-admin`.

This was restored locally in `src/commands/index.ts`.

### F2 — task_id is not delivered to bridge bots

The `/cd` and `/invite group` messages now contain no `task_id`, which avoids breaking `/cd` parsing, but it also means the target bridge bot has no deterministic task id to include in its receipt.

The comment says "taskId in separate metadata line", but no separate metadata message is sent.

Required fix: send a separate native-mention instruction/metadata message to each bridge bot before the slash commands, containing:

- `task_id`
- expected receipt format
- workspace path
- the fact that subsequent `/cd` and `/invite group` belong to that task

Keep slash command messages path-only/command-only.

### F3 — receipt ingestion is not connected to message handling

`tryIngestBootstrapReceipt()` is defined and exported, but no runtime message path calls it. `rg` only finds the definition.

Required fix: call it from the actual inbound message handling path before/around command handling, with structured mentions from the raw message.

### F4 — pin-on-first-verify still does not pin

`tryIngestBootstrapReceipt()` imports `pinBinding` but never calls it. `planBootstrap()` still receives `pinned: new Map()` for every bootstrap, so `identity_changed` remains unreachable in production.

Required fix: maintain a per-process pin store at minimum for Phase 2, pass it into `planBootstrap()`, and call `pinBinding()` when a verified receipt is accepted.

### F5 — tests still miss the integration blockers

Required tests:

- bridge dispatch sends a metadata/task message plus clean `/cd <path>` and `/invite group`
- inbound receipt calls `tryIngestBootstrapReceipt()` and advances `sent -> acknowledged -> verified`
- verified receipt pins open_id; subsequent changed live open_id yields `blocked(identity_changed)`
- public commands keep `allowed-public`

## Next Action

Send `project-bootstrap-phase2-code-review-fix2-xiaoc` to 小C. Do not request 云上C总 review until F2-F5 are fixed.

## Fix2 Resolution

小C回传 F2-F5 evidence 后，本地继续补了两处硬证据：

- 增加 commands 集成测试，覆盖三消息派发、human-admin gate、verified receipt 后 pin、下一次 live open_id 变化触发 `identity_changed`。
- 修复 receipt parser：既接受 `/cd <path> → ok`，也接受协议文案里的 `/cd → ok`。
- 修复 B1 默认 discovery：SDK `chatMembers.get` 明确不返回机器人，SDK 类型也没有 `chatMembers.bots()`；默认实现改为调用 bridge-bound `lark-cli im chat.members bots --as user --format json`，保留 injected raw seam 只用于测试。

Updated verification:

- `npm test -- --run tests/integration/commands/commands-v1.test.ts tests/unit/project/dispatch.test.ts tests/unit/project/bot-registry.test.ts`
- Result: 56/56 passed.
- `npm run build`
- Result: success.

Remaining note:

- `npm run typecheck` still reports the pre-existing `src/media/cache.ts` `downloadResourceToFile` type error; not introduced by this work.
