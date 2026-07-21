# Per-Group Owner No-Mention Response Spec

Date: 2026-07-21
Status: confirmed

## Recommendation

在现有 Bot profile 的群响应策略中新增第四种互斥语义 `owner-allowlist`：只有应用 owner 在独立名单中的群发送“没有结构化 @ 任何账号”的消息时，当前 Bot 才默认响应。

现有 `mention-only`、`owner-default`、`all-messages` 及其行为保持不变；现有 `allowedChats` 继续只表达“哪些群对群内用户开放”，不得复用为 owner 免 @ 范围。

## Confirmed Product Decisions

- **Owner 身份**：使用飞书开放平台返回的当前应用真实 owner；`admins`、`botAdmins` 或其他可配置用户不获得 owner 默认响应资格。
- **回复与引用**：沿用既有规则。回复或引用消息本身不等于结构化 @；只要 owner 的事件没有结构化 mention，仍可触发默认响应。
- **范围粒度**：名单按群 `chat_id` 管理。话题群被加入后，该群主会话和所有话题都生效；v1 不支持按 `thread_id` 单独配置。
- **多 Bot 关系**：各 Bot profile 独立配置，不建设跨 Bot 中央注册表，也不保证同一群只能配置一个默认 Bot。在 `owner-allowlist` 模式下，只有名单命中的 Bot 才通过该模式响应；其他 Bot 仍按各自已有模式独立判断。

## Problem And Boundary

当前 `owner-default` 按整个 Bot profile 生效。启用后，owner 在该 Bot 所在的任意群中发送无 @ 消息都可能触发回复，无法只让某一个 Bot 在指定群承担默认响应。

本需求只增加“某 Bot × 某群”的 owner 免 @ 路由能力，不改变 owner 身份来源、群访问控制、显式 @ 路由、多 Bot 同时被 @、session / topic 隔离、回复形态或飞书授权流程。

## Configuration Contract

在当前 profile 的 `access` 下新增独立名单：

```json
{
  "access": {
    "allowedChats": ["oc_existing_access_group"],
    "groupResponseMode": "owner-allowlist",
    "ownerNoMentionChats": ["oc_group_a", "oc_group_b"],
    "requireMentionInGroup": true
  }
}
```

- `groupResponseMode = owner-allowlist`：启用“仅指定群的 owner 免 @”语义。
- `ownerNoMentionChats`：当前 Bot 可以默认响应 owner 无 @ 消息的 `chat_id` 名单；话题群中的所有 `thread_id` 共享该群配置。
- `allowedChats` 与 `ownerNoMentionChats` 相互独立；把群加入后者不会向群内其他用户开放 Bot。
- 切换到其他响应模式时保留 `ownerNoMentionChats`，但名单不生效；再次切回后恢复。
- 旧配置缺少 `ownerNoMentionChats` 时归一化为 `[]`，行为不变。
- `requireMentionInGroup` 在此模式下保持 `true`，旧版本回滚时安全降级为 `mention-only`。

`/config` 的“群消息响应方式”增加“仅在指定群响应 owner 无 @ 消息”选项；访问控制面板单独展示 owner 免 @ 群名单和维护命令。现有三个选项的值、文案与行为不修改。

## Runtime Contract

判断继续基于飞书事件中的结构化 mention，不解析正文里的纯文本 `@名字`。

| 场景 | `owner-allowlist` 下的结果 |
| --- | --- |
| owner 在名单群发消息，`mentions=[]` 且 `mentionAll=false` | 当前 Bot 响应 |
| owner 在非名单群发无 @ 消息 | 静默 |
| owner 在名单群回复或引用其他消息，且没有结构化 @ | 当前 Bot 响应 |
| owner 在名单群只 @ 其他人或其他 Bot | 静默 |
| owner 明确 @ 当前 Bot | 沿用现有显式唤醒路径 |
| owner 同时 @ 当前 Bot 和其他账号 | 沿用现有多 mention 行为 |
| 非 owner 在名单群发无 @ 消息 | 静默 |
| `@所有成员` / `@全员` | 不走 owner 免 @ 路径，沿用现有行为 |
| 私聊、评论、卡片回调、reaction | 行为不变 |

路由优先级保持：私聊 / 显式 @ 当前 Bot优先，其后按当前 profile 选择的群响应模式进入对应分支；选择 `owner-allowlist` 时再判断 owner 身份、群名单和 mention 条件。资格判断必须发生在命令、排队、agent run 和工作状态卡片创建之前。

## Command Contract

推荐沿用现有 `/invite` / `/remove` 命令族：

- `@当前Bot /invite owner-default group`：把当前群加入 `ownerNoMentionChats`。
- `@当前Bot /remove owner-default group`：把当前群移出 `ownerNoMentionChats`。

规则：

- 命令只能在目标群执行；私聊执行返回明确错误。
- 添加和删除必须幂等，并回显当前群是否已在名单中。
- 命令只修改 `ownerNoMentionChats`，不修改 `allowedChats` 或 `groupResponseMode`。
- 当 profile 尚未选择 `owner-allowlist` 时，允许预先维护名单，但回复中提示“名单已保存，切换模式后生效”。
- 权限与 `/invite group` 对齐：应用 owner、人类管理员和 Bot 管理员可执行。
- 即使当前群尚未在名单中，也可通过显式 @ 当前 Bot 执行该命令；不接受未 @ 的初始化命令。
- v1 不提供“一次加入 Bot 所在全部群”的批量命令。

## Compatibility, Risk And Validation

- `mention-only`、`owner-default`、`all-messages` 的真值表和配置迁移测试必须保持不变。
- 新名单必须进入访问策略指纹，名单变化后不得错误复用旧 session policy。
- 缺少 `im:message.group_msg` 时继续复用现有授权引导；不新增 scope。
- 最大风险是多个 Bot 在同一群都启用该模式，导致 owner 无 @ 消息被多 Bot 同时响应。v1 接受这一结果，不做中央互斥；配置卡和命令成功提示必须明确当前操作的是“这个 Bot”。
- 自动化测试至少覆盖：配置归一化与旧配置回滚、四种模式无回归、路由真值表、命令权限与幂等、名单不扩大 `allowedChats`、配置卡回显、策略指纹变化。
- 实机验收：同一群放置两个 Bot，只给其中一个 Bot 选择 `owner-allowlist` 并加入当前群；owner 无 @ 发言时只该 Bot 回复，显式 @ 另一个 Bot 时仍只走显式路由。

## Next Phase

产品语义已经确认。后续 Coding Plan 按 `owner-allowlist`、`ownerNoMentionChats`、`/invite owner-default group` 和 `/remove owner-default group` 作为目标契约进行实现拆分；Coding Plan 评审通过前不修改运行代码。
