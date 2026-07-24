# Correct Reaction Handling By Bridge Agents — Coding Plan

Date: 2026-07-24
Status: Code Review GO; Unit 11 live verification pending deployment
Spec authority: `docs/specs/20260723-reaction-target-context-and-agent-semantics.md` (commit `d18322c`，confirmed；independent review PASS；`d18322c` 在 `e7e178f` 基础上解决 review 歧义)
Target branch: `fix/bugfix` (synced to `d18322c`)
Harness protocol: `feishu-group-project-flow-v2`
Plan Writer: 云上C总 (only writes this Plan; no self-review, no implementation)
Plan Reviewer: 小P
Implementer: 小C（Unit 1-10）→ 小P（B9 R6-R8 接管及后续闭环）

> 本 Plan 不重写需求。所有行为契约、字段、验收以 Spec 为准；本文件只把 Spec 落到真实模块、依赖、顺序、Execution Units、完成条件与 gate。Spec 与当前代码冲突处单列在「Known Issues / Blockers」与「Resolved Decisions」，不静默裁定。

## Outcome

实现 Spec 的两段不可分割交付：(1) Bridge 把「需要模型解释的 Reaction 事件 + 它所回应消息的完整可读上下文」确定性提供给 Agent；(2) 共享 `BRIDGE_SYSTEM_PROMPT` 明确要求 Agent 按「目标消息 + Reaction 动作 + Reaction 语义」组合判断。同时落地权限/self-operator 门禁、Reaction event buffer + `messageReaction.list` 权威快照 + 持久 ledger/revision、`stop_current_work` 独立控制面 + `workChainId` 关联、全部有效 Reaction 的可见回复、superseded 流式回复。`stop_current_work` 与无需模型判断的撤回由 Bridge 控制面确定性处理，不为此启动 Agent。

完成定义（与 Spec「Goal And Completion Definition」一致）：
- 每个需要模型解释的 Reaction，Agent 实际输入同时存在 Reaction 事实与完整目标消息。
- 共享 System Prompt 明确规定如何组合解释这两部分。
- 行为验收证明：同一 Reaction 作用于不同目标消息时，Agent 据目标语义产生不同且正确结果，而非机械映射 emoji 或重复执行上一任务。

## Review History

- 2026-07-24 云上C总：基于 `e7e178f` 全文读取 Spec + 全量源码勘察，产出本 Plan 草稿。Plan Writer 不自审。
- 2026-07-24 小P 复核 + 云上C总 修订（第 2 版）：DD17/B1 原结论「`/stop` 不取消 pending」误判——经 `src/bot/channel.ts:1304-1331` 复核，`intakeMessage` 对 `tryHandleCommand` 返回 `handled=true` 的命令统一 `pending.cancel(scope)`，`/stop` 已含取消 pending。stop 控制面改为复用现有 `/stop`「interrupt + pending.cancel」复合语义，不比 `/stop` 严格，无 `/stop` 对齐改动；B1 撤回。
- 2026-07-24 小P Plan Review 结论 BLOCKED（6 项 finding 有效）+ 云上C总 修订（第 3 版，基于 Spec `d18322c`）：①`Get` 不新增为第 12 个预埋 alias，v1 仍 11 个，示例用 `JIAYI`，`Get` 走 unmapped 透传；②单数 `triggerReaction` 改为按 action time+到达顺序排列的 `triggerReactions[]`，保留 `effectiveReactionSet`，补"启动前快速新增两个不同 Reaction"与"同 buffer 一增一减且最终非空"测试；③stop added 顺序改为门禁+防重后先判 scope 完全无 work→回无任务，仅 scope 有 current work 时才做 target→current workChain 关联（历史/无关→fail closed）；④定义 canonical fingerprint 稳定字段/去重/确定性排序，跨页/返回顺序打乱不产生 revision；⑤补 context-builder→fetchQuotedContext→reaction_contexts 卡片/合并转发真实内容 wiring 测试；⑥workChainId 给出明确 TTL/容量/淘汰规则与边界测试。
- 2026-07-24 小P Plan v3 复审：前 5 项 CLOSED；第 6 项 TTL/LRU 方向成立但 DD15 引入 1 个 BLOCKER（16/256 作总 Map 硬上限与 current 不淘汰、PendingQueue 无背压三者冲突；current outbound mapping 不能被 TTL 淘汰，否则长任务丢 stop 关联）。云上C总 修订（第 4 版）：16/256 重定义为 historical cache 上限（非总 Map 硬上限），current chains 及其 outbound mappings 在 queued/reserved/active 期间不参与 TTL/LRU，terminal 后才进入 30min historical retention 并按 LRU 裁剪；总边界表述为 current workload references + bounded historical cache；不引入 pending admission/drop/backpressure；Unit6 补 a/b/c 三测试。
- 2026-07-24 小P Plan v4 复审：第 6 项 BLOCKER CLOSED；六项 finding 全部闭合，未发现新的阻塞或 Spec 缩减，Plan Review `GO`。
- 2026-07-24 小P接管 B9 R6-R8：R6 经独立 SubAgent Review 发现 5 项 lifecycle/invariant 问题并在 R7 闭合；R7 复审发现 rev1 已离队但尚未 reserve 时，rev2 replacement 未写 tombstone 的 BLOCKER；R8 `67b43d8` 补齐 exact old turn invalidation。独立 SubAgent 最终复审 `5c2682d..67b43d8` 结论 `GO`，确认 R7 的 5 项修复维持闭合，允许重新打包部署并继续 Unit 11；live 验收仍需单独完成。

## Current Evidence（当前代码现状，file:line）

Reaction 入站现状（核心 gap 所在）：

- 入站 reaction 事件 handler：`src/bot/channel.ts:934-992`（`reaction: async (evt) => {...}`）。
  - 用 `channel.rawClient.im.v1.message.get` 取被回应消息恢复 `chatId`（`channel.ts:937-944`）。
  - 仅做 self-**message** 过滤（被回应消息发送者 == 本 Bot）：`channel.ts:946-961`，比较 `item.sender.id` 与 `channel.botIdentity?.openId` 及 `cfg.accounts.app.id`。
  - 合成一条 `NormalizedMessage` 直接 `pending.push(scope, …)`（`channel.ts:969-982`）：`content: "[reaction-${action}] ${emojiType} (on msg ${id.slice(-8)})"`、`rawContentType: 'reaction'`、`senderId: evt.operator.openId`、`mentionedBot:false`。
  - **缺失**：self-**operator** guard、`canUseDm`/`canUseGroup`、`decideGroupResponse`、`messageReaction.list` reconciliation、持久 ledger/revision、`<reaction_contexts>`、目标消息正文、stop 控制面、`workChainId`。
- `src/bot/reaction.ts` 仅含出站 `addWorkingReaction`/`removeReaction`（Typing 工作态），与入站处理无关。
- 普通消息权限链（可复用）：`canUseDm`/`canUseGroup`（`src/policy/access.ts:33-58`）+ `decideGroupResponse`（`src/bot/group-response-policy.ts:26-55`），普通消息在 `channel.ts:1253-1302` 调用；flush 时二次 access 校验在 `channel.ts:1514-1517`（不重算 `decideGroupResponse`）。`/invite group` denied-chat 旁路 `shouldBypassDeniedChatForInviteGroup`（`channel.ts:1337-1351`），**Reaction 不得复用**。
- Pending 队列：`src/bot/pending-queue.ts`，按 `scope` 单键 debounce（`DEBOUNCE_MS=600`，`channel.ts:121`），同 scope 消息在 quiet window 内合并为一个 batch；`block`/`unblock`（`pending-queue.ts:66-86`）保证同 scope 至多一个 run 在飞。`cancel(scope)`（`pending-queue.ts:49-55`，返回被丢弃消息）与 `cancelAll()` 存在。
- ActiveRuns：`src/bot/active-runs.ts`，按 `scope` 键；`reserve`/`register`/`interrupt(scope):boolean`/`unblock`/`stopAll`。`interrupt` 既 abort reservation（prompt-prep/pool-wait 阶段）也 `run.stop()` 已启动 run（`active-runs.ts:98-115`）。
- `/stop`：`handleStop`（`src/commands/index.ts:1567-1590`）本体只调 `ctx.activeRuns.interrupt(scope)`；但其调用方 `intakeMessage`（`src/bot/channel.ts:1304-1331`）对 `tryHandleCommand` 返回 `handled=true` 的所有命令统一执行 `pending.cancel(scope)` 再 `return`。`/stop` 是被识别命令（`handled=true`），故当前 `/stop` 实际效果 = `interrupt(scope)` + `pending.cancel(scope)`：中断 active run 并丢弃 scope 已排队消息，`unblock` 后无 pending 条目即不会重启旧队列。
- Run 启动：`startRunFlow`（`src/bot/run-flow.ts:102`）→ `executor.reserveScope`/`submit`；`AgentRunOptions`（`src/agent/types.ts:30-56`）携带 `prompt`/`systemPromptAddendum`/`routeId` 等。`buildPrompt` 调用点 `channel.ts:1483-1490`；outbound `sendOpts.replyTo = lastMsg.messageId`（`channel.ts:1502,1543`）。
- Prompt builder：`buildAgentPrompt`（`src/agent/prompt.ts:75-111`），section 数组扁平、按 truthy 过滤；`promptSection`/`safeJsonStringify`（`prompt.ts:113-124`）对所有块做 `<`/`>`/`&` 转义。`BridgePromptSource = 'im'|'card'|'comment'`（`prompt.ts:1`），无 `'reaction'`。
- 共享 System Prompt：`BRIDGE_SYSTEM_PROMPT`（`src/agent/bridge-system-prompt.ts:3-184`，单一来源）；`composeBridgeSystemPrompt(identity, addendum?)`（`:192-214`）。Claude 注入 `src/agent/claude/adapter.ts:72-84`（temp file + `--append-system-prompt-file`）；Codex 注入 `src/agent/codex/adapter.ts:205-218`（`developerInstructions`）。两路共享同一常量。无版本号/哈希；现有测试用 `toContain` 内容断言（`tests/unit/agent/bridge-system-prompt.test.ts`）。
- 目标消息规范化（可复用）：`fetchQuotedContext(channel, messageId)`（`src/bot/quote.ts:65-102`）已做 `im.v1.message.get` + SDK `normalize` + 交互卡片展开（`expandInteractiveCard`，`src/bot/interactive-card.ts:30-56`）+ merge_forward 展开 `<forwarded_messages>`（封顶 50）。返回 `QuotedContext`（`quote.ts:10-25`）。
- `rawClient.im.v1.messageReaction.list`/`listWithIterator`（SDK `@larksuiteoapi/node-sdk`）**全仓未使用**；分页模式可参考 `fetchTopicContext`（`quote.ts:184-234`，循环 `page_token`）。
- 持久 ledger 模板（可复用）：`src/session/prompt-binding-ledger.ts`（`writeFileAtomic` 原子写、`structuredClone`+重读 disk+revision bump 的 RMW 队列、`\x1f` 复合键、`schemaVersion`）；`src/platform/atomic-write.ts`；路径 `profileDir`（`src/config/app-paths.ts:39`）。
- 卡片终态：`Terminal = 'running'|'done'|'interrupted'|'error'|'idle_timeout'`（`src/card/run-state.ts:18`），无 `superseded`；`markInterrupted`（`run-state.ts:139-147`）；中断在流式循环 `channel.ts:2189,2293-2304` 反映为 `interrupted` 终态。
- `workChainId`/chain/correlation：**全仓不存在**（grep 0 命中）。outbound Bot 消息 ID 与 run 的关联**未记录**（仅日志）。
- Bot 身份：`channel.botIdentity?.openId`（`ou_`）、`cfg.accounts.app.id`（`cli_`）、`evt.raw` 的 `operator_type==='app'`（被 `normalizeReaction` 丢弃，仅 `evt.raw` 可达；`includeRawEvent:true` 已开 `channel.ts:782`）。`ReactionEvent` 无稳定 event_id。

## Design Decisions

### DD1 — Reaction 流水线归属与模块边界

新增 `src/bot/reaction/` 子目录承载入站 Reaction 全流程，替换 `channel.ts:934-992` 的「合成文本入队」路径。`src/bot/reaction.ts`（出站 Typing）保持不动。建议模块（命名可由小C 微调，职责不可省）：

- `semantics.ts` — 预埋语义表（DD4）。
- `ledger.ts` — 普通 Reaction 持久 ledger（DD6）。
- `buffer.ts` — 同 key 事件短时 buffer（DD5）。
- `reconciler.ts` — `messageReaction.list` 全分页 reconciliation + revision + 净零例外（DD5/DD7）。
- `context-builder.ts` — 构建 `<reaction_contexts>` 与目标消息（DD8/DD9）。
- `control-ledger.ts` — stop added/removed 独立持久控制 ledger（DD16）。
- `work-chain.ts` — `workChainId` 存储/继承/登记/生命周期（DD15）。
- `pipeline.ts` — 编排：事件 → self-operator guard → 路由 → own-message 过滤 → 权限门禁 → 语义映射 → buffer/reconcile 或 stop 控制面。
- `types.ts` — `ReactionContext`/`ReactionTurn`/`StopControlState` 等。

`channel.ts:934-992` 改为只做 `pipeline.handleReactionEvent(evt, deps)` 委派；不再合成 `NormalizedMessage`。流水线输出两类：普通 `ReactionTurn`（→ Agent run，DD11）或 stop 控制动作（DD16）。

### DD2 — Self-operator guard（operator 侧，先于一切）

在权限、snapshot/revision、queue、interrupt、任何回复**之前**判定 operator 是否为当前 Bot/app：

- `evt.operator.openId === channel.botIdentity?.openId`，或
- `evt.operator.openId === cfg.accounts.app.id`，或
- `evt.raw` 中 `operator_type === 'app'`（解析 `evt.raw`，因 `normalizeReaction` 丢弃该字段）。

命中即静默丢弃：不读写用户 snapshot、不更新 revision、不排队、不回复。`reconciler` 从 `messageReaction.list` 重建 `effectiveReactionSet` 时，剔除 `operator_type==='app'` 或 operator==self 的项，保证 Bridge 自己加/删 `Typing` 等工作态 Reaction 不反向触发 Agent。现有 self-**message** 过滤（`channel.ts:946-961`）保留为「仅消费本 Bot 消息上的 Reaction」的路由前提（Spec §5）。

### DD3 — 权限与群响应门禁复用（Reaction 非旁路）

self-operator guard + 安全路由 + own-message 过滤后、更新快照或产生副作用前，按普通消息同一套门禁：

1. 私聊复用 `canUseDm(profile, controls, operatorOpenId)`（`access.ts:33-45`）。
2. 群聊复用 `canUseGroup(profile, controls, chatId, operatorOpenId)`（`access.ts:47-58`）。
3. 通过后复用 `decideGroupResponse`（`group-response-policy.ts:26-55`），Reaction 无结构化 @，固定按 `mentionedBot:false`、`mentionCount:0`、`mentionAll:false` 计算；四种模式结果与「同一 operator 发一条无 @ 普通消息」一致：
   - `mention-only` → 不消费；
   - `owner-default` → 仅 owner 免 @ 条件满足者消费；
   - `owner-allowlist` → 还须命中 `ownerNoMentionChats`；
   - `all-messages` → 通过前置访问控制者可消费。
4. **不得**复用 `shouldBypassDeniedChatForInviteGroup`（`channel.ts:1337-1351`）。

任一门禁失败：静默拒绝——不更新 revision/快照、不入 pending、不启动 Agent、不 stop/interrupt、不取消队列、不发非授权提示。日志仅记受限 scope、operator 后缀、reason。`stop_current_work` 必须先通过**完全相同**的门禁才进控制面。

### DD4 — 预埋语义表（版本化、可测、case-sensitive）

`semantics.ts` 维护版本化、可测的映射表，覆盖 Spec「Confirmed Predefined Semantics」全部 11 个 `emojiType`（大小写敏感，取自飞书 Reaction emoji 列表）：

| `semanticKey` | `emojiType` |
| --- | --- |
| `approve_continue` | `OK`、`LGTM`、`Yes`、`CheckMark`、`JIAYI` |
| `explain_more` | `WHAT`、`THINKING` |
| `user_step_completed` | `DONE` |
| `stop_current_work` | `No`、`CrossMark`、`MinusOne` |

每项产出 `{ emojiType, emojiDisplay, emojiMeaning, semanticKey, emojiMeaningSource:'predefined' }`。`emojiType` 原样保留飞书值。**v1 预埋表严格为上表 11 个**（示例用 `JIAYI`）；`Get` 等**不在** v1 表的 emoji **不得**新增为第 12 个 alias，必须标记 `emojiMeaningSource='unmapped'` 完整透传，**不得**擅自提升为预埋语义。命中时 `emojiMeaningSource=predefined`；未命中的标准/自定义 emoji 仍完整透传，`emojiMeaningSource='unmapped'`，保留原始 `emojiType` 与可取得 UI glyph/label，**不得丢弃/静默/禁用**（Spec §Agent Input Contract 2）。语义定义由用户确认 + 飞书文档/真实事件对照验证，**禁止模型运行时生成预埋规则**。表带 `schemaVersion`，测试直接断言 11 个精确映射与未映射（含 `Get`）透传。

### DD5 — Reaction 事件 buffer + `messageReaction.list` 全分页权威快照

- **buffer**：除 `stop_current_work` added/removed 走独立控制路径（DD16）外，同一 `scope + operatorOpenId + targetMessageId` 的事件进入有最大等待上限的短时 buffer，按 action time、再按到达顺序排列；quiet window 或最大等待到达后做一次全分页 reconciliation。
- **权威快照**：WebSocket Reaction event 只作 reconciliation trigger，非当前集合权威。完成 self-operator、路由、own-message、权限门禁后，通过 `channel.rawClient.im.v1.messageReaction.list`（`user_id_type=open_id`）**全量分页**读取目标消息（循环 `page_token`/`has_more`，参考 `fetchTopicContext` 分页模式；不可只取首页 50），按 `operator_type + operator_id` 重建该 operator 的 `effectiveReactionSet`（剔除 self-app）。Bot 身份须具 `im:message.reactions:read`（live 验收前置）。
- **revision**：`reactionRevision` 仅在同一 key 权威 snapshot fingerprint 真正变化时单调递增（运行时并发控制标识，非用户可见序号、非跨重启业务 ID；跨重启防重由 ledger 负责）。

### DD6 — 持久 Reaction ledger（重启恢复、防重）

`ledger.ts` 按 Spec §Agent Input Contract 2 持久记录每个 `scope + operatorOpenId + targetMessageId` 最近一次已确认的：Reaction record IDs、集合 fingerprint、最新 action time、已消费 fingerprint。镜像 `prompt-binding-ledger.ts` 模式：`writeFileAtomic` 原子写、`structuredClone`+重读 disk+revision bump 的 RMW 队列、`\x1f` 复合键、`schemaVersion`，路径置于 `profileDir`。

- 重启后先加载 ledger，再处理新事件；只处理新事件对应的状态变化，**不重放**目标上已有 Reaction。
- 首次无历史 ledger：以本次真实事件为 delta、以 list 结果为当前上下文建立 baseline；**不得**仅因 reconciliation 看见旧 Reaction 就重放。
- 权威 snapshot fingerprint 与 ledger 相同通常 no-op：不递增 revision、不启动/中断 Agent、不执行控制动作、不回复（DD7 例外除外）。
- 重复投递/乱序/重启重放：以全量分页后 snapshot + ledger 为准，旧事件不覆盖新状态、不产生重复副作用。
- **canonical fingerprint**：集合 fingerprint 必须先对相关记录按稳定字段规范化、去重、确定性排序后再哈希——稳定字段至少含 `operator_type + operator_id + emoji_type`（`reaction_id` 仅用于去重，不进入排序键）；确定性排序按 `operator_id` 再按 `emoji_type`（大小写敏感）。跨页或 API 返回顺序打乱时 fingerprint 不变 → 不递增 revision、no-op（Spec §Agent Input Contract 2）。

### DD7 — 净零 added→removed 例外 / list 落后重试 / 失败单回复

- **净零例外**：buffer 中存在尚未消费、顺序明确的同 emoji `added → removed` 对，而 list 已直接越过中间状态回到原 fingerprint → 把该事件对消费为一次撤回确认：不递增 revision、不启动 Agent，**由 Bridge 只回复一次**。事件对 fingerprint 必须写入 ledger；重复投递/重启重放不再回复。
- **list 落后**：buffer reconciliation 时 list 尚未反映最新净变化 → 有限重试；仍不能取得与 buffer 事件相容的权威状态时，**不猜测、不改变 ledger**，针对整个 buffer 只可见回复一次「本次 Reaction 暂时无法确认，请重试」，不逐事件报错。
- **scope 缩权/读取失败**：`im:message.reactions:read` 不可用或分页读取失败 → fail closed；不得以单个 delta 伪造完整集合；ledger 不变、不启动/中断 Agent，产生可见失败回复。`stop_current_work` added/removed 是控制面例外（DD16），不依赖 list 中间状态。

### DD8 — 目标消息上下文（复用 `fetchQuotedContext`，两级失败处理）

- `context-builder.ts` 用 `fetchQuotedContext(channel, targetMessageId)`（`quote.ts:65-102`）复用现有规范化：文本/富文本可读、交互卡片保留真实卡片内容（`expandInteractiveCard`）、合并转发展开为受限 `<forwarded_messages>`。
- **路由成功但目标正文读取/规范化失败**：仍提供 `targetMessage.messageId` 与 `available:false`（Agent 不执行依赖目标语义的动作）。
- **路由元数据或目标 sender 无法取得**：记录受限日志后丢弃事件，不启动 Agent，**不**为产出 `available:false` 绕过路由安全校验。
- 目标消息及 Reaction 字段全部不可信，沿用 `safeJsonStringify`（`prompt.ts:117-124`）序列化，不允许正文闭合/伪造 Bridge 标签。目标消息作为 Reaction 上下文注入时，不得因其 ID 同时出现在 batch `messageIds` 中被错误去重。

### DD9 — `<reaction_contexts>` 注入与 `source='reaction'`

- `src/agent/prompt.ts`：`BridgePromptSource` 增加 `'reaction'`（`prompt.ts:1`）；`BuildAgentPromptInput` 增加 `reactionContexts?: ReactionContext[]`；section 列表新增 `promptSection('reaction_contexts', reactionContexts)`（位置在 `bridge_context` 之后、`user_input` 之前），统一走 `safeJsonStringify`。
- 每个 `<reaction_contexts>` 项含 Spec §Agent Input Contract 2 JSON 全字段：`operatorOpenId`、`reactionRevision`、`triggerReactions`（**有序数组**，按 action time、再按到达顺序排列的本次 buffer 中尚未消费、并共同导致当前 revision 的一个或多个 added/removed 事件）、`effectiveReactionSet`（权威快照）、`targetMessage`（`available`/`messageId`/`senderId`/`senderName`/`createdAt`/`rawContentType`/`content`）。`triggerReactions` 与 `effectiveReactionSet` 必须同时提供：事件 delta 识别用户刚做了什么，权威快照判断现在仍有哪些 Reaction。
- `bridge_context.source` 对纯 Reaction turn 标记为 `'reaction'`（不再伪装普通 IM 文本）；但 System Prompt 是否应用 Reaction 规则**以本轮是否存在 `<reaction_contexts>` 为准**，不依赖 batch 级 `source` 猜测。
- `user_input` 可保留简短兼容性摘要（如 `[reaction-added] JIAYI (on msg …)`），但 `<reaction_contexts>` 是权威来源，Agent 不得仅凭摘要中的短消息 ID 行动。
- 数据从 `pipeline` 经 pending/flush 链路 plumbed 到 `buildPrompt`/`buildAgentPrompt`（DD11）；Comment 路径（`comments.ts`，不经过 `buildAgentPrompt`）不受影响。

### DD10 — 共享 `BRIDGE_SYSTEM_PROMPT` `## Reaction` 段（两路注入）

- 在 `src/agent/bridge-system-prompt.ts` 的 `BRIDGE_SYSTEM_PROMPT` 中加入 Spec「Bridge System Prompt Contract」的 `## Reaction` 段（含 9 条规则 + 预埋语义子节），**逐字保留行为语义**，仅可调整标签说明以匹配最终 envelope。该段必须位于共享 Bridge System Prompt，而非群级 Prompt、某 Agent `SOUL.md`、`user_input` 或开发者文档。
- 通过现有 `composeBridgeSystemPrompt`（`bridge-system-prompt.ts:192-214`）同时注入 Claude（`claude/adapter.ts:72-84`）与 Codex（`codex/adapter.ts:205-218`）路径——两路共享同一常量，无需重复。
- 新增内容断言测试（扩展 `tests/unit/agent/bridge-system-prompt.test.ts` + Claude/Codex 注入 wiring 测试）。当前无 prompt 版本号；本 Plan 不强制新增版本常量，但若 reviewer 要求可加 `BRIDGE_SYSTEM_PROMPT_REACTION_VERSION` 供 live 验收记录（Spec 验收要求记录「共享 System Prompt 版本」）。

### DD11 — Reaction 为 pending batch barrier（不与普通消息合并）

- Reaction turn 是 pending queue 的 batch barrier，不与普通消息合并。普通消息与 Reaction 在同一 debounce window 或 active run 期间到达时，按到达顺序保留为不同 input unit。
- 实现契约：`PendingQueue`（`pending-queue.ts`）扩展为支持「barrier 条目」——Reaction turn 作为独立条目（携带 `ReactionTurn` 而非 `NormalizedMessage`），flush 时单独成一个 run；普通消息条目维持现有 debounce 合并。条目按到达顺序 flush，保证普通文本与 Reaction 的顺序关系。
- Reaction input unit 按 `scope + operatorOpenId + targetMessageId` 隔离：不同 operator/target 不合并；每个 input unit 至多一个 Agent turn，并 `replyTo` 自己的目标消息。话题消息留在原 `threadId`。
- outbound `sendOpts.replyTo` 对 Reaction turn 改为 `targetMessageId`（当前 `lastMsg.messageId`，`channel.ts:1502,1543`），`replyInThread` 按 topic 模式不变。
- 同一 input unit 可含同 operator 同 target 的多个不同 Reaction；交给模型的是最新 `effectiveReactionSet` + 导致该 revision 的全部尚未消费变化的有序 `triggerReactions[]`。Agent 启动前快速新增两个不同 Reaction，或同一 buffer 内一增一减且最终集合非空时，`triggerReactions` 必须按序保留全部变化、`effectiveReactionSet` 表达最终集合，**不丢失任一净变化**、不重放已处理语义。

### DD12 — revision 失效 / 中断 / 替代 turn

- Reaction run 记录其 `operatorOpenId + targetMessageId + reactionRevision`（在 `ActiveRuns` 之外加 per-run 元数据，或扩展 `RunHandle`，因 `ActiveRuns` 仅按 scope 键）。
- 同 operator/target 在 run 处理期间出现已授权新增/移除 → revision 递增，旧 run 立即失效并被中断（`activeRuns.interrupt(scope)`，`active-runs.ts:98-115`，覆盖已启动 run 与 reservation/prompt-prep 阶段）。
- 旧 run 收敛后只基于最新 revision 处理一次：最新 `effectiveReactionSet` 非空 → 启动一个替代 turn；已因移除变为空集 → 不启动 Agent turn，由 Bridge 回复已收到撤回。
- 不同 operator 或不同 target 的变化**不**打断当前 run，按各自 key 独立排队。
- 「是否仍在处理」只依据可观察生命周期：同 revision 仍 queued/reserved/active = in-flight；到达任意 terminal = 已处理。terminal 后收到 `removed` 永不重启 Agent，只更新 ledger 并由 Bridge 确定性回复（DD14）。中断只阻止未发生后续动作；interrupt 前已完成的工具调用/外部副作用不自动回滚。

### DD13 — superseded 流式回复（新增终态）

- `src/card/run-state.ts`：`Terminal` 增加 `'superseded'`；新增 `markSuperseded(state)`（类比 `markInterrupted`）。渲染器（`src/card/run-renderer.ts`、`text-renderer.ts`）对 `superseded` 输出明确「已被后续 Reaction 取代/已中断」文案，**不得**显示成功终态。
- revision 失效时：旧 run 已产生 outbound reply（流式卡片/Markdown）→ 保留同一消息，terminal 更新为 `superseded`；最新 revision 另发自己的回复。旧 run 未产生 outbound reply → 不补发旧状态回复，只回复最新 revision。连续多次变化可留下多个标记为 superseded 的历史回复，但任一时刻只有最新 revision 可完成为成功终态。
- 流式循环（`channel.ts:2127-2306`）需识别 superseded 并停止写入成功终态（类比现有 `markInterrupted` 路径 `channel.ts:2293-2304`）。

### DD14 — terminal 后撤回的 Bridge 回复

Reaction run 已 terminal 后才移除 Reaction：永不重新唤起 Agent、不重放、不自动回滚已完成副作用；由 Bridge 可见回复「已收到撤回 + 已完成动作未回滚」。Reaction run 完成后移除最后一个 Reaction 同此处理。除 `stop_current_work` 外，同 operator/target/emoji 在 Agent 启动前先 added 后 removed → 相消，不启动 Agent turn，Bridge 对最终撤回状态回复一次（DD7 净零例外与之协调）。

### DD15 — `workChainId` 存储/继承/登记/生命周期（新增、有界运行期元数据）

- `work-chain.ts` 维护有界运行期 `workChainId` 关联，**不交给模型推断**。
  - 每个新入站 input unit 分配 `workChainId`；显式回复或 Reaction 指向已有关联信息的 Bot 消息时继承该消息的 `workChainId`；无关联的新普通消息开启新 chain。
  - pending unit、run reservation、active run 都携带 `workChainId`；Bot outbound message ID 一旦创建立即登记为该 run 的 `workChainId`；发起当前 work 的 Bot 确认/方案消息属于被继续的同一 chain。
  - chain 仍有 queued/reserved/active work = current；全部 terminal = historical。后续有效回复/Reaction 可继承该 ID 重新继续此 chain，但在它重新产生 queued/reserved/active work 前不能停止另一个 current chain。
- **仅当**当前 scope 存在 active/reserved/queued work 时，停止 Reaction 的目标 message ID 才需映射到其中某个 current `workChainId` 以允许执行 stop 控制动作；active/reserved chain 或 pending sibling chain 都属 current。目标只属 historical chain、映射过期、或重启后无法恢复关联 → fail closed（DD16）。该 fail-closed 分支**不得**覆盖 DD16「scope 完全无 work → 幂等回复无任务」的前置分支。
- 重启后旧关联可整体失效，**不**据会话文本猜测重建。每次 outbound 登记、chain lifecycle 变化、fail-closed reason 写受限结构化日志。存储为内存 Map，**有界性 = current workload references + bounded historical cache**：
  - **current chains 及其 outbound mappings 不参与 TTL/LRU**：只要 chain 仍有 queued/reserved/active work（current），其 chain 记录与全部关联 outbound→chain 映射都原样保留，不受 `HISTORICAL_CHAIN_TTL_MS` 与 historical cap 约束（长任务不丢失 stop 关联）。PendingQueue 无容量/背压，active 期间可累积任意数量 current chain，**不**引入 pending admission/drop/backpressure。
  - **historical retention**：chain 全部进入 terminal 后才转为 historical，保留 `HISTORICAL_CHAIN_TTL_MS=1_800_000`（30 min）以供后续 Reaction 继承/关联；historical chain 记录数超过 `MAX_CHAINS_PER_SCOPE=16`、historical outbound→chain 映射数超过 `MAX_OUTBOUND_MAP_PER_SCOPE=256` 时，按 LRU 淘汰最久未访问的 historical 项；TTL 到期或被 LRU 淘汰的 historical 项再次被 stop Reaction 指向即按 fail closed 处理。
  - `MAX_CHAINS_PER_SCOPE`/`MAX_OUTBOUND_MAP_PER_SCOPE` 是 **historical cache 上限，不是总 Map 硬上限**；总 Map 大小 = current workload references（无上限）+ bounded historical cache（≤ cap）。重启 fail closed。常量为 Plan 定义默认值，小C 实现时可同量级调整。

### DD16 — `stop_current_work` 独立控制面（added/removed 独立持久 ledger，不走 Agent 链路）

`stop_current_work` 的 added 与 removed 都不依赖「普通 Reaction → buffer → pending → Agent run」链路。`control-ledger.ts` 维护独立、持久控制事件 ledger（同 DD6 模式）。

- **added**：完成 self-operator（DD2）、安全路由、own-message、权限门禁（DD3）、语义映射（DD4）与控制事件防重（`control-ledger.ts`）后，**按以下顺序**处理（**不**等普通 quiet window，**不**与紧随其后的 removed 相消）：
  1. **先判 scope 是否完全无 work**：当前 scope 无 active/reserved/queued work → 幂等回复「当前没有需要停止的任务」，不启动 Agent、不 interrupt、不取消队列，持久标记 stop-added 已消费，结束。
  2. **仅当 scope 存在 current work**（active/reserved chain 或 pending sibling chain）时，才校验目标消息的 `workChainId` 关联（DD15）：目标映射到某 current chain → 关联通过；目标只属 historical chain、映射已过期、或重启后无法恢复关联 → fail closed（不 interrupt、不取消队列，回复该 Reaction 未停止当前任务、如需停止可使用 `/stop`，持久标记 stop-added 已消费，结束）。
  3. 关联通过后立即执行控制动作 = `activeRuns.interrupt(scope)`（中断 active/reserved run）+ `pending.cancel(scope)`（取消该 scope 尚未开始的全部普通消息与 Reaction input unit，含 sibling queued unit，防止旧队列自动重启；与现有 `/stop` 复合语义一致，见 DD17）+ 流式卡片/文本收敛为 interrupted 终态（不复用成功终态），持久标记 stop-added 已消费。stop 本身不启动新 Agent run、不生成「是否真的停止」模型确认；interrupt 收敛后由 Bridge 回复可见停止结果。
  - `workChainId` 关联**不再**作为前置 gate，而是 step 2 在「scope 有 current work」分支内执行；该分支不得覆盖 step 1 的无 work 幂等回复。
- **removed**：先通过 self-operator、路由、own-message、权限门禁（**不**要求 chain 此刻仍 current）；据同 operator/target/emoji 的 stop-added ledger 只回复一次「撤回停止 Reaction 不会自动恢复工作」，持久标记 stop-removed 已消费；不撤销 interrupt、不恢复队列、不启动 Agent；无匹配 stop-added 记录 → 静默 no-op。
- added/removed 都优先用 reaction/event 可用稳定 ID 生成防重 fingerprint；缺稳定 ID 时用规范化事件字段 + action time。重复投递/乱序/重启后已消费事件 = 静默 no-op。
- 权限判断与当前 scope `/stop` 一致；`workChainId` 只在「scope 有 current work」分支内用于防历史/无关目标误触发，**不**把 `/stop` 改造成局部取消。

### DD17 — stop 控制面复用现有 `/stop` 复合语义（interrupt + pending.cancel）

**事实（已复核 `src/bot/channel.ts:1304-1331`）**：`handleStop`（`commands/index.ts:1567-1590`）本体只调 `activeRuns.interrupt(scope)`；但其调用方 `intakeMessage` 对 `tryHandleCommand` 返回 `handled=true` 的所有命令统一执行 `pending.cancel(scope)` 再 `return`。`/stop` 是被识别命令（`handled=true`），故当前 `/stop` 实际效果已是 `interrupt(scope)` + `pending.cancel(scope)`：中断 active run、丢弃 scope 已排队消息，`unblock` 后无 pending 条目即不会重启旧队列。

**Plan 裁定**：stop Reaction 控制面**复用/抽取**现有 `/stop` 的「interrupt + 命令后 pending.cancel」复合语义——即 stop 控制面直接调用 `activeRuns.interrupt(scope)` + `pending.cancel(scope)`（`pending-queue.ts:49-55`），效果与当前 `/stop` **一致**，**不**比 `/stop` 更严格，**无需**另开 `/stop` 对齐改动。`/stop` 本身不在本 Spec 修改范围（Spec 明示「不把 `/stop` 改造成局部取消」）。原 B1 基于只读 `handleStop` 本体、未追 `intakeMessage` 调用方的误判，已撤回（见 Known Issues）。

### DD18 — 全部有效 Reaction 的可见回复契约

- 每个通过权限并最终被消费的最新 Reaction 状态都必须有一条可见回复，并引用自己的目标消息；多个目标分别回复，不能用一条回复含混覆盖。重复/乱序 no-op 不是新有效状态，不重复回复。
- no-op（fingerprint 不变）→ 不回复（DD7 净零例外除外）。
- reconciliation 失败 → 整个 buffer 只回复一次「请重试」（DD7）。
- terminal 后 removed → Bridge 回复撤回已收到（DD14）。
- stop 场景各结果的可见 Bridge 回复见 DD16。
- 普通语义由 Agent 回复；控制/撤回场景由 Bridge 确定性简短反馈；「没有新 Agent turn」不等价「没有回复」。

### DD19 — 故障隔离与回滚

- 普通 IM、显式引用、topic context、交互卡片、评论 prompt 结构保持兼容；无 Reaction 时不输出 `<reaction_contexts>`。
- Reaction 路由元数据读取、`messageReaction.list` 分页、ledger 读写、目标正文规范化失败都**不**导致整个 Bridge 队列崩溃；日志记目标消息 ID、失败阶段、trace，不记凭据/无界原文。
- 回滚：可停止输出 `<reaction_contexts>` 并恢复现有合成消息行为；但 Reaction 权限门禁、self-operator guard、路由过滤、飞书回复引用关系**不**随之回退。

### DD20 — 测试策略（RED 先行，两路确定性 + live 对照）

- 每个 Execution Unit 先写失败测试（RED），再实现至绿。
- 自动化至少覆盖 Spec「Acceptance Criteria」表与 §Next Phase 列举的全部项（见覆盖矩阵）。
- Claude 与 Codex 两路都必须通过确定性结构/注入测试；随后各用当前 profile 配置的一个真实模型完成同一组 live-model 对照，记录 Agent 类型、实际模型标识、时间；任一路径未执行不得宣称全量完成。
- live oracle 见 Spec §Acceptance Criteria（隔离可逆带唯一标记的测试动作 X）。

## Execution Units

> 顺序即建议实施顺序；每 Unit 先 RED 再实现。Owner 默认 小C。`- [ ]` 为完成条件，全部勾选 + 通过对应测试方可视为完成。Unit 间依赖见各 Unit「Depends」。

### Unit 1 — 预埋语义表 + 未映射透传（RED 先行）  Owner: 小C

- [x] `src/bot/reaction/semantics.ts`：版本化映射表，11 个 `emojiType` 精确映射（case-sensitive），`emojiMeaningSource` 区分 `predefined`/`unmapped`，未映射完整透传（保留 `emojiType` + 可用 glyph/label）。
- [x] RED：`tests/unit/bot/reaction-semantics.test.ts` 断言 **严格 11 个**精确映射（case-sensitive）、`Get` **不在** v1 表且 `emojiMeaningSource='unmapped'` 完整透传（不得被提升为预埋 alias/不得新增为第 12 个）、未映射不丢弃、表 `schemaVersion` 存在。
- Depends: 无。
- Spec 覆盖：§Confirmed Predefined Semantics；Acceptance「真实 emojiType=Get 不在 v1 表(unmapped)」「未预埋但可理解」「未预埋且不透明」「OK/LGTM/Yes/CheckMark/JIAYI」「WHAT/THINKING」「DONE」「No/CrossMark/MinusOne」映射行。

### Unit 2 — Self-operator guard + 权限/群响应门禁复用（RED 先行）  Owner: 小C

- [x] `pipeline.ts`：self-operator guard（`evt.operator.openId` vs `botIdentity.openId`/`cfg.accounts.app.id`/`evt.raw.operator_type==='app'`），先于一切副作用，静默丢弃。
- [x] 复用 `canUseDm`/`canUseGroup`（operator openId）+ `decideGroupResponse({mentionedBot:false,mentionCount:0,mentionAll:false,...})`；失败静默拒绝；**不**复用 `shouldBypassDeniedChatForInviteGroup`。
- [x] RED：`tests/unit/bot/reaction-guards.test.ts` 覆盖 self-operator（含 `Typing` 回环）静默丢弃、未过 `canUseDm`/`canUseGroup` 静默拒绝、四种群响应模式同值矩阵（与同 operator 无 @ 普通消息结果一致）、`/invite group` 旁路不被复用。
- Depends: Unit 1（语义映射在 stop 路径前置，但 guard 本身不依赖；可并行起步）。
- Spec 覆盖：§Permission Contract；Acceptance「operator 未通过 canUseDm/canUseGroup」「mention-only」「owner-default/allowlist/all-messages」「两名 operator 同语义」「Bot/app Typing self-operator」「未授权停止 Reaction」。

### Unit 3 — Reaction ledger + buffer + 全分页 reconciliation + revision + 净零/重试/重启（RED 先行）  Owner: 小C

- [x] `ledger.ts`：持久 ledger（`scope+operatorOpenId+targetMessageId` → record IDs/fingerprint/actionTime/consumed fingerprint），镜像 `prompt-binding-ledger.ts`（`writeFileAtomic`、RMW 队列、revision、`schemaVersion`、`profileDir`）。
- [x] `buffer.ts`：同 key 事件短时 buffer（quiet window + 最大等待，按 action time 再按到达顺序）。
- [ ] `reconciler.ts`：`messageReaction.list` 全分页（`user_id_type=open_id`，循环 `page_token`/`has_more`），重建 `effectiveReactionSet`（剔除 self-app），构建有序 `triggerReactions[]`（按 action time+到达顺序），计算 canonical fingerprint（DD6）与净变化 vs ledger、revision、净零 added→removed 例外、list 落后有限重试、scope 缩权 fail closed。
- [ ] RED：`tests/unit/bot/reaction-reconciler.test.ts` + `tests/integration/bot/reaction-ledger.test.ts` 覆盖：全分页 reconciliation、list 越过中间状态的 added→removed 净零例外（不报失败/不递增 revision/不启动 Agent/只回复一次）、ledger 重启恢复（不重放旧 Reaction）、重复/乱序/无状态变化 no-op、list 暂时落后重试与最终失败单回复、`im:message.reactions:read` 缩权/读取失败 fail closed；**canonical fingerprint**（稳定字段 `operator_type+operator_id+emoji_type`、去重、确定性排序）跨页/API 返回顺序打乱不产生新 revision；**`triggerReactions[]` 有序**（按 action time+到达顺序）：Agent 启动前快速新增两个不同 Reaction → 单 input unit `triggerReactions` 含两个 added、`effectiveReactionSet` 含最终完整集合、不漏不重放；同一 buffer 一增一减且最终集合非空 → `triggerReactions` 保留 added/removed 有序变化、`effectiveReactionSet` 表达最终集合、只按该 revision 处理一次。
- Depends: Unit 1、Unit 2。
- Spec 覆盖：§Agent Input Contract 2（buffer/list/ledger/revision/no-op/例外）；Acceptance「重复投递 no-op」「乱序到达」「快速 added→removed list 已回空」「重启后新事件」「list 落后」「缩权/读取失败」。

### Unit 4 — 目标消息上下文 + `<reaction_contexts>` 注入 + `source='reaction'`（RED 先行）  Owner: 小C

- [x] `context-builder.ts`：用 `fetchQuotedContext` 复用规范化（文本/富文本/卡片/合并转发），两级失败处理（路由成功正文失败 → `available:false`+messageId；路由/sender 失败 → 丢弃）。
- [x] `src/agent/prompt.ts`：`BridgePromptSource += 'reaction'`；`BuildAgentPromptInput += reactionContexts?`；新增 `promptSection('reaction_contexts', …)`（`safeJsonStringify`）；`bridge_context.source='reaction'`；`user_input` 保留简短兼容摘要但标注 reaction_contexts 为权威；目标消息不被 batch messageIds 去重。
- [ ] RED：`tests/unit/agent/prompt-reaction-contexts.test.ts` 覆盖：`<reaction_contexts>` 含全字段且 `triggerReactions[]`+`effectiveReactionSet` 同时存在（含两个 added、一增一减场景的有序 `triggerReactions`）、伪造 Bridge/XML 标签不注入、目标 ID 与 batch messageIds 重叠不被去重、`available:false` 表达、无 Reaction 时不输出该块、`source='reaction'`；**wiring 测试** `context-builder → fetchQuotedContext → reaction_contexts` 对交互卡片真实卡片内容与合并转发 `<forwarded_messages>` 真实内容的端到端传播（非占位符）。
- Depends: Unit 3。
- Spec 覆盖：§Agent Input Contract 2（结构化上下文/安全序列化/不去重/available）；Acceptance「目标是交互卡片或合并转发」「路由成功正文失败 available=false」「无法取得路由/sender 丢弃」「目标正文含伪造标签」「approve_continue Reaction prompt 同时含 Reaction+完整目标消息」。

### Unit 5 — 共享 `BRIDGE_SYSTEM_PROMPT` `## Reaction` 段 + 两路注入（RED 先行）  Owner: 小C

- [x] `src/agent/bridge-system-prompt.ts`：加入 Spec「Bridge System Prompt Contract」`## Reaction` 段（9 条规则 + 预埋语义子节），行为语义不弱化。
- [x] 通过 `composeBridgeSystemPrompt` 经 Claude（`claude/adapter.ts:72-84`）与 Codex（`codex/adapter.ts:205-218`）两路注入；两路共享同一常量。
- [ ] RED：扩展 `tests/unit/agent/bridge-system-prompt.test.ts` + `tests/integration` Claude/Codex 注入 wiring 测试，断言两路均收到 Reaction 规则关键短语；段位于共享 prompt 而非群级/SOUL/user_input。
- Depends: 无（可与 Unit 1-4 并行）。
- Spec 覆盖：§Bridge System Prompt Contract；Acceptance「共享 Bridge System Prompt 构建」。

### Unit 6 — `workChainId` 存储/继承/登记/生命周期 + fail-closed 关联（RED 先行）  Owner: 小C

- [x] `work-chain.ts`：分配/继承（回复或 Reaction 指向已关联 Bot 消息时继承）/outbound message ID 登记/terminal 生命周期；current vs historical；停止目标 message ID → current chain 映射；重启失效 fail closed；受限日志。
- [x] pending unit / reservation / active run 携带 `workChainId`；outbound message ID 创建即登记。
- [x] RED：`tests/unit/bot/reaction-work-chain.test.ts` 覆盖：input/pending/reservation/active/outbound/terminal 全生命周期关联、目标确认消息被 Reaction 继续（继承 chain）、sibling queued unit、重启后未知关联 fail closed、historical chain 目标 fail closed、outbound 登记后可匹配 active chain；**有界边界（historical cache 语义）**：a) 同 scope >16 个 queued/current chains 均不被淘汰（current 不参与 LRU/cap），全部 terminal 后 historical 才收敛至 `MAX_CHAINS_PER_SCOPE=16`（LRU 裁剪最旧）；b) current chain 的 outbound mapping 超 30min 仍可 stop 关联（current 不参与 TTL），terminal 后转 historical、过 `HISTORICAL_CHAIN_TTL_MS` 才 fail closed；c) historical outbound→chain 映射超 `MAX_OUTBOUND_MAP_PER_SCOPE=256` 按 LRU 淘汰、被淘汰目标 stop fail closed；淘汰/过期后 chain 可被新普通消息重新开启。**不得**引入 pending admission/drop/backpressure。
- Depends: 无（可与前面并行；但 DD12/DD16 集成需它）。
- Spec 覆盖：§Stop Reaction Control Contract（workChainId 关联）；Acceptance「目标确认消息被 Reaction 继续」「sibling queued unit」「重启后未知关联 fail closed」「当前 run 已产生 Bot 输出，停止 Reaction 指向该输出」。

### Unit 7 — Reaction turn batch barrier + replyTo 目标 + 可见回复（RED 先行）  Owner: 小C

- [x] `PendingQueue` 扩展 barrier 条目（Reaction turn 独立 flush，不与普通消息合并，按到达顺序）；`pipeline` 产出 `ReactionTurn` 经此路径启动 run。
- [x] Reaction turn outbound `sendOpts.replyTo = targetMessageId`（topic 模式 `replyInThread` 不变）；每个被消费最新状态一条可见回复引用自己目标；多目标分别回复；no-op 不回复。
- [x] RED：`tests/integration/bot/reaction-batch-barrier.test.ts` 覆盖：Reaction 与普通文本同 debounce window 按到达顺序成不同 turn、普通文本不被归类为 Reaction、多目标按目标拆分且各回复引用自己目标、单个 Reaction 在普通群/私聊/话题回复正确引用且不出 thread、重复/乱序 no-op 不回复、所有被消费 Reaction 有可见回复。
- Depends: Unit 3、Unit 4、Unit 6。
- Spec 覆盖：§5 Batching/路由/回复；Acceptance「单 Reaction 普通群/私聊/话题」「与普通文本同 debounce window」「多 Reaction 不同目标」「其他 Bot/用户消息 Reaction 不启动」「按目标拆分 reply target」。

### Unit 8 — revision 失效/中断/替代 + superseded 流式回复 + terminal 后撤回（RED 先行）  Owner: 小C

- [x] Reaction run 记录 `operatorOpenId+targetMessageId+reactionRevision`（`ActiveRuns` 之外加 per-run 元数据或扩展 `RunHandle`）；同 key 新授权变化 → revision++、`activeRuns.interrupt(scope)`、替代 turn（空集则不启动 Agent + Bridge 撤回回复）；不同 operator/target 不打断。
- [x] `run-state.ts`：`Terminal += 'superseded'` + `markSuperseded`；渲染器输出「已被后续 Reaction 取代/已中断」、不显示成功终态；流式循环识别 superseded 停止写成功终态。
- [x] 旧 run 已产生 outbound reply → 更新为 superseded；未产生 → 不补发；只最新 revision 可成功收尾。
- [x] terminal 后 removed / 完成后移除最后一个 Reaction → 不重启 Agent、不回滚，Bridge 回复撤回已收到。
- [ ] RED：`tests/integration/bot/reaction-revision-superseded.test.ts` 覆盖：run 中移除一个 Reaction 集合仍非空（旧 revision 中断+替代不重放）、run 中新增第二个 Reaction（中断+按两 Reaction 快照处理一次）、run 中移除触发 Reaction（空集不启动替代+Bridge 撤回）、terminal 后移除（不重启+Bridge 回复）、旧 revision 未产生 reply 不补发、旧 revision 已产生流式 reply 更新为 superseded、完成后移除最后一个 Reaction、不同 operator/target 变化不打断。
- Depends: Unit 3、Unit 6、Unit 7。
- Spec 覆盖：§5 revision/superseded/terminal；Acceptance 对应行（queued/reserved/active 移除、terminal 后移除、旧 revision 未产生/已产生 reply、完成后移除最后一个、run 中新增/移除触发 Reaction、不同 operator/target 变化）。

### Unit 9 — `stop_current_work` 独立控制面（added/removed 独立 ledger + interrupt + cancel pending + 可见回复）（RED 先行）  Owner: 小C

- [x] `control-ledger.ts`：stop added/removed 独立持久 ledger（同 DD6 模式），防重 fingerprint（稳定 ID 优先，否则规范化字段 + action time）。
- [x] added：self-operator+路由+own-message+权限+语义+控制 ledger 防重后，**按序**：①先判 scope 完全无 active/reserved/queued work → 幂等回复「无任务」+ 标记 stop-added 已消费，结束；②仅 scope 有 current work 时校验目标→current `workChainId` 关联（DD15），历史/无关/未知 → fail closed 回复「未停止当前任务，可使用 /stop」+ 标记已消费，结束；③关联通过 → `activeRuns.interrupt(scope)` + `pending.cancel(scope)`（取消 scope 全部普通消息与 Reaction input unit 含 sibling）+ 流式收敛 interrupted 终态 + 标记 stop-added 已消费 + Bridge 可见停止结果；不启动 Agent、不生成模型确认。`workChainId` 关联不再前置。
- [x] removed：同门禁（不要求 chain 仍 current）+ 匹配 stop-added ledger + 防重 → 只回复一次「撤回不会自动恢复」+ 标记 stop-removed 已消费；无匹配 → 静默 no-op。
- [ ] RED：`tests/integration/bot/reaction-stop-control.test.ts` 覆盖：与 `/stop` 一致权限判断、`workChainId` 全生命周期关联、目标确认消息被 Reaction 继续、sibling queued unit、重启后未知关联 fail closed、added/removed 独立 ledger 重复投递与重启防重、active handle、run reservation/prompt preparation、scope pending 取消、**无任务幂等（scope 完全无 work 分支，单独测试）**、**scope 有 current work + 目标→current chain 关联通过 → interrupt（单独测试）**、**历史目标 + 另一 current chain → fail closed（单独测试）**、removed 不恢复、每种结果可见回复、interrupted UI 终态、stop 不产生新 Agent run、快速 added→removed（不相消）、removed 重复投递、stop-added 后重启再 removed。
- Depends: Unit 2、Unit 5、Unit 6、Unit 8。
- Spec 覆盖：§Stop Reaction Control Contract 全部；Acceptance 所有 stop 行（未授权停止、指向当前链路、指向历史/无关、已产生 Bot 输出、目标确认消息继续、sibling queued、重启 fail closed、无任务幂等、移除不恢复、快速 added→removed、removed 重复投递、stop-added 后重启再 removed）。

### Unit 10 — 接线：`channel.ts` reaction handler 委派 + 故障隔离  Owner: 小C

- [x] `channel.ts:934-992` 改为 `pipeline.handleReactionEvent(evt, deps)` 委派，移除合成 `NormalizedMessage` push；保留 self-message 路由前提与 `withTrace`。
- [x] 故障隔离：路由/list/ledger/规范化失败不崩 bridge 队列；受限日志（目标消息 ID、阶段、trace，不记凭据/无界原文）。
- [ ] RED：`tests/integration/bot/reaction-pipeline-wiring.test.ts` 覆盖端到端：事件 → guard → 门禁 → buffer → reconcile → turn → run → 可见回复；各类失败被隔离不影响普通消息队列。
- Depends: Unit 1-9。
- Spec 覆盖：§Compatibility, Failure And Rollback；Acceptance「其他发送者过滤」「无法取得路由/sender 丢弃」。

### Code Review Gate  Owner: 小P

- [x] 小P 对 Unit 1-10 实现 + 测试做 Code Review（Plan Writer 云上C总 不自审）。
- [x] DD17/B1 已澄清：当前 `/stop` 经 `intakeMessage`（`channel.ts:1304-1331`）已 `interrupt + pending.cancel`；stop 控制面复用该复合语义，不比 `/stop` 严格，无 `/stop` 对齐改动。
- [x] 确认未静默缩减 Spec 验收；覆盖矩阵全绿。

Progress update (2026-07-24): Code Review GO at `4855a97`; only Unit 11 is
released. Reviewer-tracked, non-blocking test-strength follow-ups remain open
in the unchecked RED items for Units 3/4/5/8/9/10: full mocked
`messageReaction.list` reconciliation, Claude/Codex adapter-boundary
injection, streaming-path superseded, stop UI terminal convergence, and
card/merged-forward reaction-context propagation.

Progress update (2026-07-24): B9 R6-R8 was implemented by 小P after takeover
and reviewed by an independent SubAgent. R6 review found five lifecycle and
invariant gaps; R7 closed them, and R8 closed the remaining pre-reservation
replacement race. Final review of `5c2682d..67b43d8` is `GO`. Full automated
verification at `67b43d8`: typecheck 0, build success, 1292 pass / 33 skip /
0 fail, worktree clean, and `git diff --check` clean. Code Review Gate is
closed; this GO releases deployment and Unit 11 only, not live completion.

### Unit 11 — 自动化全量 + live-model 对照验收（两路）  Owner: 小P（接管闭环）

- [x] 自动化：Spec §Acceptance Criteria 与 §Next Phase 列举的全部确定性场景在 Claude 与 Codex 两路通过结构/注入测试。
- [ ] live-model：隔离可逆带唯一标记测试动作 X，按 Spec oracle 覆盖 4 个预埋 `semanticKey` 各一个代表 emoji + 一次未预埋 + 一次 removed；停止场景证明 interrupt 发生在旧 run 完成之前且无后继 Agent run 自动启动。
- [ ] 每条验收保存：实际动态 prompt、共享 System Prompt 版本（DD10）、工具调用、可观察副作用、最终回复、飞书消息 ID；记录 Agent 类型、实际模型标识、时间。
- [ ] 核对 UI 引用、Agent 输入、System Prompt、工具副作用、最终行为一致。
- Depends: Code Review Gate 通过。
- Spec 覆盖：§Acceptance Criteria live oracle 全部。

Progress update (2026-07-24): Unit 11 automated evidence was returned at
`db8822b`/`4855a97` (typecheck, build, 1207 pass / 33 skip). Live verification
is blocked before execution: both `codex` and `claude` daemons currently run
the global `0.5.9-qp.3` package at `/opt/homebrew/bin/lark-channel-bridge`,
whose installed source revision `ab13df7` does not contain the Reaction
implementation. Both Bot apps have independently passed a real
`im.reactions.list` scope probe. Await explicit authorization to back up and
replace the shared global package with the reviewed branch build, restart both
profiles, and retain a rollback artifact; no live case is counted as passed
before post-restart readback.

Progress update (2026-07-24): the live blocker is cleared with explicit
operator authorization. The previous global package is backed up under
`~/.lark-channel/backups/bridge-live-unit11-20260724-034625`; reviewed package
SHA-256 is `720859bbbae726cf289634f2c14bfa6ace56e2e5556e82517be2e4fa12019347`.
Post-restart readback confirms `claude` PID 85575 and `codex` PID 86566 both
run through the global executable whose dist contains the reviewed Reaction
implementation. Unit 11 live cases may now begin; no case is pre-counted.

Progress update (2026-07-24): the first Codex `approve_continue` live case
failed on target `om_x100b69134b23e4a0c11813f9f6feeed`. The authoritative
`im.reactions.list` snapshot contained one human `JIAYI` record, but
`fetchAllReactions()` read nonexistent flat `operator_id` / `operator_type` /
`emoji_type` fields instead of the real nested `operator.*` and
`reaction_type.emoji_type` response. Three retries therefore misclassified
the valid snapshot as stale and replied “本次 Reaction 暂时无法确认，请重试”.
Unit 3 reconciliation and the coverage gate are reopened; Unit 11 is paused
until Fix, independent Code Review, rebuilt live install, and restart readback.

Progress update (2026-07-24): nested-response fix `2069bee` plus real
`reconcile()` coverage `cfc2242` passed independent review and was redeployed.
Codex live cases `approve_continue`, `explain_more`,
`user_step_completed`, and unmapped `Get` passed. Terminal removal then
failed on target `om_x100b691339de2ca0df9d5ca91c42890`: removing `Get`
correctly produced revision 2 with one `removed` trigger and an empty
`effectiveReactionSet`, but still started an Agent turn. Production
`channel.ts` unconditionally stores Reaction context, calls
`setReactionTurnMeta`, and `pending.pushBarrier` for every non-no-op
reconciliation result; it has no empty-set/terminal-removal Bridge branch.
The existing “post-terminal removal does not restart Agent” test only
asserts tracker state and comments what the pipeline should do, so it never
exercises this production seam. Unit 8, Unit 10 wiring coverage, and the Code
Review coverage gate are reopened. Unit 11 is paused before stop testing
until the fix has a production-wiring regression test, independent review,
redeploy, and live retry.

## Acceptance Coverage Matrix（Spec 验收行 → Unit）

| Spec 验收场景 | 覆盖 Unit |
| --- | --- |
| 共享 Bridge System Prompt 构建（Claude+Codex） | 5 |
| operator 未过 canUseDm/canUseGroup | 2 |
| mention-only / owner-default/allowlist/all-messages | 2 |
| 两名 operator 同 semanticKey | 2 |
| Bot/app Typing self-operator | 2 |
| 重复投递 no-op | 3 |
| 乱序到达 | 3 |
| fingerprint 跨页/返回顺序打乱不产生 revision | 3 |
| 快速 added→removed list 已回空（净零） | 3 |
| 重启后新事件 | 3 |
| list 落后 / 缩权 fail closed | 3 |
| 未授权停止 Reaction | 2、9 |
| 真实 emojiType=Get 不在 v1 表(unmapped 透传) | 1 |
| 未预埋可理解 / 未预埋不透明 | 1 |
| OK/LGTM/Yes/CheckMark/JIAYI；WHAT/THINKING；DONE | 1 |
| No/CrossMark/MinusOne 指向当前链路 | 9 |
| stop 指向历史/无关 fail closed | 6、9 |
| 当前 run 已产生输出，stop 指向该输出 | 6、9 |
| approve_continue 启动新 run 后 stop 仍指确认消息 | 6、9 |
| stop 指向 current chain + sibling queued | 9 |
| 重启后旧 Bot 消息 stop → fail closed | 6、9 |
| workChainId historical TTL/LRU 淘汰 → fail closed（current 不参与） | 6 |
| 同 scope >16 current chains 不淘汰，terminal 后 historical 收敛至 cap | 6 |
| current outbound mapping 超30min 仍可 stop，terminal 后过 TTL 才 fail closed | 6 |
| historical outbound map >256 按 LRU 淘汰 | 6 |
| stop added 顺序：scope 完全无 work → 无任务（分支单独测试） | 9 |
| stop added：scope 有 current work + 目标→current chain → interrupt | 9 |
| stop added：历史目标 + 另一 current chain → fail closed | 9 |
| stop 无任务幂等 | 9 |
| 移除 stop 不恢复 | 9 |
| stop 快速 added→removed | 9 |
| stop removed 重复投递 | 9 |
| stop-added 后重启再 removed | 9 |
| approve_continue 对「是否继续 X」执行一次 X | 4、8、11 |
| 对「X 已完成」点相同 Reaction 不重复 X | 8、11 |
| 否定/拒绝类 Reaction | 11 |
| run 中移除（集合非空）替代 | 8 |
| run 中新增第二个 Reaction | 8 |
| run 中移除触发 Reaction（空集） | 8 |
| terminal 后移除 | 8 |
| 旧 revision 未产生 reply 不补发 | 8 |
| 旧 revision 已产生流式 reply → superseded | 8 |
| 完成后移除最后一个 Reaction | 8 |
| 不同 operator/target 变化不打断 | 8 |
| context-builder→fetchQuotedContext→reaction_contexts 卡片/合并转发真实内容 wiring | 4 |
| 路由成功正文失败 available=false | 4 |
| 无法取得路由/sender 丢弃 | 4、10 |
| 其他 Bot/用户消息 Reaction 不启动 | 2、10 |
| 单 Reaction 普通群/私聊/话题 | 7 |
| 与普通文本同 debounce window | 7 |
| 多目标拆分 | 7 |
| 同 key 启动前 added→removed 相消 | 3、8 |
| Agent 启动前快速新增两个不同 Reaction（triggerReactions 有序+最终集合） | 3、4 |
| 同 buffer 一增一减且最终非空（triggerReactions 保留+最终集合） | 3、4 |
| 目标正文含伪造标签 | 4 |

Spec §Acceptance Criteria 末段「自动化测试至少覆盖……」清单与 live oracle 由 Unit 1-11 + Code Review Gate + 覆盖矩阵共同保证；任一项缺失不得宣称完成。

## Verification Commands

```bash
# 类型/构建
pnpm install
pnpm -s typecheck   # 或仓库既有 typecheck 脚本（见 package.json）
pnpm -s build

# 单测 + 集成（Reaction 相关）
pnpm -s test -- tests/unit/bot/reaction-semantics.test.ts
pnpm -s test -- tests/unit/bot/reaction-guards.test.ts
pnpm -s test -- tests/unit/bot/reaction-reconciler.test.ts
pnpm -s test -- tests/unit/bot/reaction-work-chain.test.ts
pnpm -s test -- tests/unit/agent/prompt-reaction-contexts.test.ts
pnpm -s test -- tests/unit/agent/bridge-system-prompt.test.ts
pnpm -s test -- tests/integration/bot/reaction-ledger.test.ts
pnpm -s test -- tests/integration/bot/reaction-batch-barrier.test.ts
pnpm -s test -- tests/integration/bot/reaction-revision-superseded.test.ts
pnpm -s test -- tests/integration/bot/reaction-stop-control.test.ts
pnpm -s test -- tests/integration/bot/reaction-pipeline-wiring.test.ts

# 全量回归
pnpm -s test

# live-model（两路，需当前 profile 真实模型 + im:message.reactions:read）
# 按 Unit 11 oracle 执行并归档 prompt/systemPrompt 版本/工具调用/副作用/回复/飞书消息 ID
```

> 实际脚本名以 `package.json` 既有 `typecheck`/`build`/`test` 为准；小C 执行前先对齐脚本名，不得新增未约定的脚本。

## Rollback

- 停止输出 `<reaction_contexts>` 并恢复 `channel.ts:934-992` 现有「合成 `[reaction-…]` 文本入队」行为。
- **不得**回退：Reaction 权限门禁（DD3）、self-operator guard（DD2）、路由/own-message 过滤、飞书回复引用关系（`replyTo` 目标消息）。
- ledger/控制 ledger/workChainId 存储可保留（惰性失效）或删除 profile 下对应文件；删除前确认无其它依赖。

## Resolved Decisions（不推迟实现）

- **RD1**：新增 `src/bot/reaction/` 子目录承载入站 Reaction 流水线，替换合成文本入队（DD1）。
- **RD2**：权限/群响应门禁复用 `canUseDm`/`canUseGroup`/`decideGroupResponse`（`mentionedBot=false` 等），不复用 `/invite group` 旁路（DD3）。
- **RD3**：权威快照走 `messageReaction.list` 全分页，event 仅作 trigger；revision 仅在 fingerprint 变化时递增（DD5）。
- **RD4**：ledger/控制 ledger 镜像 `prompt-binding-ledger.ts` 模式（DD6/DD16）。
- **RD5**：Reaction 为 batch barrier，`PendingQueue` 扩展 barrier 条目（DD11）。
- **RD6**：superseded 新增 `Terminal`（DD13）。
- **RD7**：`workChainId` 有界运行期元数据，重启 fail closed，不交给模型（DD15）。
- **RD8**：stop 控制面复用现有 `/stop` 复合语义 = `interrupt(scope)` + `pending.cancel(scope)`（`channel.ts:1304-1331`）；效果与 `/stop` 一致，不比其严格，`/stop` 不改，无需另开对齐改动（DD16/DD17）。原 B1 撤回。

## Known Issues / Blockers

- **B1（已撤回，原误判）**：原结论「当前 `/stop` 不取消 pending queue」基于只读 `handleStop`（`commands/index.ts:1567-1590`）本体、未追调用方。经复核 `src/bot/channel.ts:1304-1331`，`intakeMessage` 对所有 `tryHandleCommand` 返回 `handled=true` 的命令统一 `pending.cancel(scope)`，`/stop` 已含取消 pending。故 stop 控制面复用该复合语义即可，不比 `/stop` 严格，无需 `/stop` 对齐改动（见 DD17/RD8）。
- **B2（实现注意）**：`operator_type`（`'app'`/`'user'`）被 SDK `normalizeReaction` 丢弃，self-operator guard 的「operator 是当前 app」判定需解析 `evt.raw`（`includeRawEvent:true` 已开）。
- **B3（live 验收前置）**：`messageReaction.list` 需 Bot 身份具 `im:message.reactions:read` scope；若当前 app 未授权，live 验收前需补授权（非代码阻塞）。
- **B4（实现注意）**：`ReactionEvent` 无稳定 event_id；stop 控制 ledger 与普通 ledger 防重 fingerprint 优先用 `evt.raw.header.event_id`（若可达），否则用规范化字段 + action time（Spec §Stop 已允许）。
- **B5（实现注意）**：`NormalizedMessage` 为 vendored SDK 类型不易扩展；Reaction turn 经 `PendingQueue` barrier 条目携带 `ReactionTurn` 而非扩展 `NormalizedMessage`（DD11），`<reaction_contexts>` 数据经侧信道 plumbed 到 `buildAgentPrompt`。
- **B6（实现注意）**：`ActiveRuns` 仅按 scope 键，无 per-run (operator,target,revision,workChainId) 元数据；DD12/DD15 需在其外加 per-run 元数据注册或扩展 `RunHandle`，注意与现有 `interrupt`/`unregister` 生命周期一致。
- **B7（实现注意，第 3 版；v4 修订）**：DD15 的 `workChainId` 常量（`MAX_CHAINS_PER_SCOPE=16`、`MAX_OUTBOUND_MAP_PER_SCOPE=256`、`HISTORICAL_CHAIN_TTL_MS=1_800_000`）为 Plan 定义默认值，小C 实现时可同量级调整。**16/256 是 historical cache 上限，非总 Map 硬上限**；current chains 及其 outbound mappings 在 queued/reserved/active 期间不参与 TTL/LRU，仅 terminal 后进入 historical retention 并按 LRU/TTL 裁剪；不引入 pending admission/drop/backpressure。
- **B8（Unit 11 live blocker，已修复）**：普通 Reaction reconciliation 产生空 `effectiveReactionSet` 时，buffer flush 经 `decideReactionFlush` 走 `bridge-reply`(empty-set) 分支——Bridge 回复"已收到撤回"+interrupt(若有 active)+cancelPending+clearContext+deleteTurnMeta，**不 enqueue Agent**（channel.ts `executeReactionFlushDecision`）。terminal 后 removed 只由 Bridge 回复；in-flight/queued removal 经 `evictInFlightReactionEntry`(tri-state) 使旧 revision 失效；空集合不启动替代 turn；净零/重复投递遵守 DD7/DD14 防重。已由 B8 fix + 本轮 invariants 修复覆盖。
- **B9（invariants 修复，云上C总 Implementer，R4 — 待小P Review）**：R3 Review（8919bd2..738c6f5）BLOCKED 5 项（R3-F1..F5），R4 把 workChain/lifecycle token 从 messageId side-map 迁移到**真实 PendingUnit**：
  - R3-F1（lease on PendingUnit，替代 side-map）：`PendingQueue` 重写——`PendingUnit` 携带 `WorkLease{workChainId,unitId}`；`leaseHooks{acquire,release}` 在 unit 创建时 acquire、cancel 时 release、onFlush 时 transfer 给 run。`push` 仅同 workChainId 合并（不同 chain 拆 unit），`pushBarrier` 带 lease。`intakeMessage` 普通 REPLY（有 replyTo）传 workChainId（enqueue acquire），top-level（无 replyTo）无 lease（按旧方式合并，run start 分配 B1）。`runAgentBatch` 从 `deps.lease` 取 workChainId/unitId（不再 acquire，不再 consumeOrdinaryTurnMeta）。解决 batch 2..N 条 meta 泄漏。
  - R3-F2（evict/empty-set 释放旧 unit）：`cancelMessage`/`cancel` 现经 leaseHooks release 被移除 unit 的 lease——evict 的 cancelMessage、empty-set 的 cancelPendingForTarget 自动释放 rev1 unit（不再裸 deleteReactionTurnMeta）。`executeReactionFlushDecision` empty-set / `evictInFlightReactionEntry` queued 路径覆盖。
  - R3-F3（命令路径 cancel 释放）：`pending.cancel(scope)` 释放所有 unit lease（queue 内置）；`intakeMessage` handled=true 的 `pending.cancel` 同样释放。stop Reaction 分支保留 releaseEnqueuedTurn 清 reaction meta/tracker。
  - R3-F4（startFlow throw 释放）：onFlush 的 `invokeFlush` catch 释放 lease；`runAgentBatch` `!flow.ok` 释放 `deps.lease` + 清 reaction meta/tracker。
  - R3-F5（测试+Plan）：B4 acquireUnit/releaseUnit per-unit sibling 测试 + hasActiveOrReserved + isLatest 已存。typecheck=0、reaction+runtime+executor 364/364。完整 lease-on-PendingUnit 端到端 production-seam 测试仍建议跟进。Plan B9 保持 OPEN。
- **B9 R5（云上C总 Implementer，待小P Review）**：R4 Review（738c6f5..041b300）BLOCKED 3 项，R5 修复：
  - B1（top-level 普通 unit 也带 lease，DD15）：`leaseHooks` 加 `allocate(scope, replyTo)`；`push(scope, msg, replyTo?)` 按 replyTo 合并（同 replyTo/top-level 合一 unit），新 unit 经 allocate 分配 chain+lease（per-unit 非 per-message）。`intakeMessage` 传 `emsg.replyToMessageId`（top-level 与 reply 都带 lease）。`runAgentBatch` 去 top-level B1 fallback（lease 覆盖）。
  - B2（async onFlush catch 释放 lease）：onFlush handler 的 catch 释放 `lease`（workChainStore.releaseUnit）+ `releaseEnqueuedTurn`（清 reaction meta/tracker），覆盖 chatMode resolve/startFlow/stream 异步 throw。
  - B3（命令 cancel / empty-set 清 reaction side-state）：`intakeMessage` handled cancel 对每个 dropped msg 调 `releaseEnqueuedTurn`；`executeReactionFlushDecision` empty-set 加 `unregisterTrackerForTarget` effect 清 tracker。统一 lease（queue）+ reaction side-state（releaseEnqueuedTurn）释放。
  - 死 side-map 清理：移除 `_ordinaryTurnMeta`/`setOrdinaryTurnMeta`/`consumeOrdinaryTurnMeta`；`releaseEnqueuedTurn` 简化为 reaction-only（ordinary lifecycle 完全在 PendingUnit lease）。typecheck=0、reaction+runtime+executor 364/364。
- **B9 R6（小P接管实现，待最终 Review/Unit 11）**：R5 Review 发现共享调用方与测试 gate 未闭合，R6 收敛为单一消息契约：
  - `PendingQueue.push(scope, msg)` 直接读取 `msg.replyToMessageId`，不再要求调用方并行传递 target；top-level 同 debounce unit 共用新 chain，显式回复按实际 resolved `workChainId` 合并，同 chain 的不同 Bot outbound target 不再被误拆成串行 unit。
  - Card callback synthetic message 写入 `replyToMessageId=evt.messageId`，点击继续承载卡片的原 workChain，不再分配无关 top-level chain。
  - `releaseEnqueuedTurn` 与 `releaseFlushedTurnAfterError` 统一清理 context/meta/tracker/lease；命令取消、empty-set queued、chatMode/startFlow 前后异常均不会留下无界 context 或 stale tracker。
  - 新增真实 lease/cleanup production-seam 测试：top-level acquire+merge+cancel release、同 chain 不同 target 合并、不同 chain 拆分、flush ownership transfer、command-style cancel、empty-set queued、async flush failure、Card callback chain target 继承。
- **B9 R7（独立 SubAgent Review BLOCKED 后修复；R7 复审发现 1 项 replacement race，转 R8）**：
  - empty-set 对 exact key 的 queued/reserved/active 全部视为 in-flight；仍在队列则只精确取消，已跨过 queue→prompt-prep 边界则写 turn tombstone，并在 `runAgentBatch` 入口及 `startRunFlow` 前消费释放；reservation/active 路径同时经 `ActiveRuns.interrupt` 收敛，空集合不再启动无上下文 Agent turn。
  - 相同未知 `replyTo` 先按 target 快路径合并，不再用有分配副作用的 `resolveOrAllocate` 作 merge probe；不同 target 仍按真实 inherited chain 合并或拆分。
  - `runAgentBatch` 从 consume Reaction meta 后即进入统一 terminal try/catch；`executePendingFlushWithCleanup` 覆盖 queue→trace/run 的同步与异步异常，均清 lease/context/meta/tracker。
  - historical chain 重新 current 时同步移除其 outbound IDs 的 historical LRU 资格；prune 再防御性跳过 current chain，保证 DD15 current mappings 永不受 historical TTL/cap 淘汰。
  - 新增 reserved/prompt-prep empty-set、同步 handoff throw、相同未知 reply target、reactivated-current outbound cap 回归测试。
- **B9 R8（独立 SubAgent 最终复审 GO）**：同 key 新 revision 的 `evictInFlightReactionEntry` 与 empty-set 共用 queue→reservation tombstone 约束；旧 barrier 已 flush、`ActiveRuns` 尚未 reserve 时，rev2 为 rev1 turnId 写 invalidation，rev1 在 run 入口/submit 前释放，不能以 ordinary synthetic Reaction 继续启动。新增 rev1-flushed/pre-reserve→rev2 replacement production-seam 回归测试。独立复审 `5c2682d..67b43d8` 确认 exact old turnId 被精准失效、rev2 不受影响，且 R7 的 5 项修复维持闭合；结论 `GO`，Code Review Gate 关闭，进入部署与 Unit 11 live。

## Plan Review Gate  Owner: 小P

- [x] 小P 确认本 Plan 覆盖 Spec 全部必做单元（权限/self-operator 门禁、buffer/权威快照/ledger/revision、动态 Reaction 上下文、共享 System Prompt、可见回复、stop 控制面）。
- [x] 小P 复审第 3 版 6 项 finding 是否逐项解决：①Get unmapped（v1 仍 11，示例 JIAYI）；②triggerReactions[] 有序+两场景测试；③stop added 顺序（无 work→无任务；有 current work→关联）；④canonical fingerprint 稳定字段/去重/确定性排序+跨页不产生 revision；⑤卡片/合并转发 wiring 测试；⑥workChainId TTL/容量/淘汰+边界测试。
- [x] DD17/B1 已澄清：`/stop` 经 `intakeMessage`（`channel.ts:1304-1331`）已 `interrupt + pending.cancel`；stop 控制面复用该语义，不比 `/stop` 严格，无 `/stop` 对齐改动。
- [x] 确认未静默缩减 Spec 验收，覆盖矩阵完整。
- [x] GO 后交 小C 实施；Plan Review 前不修改运行代码。
