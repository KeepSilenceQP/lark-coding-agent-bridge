# Correct Reaction Handling By Bridge Agents — Delta Spec

Date: 2026-07-24
Status: confirmed; independent review PASS

## Recommendation

本需求的目标是让大模型正确处理用户的 Reaction，而不只是让 Reaction 事件进入 Agent。修复必须同时包含两个不可分割的交付：

1. Bridge 把需要模型解释的 Reaction 事件及其所回应消息的完整、可读上下文确定性地提供给 Agent。
2. 共享 Bridge System Prompt 明确要求 Agent 结合“目标消息内容 + Reaction 动作 + Reaction 语义”判断用户意图，并据此执行、拒绝、澄清或仅确认。

只完成任意一项都不算修复完成：只有 System Prompt 而没有目标消息，模型无从正确理解；只有消息入站而没有处理规则，模型仍可能把点赞、拒绝或撤回误当成普通文本。`stop_current_work` 和无需模型重新判断的撤回反馈是明确例外，由 Bridge 控制面确定性处理，不为了满足入站形式而额外启动 Agent。

Reaction 语义采用双层模型：用户确认的常用语义作为预埋规则直接提供给模型；未预埋的 Reaction 也必须完整透传，由模型结合目标消息和会话上下文自行分析。预埋规则是高置信快捷知识，不是 Reaction 白名单。

UI 继续引用被 Reaction 的原消息，现有“只处理当前 Bot 自己消息上的 Reaction”路由不变。

所有通过现有消息权限门禁、并被 Bridge 消费的有效 Reaction 都必须产生一条用户可见的回复。普通语义由 Agent 回复；需要立即抢占或无需重新唤起 Agent 的控制/撤回场景由 Bridge 给出确定性简短反馈，不能以“没有新 Agent turn”等价于“没有回复”。

## Goal And Completion Definition

完成标准不是“Bridge 收到了 Reaction”、也不是“飞书 UI 显示了引用”，而是以下三点同时成立：

- 每个需要模型解释的 Reaction，Agent 实际输入中同时存在 Reaction 事实和它所回应的完整目标消息。
- Agent 的共享 System Prompt 明确规定如何组合解释这两部分信息。
- 行为验收证明：同一个 Reaction 作用于不同目标消息时，Agent 会根据目标消息语义产生不同且正确的处理结果，而不是机械映射 emoji 或重复执行上一任务。

## Problem And Boundary

当前 Reaction handler 已读取目标消息来解析 `chatId`、话题范围和消息发送者，并把事件排入正常消息队列，但 Agent 实际只收到类似：

```text
[reaction-added] Get (on msg d36aa5e4)
```

`bridge_context.messageIds` 中虽然有完整目标消息 ID，目标消息正文却没有进入 prompt。UI 上显示引用，是因为 Bridge 把同一个目标消息 ID 用作回复的 `replyTo`；这是输出展示关系，不代表 Agent 已看到目标消息。

当前共享 Bridge System Prompt 也没有 Reaction 专属规则，因此即使模型从会话历史中偶然猜到目标，仍没有稳定契约要求它以目标消息和 Reaction 的组合语义为准。

当前 Reaction handler 在完成 own-message 过滤后会直接进入 pending queue，没有经过普通消息的 `canUseDm` / `canUseGroup` 与 `decideGroupResponse` 门禁；因此权限复用也是本修复的必要组成部分，而不是额外优化。

本需求只修复 Reaction 的访问门禁、Agent 上下文和大模型处理规则，不改变飞书事件订阅与平台 scope、普通消息/评论/卡片回调路由、既有群响应策略本身、会话隔离或回复 UI。

## Agent Input Contract

### 1. Reaction 成为明确的入站来源

- 纯 Reaction turn 在 `bridge_context.source` 中标记为 `reaction`，不得继续伪装成用户输入的一条普通 IM 文本。
- `bridge_context.senderId` 继续表示 Reaction 操作者；`chatId`、`chatType`、`threadId` 和 `botOpenId` 沿用现有定义。
- System Prompt 是否应用 Reaction 规则，以本轮是否存在 `<reaction_contexts>` 为准，不依赖 batch 级 `source` 猜测。

### 2. 注入结构化 Reaction 上下文

动态 prompt 新增 `<reaction_contexts>` JSON 数组。每项表示“同一操作者 + 同一目标消息”的一个当前快照，至少包含：

```json
{
  "operatorOpenId": "ou_xxx",
  "reactionRevision": 7,
  "triggerReactions": [
    {
      "action": "added",
      "emojiType": "JIAYI",
      "emojiDisplay": "+1",
      "emojiMeaning": "同意模型提出的意见或下一步，继续执行",
      "semanticKey": "approve_continue",
      "emojiMeaningSource": "predefined",
      "actionTime": 1784810000000
    }
  ],
  "effectiveReactionSet": [
    {
      "emojiType": "JIAYI",
      "emojiDisplay": "+1",
      "emojiMeaning": "同意模型提出的意见或下一步，继续执行",
      "semanticKey": "approve_continue",
      "emojiMeaningSource": "predefined"
    }
  ],
  "targetMessage": {
    "available": true,
    "messageId": "om_xxx",
    "senderId": "cli_xxx",
    "senderName": "小P",
    "createdAt": "2026-07-23T13:00:00.000Z",
    "rawContentType": "text",
    "content": "是否按这个方案继续执行？"
  }
}
```

- `triggerReactions` 是有序数组，表示本次 buffer 中尚未消费、并共同导致当前 revision 的一个或多个添加/移除事件；按 action time、再按到达顺序排列。`effectiveReactionSet` 表示 reconciliation 后，该操作者在该目标消息上仍然有效的完整 Reaction 集合。两者必须同时提供：事件 delta 用来识别用户刚刚做了什么，权威快照用来判断现在仍有哪些 Reaction；模型不能把集合中早已处理且仍保留的 Reaction 再执行一次。
- WebSocket Reaction event 只作为 reconciliation trigger，不是当前集合的权威来源。完成 self-operator、路由、own-message 和权限门禁后，Bridge 必须通过飞书 Reaction list API（当前仓库 SDK 调用面为 `rawClient.im.v1.messageReaction.list`）全量分页读取目标消息，指定 `user_id_type=open_id`，再按 `operator_type + operator_id` 重建该 operator 的 `effectiveReactionSet`。实现所用 Bot 身份必须具备 `im:message.reactions:read`。
- Bridge 必须持久记录每个 `scope + operatorOpenId + targetMessageId` 最近一次已确认的 Reaction record IDs、集合 fingerprint、最新 action time 和已消费 fingerprint；重启后先加载该 ledger，再处理新事件。集合 fingerprint 必须先对相关记录按稳定字段规范化、去重和确定性排序，不能因分页或 API 返回顺序变化而产生新 revision。首次没有历史 ledger 时，以本次真实事件为 delta、以 list 结果为当前上下文建立 baseline，不能仅因 reconciliation 看见旧 Reaction 就重放它们。
- 除 `stop_current_work` 的 added/removed 独立控制事件路径外，同一 key 的事件先进入有最大等待上限的短时 buffer，按 action time、再按到达顺序排列；quiet window 或最大等待到达后只做一次全分页 reconciliation。实现以“buffer 开始前的持久 ledger snapshot → list 返回的最新权威 snapshot”的净变化决定 revision 和 Agent 行为，不要求飞书 list 暴露已经消失的中间状态。
- 权威 snapshot fingerprint 与 ledger 相同时通常是 no-op：不递增 revision、不启动或中断 Agent、不执行控制动作，也不回复。唯一例外是 buffer 中存在尚未消费、顺序明确的同 emoji `added → removed` 对，而 list 已经直接越过中间状态回到原 fingerprint；此时把该事件对消费为一次撤回确认，不递增 reaction revision、不启动 Agent，并只由 Bridge 回复一次。事件对 fingerprint 必须写入 ledger，重复投递或重启后重放不能再次回复。
- 若 buffer reconciliation 时 list 尚未反映最新净变化，允许有限重试；仍不能取得与 buffer 事件相容的权威状态时，不猜测、不改变 ledger，并针对整个 buffer 只可见回复一次“本次 Reaction 暂时无法确认，请重试”，不能逐事件重复报错。
- `reactionRevision` 只在同一 key 的权威 snapshot fingerprint 真正变化时单调递增，用于判断正在运行的 Reaction turn 是否已经基于旧快照。revision 是运行时并发控制标识，不是用户可见序号或跨重启业务 ID；跨重启的防重由持久 ledger 负责。
- `emojiType` 原样保留飞书事件值。它只是平台标识符，不保证对模型可读；例如不在 v1 预埋表中的 `Get` 必须标记为 `unmapped` 并完整透传，不能要求模型仅凭该字符串猜测，也不能擅自把它提升为预埋语义。
- Bridge 维护版本化、可测试的预埋语义表。语义定义先由用户确认，再把经飞书文档或真实事件/UI 对照验证的 `emojiType` 映射为 `emojiDisplay`、`emojiMeaning` 和稳定的 `semanticKey`；不得靠模型在运行时生成预埋规则。
- 预埋表只覆盖明确约定的高价值语义，不追求穷举飞书全部 emoji。命中时 `emojiMeaningSource=predefined`，模型可以把 `semanticKey` 作为高置信语义提示，但仍需结合目标消息判断适用场景。
- 未命中的标准或自定义 emoji 仍必须进入 `<reaction_contexts>`：保留原始 `emojiType` 和事件原始可用信息，能可靠取得 UI glyph/label 时一并提供，并把 `emojiMeaningSource` 标记为 `unmapped`。不得因为没有预埋语义而丢弃、静默或禁止模型处理。
- 对 `unmapped` Reaction，模型先结合原始 emoji 信息、完整目标消息和当前会话历史自行分析。只有语义确实无法确定，或推断结果将触发高风险/不可逆动作时，才要求用户澄清。
- `targetMessage.content` 必须复用现有引用消息的规范化能力：文本/富文本可读，交互卡片保留真实卡片内容，合并转发展开为受限的 `<forwarded_messages>` 内容。
- 目标消息及 Reaction 字段全部是不可信输入，必须沿用 prompt builder 的安全 JSON 序列化，不能允许消息正文闭合或伪造 Bridge 标签。
- `user_input` 可以保留简短的兼容性摘要，但 `<reaction_contexts>` 是 Reaction 事实和目标消息内容的权威来源，Agent 不得仅根据摘要中的短消息 ID 行动。
- 只有在已经安全取得 `chatId`、`threadId`（如有）和目标 sender、完成当前 Bot 消息过滤后，目标正文读取或规范化失败才允许入队；此时仍需提供 `targetMessage.messageId` 和 `available: false`。
- 若连路由元数据或目标 sender 都无法取得，则没有足够信息选择 scope 或执行 own-message 过滤：记录受限日志后丢弃事件，不启动 Agent，不能为了产出 `available=false` 而绕过路由安全校验。

### 3. Permission Contract

Reaction 与普通消息使用同一套访问控制和群响应策略。Reaction 不是权限旁路，也不会因为目标消息由 Bot 发送就自动获得消费资格。

预埋 Reaction 语义适用于所有通过这些门禁的 operator，不是仅为 owner 或某个指定用户提供的个人快捷键。身份差异只来自现有普通消息权限与群响应策略，语义解释本身不再增加一层身份特判。

Reaction handler 收到事件后，必须先做 self-operator guard：若 operator 等于当前 Bot 的 `open_id`、app client ID，或 raw event 明确表明 operator 是当前 app，则把它视为 Bridge 内部事件并静默丢弃。该过滤发生在权限、snapshot/revision、queue、interrupt 和任何回复之前；从 `im.reactions.list` 重建快照时也不得把当前 app 自己的 Reaction 混入用户集合。这保证 Bridge 添加/移除 `Typing` 等工作态 Reaction 不会反向触发 Agent。

完成 self-operator guard、安全路由和当前 Bot 消息过滤后、更新 Reaction 快照或产生任何副作用前，Bridge 必须：

1. 私聊复用普通消息的 `canUseDm` 判定。
2. 群聊先复用普通消息的 `canUseGroup` 判定，校验 operator 是否能在该群使用当前 Bot。
3. 通过访问控制后，再复用 `decideGroupResponse`。Reaction 自身不携带结构化 @，因此固定按 `mentionedBot=false`、`mentionCount=0`、`mentionAll=false` 计算：
   - `mention-only`：Reaction 不被消费；
   - `owner-default`：只有满足现有 owner 免 @ 条件的 operator 才能消费；
   - `owner-allowlist`：还必须命中当前群名单；
   - `all-messages`：通过前置访问控制的 operator 可以消费。
4. Reaction 不得复用 `/invite group` 的 denied-chat 命令特例；它不是管理命令。

任一权限门禁失败时必须静默拒绝：不更新 Reaction revision/快照、不进入 pending queue、不启动 Agent、不调用 stop/interrupt、不取消已有队列，也不发送非授权提示。日志只记录受限的 scope、operator 后缀和拒绝 reason。

`stop_current_work` 也必须先通过完全相同的门禁，才允许进入控制面。未经授权的 `No`、`CrossMark` 或 `MinusOne` 不能停止其他人的任务。

### 4. Confirmed Predefined Semantics

以下 v1 语义由用户确认。`emojiType` 大小写敏感，取自飞书当前 Reaction emoji 列表；UI 名称仅用于人类核对，运行时以 `emojiType` 为准。

| `semanticKey` | 用户约定语义 | 飞书 UI Reaction | `emojiType` | 目标行为 |
| --- | --- | --- | --- | --- |
| `approve_continue` | 同意模型提出的意见或下一步，继续执行 | OK、我看行、Yes、勾号、+1 | `OK`、`LGTM`、`Yes`、`CheckMark`、`JIAYI` | 等价于 operator 对该目标消息文字回复“同意继续”；按普通消息收到这句话时的同一上下文、授权和确认规则继续 |
| `explain_more` | 没有理解模型在说什么，希望继续展开介绍 | 什么？、思考 | `WHAT`、`THINKING` | 暂不假定用户已理解，也不把它当成继续执行授权；围绕目标消息补充背景、推理、例子或更清晰的解释 |
| `user_step_completed` | 用户已经完成模型要求其手动完成的事情，可以继续 | 完成 | `DONE` | 把目标消息中的用户侧前置步骤视为已完成；从该等待点继续后续流程，不重复要求用户完成同一件事 |
| `stop_current_work` | 用户认为模型当前方向不对，希望立即停止，语义类似 `/stop` | No、叉号、-1 | `No`、`CrossMark`、`MinusOne` | 由 Bridge 控制面立即请求中断当前 scope，并取消尚未开始的排队工作；不能等待模型下一轮才决定是否停止 |

- `approve_continue` 与文字回复“同意继续”具有完全相同的产品语义和授权强度：如果该文字回复在相同上下文中足以确认目标消息提出的动作，Reaction 也足以确认；如果该文字回复仍不足以通过权限、审批或工具确认门禁，Reaction 同样不足。它只同意目标消息中明确提出的内容，不授权目标消息没有说明的新动作。
- `explain_more` 的默认输出是解释目标消息，而不是重新执行目标任务。模型可以先定位用户可能没理解的部分，再分层展开。
- `user_step_completed` 是用户对其自身动作完成状态的声明。模型继续前可以做低成本、必要的结果核对，但不得无依据否定声明或让用户机械重复。
- 预埋语义仍需结合目标消息。若 Reaction 与目标内容明显不匹配，按普通上下文分析；不得仅凭 `semanticKey` 生造一项不存在的待办。

### 5. Batching、Revision、路由与回复关系

- 只有目标消息发送者等于当前 Bot 的 `open_id` 或 app client ID 时，Reaction 才能进入 Agent 队列；其他 Bot 或用户消息上的 Reaction 继续静默跳过。
- Reaction 是 pending queue 的 batch barrier，不与普通消息合并。普通消息与 Reaction 在同一 debounce window 或 active run 期间到达时，按到达顺序保留为不同 input unit。
- Reaction input unit 按 `scope + operatorOpenId + targetMessageId` 隔离。不同操作者或不同目标消息不得合并；每个 input unit 至多产生一个 Agent turn，并 `replyTo` 自己的目标消息。由 Bridge 确定性处理的控制/撤回状态不创建 Agent turn。话题消息继续留在原 `threadId`。
- 每个通过权限并最终被消费的最新 Reaction 状态都必须有一条可见回复，并引用自己的目标消息。多个目标仍分别回复，不能用一条回复含混覆盖。重复/乱序 no-op 不是新的有效状态，不重复回复。
- 同一 input unit 可以包含同一操作者对同一目标消息的多个不同 Reaction；交给模型的是最新 `effectiveReactionSet`，同时通过有序 `triggerReactions` 保留导致该 revision 的全部尚未消费变化。Agent 启动前快速新增两个不同 Reaction，或同一 buffer 内一增一减且最终集合非空时，不能丢失任一净变化。
- Reaction run 必须记录其 `operatorOpenId + targetMessageId + reactionRevision`。同一 operator/target 在 run 处理期间出现任何已授权的新增或移除时，revision 递增，旧 run 立即失效并被中断；不同 operator 或不同 target 的变化不影响当前 run，继续独立排队。
- 旧 run 收敛后只基于最新 revision 处理一次：最新 `effectiveReactionSet` 非空时启动一个替代 turn；若因移除已经变为空集，则不再启动 Agent turn，由 Bridge 回复已收到撤回，且不会执行旧语义。
- “是否仍在处理”只依据可观察生命周期判断：同 revision 仍处于 queued/reserved/active 时属于 in-flight；run 到达任意 terminal 后即视为已处理完成。terminal 后收到 `removed` 永不重新启动 Agent，只更新 ledger，并由 Bridge 确定性回复已收到撤回、已完成动作未被回滚。Bridge 不推测模型是否还存在未结构化的“待决定事项”。
- 中断只能阻止尚未发生的后续动作；旧 run 在 interrupt 前已完成的工具调用或外部副作用不会自动回滚。后续 turn 需要时应基于可观察事实说明已经完成的部分。
- 除 `stop_current_work` 外，同一 `operator + targetMessage + emojiType` 在 Agent 尚未启动前先 `added` 后 `removed`，两者相消，不启动无意义的 Agent turn；Bridge 对最终撤回状态给出一次简短可见回复。停止语义必须立即抢占，不能等待 debounce 判断是否相消；其 `removed` 也不恢复工作。
- revision 失效时，若旧 run 尚未创建任何 outbound reply，不再为该旧状态补发回复；若已经创建流式卡片或 Markdown 回复，保留同一消息并把 terminal 明确更新为“已被后续 Reaction 取代/已中断”，不得显示成功终态。最新 revision 另行产生自己的回复。连续多次变化可以留下多个明确标记为 superseded 的历史回复，但任一时刻只有最新 revision 可以完成为成功终态。
- 目标消息作为 Reaction 上下文注入时，不得因为其 ID 同时出现在 batch `messageIds` 中而被错误去重。

## Stop Reaction Control Contract

`stop_current_work` 的 added 和 removed 都不能依赖普通 Reaction → event buffer → pending queue → Agent run 链路。Bridge 为它们维护独立、持久的控制事件 ledger：

- 完成 self-operator、安全路由、own-message、权限门禁、语义映射和控制事件防重后，`action=added` 按以下顺序处理：若当前 scope 完全没有 active/reserved/queued work，直接幂等回复“当前没有需要停止的任务”；只有 scope 存在 current work 时，才校验目标消息的 `workChainId` 关联，关联通过后立即执行一次控制动作并持久标记 stop-added 已消费。它不等待普通 Reaction quiet window，也不能与紧随其后的 `removed` 相消。
- `action=removed` 仍先通过 self-operator、安全路由、own-message 和权限门禁，但不要求该 chain 此刻仍为 current；它根据同一 operator/target/emoji 的 stop-added ledger 只回复一次“撤回停止 Reaction 不会自动恢复工作”，随后持久标记 stop-removed 已消费。它不撤销 interrupt、不恢复队列、不启动 Agent；没有匹配 stop-added 记录时静默 no-op。
- added/removed 都优先使用 reaction/event 中可用的稳定 ID 生成防重 fingerprint；缺少稳定 ID 时使用规范化事件字段和 action time 生成。重复投递、乱序重放或 Bridge 重启后的已消费事件均为静默 no-op，不能重复中断或回复。

停止能力还必须校验目标消息与当前执行链路的关联，避免用户给历史消息添加否定 Reaction 时误停一个无关的新任务。关联使用 Bridge 内部的 `workChainId`，不交给模型推断：

- 每个新入站 input unit 分配 `workChainId`；显式回复或 Reaction 指向已有关联信息的 Bot 消息时继承该消息的 `workChainId`，无关联的新普通消息开启新 chain。
- pending unit、run reservation、active run 都携带 `workChainId`。Bot outbound message ID 一旦创建，立即登记为该 run 的 `workChainId`；发起当前 work 的 Bot 确认/方案消息也属于被继续的同一 chain。
- chain 只要仍有 queued/reserved/active work 就是 current；全部进入 terminal 后是 historical。后续有效回复或 Reaction 可以继承该 ID 重新继续此 chain，但在它重新产生 queued/reserved/active work 前不能停止另一个 current chain。
- 当前 scope 存在 active/reserved/queued work 时，停止 Reaction 的目标 message ID 必须映射到其中某个 current `workChainId`，才允许执行 stop 控制动作；active/reserved chain 或尚在 pending 的 sibling chain 都属于 current。目标只属于 historical chain、映射已过期，或 Bridge 重启后无法恢复关联时，一律 fail closed：不中断、不取消队列，并回复该 Reaction 未停止当前任务、如需停止可使用 `/stop`。该分支不得覆盖前述“scope 完全无 work”的幂等回复。
- `workChainId` 和 message correlation 是有界运行期控制元数据；Bridge 重启后旧关联可以整体失效，不根据会话文本猜测重建。每次 outbound 登记、chain lifecycle 变化和 fail-closed reason 都写受限结构化日志。

1. 权限判断与当前 scope 的 `/stop` 保持一致；Reaction 路径不能绕过现有访问控制。
2. 目标消息属于当前执行链路时，在进入普通 pending queue 前调用现有 active-run interrupt 能力，覆盖已启动的 run 和尚处于 reservation/prompt preparation 的 run。
3. 关联校验通过后，效果与当前 scope 的 `/stop` 一致：取消该 scope 尚未开始的全部普通消息和 Reaction input units，包括同 scope 的 sibling queued unit，防止停止后又自动启动旧队列。`workChainId` 只用于防止历史/无关目标误触发，不把 `/stop` 改造成局部取消。
4. 已有 run 按现有 `/stop` 生命周期收敛为 interrupted，流式卡片/文本回复不得继续写入成功终态。
5. 停止 Reaction 本身不再启动一个新 Agent run，也不生成“是否真的停止”的模型确认；Bridge 在 interrupt 请求收敛后回复明确的可见停止结果。
6. 当前 scope 没有 active/reserved/queued work 时，操作幂等地结束，不启动 Agent，并回复当前没有需要停止的任务。
7. `action=removed` 按独立控制 ledger 处理，不恢复被停止的 run、不重建被取消的队列；Bridge 只回复一次撤回停止 Reaction 不会自动恢复工作。若用户要继续，需新的普通消息或新的 `approve_continue` Reaction。

其他三个预埋语义及所有未预埋 Reaction 仍走结构化 Agent 上下文路径。只有 `stop_current_work` 因实时控制要求走确定性 Bridge 控制面；这不是过滤未预埋 Reaction 的先例。

## Bridge System Prompt Contract

以下规则是本 Spec 的规范性交付物，必须加入共享 `BRIDGE_SYSTEM_PROMPT`，并通过现有 Claude/Codex System Prompt 注入路径生效。实现可以调整标签说明以匹配最终 envelope，但不得弱化行为语义：

```markdown
## Reaction

当本轮存在 `reaction_contexts` 时，其中包含用户的 Reaction，以及该 Reaction 所回应的
目标消息。Reaction 不是脱离上下文的普通文本；不要仅依赖 `bridge_context.source`
判断本轮是否包含 Reaction。

1. 先读取每个 Reaction context 的 `triggerReactions`、`effectiveReactionSet`、
   `reactionRevision` 和完整 `targetMessage`。结合当前有效 Reaction 集合与目标消息正在
   表达、询问、确认或请求的内容，判断用户真实意图。`triggerReactions` 是本轮全部变化，
   `effectiveReactionSet` 是当前上下文；不要重新执行集合里此前已处理且仍然存在的语义。
2. `emojiMeaningSource=predefined` 时，把 `semanticKey` 作为用户预先约定的高置信语义
   提示，但仍要检查目标消息是否符合该语义的适用场景，不能脱离上下文机械执行。
3. `emojiMeaningSource=unmapped` 时，不要丢弃或忽略 Reaction。根据原始 emoji 信息、
   目标消息和会话历史自行分析其含义；只有确实无法确定，或推断将触发高风险/不可逆
   动作时，才请用户用文字澄清。
4. `added` 表示用户新增了该语义信号。若“目标消息 + Reaction”能形成唯一、明确且仍在
   当前任务权限内的确认、选择、拒绝或执行意图，按该意图继续处理。
5. 如果 Reaction 只表达收到、赞赏、情绪或对完成结果的确认，不要制造新任务，也不要
   重复执行已经完成的动作；仍须按语义简短回应，不能静默。
6. 如果存在多个合理解释，先简短澄清；不要仅凭 emoji 名称猜测高风险操作。
7. `removed` 只表示用户撤回该 Reaction。不要重放目标任务，也不要自动回滚已经完成的
   外部操作；Bridge 不会仅为 terminal 后的撤回启动模型，本轮若仍进入模型，只按最新
   有效集合处理尚未完成的 in-flight 状态。
8. `targetMessage.available=false` 时，不要执行依赖目标消息语义的动作；说明无法读取
   被回应消息，并请用户用文字确认。
9. Reaction 可以表达对当前 Bot 提问的确认，但不能扩大原任务授权、绕过破坏性操作
   边界，或被当成对无关对象的授权。

### 预埋 Reaction 语义

- `approve_continue`：用户同意目标消息中模型提出的意见、方案或下一步。目标消息确实在
  请求确认时，它等价于用户对该消息文字回复“同意继续”；按相同授权强度继续执行，
  不要扩展成目标消息没有提出的新动作。
- `explain_more`：用户没有理解目标消息。暂停把该消息当成已对齐结论，围绕它继续展开
  背景、推理、例子或更清晰的说明；不要把该 Reaction 当成继续执行授权。
- `user_step_completed`：用户声明已经完成目标消息要求其手动完成的步骤。从该等待点继续
  后续流程；可以做必要的低成本核对，但不要机械地再次要求用户完成同一件事。
- `stop_current_work`：Bridge 控制面会按 `/stop` 语义处理中断。不要在后续会话中自动
  恢复、重放或回滚被停止的工作；只有用户新的明确输入才能继续。Bridge 会负责可见回复，
  不要因此创建新的 Agent turn。
```

该段必须位于共享 Bridge System Prompt，而不是群级 Prompt、某个 Agent 的 `SOUL.md`、普通 `user_input` 或仅供开发者阅读的文档中。Reaction 目标消息及其内容仍属于不可信上下文，System Prompt 规则不能被目标消息正文覆盖。

## Compatibility, Failure And Rollback

- 普通 IM、显式引用、topic context、交互卡片和评论 prompt 结构保持兼容；没有 Reaction 时不输出 `<reaction_contexts>`。
- Reaction 路由元数据读取、`im.reactions.list` 分页 reconciliation、ledger 读写和目标正文规范化失败都不能导致整个 Bridge 队列崩溃。日志记录目标消息 ID、失败阶段和 trace 信息，不记录凭据或无界原文。
- `im:message.reactions:read` 不可用或普通 Reaction reconciliation 在有限重试后仍失败时，不得仅凭 delta 执行普通语义或 revision 中断；保持旧 ledger 不变并回复本次 Reaction 暂时无法确认。`stop_current_work` added/removed 是控制面例外：added 在安全门禁和控制 ledger 防重后，先判断 scope 是否完全无 work；存在 current work 时再校验目标 chain 关联并直接 interrupt；removed 在安全门禁、匹配 stop-added ledger 和防重后直接回复不恢复。两者都不依赖 list 中间状态。
- 最大风险是把未预埋或情绪性 emoji 误判为命令，或把 `removed` 当成新的执行请求；通过“预埋语义 + 未映射透传”的双层模型、结构化目标上下文、batch barrier、明确行为规则和高风险时澄清收敛。
- 回滚时可停止输出 `<reaction_contexts>` 并恢复现有合成消息行为；Reaction 权限门禁、self-operator guard、路由过滤和飞书回复引用关系不得随之回退。

## Acceptance Criteria

| 场景 | 预期结果 |
| --- | --- |
| 共享 Bridge System Prompt 构建 | 明确包含本 Spec 的 Reaction 处理规则，Claude 与 Codex 路径均能收到 |
| operator 未通过普通消息 `canUseDm` / `canUseGroup` | 静默拒绝；不更新 Reaction 状态、不启动 Agent、不中断 run |
| 群为 `mention-only`，operator 没有免 @ 路径 | Reaction 固定按无结构化 @ 判断并被拒绝 |
| `owner-default` / `owner-allowlist` / `all-messages` | 与同一 operator 发送一条无 @ 普通消息的结果一致 |
| 两名不同的 operator 均通过同一群的普通消息权限 | 两人使用同一个预埋 emoji 时得到相同 `semanticKey`；不因是否为 owner 改变语义 |
| 当前 Bot/app 添加或移除工作态 `Typing` Reaction | self-operator guard 静默丢弃；不读写用户 snapshot、不更新 revision、不排队、不回复 |
| 同一用户 Reaction 事件被重复投递 | `im.reactions.list` snapshot 与已消费 fingerprint 相同；判定 no-op，不递增 revision、不重复执行或回复 |
| added/removed 事件乱序到达 | 以全量分页后的当前 snapshot 和持久 ledger 为准；旧事件不得覆盖新状态或产生重复副作用 |
| 同一非停止 emoji 快速 added→removed，list 首次读取已直接返回原空集合 | buffer 识别尚未消费的有序事件对；不报 reconciliation 失败、不递增 revision、不启动 Agent，由 Bridge 只回复一次撤回确认 |
| Bridge 重启后收到新 Reaction 事件 | 先加载 ledger，再用 list reconciliation；只处理新事件对应的状态变化，不重放目标上已有 Reaction |
| `im.reactions.list` 暂时落后于事件 | 有限重试；最终无法确认时 ledger 不变、不启动/中断 Agent，并可见回复请用户重试 |
| `im:message.reactions:read` 缩权或分页读取失败 | fail closed；不得以单个 delta 伪造完整集合，并产生可见失败回复 |
| 未授权 operator 添加停止 Reaction | 不调用 interrupt、不取消 pending，不影响当前 run |
| 真实 `emojiType=Get` 不在 v1 预埋表 | envelope 原样保留 `Get` 并标记 `emojiMeaningSource=unmapped`；仍交给模型结合目标消息分析 |
| 未预埋但名称/glyph 可理解的 Reaction | `emojiMeaningSource=unmapped`；仍完整交给模型，模型结合目标消息正常分析并产生可见回复 |
| 未预埋且语义不透明的 Reaction | 仍完整交给模型；普通低风险语境允许上下文推断，高风险或确实无法判断时通过可见回复澄清 |
| `OK` / `LGTM` / `Yes` / `CheckMark` / `JIAYI` | 映射为 `approve_continue`；行为与对目标消息文字回复“同意继续”完全一致，且明确动作只执行一次 |
| `WHAT` / `THINKING` | 映射为 `explain_more`；围绕目标消息展开解释，不把 Reaction 当成执行授权 |
| `DONE` | 映射为 `user_step_completed`；从用户侧等待点继续，不重复要求同一步骤 |
| `No` / `CrossMark` / `MinusOne` 指向当前执行链路，且 scope 正在运行或准备运行 | 映射为 `stop_current_work`；在普通排队前触发与 `/stop` 等价的 interrupt，取消 pending，并由 Bridge 回复停止结果 |
| `stop_current_work` 指向历史/无关消息，同时当前 scope 有另一条执行链路 | fail closed；不 interrupt、不取消当前 pending，并可见回复未停止及 `/stop` 提示 |
| 当前 run 已产生 Bot 输出，停止 Reaction 指向该输出 | outbound message 与 active `workChainId` 匹配；允许 interrupt |
| `approve_continue` Reaction 由目标确认消息启动新 run，随后停止 Reaction 仍指向该确认消息 | Reaction run 继承目标的 `workChainId`；允许停止该 current chain |
| 停止 Reaction 指向 current chain，同时同 scope 另有 sibling queued unit | 关联校验通过后执行 scope 级 `/stop`；active/reserved work 和全部 scope pending 一并取消 |
| Bridge 重启后对旧 Bot 消息添加停止 Reaction | correlation 未知，fail closed；不停止新 run，回复使用 `/stop` |
| `stop_current_work` 到达时无 active/reserved/queued work | 幂等结束，不启动 Agent run，并可见回复当前没有需要停止的任务 |
| 用户移除 `stop_current_work` Reaction | 不恢复已中断 run，不重建已取消队列；可见回复撤回不会自动恢复 |
| `stop_current_work` 快速 added→removed | added 不进入普通 buffer 且立即触发一次控制动作；removed 不相消、不恢复，并产生对应可见反馈 |
| `stop_current_work removed` 被重复投递 | 控制 ledger 已标记 removed 消费；不重复回复、不恢复任务、不启动 Agent |
| Bridge 在 stop-added 后重启，再收到对应 removed | 从持久控制 ledger 找到 added；只回复一次不自动恢复并标记 removed 已消费 |
| 用户对 Bot 的“是否继续执行可逆测试动作 X？”点 `approve_continue` Reaction | Agent prompt 同时包含 Reaction 和完整目标消息；只执行一次 X |
| 用户对“X 已执行完成”的通知点相同 Reaction | 不调用执行工具，不重复 X，不虚构新的执行结果 |
| 用户添加否定或拒绝类 Reaction | 结合目标问题表达拒绝；存在歧义时澄清 |
| queued/reserved/active Reaction run 期间移除一个 Reaction，集合仍非空 | 旧 revision 中断；基于最新集合创建替代 turn，不重放已移除语义 |
| Reaction run 已 terminal，之后才移除 | 永不重新唤起 Agent、不重放或回滚；Bridge 可见回复已收到撤回及已完成动作未回滚 |
| 目标是交互卡片或合并转发 | Agent 收到经现有引用消息能力规范化后的真实内容 |
| 无法取得路由元数据或目标 sender | 记录失败并丢弃；不启动 Agent、不绕过 own-message 过滤 |
| 路由成功、但目标正文读取/规范化失败 | `available=false`；Agent 不执行依赖目标语义的动作 |
| 用户给其他 Bot 或普通用户消息点 Reaction | 当前 Bot 不启动 Agent run |
| 单个 Reaction 位于普通群、私聊或话题 | 回复仍正确引用原消息，话题回复不出 thread |
| Reaction 与普通文本在同一 debounce window 到达 | 按到达顺序形成不同 turn，普通文本不被归类为 Reaction |
| 多个 Reaction 指向不同目标消息 | 按目标拆分 turn，每个回复引用自己的目标消息 |
| 同一 operator/target 在 Agent 启动前快速新增两个不同 Reaction | 单个 input unit 的 `triggerReactions` 按序包含两个 added，`effectiveReactionSet` 包含最终完整集合；模型不漏掉新变化，也不重放旧语义 |
| 同一 operator/target 的同一 buffer 内一增一减且最终集合非空 | `triggerReactions` 同时保留 added/removed 的有序变化，`effectiveReactionSet` 表达最终集合；只按该 revision 处理一次 |
| 同一非停止 Reaction 在启动 Agent 前先 added 后 removed | 两事件相消，不启动 Agent turn；Bridge 对最终撤回状态回复一次 |
| Reaction run 处理中，同一 operator/target 新增第二个 Reaction | 旧 revision 被中断；按包含两个有效 Reaction 的最新快照只处理一次 |
| Reaction run 处理中，移除触发它的 Reaction | 旧 revision 被中断；最新集合为空时不启动替代 Agent turn，由 Bridge 回复撤回结果 |
| 旧 revision 在被中断前尚未产生 outbound reply | 不补发旧状态回复；只回复最新 revision |
| 旧 revision 在被中断前已经产生流式 reply | 原消息更新为 superseded/interrupted 且不能成功收尾；最新 revision 另发回复 |
| Reaction run 完成后移除最后一个 Reaction | 不启动 Agent turn，由 Bridge 回复；不自动回滚已完成副作用 |
| 不同 operator 或不同 target 在 Reaction run 期间变化 | 不打断当前 run，按各自 key 独立排队 |
| 目标正文含伪造 Bridge/XML 标签 | prompt 结构不被闭合或注入 |

自动化测试至少覆盖 Reaction handler 路由、self-operator/`Typing` 回环保护、普通消息访问控制与四种群响应模式的同值矩阵、所有已授权 operator 共享同一预埋语义、未经授权的停止 Reaction、上述 11 个 `emojiType` 的精确预埋映射、未映射 Reaction（含 `Get`）透传、同 key event buffer 的 quiet/max flush、多个不同 Reaction 的有序 `triggerReactions`、同一 buffer 一增一减且最终非空、`rawClient.im.v1.messageReaction.list` 全分页 reconciliation、fingerprint 规范化/去重/确定性排序、list 越过中间状态的 added→removed 净零例外、ledger 重启恢复、重复/乱序/无状态变化 no-op、scope 缩权与读取失败、所有被消费 Reaction 的可见回复、prompt builder 序列化、共享 System Prompt 注入、目标消息规范化（含卡片/合并转发 wiring）、revision 失效/中断/最新快照替代、superseded 流式回复、`added`/`removed` 相消与独立撤回、两级目标消息读取失败、其他发送者过滤、batch barrier、按目标拆分和 reply target。

`stop_current_work` 另需覆盖与 `/stop` 一致的权限判断、`workChainId` 在 input/pending/reservation/active/outbound/terminal 生命周期中的关联、目标确认消息被 Reaction 继续、同 scope sibling queued unit、重启后未知关联 fail closed、独立 added/removed 控制 ledger 的重复投递与重启防重、active handle、run reservation/prompt preparation、scope pending queue 取消、无任务幂等、removed 不恢复、每种结果的可见 Bridge 回复、interrupted UI 终态，以及“停止 Reaction 不产生新的 Agent run”。

Claude 和 Codex 两条 adapter 路径都必须通过确定性的结构/注入测试。随后各使用验收时当前 profile 配置的一个真实模型完成同一组 live-model 对照；记录 Agent 类型、实际模型标识和时间，任一路径未执行都不能宣称全量完成。

live-model 对照使用隔离、可逆且带唯一标记的测试动作 X，oracle 为：

- 对“是否继续执行 X？”的已知肯定 Reaction：结果必须与文字回复“同意继续”一致，允许执行一次 X；不允许零次或重复执行。
- 对“X 已执行完成”的相同 Reaction：不允许再次调用执行工具；允许简短确认。
- 对 `explain_more`：不允许继续执行 X；最终回复必须对目标消息作进一步说明。
- 对 `user_step_completed`：允许从等待点继续；不允许再次要求用户完成相同步骤。
- 对未预埋但可从低风险上下文理解的 Reaction：必须给出符合上下文的处理，不得仅因未映射而拒绝分析。
- 对未预埋且高风险歧义的 Reaction：不允许执行 X，必须澄清。
- 对 `available=false`：不允许执行 X，必须说明目标消息不可读。
- 对已经处理后的 `removed`：不允许重放 X 或自动回滚；必须有可见回复说明撤回已收到。

每条验收保存实际动态 prompt、共享 System Prompt 版本、工具调用、可观察副作用、最终回复和飞书消息 ID。实机至少覆盖四个预埋 `semanticKey` 各一个代表 emoji、一次未预埋 Reaction 和一次 removed，核对 UI 引用、Agent 输入、System Prompt、工具副作用与最终行为一致；停止场景还必须证明 interrupt 发生在旧 run 完成之前，且没有后继 Agent run 自动启动。

## Next Phase

本 Spec 确认后再编写 Coding Plan。Plan 必须把“权限与 self-operator 门禁”“Reaction event buffer/权威快照/持久 ledger/revision”“动态 Reaction 上下文”“共享 Bridge System Prompt 规则”“全部有效 Reaction 的可见回复”和“停止 Reaction 控制面”作为同一修复的必做单元，并覆盖普通消息权限函数复用、四种群响应模式、所有授权 operator 共用语义、11 个已确认 emoji 映射、未映射 Reaction 透传、`rawClient.im.v1.messageReaction.list` 全分页与 scope、净零 added→removed 例外、重复/乱序/重启幂等、in-flight revision 失效与替代、superseded 流式回复、terminal 后撤回的 Bridge 回复、Reaction 元数据在 pending batch 中的表示、目标消息规范化复用、`workChainId` 与停止目标关联、stop added/removed 独立控制 ledger 与快路径、现有 `/stop`/ActiveRuns/PendingQueue 能力复用、两种 Agent 的 Prompt 注入、模型行为对照验收及实机验收；Plan 评审通过前不修改运行代码。
