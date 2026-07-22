# Bot-to-Bot Native Mention Primitive Spec

Date: 2026-07-22
Status: confirmed — R7 independent review PASS

## Recommendation

在 `lark-channel-bridge` CLI 中新增一个最小的三参数原语 `at-bot`。调用方只提供目标群 `chat_id`、目标 Bot `open_id` 和消息正文；Bridge 负责校验目标、构造飞书原生结构化 mention，并始终使用当前 profile 的 Bot 身份发送。

该原语只解决“模型手工拼接 mention 协议容易出错”的问题。v1 不引入任务状态、自动回传、ACK、超时、重试 ledger 或 Harness 生命周期管理。

## Problem And Boundary

Bridge system prompt 已经明确说明 Bot-to-Bot 消息必须使用 native mention，并给出 `lark-cli` 的原始发送示例。但真实运行中，Agent 曾把 `</at>` 写成 `</a>`：飞书成功创建了普通文本消息，却没有生成结构化 `mentions`，目标 Bot 因而没有收到事件。

问题不是缺少规则，而是当前接口要求模型同时正确处理 Bot 身份发现、mention 标记、JSON 和 shell 转义。`at-bot` 将飞书协议细节收回到确定性代码中，同时保持调用面只有三个业务参数。

本需求不改变群消息准入、Bot-to-Bot 接收规则、群响应模式、权限配置、session、CardKit、Harness 角色或现有 `lark-cli` 命令。

## Delivery Surfaces

本需求需要两个边界同时落地，但不建立跨仓库运行状态：

- **lark-channel-bridge**：提供 `at-bot` 原语，并在共享 Bridge system prompt 中把面向 Bot 的 `@ / mention / 通知 / 转交 / Return to / 完成后回给` 意图映射到该原语。
- **sayToLittleP Harness**：把 Task Brief 的 `Return to` 从自然语言提示收紧为流程级交接义务；目标是 Bot 时必须调用 `at-bot`，普通最终文本不算已经通知。

Bridge 原语实现与 Harness 文案可以分别提交，但在两边完成并通过弱模型实机验收前，本需求不能 close。

## CLI Contract

命令形态：

```bash
lark-channel-bridge at-bot \
  --chat-id oc_xxx \
  --bot-id ou_xxx \
  --message "Plan Review 已完成，请复审。"
```

三个参数均必填：

- `--chat-id`：目标群的 `chat_id`；v1 只接受 `oc_` 形式的群 ID。
- `--bot-id`：目标 Bot 在当前发送 profile 下可用的 `open_id`；v1 只接受 `ou_` 形式。
- `--message`：发送给目标 Bot 的非空纯文本正文。

v1 不接受 Bot 名称作为目标，不做模糊匹配，也不允许调用方选择 `--as user`、消息类型或自行提供 mention JSON。

成功时 stdout 输出机器可读 JSON，进程退出码为 `0`：

```json
{
  "ok": true,
  "chatId": "oc_xxx",
  "botId": "ou_xxx",
  "messageId": "om_xxx"
}
```

失败时进程退出码非 `0`，不得输出成功 JSON 或声称已经通知。错误信息保持简短、可行动，并至少区分参数无效、目标不在群 Bot 列表、bridge-bound lark-cli 不可用或未绑定、发送失败。Commander 参数错误可以沿用标准 stderr；运行时错误不得包含 App Secret、token、私有配置正文或未经清理的底层调用堆栈。

## Runtime Contract

1. 命令只服务 bridge-bound Agent 调用。它继承当前 Bridge 进程注入的 profile 环境，不得 unset 或绕过 `LARK_CHANNEL`、`LARK_CHANNEL_HOME`、`LARK_CHANNEL_PROFILE`、`LARK_CHANNEL_CONFIG` 或 `LARKSUITE_CLI_CONFIG_DIR`；未检测到有效 bridge-bound context，或 lark-cli 报告未绑定时，必须非零退出，不能回退到普通 profile。
2. `senderId` 或目标 mention 提供的 `openId` 只是调用方候选。Bridge 必须使用当前 profile 的 Bot 身份实时读取目标群 Bot 列表，并以本次列表中的 `bot_id === --bot-id` 精确确认目标。唯一可进入发送 payload 的目标 ID 是本次群 Bot 列表命中的 `ou_`；`cli_*` app ID、`user_id`、`union_id`、静态缓存或只按显示名猜测的身份均不接受。找不到目标时停止，不发送降级消息。
3. Bridge 从同一次群 Bot 列表结果取得目标显示名，在代码中构造下面唯一允许的 post 结构：一个 locale、一个 paragraph，首元素且唯一的 `at` 指向目标 Bot，`--message` 只进入其后的独立 `text` 元素。

```json
{
  "zh_cn": {
    "title": "",
    "content": [[
      {
        "tag": "at",
        "user_id": "<validated-bot-id>",
        "user_name": "<name-from-the-same-bot-list-item>"
      },
      {
        "tag": "text",
        "text": " <message>"
      }
    ]]
  }
}
```

正文中的引号、换行、尖括号、`</a>`、伪 `<at>` 或类似 `@名字` 的内容不得破坏 mention 结构，也不得被解释成额外 mention。v1 不添加 title 文案、markdown、链接或其他 post 元素。

4. 最终发送固定使用当前 profile 的 Bot 身份。调用方不能覆盖身份，也不能传入预构造的 `content`。
5. 飞书发送接口成功并返回 `message_id` 后，命令返回成功。v1 不自动回读消息，不等待目标 Bot ACK，也不把“发送成功”表述为“目标已处理”或“任务已完成”。
6. 所有底层进程调用使用 argv 数组和结构化序列化，不通过 `sh -c`、`node -e` 或拼接 shell 命令生成 JSON。

发送语义固定等价于：

```bash
lark-cli im +messages-send \
  --chat-id <validated-chat-id> \
  --as bot \
  --msg-type post \
  --content <serialized-canonical-post> \
  --format json
```

原语固定发送结构化 post，不使用 text XML 或 interactive card。post 构造或发送失败时必须返回失败，不得降级发送 plain text；否则可能产生“消息已发出但没有结构化 mention”的伪成功。

## Bridge Prompt Contract

共享 Bridge system prompt 的 Bot-to-Bot 发送规则改为优先调用该原语：

```text
当任务要求 @、mention、通知、转交、Return to 或完成后回给某个 Bot 时，
必须调用 lark-channel-bridge at-bot；在普通最终文本中写 @名字不算已经通知。
唯一调用形态是：
lark-channel-bridge at-bot --chat-id '<bridge_context.chatId>' \
  --bot-id '<经当前群 live bot list 验证的 bot_id>' \
  --message '<本轮简短结果或 blocker>'
三个占位符必须替换成本轮真实值；不得照抄尖括号占位符。chat-id 只取当前
bridge_context.chatId，message 是要交给目标 Bot 的结果或 blocker，不是命令说明。
chat-id 使用 bridge_context.chatId。若目标是触发当前 turn 的 Bot 且 senderType=bot，
senderId 只作为 bot-id 候选并由 at-bot 再做群 Bot 校验；若目标另有其 Bot，只有
该目标本身明确出现在结构化 mentions 中时才使用其 openId 候选，否则查询当前群
Bot 列表：
lark-cli im chat.members bots \
  --params '{"chat_id":"<bridge_context.chatId>"}' \
  --as bot --format json
按名称发现只接受 NFC-normalized 后唯一的全名精确匹配；0 个或多个匹配
都必须停止并报告 blocker，不能猜测、取第一项或使用静态 ID。
若 senderId 或目标 mention 的 openId 候选未命中本次群 Bot 列表，只能使用同一入站
上下文中该目标的 name 对本次列表做唯一 NFC 全名精确匹配；唯一命中后改用列表返回
的 bot_id，缺少名称、0 个或多个匹配时停止。
禁止把 botOpenId、自己的 mention 或 mentions 第一项误当成目标；禁止手工拼接
mention XML、post JSON 或纯文本 @名字。
```

保留现有身份发现、无法验证目标时停止、Bot 循环防护和 bridge-bound 环境规则；删除鼓励 Agent 手工构造 `<at>` 或 post mention JSON 的示例。

`mentions` 只描述入站消息实际 @ 到的账号。在 Harness 派发链路中，派发方用 native mention 唤醒实现方，因此实现方看到的 `mentions` 通常包含实现方自己，而回传目标是入站消息的 Bot 发送者。此时 `senderId` 是回传候选；它只有在形态为 `ou_` 且被 `at-bot` 的本次群 Bot 列表精确命中后才能发送。正常情况下，入站 `senderId` 和 bot-list 都由接收方当前 profile 获取，应能直接匹配；若实际事件未满足该条件，按同一入站 `senderName` 做唯一 live-name fallback，不能跨 profile 复用其它 open_id。`botOpenId` 永远表示当前 Bot 自己；当前 SDK 的 `mentions[].isBot` 只可靠表示 mention 是否命中当前 Bot，不能用来判断任意账号是不是其他 Bot。

sayToLittleP 的主流程和角色不变，但 Harness 规则与 Task Brief 必须明确：模板中的回传字段改为 `Return to：<目标名> (Bot)`，并紧邻注明 `完成后必须用 lark-channel-bridge at-bot 回传；普通最终文本不算通知`。`Return to：小P (Bot)`、`完成后通知小P` 等 Bot 交接语义要求携带简短结果或 blocker 调用 `at-bot`；当本轮 `senderType=bot` 且目标就是派发者时以 `senderId` 为候选，否则按当前群 live bot list 发现并唯一匹配目标。命令非零退出时不得声称已经通知，应把通知失败作为 blocker 返回给当前可见接收方。目标名称只能通过当前群 Bot 列表的唯一 NFC 精确匹配解析；同名、未命中或目标等于当前 `botOpenId` 时停止。该约束不引入 ACK、自动回传或持久化任务状态。

## Compatibility, Risk And Rollback

- 该命令是新增能力，不修改现有配置 schema、消息路由或 daemon 生命周期；旧 profile 升级后行为不变。
- 最大剩余风险是模型仍未遵循 Prompt / Task Brief，或传入错误的 `chat_id` / `bot_id`。Bridge Prompt 与 Harness 同时明确调用触发语义，原语再通过当前群 live validation fail-closed；这降低错误率但不宣称能从运行时强制模型一定执行通知动作。
- v1 不新增 daemon IPC 或第 4 个身份参数来暴露当前 Bot 的 `open_id`。当前 standalone `lark-cli` 的 `whoami --as bot` 只返回 profile / app ID，`/open-apis/bot/v3/info` 通过其通用 `api` 命令也未暴露 `bot.open_id`；因此原语本身无法用现有简单接口确定性识别 self-target。禁止通知自己的约束保留在 Bridge Prompt / Harness，并由受控 Agent 行为 Gate 验证；若未来 CLI 稳定暴露当前 Bot `open_id`，再把它下沉为原语级 fail-closed 校验。v1 不为此引入状态或扩大参数面。
- v1 接受一次额外的群 Bot 列表读取，以换取目标身份校验；不缓存跨群 Bot ID。
- 当前 bridge-bound profile 已实证 `lark-cli im chat.members bots ... --as bot --format json` 能返回本群 `bot_id` / `bot_name`；因此 v1 的 discovery 与最终发送都固定使用 Bot 身份，不依赖额外 user OAuth。若目标环境的 Bot 身份 discovery 失败，原语 fail-closed，不回退 `--as user`。
- Harness 的新回传规则按参与 profile 启用。某个实现方或 Reviewer 使用该规则前，必须完成该 profile 的发布闭环：部署同时包含 `at-bot` 和新 Bridge Prompt 的 artifact；确认 daemon 的实际命令行 / artifact revision 指向该版本并在部署后完成重启或滚动；在同一 bridge-bound 环境确认 `lark-channel-bridge at-bot --help` 可用且当前 Bot 能读取目标群 Bot 列表；通过一次真实 Agent turn 或等价行为 probe 证明模型收到新 Prompt 并把通知意图映射为 `at-bot`。仅有 PATH 上的新 CLI 不算完成部署。
- sayToLittleP 的 Harness 与 Task Brief 修改必须落在可追溯 revision 中，本次派发的 Task Brief 确实来自该 revision。Bridge 或 Harness 任一侧未满足时，Harness 节点进入 blocked，不要求模型退回手工 mention。
- 回滚只需删除 `at-bot` 命令并恢复原 system prompt 文案，无数据迁移或状态清理。

## Acceptance Criteria

- 自动化测试证明三个参数必填，非法 ID、空正文和群内无该 Bot 时均非零退出且不调用发送。
- 身份矩阵覆盖：`mentions` 只有当前 Bot 而 sender 是另一 Bot；sender ID 为有效 `ou_`、非 `ou_` 或未在群 Bot 列表；目标另有明确 mention；目标只能按群 Bot 列表发现。候选 ID 未命中但同一入站 sender/mention name 唯一命中当前群列表时，改用列表返回的 `bot_id`；名称缺失、同名或未命中时 blocked。只有本次列表精确命中的 `bot_id` 可以发送。
- 正文包含单双引号、换行、尖括号、`</a>`、伪 `<at>` 或纯文本 `@名字` 时，post payload 仍只有一个独立 `at` 元素指向目标，正文只进入 `text` 元素；构造失败不得降级成普通文本。
- 群 Bot 列表读取和消息发送都固定使用当前 profile 的 Bot 身份，调用方无法切换为 user 身份或注入自定义 content。
- lark-cli 不可用、bridge-bound context 未绑定、spawn/timeout/非预期输出以及飞书发送失败时，命令非零退出且不声称成功；运行时错误不泄露凭据。
- 成功输出包含真实 `message_id`；失败输出不泄露凭据。
- Bridge system prompt 教 Agent 使用 `at-bot`，并覆盖三种目标候选来源：Bot 发送者的 `senderId`、目标本身被明确 mention 时的 `openId`、其余按当前群 Bot 列表精确发现；最终都由原语 live validation。不得把自己的 `botOpenId`、`mentions[].isBot` 或 mentions 第一项当作回传目标。Prompt 不再要求 Agent 手工拼接 mention XML / JSON；Codex 与 Claude 继续消费同一语义规则。
- Bridge system prompt 直接给出唯一三参数 argv 模板，并明确 `bridge_context.chatId → --chat-id`、live-validated `bot_id → --bot-id`、本轮结果或 blocker → `--message`；目标需按名称发现时给出固定的 Bot 身份 bot-list 查询命令。Agent 不需要从 `mentions` 推断一个从未被入站消息 @ 到的目标。
- sayToLittleP Harness 与 Task Brief 把回传字段标为 `Return to：<目标名> (Bot)`，并明确把面向 Bot 的 `@ / mention / 通知 / Return to / 完成后回给` 作为必须调用 `at-bot` 的交接义务，普通最终文本不算通知。
- 受控 Agent 行为验收覆盖三种措辞与身份路径：`Return to` 当前 Bot 发送者、通知消息中明确 mention 的另一个 Bot、按名称从当前群发现目标。每个成功场景都应观察到 `at-bot` 调用，且 argv 的 `--chat-id` 等于本轮 `bridge_context.chatId`、`--bot-id` 等于 live list 验证后的目标、`--message` 是本轮结果或 blocker；同名 Bot、名称未命中、目标是当前 Bot 三个负例不得调用。所有场景不得观察到手工 mention payload、直接调用 `lark-cli ... messages-send` 或仅输出纯文本 `@名字`。
- 双 Bot 实机验收前，两个参与 profile 都必须运行同时包含 `at-bot` 与新 Prompt 的 Bridge artifact，完成 daemon 重启 / 滚动并记录实际 artifact revision；sayToLittleP Harness / Task Brief 也必须来自包含新交接规则的已知 revision。接收 profile 还必须回读并证明目标群通过其现有 group access gate，且 native mention 会进入现有 `mentioned-bot` 响应路径；不修改或绕过既有 access policy。命令存在性、PATH 版本或发送成功不能替代运行 daemon、接收准入与实际 Agent 行为证明；任一前置缺失时 Gate 为 blocked。
- 实机验收在包含两个 Bridge Bot 的群中执行：调用前从当前 bridge-bound profile 的 `whoami --as bot` 或等价 profile 元数据记录调用方 App ID；调用方只传 `chat_id`、目标 `bot_id` 和随机 nonce 正文。飞书消息回读必须同时证明 `sender.id` / `sender.id_type` 映射到该调用 profile 的 App、canonical post 的 `mentions` 命中目标 Bot，并以同一 message ID / nonce 在目标 Bot 侧观察到 intake。纯文本对照消息不能触发目标 Bot。不得把消息发送成功或目标 intake 错归因给群内另一个 Bot profile。

## Next Phase

R7 独立复审 `PASS`，Spec 已确认，下一阶段进入 Coding Plan。Plan 需要落到 CLI 注册、可测试的发送边界、Bridge Prompt 更新、sayToLittleP Harness / Task Brief 同步、自动化测试、参与 profile 发布闭环、受控弱模型行为验收和一次双 Bot 实机验收；Plan Review 通过前不修改运行代码。

## Review History

- R1 `BLOCKED`：要求 Harness 与 Prompt 同时定义自然语言通知意图到 `at-bot` 的映射；把 sender/mention ID 降为候选并由当前群 Bot 列表最终校验；固定结构化 post 且禁止 plain-text 降级；收紧 bridge-bound 与失败边界。主 Agent 接受前三项，并将“所有失败 JSON”收敛为更小的“成功 JSON、失败非零且不泄密”。
- R2 `CONDITIONAL`：要求名称发现唯一匹配、固定 post wire contract、增加参与 profile 部署前置。主 Agent 接受三个问题；采用本机已验证的 `zh_cn.title + zh_cn.content` canonical post，而未采用 Reviewer 提出的不完整 JSON 形态。
- R3 `CONDITIONAL`：要求补 sender ID 未命中时的唯一 live-name fallback，并证明运行 daemon 与 Harness revision 已实际加载新规则。主 Agent 不接受“同 profile 下 senderId 必然跨应用不可比”的推断，但接受 fail-closed fallback 与完整发布 Gate。
- R4 `CONDITIONAL`：要求原语自身拒绝 self-target，不能只依赖 Prompt / Harness。主 Agent 初步接受并拟复用 `/open-apis/bot/v3/info`；该决定随后因 R5 的 standalone CLI 实机证据撤回。
- R5 `BLOCKED`：指出通用 `lark-cli api GET /open-apis/bot/v3/info --as bot` 实际返回空 `data`，`whoami --as bot` 也只有 App ID，故 R4 设计的命令级 self-target 守卫没有可实现的简单身份来源；同时要求实机 Gate 证明出站 sender 确属调用 profile。主 Agent 现场复现并接受事实：为保持三参数、无状态原语，self-target 约束暂留 Prompt / Harness 与受控行为 Gate，不引入 daemon IPC；接受 sender mapping finding，并把调用 profile App ID、回读 sender、message ID / nonce 与目标 intake 纳入同一证据链。
- R6 `CONDITIONAL`：要求 Prompt 给弱模型完整三参数 argv 映射、Task Brief 把 `Return to` 明示为 Bot，并把接收 profile 的群准入纳入双 Bot Gate；主 Agent 接受。Reviewer 同时认为 Bot 身份不能执行 bot-list discovery；主 Agent 以当前 bridge-bound profile 的只读实测驳回该事实判断：`--as bot` 成功返回本群 3 个 Bot 的 `bot_id` / `bot_name`，因此保持 discovery 与 send 均为 Bot 身份，并规定失败时不降级 user 身份。
- R7 `PASS`：独立 Reviewer 确认自然语言交接意图、唯一三参数 argv、System Prompt / Harness / Task Brief 三层交付、canonical post、target validation、接收准入与 sender-to-intake 证据链均已闭合；self-target 作为 Prompt / Harness + 负向行为 Gate 的 v1 边界清楚，不需要引入 IPC 或第 4 参数。
