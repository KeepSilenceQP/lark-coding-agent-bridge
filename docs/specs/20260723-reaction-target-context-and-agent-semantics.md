# Correct Reaction Handling By Bridge Agents — Delta Spec

Date: 2026-07-24
Status: confirmed; `stop_current_work` trigger-message amendment independently reviewed PASS

Current amendment: 2026-10-23 profile-local runtime Reaction configuration.

> 本次修订优先于下文历史描述：emoji 对应的含义与行为以当前 profile 的
> `reaction-semantics.json` 为准，不再由代码或共享 System Prompt 固定。下文的 DONE、
> GoGoGo、No 及具体 `semanticKey` 只描述默认配置或历史验收场景，不是不可修改的协议。
> 旧文中的 10/11 项映射数量属于历史状态；当前首次生成 13 条默认规则，用户可增删。
> `user_step_completed` 是可配置的语义标识，默认不启用，不能再笼统称为禁止或退役。

当前配置契约：

- 文件为 `<profileDir>/reaction-semantics.json`，不存在时首次启动自动生成默认配置；
  profile 之间隔离。格式为 `schemaVersion: 1` 和全量 `rules` 映射，删除规则即变为
  `unmapped`，不会回填默认值；静默禁用应使用 `behavior=passive`。
- 规则包含 `behavior`（`agent` / `passive` / `stop` / `continue` / `restart`）、自由命名的
  `semanticKey`、当前权威解释 `emojiMeaning` 和可选 `emojiDisplay`。控制流只由
  `behavior` 决定；`semanticKey` 不是固定动作开关。
- 后续 Reaction 事件自动读取新配置，无需重启。待合并批使用一致的配置快照；已处理
  或执行中的任务不会仅因文件修改而重放、回滚或中断。运行期无效配置保留 last-good
  并告警；首次没有有效配置可用时启动报错，不覆盖已有无效文件。
- 动态上下文包含 `policyVersion` 与每项的 `behavior` / `emojiMeaning`。共享 Prompt
  版本为 `3.0.0`，只定义通用行为、上下文、权限、撤回和防重边界，不内置 emoji 或
  `semanticKey` 的固定释义。
- 配置不会扩大原有目标范围或授权：继续原任务仍要求操作者为原作者、且当前 Bot
  已处理并保留有效关联；停止和编辑后重跑仍由 Bridge 控制面校验；被动行为静默过滤。
- `behavior=restart` 仅由专用控制面处理；重跑能力未启用时静默过滤，不得落入普通
  Agent 路径。有效集合中保留的 restart 条目仍有配置的 behavior、meaning 和
  `predefined` 标记，但不代表新增重跑请求。

操作说明与手动步骤完成示例见 [Reaction 配置指南](../runbooks/reaction-semantics.md)。
以下 review history 记录较早的 stop 修订，不表示本次配置能力已通过同样的实机验收。

Amendment review history:

- R1 `76e6f02` BLOCKED：user-target eligibility/no-work 顺序、removed ledger bypass、
  PendingUnit 多 trigger、current mapping TTL/LRU 和 Reaction 无 @ 权限边界不完整。
- R2 `ab1fee0` BLOCKED：Compatibility/编号规则仍残留 no-work-before-eligibility；
  expired/restart-lost user target 的 silent 与 visible fail-closed 冲突。
- R3 `602bc7a` PASS/GO：上述冲突全部闭合；GO 仅代表 Spec，不代表 Plan、实现、部署或 live。

## Recommendation

本需求的目标是让大模型正确处理用户的 Reaction，而不只是让 Reaction 事件进入 Agent。修复必须同时包含两个不可分割的交付：

1. Bridge 把需要模型解释的 Reaction 事件及其所回应消息的完整、可读上下文确定性地提供给 Agent。
2. 共享 Bridge System Prompt 明确要求 Agent 结合“目标消息内容 + Reaction 动作 + Reaction 语义”判断用户意图，并据此执行、拒绝、澄清或仅确认。

只完成任意一项都不算修复完成：只有 System Prompt 而没有目标消息，模型无从正确理解；只有消息入站而没有处理规则，模型仍可能把点赞、拒绝或撤回误当成普通文本。`stop_current_work` 和无需模型重新判断的撤回反馈是明确例外，由 Bridge 控制面确定性处理，不为了满足入站形式而额外启动 Agent。

需要处理的 Reaction 语义采用双层模型：用户确认的常用语义作为预埋规则直接提供给模型；未预埋的 Reaction 也必须完整透传，由模型结合目标消息和会话上下文自行分析。预埋规则是高置信快捷知识，不是 Reaction 白名单。配置为 `passive` 的静默标记按下节契约在 Bridge 中排除，不属于这两层模型输入；默认是 `DONE`。

UI 继续引用被 Reaction 的原消息。普通语义仍只处理当前 Bot 自己消息上的 Reaction；
`stop_current_work` 是控制面例外：除了当前 chain 中可添加 Reaction 的 Bot 消息外，也
允许作用于**触发当前 queued/reserved/active work 的入站用户消息**。这是流式卡片在更新
期间不能添加 Reaction、但用户仍需在任务完成前表达 stop 的必要入口。

### 原消息续执行（2026-10-22 引入，2026-10-23 改为配置）

用户对自己发出、且本进程已登记为当前 Bot inbound trigger 的原消息添加
`behavior=continue` 的 Reaction（默认 `GoGoGo`），
表示明确请求继续原任务，包括已被 No 停止的任务。这是普通 Reaction 的窄例外；下文
“用户消息上的非停止 Reaction 被过滤”的约束均保留本节例外。其他用户的消息、其他
Bot 的消息、未登记原消息，以及用户消息上的 `DONE` 等其他非停止表情继续被过滤。

该路径复用现有权限、权威快照、持久 ledger、revision、队列和会话 resume；继承原
workChain，确保后续 No 仍可作用于原消息。旧 No 可以保留在有效集合中，但不是新的
停止事件。GoGoGo 的重复投递不重复启动；撤回 GoGoGo 后即使集合仍有 No，也只确认
撤回、清理对应的待执行/进行中 Reaction，不新建 Agent turn、不回滚已完成动作。
Agent 从已完成位置继续，不扩大原任务授权。默认 GoGoGo 现作为配置映射携带
`predefined`、`behavior=continue` 和当前 `emojiMeaning`；共享 System Prompt 只规定
通用 continue 边界，不绑定 GoGoGo 名称。

inbound trigger 的关联沿用现有内存、TTL 和容量限制：重启、历史记录过期或被逐出后
不能仅凭原消息 GoGoGo 重建关联，此时应发送新的普通消息继续。

### 静默标记（2026-10-22 引入，2026-10-23 改为配置）

默认配置将飞书 UI 的 [完成]（精确 `emojiType=DONE`）设为 `behavior=passive`，用于
“已处理”标记。各 profile 可修改此映射；以下 DONE 场景仅在保留默认配置时适用，
其他配置为 passive 的 emoji 具有同样的静默处理规则。被动行为适用于各操作者、私聊/
普通群/话题及用户或 Bot 消息，不依赖 workChain 登记或目标内容。

- Bridge 在事件入口直接忽略 DONE 的 added/removed，不读取目标消息或 Reaction list，
  不入 buffer/queue，不写消费 ledger/revision，不启动或中断 Agent，也不发送任何回复。
- 全分页快照同样排除 DONE：它不能进入 `effectiveReactionSet`、`triggerReactions`、
  canonical fingerprint、动态 Reaction 上下文或触发文本；与其他表情同时存在时，只处理
  其他表情的变化。共享 System Prompt 只保留通用 passive 边界，不再绑定 DONE。
- DONE 的增删不影响已有普通输入或 Reaction 的 queued/reserved/active 生命周期。
  同一消息保留 DONE 时撤回最后一个主动 Reaction，仍按空的有效集合处理。
- 旧版 ledger 只保存 fingerprint 等元数据，不保存可供过滤的完整 Reaction 记录。
  reconciliation 用当前主动记录加 DONE 重算旧版 fingerprint；只有持久 current 与
  consumed fingerprint 都精确匹配时，才归一化为不含 DONE 的 fingerprint，保持 revision
  不变且不重放已消费语义。真实主动集合变化仍按正常规则产生新 revision。
- 标记的存储和展示由飞书原生 Reaction 提供，不额外建立话题状态库；不关闭话题、不停止
  或恢复任务，也不宣称整个任务已经完成。其他群成员可看到该 Reaction。
- 默认 DONE 不表达手动步骤完成。需要该快捷含义时，可按配置指南将其他 emoji
  配置为 `agent` 并填写 `user_step_completed` 及完整含义，或继续使用文字回复；
  配置文件可以改变 DONE 自身的行为与含义。

下文关于未映射透传、全部有效 Reaction 可见回复、撤回确认及 revision 中断的要求，
均只针对排除 passive 后的主动 Reaction。默认 DONE 是配置过的被动标记，不是
未映射 Reaction，也不产生撤回确认；删除 DONE 配置后则按 unmapped 处理。

所有通过现有消息权限门禁、并被 Bridge 消费的主动 Reaction 都必须产生一条用户可见的回复。普通语义由 Agent 回复；需要立即抢占或无需重新唤起 Agent 的控制/撤回场景由 Bridge 给出确定性简短反馈，不能以“没有新 Agent turn”等价于“没有回复”。

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

live 验收确认：流式卡片在持续更新期间无法由用户添加 Reaction，更新完成后才可添加。
因此“对正在输出的卡片添加 `No`”不能作为 active-run stop 的唯一入口。Bridge 必须把
触发当前 input unit 的入站消息 ID 纳入 `workChainId` correlation，使用户可在原始 trigger
消息上添加停止 Reaction；这不要求改变飞书卡片能力，也不把普通用户消息上的其他
Reaction 交给 Agent。

本需求只修复 Reaction 的访问门禁、Agent 上下文、大模型处理规则和停止控制关联，不改变飞书事件订阅与平台 scope、普通消息/评论/卡片回调路由、既有群响应策略本身、会话隔离或回复 UI。

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
  "policyVersion": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "triggerReactions": [
    {
      "action": "added",
      "emojiType": "JIAYI",
      "behavior": "agent",
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
      "behavior": "agent",
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
    "senderName": "Coordinator Bot",
    "createdAt": "2026-07-23T13:00:00.000Z",
    "rawContentType": "text",
    "content": "是否按这个方案继续执行？"
  }
}
```

- `triggerReactions` 是有序数组，表示本次 buffer 中尚未消费、并共同导致当前 revision 的一个或多个添加/移除事件；按 action time、再按到达顺序排列。`effectiveReactionSet` 表示 reconciliation 后，该操作者在该目标消息上仍然有效、且已排除 passive 的完整主动 Reaction 集合。两者必须同时提供：事件 delta 用来识别用户刚刚做了什么，权威快照用来判断现在仍有哪些主动 Reaction；模型不能把集合中早已处理且仍保留的 Reaction 再执行一次。
- 对需要模型解释的普通 Reaction，WebSocket event 只作为 reconciliation trigger，不是当前集合的权威来源。完成 self-operator、路由、own-message 和权限门禁后，Bridge 必须通过飞书 Reaction list API（当前仓库 SDK 调用面为 `rawClient.im.v1.messageReaction.list`）全量分页读取目标消息，指定 `user_id_type=open_id`，再按 `operator_type + operator_id` 重建该 operator 的 `effectiveReactionSet`。实现所用 Bot 身份必须具备 `im:message.reactions:read`。`stop_current_work` 仍按独立控制事件路径处理，不因新增 user-trigger 目标而进入普通 snapshot/revision 流程。
- Bridge 必须持久记录每个 `scope + operatorOpenId + targetMessageId` 最近一次已确认的 Reaction record IDs、集合 fingerprint、最新 action time 和已消费 fingerprint；重启后先加载该 ledger，再处理新事件。集合 fingerprint 必须先对相关记录按稳定字段规范化、去重和确定性排序，不能因分页或 API 返回顺序变化而产生新 revision。首次没有历史 ledger 时，以本次真实事件为 delta、以 list 结果为当前上下文建立 baseline，不能仅因 reconciliation 看见旧 Reaction 就重放它们。
- 除 `stop_current_work` 的 added/removed 独立控制事件路径外，同一 key 的事件先进入有最大等待上限的短时 buffer，按 action time、再按到达顺序排列；quiet window 或最大等待到达后只做一次全分页 reconciliation。实现以“buffer 开始前的持久 ledger snapshot → list 返回的最新权威 snapshot”的净变化决定 revision 和 Agent 行为，不要求飞书 list 暴露已经消失的中间状态。
- 权威 snapshot fingerprint 与 ledger 相同时通常是 no-op：不递增 revision、不启动或中断 Agent、不执行控制动作，也不回复。唯一例外是 buffer 中存在尚未消费、顺序明确的同 emoji `added → removed` 对，而 list 已经直接越过中间状态回到原 fingerprint；此时把该事件对消费为一次撤回确认，不递增 reaction revision、不启动 Agent，并只由 Bridge 回复一次。事件对 fingerprint 必须写入 ledger，重复投递或重启后重放不能再次回复。
- 若 buffer reconciliation 时 list 尚未反映最新净变化，允许有限重试；仍不能取得与 buffer 事件相容的权威状态时，不猜测、不改变 ledger，并针对整个 buffer 只可见回复一次“本次 Reaction 暂时无法确认，请重试”，不能逐事件重复报错。
- `reactionRevision` 只在同一 key 的权威 snapshot fingerprint 真正变化时单调递增，用于判断正在运行的 Reaction turn 是否已经基于旧快照。revision 是运行时并发控制标识，不是用户可见序号或跨重启业务 ID；跨重启的防重由持久 ledger 负责。
- `emojiType` 原样保留飞书事件值。它只是平台标识符，不保证对模型可读；例如不在 v1 预埋表中的 `Get` 必须标记为 `unmapped` 并完整透传，不能要求模型仅凭该字符串猜测，也不能擅自把它提升为预埋语义。
- Bridge 从当前 profile 文件读取版本化、可测试的配置映射，将精确 `emojiType` 映射为 `behavior`、`emojiDisplay`、`emojiMeaning` 和自由命名的 `semanticKey`。`policyVersion` 标识所用配置快照；不得靠模型在运行时生成配置规则。
- 预埋表只覆盖明确约定的高价值语义，不追求穷举飞书全部 emoji。命中时 `emojiMeaningSource=predefined`，模型以当前 `emojiMeaning` 为权威解释，`semanticKey` 仅是标识；仍需结合目标消息判断适用场景。
- 除配置为 passive 的静默标记外，未命中的标准或自定义 emoji 仍必须进入 `<reaction_contexts>`：保留原始 `emojiType` 和事件原始可用信息，能可靠取得 UI glyph/label 时一并提供，并把 `emojiMeaningSource` 标记为 `unmapped`。不得因为没有预埋语义而丢弃、静默或禁止模型处理。
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

完成 self-operator guard 和安全路由后，普通语义继续先做当前 Bot 消息过滤。
`stop_current_work added` 仅在目标是本进程已登记的 inbound trigger 时可绕过该过滤；
`removed` 仅在持久 control ledger 存在匹配的已消费 added 时可绕过。两者都不能绕过下面
的 Reaction 权限门禁；added 还必须通过 chain-correlation 校验。更新 Reaction 快照或产生
任何副作用前，Bridge 必须：

1. 私聊复用普通消息的 `canUseDm` 判定。
2. 群聊先复用普通消息的 `canUseGroup` 判定，校验 operator 是否能在该群使用当前 Bot。
3. 通过访问控制后，再复用 `decideGroupResponse`。Reaction 自身不携带结构化 @，因此固定按 `mentionedBot=false`、`mentionCount=0`、`mentionAll=false` 计算：
   - `mention-only`：Reaction 不被消费；
   - `owner-default`：只有满足现有 owner 免 @ 条件的 operator 才能消费；
   - `owner-allowlist`：还必须命中当前群名单；
   - `all-messages`：通过前置访问控制的 operator 可以消费。
4. Reaction 不得复用 `/invite group` 的 denied-chat 命令特例；它不是管理命令。

任一权限门禁失败时必须静默拒绝：不更新 Reaction revision/快照、不进入 pending queue、不启动 Agent、不调用 stop/interrupt、不取消已有队列，也不发送非授权提示。日志只记录受限的 scope、operator 后缀和拒绝 reason。

`stop_current_work` 也必须先通过完全相同的 Reaction 门禁，才允许进入控制面。未经授权的
`No`、`CrossMark` 或 `MinusOne` 不能停止其他人的任务。目标消息的 sender 只用于安全路由
和 workChain correlation，不额外授予 stop 权限。停止后的**效果**与 `/stop` 相同，但权限
不是“能发送带 @ 的 `/stop` 就能消费 Reaction”：Reaction 仍固定按
`mentionedBot=false` 的 `decideGroupResponse` 计算，只允许能发送等价无 @ 普通输入的
operator 消费，不得复用命令特例或结构化 @ 资格旁路。

### 4. Default Configured Semantics

以下是首次生成文件的默认配置，不限制用户增删或重新命名语义。共 13 个 emoji type：
12 条非 passive 规则（7 个 agent、3 个 stop、各 1 个 continue/restart），另有 1 个
passive 标记。`emojiType` 大小写敏感；
UI 名称仅用于人类核对。下表前 3 行保留历史默认意图，后 3 行补齐控制与被动行为。

| `semanticKey` | 用户约定语义 | 飞书 UI Reaction | `emojiType` | 目标行为 |
| --- | --- | --- | --- | --- |
| `approve_continue` | 同意模型提出的意见或下一步，继续执行 | OK、我看行、Yes、勾号、+1 | `OK`、`LGTM`、`Yes`、`CheckMark`、`JIAYI` | 等价于 operator 对该目标消息文字回复“同意继续”；按普通消息收到这句话时的同一上下文、授权和确认规则继续 |
| `explain_more` | 没有理解模型在说什么，希望继续展开介绍 | 什么？、思考 | `WHAT`、`THINKING` | 暂不假定用户已理解，也不把它当成继续执行授权；围绕目标消息补充背景、推理、例子或更清晰的解释 |
| `stop_current_work` | 用户认为模型当前方向不对，希望立即停止，语义类似 `/stop` | No、叉号、-1 | `No`、`CrossMark`、`MinusOne` | 由 Bridge 控制面立即请求中断当前 scope，并取消尚未开始的排队工作；不能等待模型下一轮才决定是否停止 |
| `handled_marker` | 标记已处理 | 完成 | `DONE` | `behavior=passive`，静默排除 |
| `continue_original_task` | 继续自己的原任务 | GoGoGo | `GoGoGo` | `behavior=continue`，校验作者和原消息关联 |
| `restart_edited_message` | 按编辑后的原消息重跑 | 喇叭 | `Loudspeaker` | `behavior=restart`，能力启用时由控制面校验并重启对应任务运行；未启用时静默过滤，不转为 Agent 输入 |

以下说明适用于保留上述默认含义时：

- `approve_continue` 与文字回复“同意继续”具有完全相同的产品语义和授权强度：如果该文字回复在相同上下文中足以确认目标消息提出的动作，Reaction 也足以确认；如果该文字回复仍不足以通过权限、审批或工具确认门禁，Reaction 同样不足。它只同意目标消息中明确提出的内容，不授权目标消息没有说明的新动作。
- `explain_more` 的默认输出是解释目标消息，而不是重新执行目标任务。模型可以先定位用户可能没理解的部分，再分层展开。
- 预埋语义仍需结合目标消息。若 Reaction 与目标内容明显不匹配，按普通上下文分析；不得仅凭 `semanticKey` 生造一项不存在的待办。

### 5. Batching、Revision、路由与回复关系

- 普通 Reaction 仅在目标发送者等于当前 Bot 的 `open_id` 或 app client ID 时进入 Agent 队列；用户原消息仅保留上文 `behavior=continue` 的受限例外。`behavior=stop` 不进入 Agent 队列，可额外接受目标为已登记 workChain inbound trigger 的用户消息；从未登记过的用户消息静默跳过，已知 historical trigger 在另一 current chain 存在时才按关联不匹配 fail closed。`behavior=restart` 由编辑后重跑控制面独立校验，其他 Bot 的消息不因此成为合法目标。
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

`stop_current_work` 的 added 和 removed 都不能依赖普通 Reaction → event buffer → pending queue → Agent run 链路。Bridge 为它们维护独立、持久的控制事件 ledger。`added` 有两类可识别目标：

1. 已映射到当前 workChain 的 Bot 普通消息或卡片；以及
2. 触发当前 queued/reserved/active input unit 的入站用户消息。

第二类是流式卡片更新期间的主 stop 入口；只对 `No` / `CrossMark` / `MinusOne` 生效，
不得让用户消息上的肯定、解释、完成或未映射 Reaction 进入 Agent。对于 user target，
Bridge 必须先证明它是本进程登记过的 inbound trigger，才能把 `No` / `CrossMark` /
`MinusOne` 解释为 stop；从未登记过的用户消息不具有 stop 语义。

- 完成 self-operator、安全路由、目标 sender 分类、Reaction 权限门禁、语义映射和控制事件防重后，`action=added` 先做目标 eligibility，再判断 work 状态：
  - user target 从未登记为该 scope 的 inbound trigger：静默丢弃，不回复、不写控制 ledger；
  - user target 是仍受 retention 保护的 historical trigger，且 scope 完全无 work：幂等回复“当前没有需要停止的任务”并持久标记已消费；
  - user target 是 historical trigger，但 scope 有另一 current chain：fail closed，不 interrupt、不取消队列，回复未停止及 `/stop` 提示并持久标记已消费；
  - Bot target 沿用现有规则：scope 完全无 work 时先幂等回复无任务；存在 work 时再校验它是否映射到 current chain；
  - target 是 current workChain 的 inbound trigger 或 Bot outbound：立即执行一次控制动作并持久标记 stop-added 已消费。
  它不等待普通 Reaction quiet window，也不能与紧随其后的 `removed` 相消。
- `action=removed` 仍先通过 self-operator、安全路由、目标 sender 分类和 Reaction 权限门禁，
  但不依赖 target 仍为 current/historical，也不依赖运行期 correlation 尚存在。对于 user
  target，只有持久控制 ledger 中存在同一 operator/target/emoji 的**已消费 added** 记录，
  才允许绕过 own-message filter；匹配后只回复一次“撤回停止 Reaction 不会自动恢复工作”，
  随后持久标记 stop-removed 已消费。它不撤销 interrupt、不恢复队列、不启动 Agent；
  没有匹配 stop-added 记录时静默 no-op。
- added/removed 都优先使用 reaction/event 中可用的稳定 ID 生成防重 fingerprint；缺少稳定 ID 时使用规范化事件字段和 action time 生成。重复投递、乱序重放或 Bridge 重启后的已消费事件均为静默 no-op，不能重复中断或回复。

停止能力还必须校验目标消息与当前执行链路的关联，避免用户给历史消息添加否定 Reaction 时误停一个无关的新任务。关联使用 Bridge 内部的 `workChainId`，不交给模型推断：

- 每个新入站 input unit 在进入 pending queue 时分配 `workChainId`。一个 regular
  PendingUnit 可以合并同 debounce window 的多条普通消息，因此必须登记该 unit 中**全部
  真实、用户可见的 inbound message ID**，形成
  `triggerMessageIds[] → workChainId`，不能只登记 first/last message。内部 synthetic
  unit ID 不得替代用户实际能够添加 Reaction 的 message ID。启动 Reaction turn 的 Bot
  目标消息继续通过 Bot outbound correlation 继承 chain；卡片回调若只有内部 synthetic
  message，则不凭 synthetic ID 创建 user-trigger stop 入口。显式回复或 Reaction 指向已有
  关联信息的 Bot 消息时继承该消息的 `workChainId`，无关联的新普通消息开启新 chain。
- pending unit、run reservation、active run 都携带 `workChainId`。Bot outbound message ID 一旦创建，立即登记为该 run 的 `workChainId`；发起当前 work 的 Bot 确认/方案消息也属于被继续的同一 chain。
- chain 只要仍有 queued/reserved/active work 就是 current；全部进入 terminal 后是 historical。后续有效回复或 Reaction 可以继承该 ID 重新继续此 chain，但在它重新产生 queued/reserved/active work 前不能停止另一个 current chain。
- 当前 scope 存在 active/reserved/queued work 时，停止 Reaction 的目标 message ID 必须作为
  inbound trigger 或 Bot outbound 映射到其中某个 current `workChainId`，才允许执行 stop
  控制动作；active/reserved chain 或尚在 pending 的 sibling chain 都属于 current。目标是
  retained historical trigger/outbound、且 scope 有另一 current chain 时，fail closed：
  不中断、不取消队列，并回复该 Reaction 未停止当前任务、如需停止可使用 `/stop`。Bot
  target 映射已过期或 Bridge 重启后未知时沿用该可见 fail-closed；user target 映射已过期、
  从未登记或重启后未知时无法证明它具有 stop 语义，必须静默丢弃且不写控制 ledger。
- inbound trigger 与 Bot outbound correlation 使用相同 chain 生命周期。queued/reserved/
  active chain 的全部 trigger/outbound mapping 都是 current workload reference，不参与
  historical TTL/LRU；最后一个 in-flight unit terminal 后才进入 historical retention。chain
  因后续有效回复或 Reaction 重新 current 时，其仍保留的 trigger/outbound mapping 一并
  恢复 current 保护。historical mapping 才受有界 TTL/LRU 裁剪；Bridge 重启后运行期
  correlation 可以整体失效并 fail closed，不根据会话文本猜测重建。每次 trigger/outbound
  登记、chain lifecycle 变化和 fail-closed/drop reason 都写受限结构化日志。

1. 权限严格使用 Reaction 的 `canUse* + mentionedBot=false 的 decideGroupResponse` 门禁；
   只有 interrupt/cancel **效果**与当前 scope 的 `/stop` 一致。Reaction 路径不能复用命令
   特例、结构化 @ 或绕过现有访问控制。
2. 目标消息属于当前执行链路时，在进入普通 pending queue 前调用现有 active-run interrupt 能力，覆盖已启动的 run 和尚处于 reservation/prompt preparation 的 run。
3. 关联校验通过后，效果与当前 scope 的 `/stop` 一致：取消该 scope 尚未开始的全部普通消息和 Reaction input units，包括同 scope 的 sibling queued unit，防止停止后又自动启动旧队列。`workChainId` 只用于防止历史/无关目标误触发，不把 `/stop` 改造成局部取消。
4. 已有 run 按现有 `/stop` 生命周期收敛为 interrupted，流式卡片/文本回复不得继续写入成功终态。
5. 停止 Reaction 本身不再启动一个新 Agent run，也不生成“是否真的停止”的模型确认；Bridge 在 interrupt 请求收敛后回复明确的可见停止结果。
6. 只有 target 已通过上述 eligibility（Bot target，或仍可识别的 current/historical user
   trigger）后，当前 scope 没有 active/reserved/queued work 时才幂等回复当前没有需要
   停止的任务；unknown/expired/restart-lost user target 在此前已静默丢弃。
7. `action=removed` 按独立控制 ledger 处理，不恢复被停止的 run、不重建被取消的队列；Bridge 只回复一次撤回停止 Reaction 不会自动恢复工作。若用户要继续，需新的普通消息或新的 `approve_continue` Reaction。

`behavior=agent`、符合条件的 continue 及未映射 Reaction 走结构化 Agent 上下文路径。
`behavior=stop` / `restart` 走确定性 Bridge 控制面；`behavior=passive` 静默排除。
这些行为由配置选择，不是任意过滤未映射 Reaction 的先例。

## Bridge System Prompt Contract

以下规则是本 Spec 的规范性交付物，必须加入共享 `BRIDGE_SYSTEM_PROMPT`，并通过现有 Claude/Codex System Prompt 注入路径生效。实现可以调整标签说明以匹配最终 envelope，但不得弱化行为语义：

```markdown
## Reaction

Reaction 的行为和含义来自当前 profile 的 `reaction-semantics.json`，可在运行时修改。
不要根据 emoji 名称、`semanticKey` 字面值或历史轮次中的旧映射推断固定含义。

当本轮存在 `reaction_contexts` 时，其中包含用户的 Reaction，以及该 Reaction 所回应的
目标消息。Reaction 不是脱离上下文的普通文本；不要仅依赖 `bridge_context.source`
判断本轮是否包含 Reaction。

1. 先读取每个 Reaction context 的 `triggerReactions`、`effectiveReactionSet`、
   `reactionRevision`、`policyVersion` 和完整 `targetMessage`。结合当前有效 Reaction 集合
   与目标消息正在表达、询问、确认或请求的内容，判断用户真实意图。`triggerReactions` 是
   本轮全部变化，`effectiveReactionSet` 是当前上下文；不要重新执行集合里此前已处理且
   仍然存在的语义。
2. `emojiMeaningSource=predefined` 时，以本轮每项的 `behavior` 和 `emojiMeaning` 为准。
   `emojiMeaning` 是当前配置给出的权威语义解释，`semanticKey` 只是自由标识，不能代替
   解释或触发固定动作。仍要检查目标消息是否符合该语义的适用场景，不能脱离上下文
   机械执行。`policyVersion` 标识本轮所用配置；配置变化本身不表示新的用户执行请求。
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
10. `behavior=continue` 在用户任务原消息上的续执行只适用于：操作者就是消息作者，
   且该原消息已由当前 Bot 处理并具有有效关联。符合条件的新增信号可以明确继续此前
   被停止的原任务；从已完成位置继续，不重复动作、不扩大原任务授权。仅撤回不表示
   继续；有效集合中仍保留的旧停止信号是历史上下文，不能再次当成新增停止信号。

### Reaction 行为边界

- `behavior=agent`：结合当前 `emojiMeaning` 与目标消息解释用户意图，再按上面的
  授权、上下文和去重规则处理；不要从标识符推导额外任务。
- `behavior=passive`：Bridge 在入站和快照中排除；添加和移除都不启动 Agent、不回复、
  不打断任务，也不关闭话题。不要根据历史中的被动标记生成执行请求。
- `behavior=stop`：Bridge 控制面按 `/stop` 语义处理中断并负责可见回复，不因此创建
  新的 Agent turn。不要在后续会话中自动恢复、重放或回滚被停止的工作；只有用户新的
  明确输入才能继续，撤回停止信号不自动恢复工作。
- `behavior=restart`：由 Bridge 控制面验证作者、权限和运行状态后，按编辑后的原消息
  重启对应任务运行；不要仅因有效集合保留该信号再次重启任务或创建新任务。
```

该段必须位于共享 Bridge System Prompt，而不是群级 Prompt、某个 Agent 的 `SOUL.md`、普通 `user_input` 或仅供开发者阅读的文档中。Reaction 目标消息及其内容仍属于不可信上下文，System Prompt 规则不能被目标消息正文覆盖。

## Compatibility, Failure And Rollback

- 普通 IM、显式引用、topic context、交互卡片和评论 prompt 结构保持兼容；没有 Reaction 时不输出 `<reaction_contexts>`。
- Reaction 路由元数据读取、`im.reactions.list` 分页 reconciliation、ledger 读写和目标正文规范化失败都不能导致整个 Bridge 队列崩溃。日志记录目标消息 ID、失败阶段和 trace 信息，不记录凭据或无界原文。
- `im:message.reactions:read` 不可用或普通 Reaction reconciliation 在有限重试后仍失败时，不得仅凭 delta 执行普通语义或 revision 中断；保持旧 ledger 不变并回复本次 Reaction 暂时无法确认。`stop_current_work` added/removed 是控制面例外：added 在安全门禁和控制 ledger 防重后，**先按 sender class 与运行期 mapping 判断 target eligibility**；unknown/expired/restart-lost user target 静默丢弃，eligible target 才进入 no-work/current/historical 分支，current 关联通过后直接 interrupt。removed 在安全门禁、匹配已消费 stop-added ledger 和防重后直接回复不恢复，不依赖当前 correlation。两者都不依赖 list 中间状态。
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
| `DONE` added/removed，目标为用户消息、当前或其他 Bot 消息 | 入口静默忽略；不读目标/list、不入 buffer、不写 ledger/revision、不启动/中断 Agent、不回复 |
| 同 key queued/reserved/active Reaction 或普通任务期间添加/移除 DONE | 已有任务继续，既有 revision 和队列保持不变；不产生替代 turn 或回复 |
| DONE 与 OK/GoGoGo 等主动 Reaction 共存 | list 快照、fingerprint、triggerReactions 和动态 Reaction 输入都不含 DONE；只处理主动信号；共享 System Prompt 包含通用 passive 规则 |
| DONE 仍保留时撤回最后一个主动 Reaction | 有效集合为空；遵守该主动 Reaction 的撤回规则，不因 DONE 启动替代 turn |
| 升级前的持久 ledger fingerprint 包含 DONE | 识别并归一化旧版含 DONE fingerprint；仅 current/consumed 均精确匹配时保持 revision 并避免重放，真实主动变化仍正常处理 |
| `No` / `CrossMark` / `MinusOne` 指向当前执行链路，且 scope 正在运行或准备运行 | 映射为 `stop_current_work`；在普通排队前触发与 `/stop` 等价的 interrupt，取消 pending，并由 Bridge 回复停止结果 |
| 流式卡片仍在更新，operator 对触发当前任务的用户消息添加 `No` / `CrossMark` / `MinusOne` | trigger message 已在 enqueue 时映射到 current `workChainId`；允许立即 interrupt + cancel pending，不要求正在更新的卡片可添加 Reaction |
| operator 对普通用户消息添加非停止 Reaction | 除作者对已登记原消息使用 GoGoGo 的受限续执行例外外，继续静默跳过；默认 DONE 按被动标记处理，不进入 Agent、不建立普通 Reaction snapshot/revision |
| scope 无 work，operator 对从未登记过的普通用户消息添加停止 Reaction | 静默丢弃；不回复、不写控制 ledger |
| scope 无 work，operator 对仍在 retention 内的 known historical trigger 添加停止 Reaction | 幂等回复当前没有需要停止的任务并写已消费控制 ledger；不启动 Agent |
| scope 有另一 current chain，operator 对 unrelated user message 添加停止 Reaction | 未知 user target 静默丢弃；已知 historical trigger 则 fail closed，均不 interrupt、不取消 pending |
| `mention-only` 群内，operator 可以发送结构化 `@bot /stop`，但没有无 @ 豁免 | 文字命令按原规则处理；stop Reaction 固定按 `mentionedBot=false` 被拒绝，不借命令资格旁路 |
| trigger 消息作者无 Reaction 权限 | sender 身份不授予权限；静默拒绝且不影响 run |
| 另一 operator 通过 Reaction 无 @ 门禁，对 current trigger 添加停止 Reaction | target sender 不限制 operator；按与其无 @ 普通输入相同的权限允许 stop |
| Reaction 事件解析出的 scope/thread 与 trigger correlation 不一致 | fail closed；不 interrupt、不取消 pending |
| 同一 regular PendingUnit 合并用户消息 A、B | A、B 的真实 message ID 均映射同一 current chain；对任一消息添加 stop 均可停止，synthetic unit ID 不作为用户入口 |
| current trigger 持续时间超过 historical TTL，或 current mapping 数量超过 historical cap | trigger mapping 仍受 current 保护，不被 TTL/LRU 淘汰；stop 继续可达 |
| user trigger 已 terminal 且 mapping 被 TTL/LRU 淘汰，或 Bridge 重启后 correlation 丢失，再收到新的 user-target stop-added | 无法证明 target eligibility；静默丢弃，不回复、不写控制 ledger |
| stop-added 后 chain terminal 或 trigger correlation 被 historical TTL/LRU 淘汰，再收到对应 removed | 仅凭持久 added ledger 匹配并只回复一次不恢复；不依赖运行期 correlation |
| Bridge 在 stop-added 后重启，再收到 user-target removed | 从持久 added ledger 匹配并只回复一次不恢复；无匹配则静默 |
| 当前任务已 terminal 后，operator 才对完成卡片添加停止 Reaction | scope 无 current work 时回复当前没有需要停止的任务；不回滚已完成动作、不启动 Agent |
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
| 用户给其他 Bot 或普通用户消息点非停止 Reaction | 其他 Bot 目标不启动 Agent；用户目标仅保留作者对已登记原消息的 GoGoGo 续执行例外；DONE 对所有目标均静默排除 |
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

自动化测试至少覆盖 Reaction handler 路由、self-operator/`Typing` 回环保护、普通消息访问控制与四种群响应模式的同值矩阵、所有已授权 operator 共享同一预埋语义、未经授权的停止 Reaction、13 条默认规则及自定义 emoji/语义/行为的热更新、DONE 静默标记的入口/快照过滤、旧版含 DONE fingerprint 归一化及任务期间无副作用、未映射 Reaction（含 `Get`）透传、同 key event buffer 的 quiet/max flush、多个不同 Reaction 的有序 `triggerReactions`、同一 buffer 一增一减且最终非空、`rawClient.im.v1.messageReaction.list` 全分页 reconciliation、fingerprint 规范化/去重/确定性排序、list 越过中间状态的 added→removed 净零例外、ledger 重启恢复、重复/乱序/无状态变化 no-op、scope 缩权与读取失败、所有被消费主动 Reaction 的可见回复、prompt builder 序列化、共享 System Prompt 注入、目标消息规范化（含卡片/合并转发 wiring）、revision 失效/中断/最新快照替代、superseded 流式回复、`added`/`removed` 相消与独立撤回、两级目标消息读取失败、其他发送者过滤、batch barrier、按目标拆分和 reply target。

`stop_current_work` 另需覆盖 Reaction 无 @ 权限门禁与 `/stop` interrupt/cancel 效果、
`workChainId` 在 inbound
trigger/input/pending/reservation/active/outbound/terminal 生命周期中的关联、同一 regular
PendingUnit 全部真实 inbound message ID 的登记、current trigger mapping 不受 historical
TTL/LRU、用户 trigger 和 Bot outbound 两类合法目标、未知 user target 静默、known
historical trigger 的 no-work/fail-closed 分支、用户消息上的非停止 Reaction 仍被过滤、
目标确认消息被 Reaction 继续、同 scope sibling queued unit、Reaction 无 @ 权限与
`@bot /stop` 命令资格的差异、sender 不授予权限、scope/thread 不匹配、重启后未知关联
fail closed、独立 added/removed 控制 ledger 的重复投递与重启防重、removed 在 correlation
消失/淘汰/重启后仅凭 added ledger 匹配、active handle、run reservation/prompt
preparation、scope pending queue 取消、无任务幂等、removed 不恢复、每种结果的可见
Bridge 回复、interrupted UI 终态，以及“停止 Reaction 不产生新的 Agent run”。

Claude 和 Codex 两条 adapter 路径都必须通过确定性的结构/注入测试。随后各使用验收时当前 profile 配置的一个真实模型完成同一组 live-model 对照；记录 Agent 类型、实际模型标识和时间，任一路径未执行都不能宣称全量完成。

live-model 对照使用隔离、可逆且带唯一标记的测试动作 X，oracle 为：

- 对“是否继续执行 X？”的已知肯定 Reaction：结果必须与文字回复“同意继续”一致，允许执行一次 X；不允许零次或重复执行。
- 对“X 已执行完成”的相同 Reaction：不允许再次调用执行工具；允许简短确认。
- 对 `explain_more`：不允许继续执行 X；最终回复必须对目标消息作进一步说明。
- 对 DONE：添加和移除都没有 Agent turn、工具调用或回复；在同目标 active Reaction run 期间也不打断它。
- 对未预埋但可从低风险上下文理解的 Reaction：必须给出符合上下文的处理，不得仅因未映射而拒绝分析。
- 对未预埋且高风险歧义的 Reaction：不允许执行 X，必须澄清。
- 对 `available=false`：不允许执行 X，必须说明目标消息不可读。
- 对已经处理后的 `removed`：不允许重放 X 或自动回滚；必须有可见回复说明撤回已收到。

每条主动 Reaction 验收保存实际动态 prompt、共享 System Prompt 版本、工具调用、可观察副作用、最终回复和飞书消息 ID。实机至少覆盖三个预埋 `semanticKey` 各一个代表 emoji、一次未预埋 Reaction 和一次 removed，核对 UI 引用、Agent 输入、System Prompt、工具副作用与最终行为一致；停止场景必须在流式卡片仍处于更新状态时，对触发当前任务的入站用户消息添加代表性 stop Reaction，证明 interrupt 发生在旧 run 完成之前，且没有后继 Agent run 自动启动。DONE 单独核对用户/Bot 目标上的添加、移除及与主动 Reaction 共存，保存无 run/回复/interrupt 的证据。另需验证相同用户消息上的非停止 Reaction 除前述 GoGoGo 例外外不被消费。

## Implementation Coverage

实现必须把“权限与 self-operator 门禁”“Reaction event buffer/权威快照/持久 ledger/revision”“动态 Reaction 上下文”“共享 Bridge System Prompt 规则”“全部有效主动 Reaction 的可见回复”“停止 Reaction 控制面”和“DONE 静默标记”作为一套完整契约，并覆盖普通消息权限函数复用、四种群响应模式、所有授权 operator 共用语义、13 条默认配置、按 profile 热更新、全量替换及无效配置 last-good、未映射 Reaction 透传、DONE 在入口/快照中的排除及旧版含 DONE fingerprint 的识别归一化、`rawClient.im.v1.messageReaction.list` 全分页与 scope、净零 added→removed 例外、重复/乱序/重启幂等、in-flight revision 失效与替代、superseded 流式回复、terminal 后主动 Reaction 撤回的 Bridge 回复、Reaction 元数据在 pending batch 中的表示、目标消息规范化复用、inbound trigger 与 Bot outbound 两类 `workChainId` 停止目标关联、用户消息上的 stop 和 GoGoGo 受限例外、stop added/removed 独立控制 ledger 与快路径、现有 `/stop`/ActiveRuns/PendingQueue 能力复用、两种 Agent 的 Prompt 注入、模型行为对照验收及实机验收。原 Coding Plan 中关于 11 项映射、DONE 继续执行和四个预埋 semanticKey 的记录属于历史状态，以本 Spec 顶部的 2026-10-23 配置修订为准。
