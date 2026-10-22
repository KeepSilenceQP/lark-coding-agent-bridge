# 按群要求话题首条显式 @ 当前 Bot

日期：2026-10-23

## 需求

用户在话题群中并行跟进多个事项，希望新话题只有显式 @ 当前 Bot 才启动处理；
后续回复继续使用已配置的群响应策略，不以 Bot 是否有该话题的历史会话作为门槛。

## 行为与配置

- 新增可选配置 `access.topicRootRequireMention?: Record<string, boolean>`，按群隔离，缺省及 `false` 均保持原行为。
- 开启群内该规则后，话题首条无结构化 @ 当前 Bot 时静默退出，不回复、不进入任务队列、不启动或打断 Agent。仅文字包含 Bot 名称、@ 其他账号或 @all 不满足要求。
- 首条显式 @ 当前 Bot 后，继续执行原权限与群响应检查，不因此扩大用户权限。
- 后续回复按原 `mention-only`、`owner-default`、`owner-allowlist`、`all-messages` 及已有按群覆盖策略处理；即使 Bot 未参与首条、没有该话题的历史 session，也可按策略响应。
- 覆盖 `chat_mode=topic` 和 `chat_mode=group, group_message_type=thread`；不能因首条事件缺少 `threadId` 就将它当成普通聊天绕过规则。
- 普通 `group/chat`、私聊和 Reaction 不受此开关限制。Reaction 保留自身权限和语义规则。
- 开启规则时，若无法可靠判断无 @ 消息的群模式或首条/回复身份，则静默忽略；默认关闭保持兼容。

owner 或管理员可在目标群显式 @ 当前 Bot 后发送：

```text
/config topic-root-mention on
/config topic-root-mention off
```

Web 控制台提供对应群的独立开关，保存相同配置。

## 分类依据

从群详情读取 `chat_mode` 与 `group_message_type`，结合事件的 `threadId`、`rootId`
和 SDK 实际提供的 `replyToMessageId` 判断消息位置。必要时读取原始消息补齐
`thread_id`、`root_id`、`parent_id`；不得依赖历史 session 判断“首条”。

## 验收

真实 Channel 测试覆盖无 @ 首条静默、显式 @ 后执行、缺 `threadId` 的普通群话题首条、
元数据失败时拒绝误启动、关闭开关兼容、无历史会话的后续回复、原访问权限，以及
普通聊天/私聊/Reaction 不受误拦。配置、命令和 Web 保存流程有独立回归覆盖。
