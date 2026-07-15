# Owner No-Mention Default Response Spec

Date: 2026-07-15
Status: confirmed

## Background

当前群消息路由只有两种行为：群里必须明确 @ 当前 bot，或把所有群消息都交给 agent。后者会让 bot 介入本来发给其他人或其他 bot 的消息，不能满足“小P只承接秦鹏没有指定接收者的群消息”这一需求。

本需求增加一个独立的 owner-default 路由语义：应用 owner 在群里发送消息时，如果没有结构化 @ 任何账号，则默认由当前 bot 回答；一旦存在任何 @，默认响应不生效。

## Goals

- 应用 owner 在群聊或话题群中发送完全没有 @ 的消息时，可以像私聊当前 bot 一样触发回复。
- 只要消息 @ 了任何人或任何 bot，当前 bot 不通过“默认响应”路径介入。
- 明确 @ 当前 bot 时，继续使用现有的显式唤醒路径；本需求不改变单 bot 或多 bot 被同时 @ 时的既有行为。
- 默认响应只属于应用 owner，不扩展给群内其他用户或其他 bot。
- 保持现有访问控制、session、话题隔离、命令和回复形态不变。
- 新行为必须按 profile 显式启用；现有 profile 升级后行为不变。

## Routing Contract

判断依据是飞书事件中的结构化 mention 数据，不解析正文里的纯文本 `@名字`。

| 场景 | 预期 |
| --- | --- |
| owner 发群消息，`mentions[]` 为空且 `mentionAll=false` | 当前 bot 默认回答 |
| owner 只 @ 某个人 | 当前 bot 静默 |
| owner 只 @ 其他 bot | 当前 bot 静默 |
| owner 同时 @ 人和其他 bot，但未 @ 当前 bot | 当前 bot 静默 |
| owner 明确 @ 当前 bot | 当前 bot 按现有显式唤醒逻辑回答 |
| owner 同时 @ 当前 bot 和其他 bot | 完全沿用现有多 bot 显式唤醒行为；当前 bot 仍按既有逻辑回答，其他 bot 是否回答由各自既有路由决定 |
| owner 同时 @ 当前 bot 和其他人 | 完全沿用现有显式唤醒行为，不由 owner-default 路径重新定义 |
| 非 owner 未 @ 当前 bot | 不触发 owner-default；沿用原有群路由策略 |
| 其他 bot 未 @ 当前 bot | 不触发 owner-default |
| `@所有成员` / `@全员` | 完全沿用现有行为，不由本需求重新定义 |
| 私聊、云文档评论、卡片回调、reaction | 行为不变 |

回复、引用某条消息本身不等于 @。只要事件没有结构化 mention，owner-default 仍可触发。

## Configuration And Compatibility

群响应策略需要能表达三种互斥语义：

- `mention-only`：现有默认行为，只响应明确 @ 当前 bot 的群消息。
- `owner-default`：本需求新增行为；owner 无任何 @ 时默认响应，存在任何 @ 时不抢答。
- `all-messages`：保留现有“不要求 @”能力，继续用于已有显式配置。

旧配置必须无损映射到原有语义；不得因为升级自动启用 `owner-default`。小P 的 Codex profile 在功能部署后单独切换到 `owner-default`。

启用 `owner-default` 仍依赖飞书向应用投递非 @ 群消息的权限。复用现有 `im:message.group_msg` 检查和授权引导，不新增授权流程。

## Non-Goals

- 不判断消息正文语义上“像不像在对某个人说话”。
- 不查询群 bot 列表，也不区分 mention 目标是人还是 bot；任何结构化 mention 都足以关闭默认响应。
- 不改变其他 bot 的路由策略或配置。
- 不改变明确 @ 当前 bot 时的现有行为，包括同时 @ 多个 bot 的场景。
- 不改变 `@所有成员` / `@全员` 的现有接收与响应行为。
- 不改变 owner、管理员、群白名单等现有访问权限定义。
- 本 Spec 不包含 Coding Plan、实现拆分或部署步骤。

## Acceptance Criteria

- 路由真值表中的场景都有自动化测试。
- owner-default 判断发生在命令处理、排队和 agent run 创建之前；静默消息不得产生 run、回复或工作状态卡片。
- 显式 @ 当前 bot 的现有行为无回归；同时 @ 当前 bot 和其他 bot 时，各 bot 继续按各自现有路由独立响应。
- 旧配置加载、保存和迁移测试证明默认行为不变。
- 配置界面能选择并正确回显三种群响应策略。
- 缺少非 @ 群消息权限时，继续显示现有授权引导；授权完成后无需修改路由配置。

## Phase Gate

本文件经用户确认后才生成 Coding Plan。Coding Plan 完成后必须由 SubAgent review；review 结论无阻塞项后才允许开始实现。
