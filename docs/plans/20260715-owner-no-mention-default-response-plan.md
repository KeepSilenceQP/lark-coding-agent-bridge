# Owner No-Mention Default Response Coding Plan

Date: 2026-07-15
Status: reviewed — PASS
Authority: `docs/specs/20260715-owner-no-mention-default-response.md` (confirmed)
Branch: `feat/owner-no-mention-default-response`

## Outcome

为每个 bridge profile 增加第三种群响应策略 `owner-default`：应用 owner 在群聊或话题群中发送完全没有结构化 mention 的消息时，当前 bot 默认响应；任何显式 mention、`@所有成员`、非 owner 消息和其他 bot 消息均不通过新增路径。显式 @ 当前 bot 的既有行为保持不变。

## Current Evidence

- `src/bot/channel.ts` 在 access gate 之后，仅用 `getRequireMentionInGroup(...) && !msg.mentionedBot` 决定是否静默；决策发生在命令处理和 pending queue 之前。
- `NormalizedMessage` 已提供 `mentionedBot`、`mentions[]` 和 `mentionAll`，无需查询群成员或 bot 列表。
- `Controls.botOwnerId` 与 `ownerRefreshState` 已提供动态 owner 身份。Live code 的 `isCreator(...)` 只在 state=`unknown` 时拒绝；state=`failed` 时可能继续使用残留的 `botOwnerId`。该行为属于现有 access gate，本需求不得假设它已经 fail closed。
- `src/bot/app-scope.ts` 与 `/config` 已能检查并引导授权 `im:message.group_msg`，可复用于 `owner-default`。
- 当前 profile schema、配置卡和 policy fingerprint 仍以 `requireMentionInGroup: boolean` 表达两种模式。

## Design Decision

### 1. Canonical group response mode

在 profile access 配置中增加：

```ts
type GroupResponseMode = 'mention-only' | 'owner-default' | 'all-messages';
```

`controls.profileConfig.access.groupResponseMode` 是 intake 路由和 `/config` 的唯一运行时权威。为兼容旧配置、旧配置卡和旧二进制回滚，继续保存一致的 `requireMentionInGroup`：

| `groupResponseMode` | legacy `requireMentionInGroup` |
| --- | --- |
| `mention-only` | `true` |
| `owner-default` | `true` |
| `all-messages` | `false` |

profile normalize/load 时优先采用合法的 `groupResponseMode`；字段缺失时按旧布尔值映射：`false -> all-messages`，其余情况 -> `mention-only`。保存时始终重写为一致字段，消除漂移。`controls.cfg` 上的 legacy getter 不得再参与新 intake 路由决策。

### 2. Pure routing decision

新增一个可单测的纯策略函数，输入当前消息、group response mode 和 owner identity，输出 accept/skip 及稳定 reason。顺序固定为：

1. 私聊：交回原逻辑。
2. `mentionedBot=true`：accept，确保单 @、多 bot 同时 @、同时 @ 人等显式唤醒行为不变。
3. `mention-only`：skip。
4. `all-messages`：保持现有行为；不在本需求内增加额外过滤。
5. `owner-default`：仅当 `ownerRefreshState==='ok'`、`botOwnerId===senderId`、`mentions[]` 为空且 `mentionAll=false` 时 accept；其余 skip。

该函数接在现有 access gate 之后、`tryHandleCommand` 和 `pending.push` 之前。owner 信息缺失、state=`unknown`、或 state=`failed`（即使仍残留匹配的 `botOwnerId`）时均 fail closed；显式 @ 当前 bot 不受影响。该严格判断只属于 owner-default，不修改现有 access gate 的 owner/admin 语义。

### 3. Configuration UX

把 `/config` 中“群里需要 @ bot”的二选一改为三选一：

- 仅明确 @ bot 时响应（默认）
- owner 未 @ 任何账号时默认响应
- 所有群消息都响应（兼容旧能力）

新表单提交 `group_response_mode`。提交处理继续接受旧卡片的 `require_mention_in_group=yes|no`，避免用户点击升级前已发出的配置卡时失败。保存成功卡和 README 同步展示三种语义。

`owner-default` 与 `all-messages` 都需要非 @ 群消息投递权限，因此两者都复用现有 scope 检查和授权卡；授权文案从特指“群里不需要 @ bot”调整为“接收群里非 @ 消息”。

## Execution Units

### Unit 1 — RED: routing and config compatibility tests

Files:

- `tests/unit/bot/group-response-policy.test.ts`（新增）
- `tests/integration/bot/bot-at-bot-context.test.ts`（扩展现有 `startChannel`/fake channel harness）
- `tests/unit/config/profile-schema.test.ts`
- `tests/unit/config/profile-store.test.ts`
- `tests/integration/config/profile-migration.test.ts`
- `tests/integration/commands/profile-config-command.test.ts`
- `tests/unit/policy/fingerprint.test.ts` 或现有对应测试文件

Add failing coverage for:

- owner 无 mention -> owner-default accept。
- owner @ 人、@其他 bot、`mentionAll=true` -> owner-default skip。
- 明确 @ 当前 bot，包括同时 @ 其他 bot -> accept。
- 非 owner、bot sender、owner identity `unknown` -> skip。
- owner refresh `failed` 且残留匹配的 `botOwnerId` -> skip，证明新增路径不接受 stale owner。
- mention-only 与 all-messages 保持旧行为。
- 旧 `true/false` 配置映射、新 enum 优先级、保存后的双字段一致性。
- 旧表单字段与新表单字段都能提交。
- policy fingerprint 随 group response mode 改变。
- intake skip 不进入 command、pending queue、agent run、stream/card；显式 @ 当前 bot及多 bot 同时 @ 仍进入既有 run 路径。

Gate: targeted tests must fail for missing behavior before production edits.

### Unit 2 — Config model and migration

Files:

- `src/config/profile-schema.ts`
- `src/config/schema.ts`
- `src/config/profile-store.ts`（如序列化需显式规范化）
- `src/config/migrate-v2.ts`
- `src/policy/fingerprint.ts`

Changes:

- 定义并规范化 `GroupResponseMode`。
- 提供 config normalize/resolver；intake 和 `/config` 直接读取 `controls.profileConfig.access.groupResponseMode`，不经 `controls.cfg` legacy 投影。
- 保留 `getRequireMentionInGroup(...)` 兼容 resolver，但不得再作为新路由的权威语义。
- 迁移与序列化保持旧配置、旧二进制安全降级和 policy fingerprint 一致。
- 加载 -> 保存 -> 再加载 readback 必须保持 enum/legacy 双字段一致；用旧字段 normalize 的测试证明回滚时 `owner-default -> mention-only`、`all-messages -> all-messages`。

Gate: config/schema/migration/fingerprint targeted tests pass.

### Unit 3 — Intake routing

Files:

- `src/bot/group-response-policy.ts`（新增）
- `src/bot/channel.ts`

Changes:

- 实现纯策略函数和稳定 skip reason，owner-default 使用严格 owner state predicate，不复用宽松的 `isCreator(...)`。
- 在现有 group mention gate 位置接入，保持 access gate、显式 mention、命令、queue、topic scope 顺序不变。
- 为 `owner-default` skip 增加可检索日志 reason；不得发送提示消息或创建状态卡。

Gate: routing matrix单测与 intake 集成测试通过；集成测试证明 skip 在 command/queue/run/card 之前，且现有 bot-at-bot 和 topic tests pass.

### Unit 4 — `/config`, scope prompt, docs

Files:

- `src/card/config-card.ts`
- `src/commands/index.ts`
- `src/bot/app-scope.ts`
- `README.md`
- `README.zh.md`
- 相关 card/docs contract tests

Changes:

- 配置卡三选一、回显和保存。
- 兼容旧卡 submit payload。
- 两种非 @ 模式复用 scope 授权检查并更新中英文文案。
- 文档说明三种模式、默认值和 owner-default 边界。

Gate: config command/card tests and docs contract tests pass.

### Unit 5 — Profile activation and verification

After code gates pass:

1. 构建 feature worktree 产物。
2. 先检查当前全局 CLI 软链和 launchd/daemon 实际入口；当前已知 `/opt/homebrew/lib/node_modules/lark-channel-bridge` 指向已不存在的 `bridge_bugfix`，不得直接重启后才发现入口断裂。
3. 修复 CLI 入口到可验证构建，再重启 Codex profile；不改 Claude profile 的响应模式。
4. 仅把 Codex profile 切换为 `owner-default`，保持其他 access 配置不变。
5. 验证 daemon、WS、profile config readback 和日志无启动错误。
6. 在测试群完成真实消息矩阵：无 @、@ 人、@ 其他 bot、@ 小P、同时 @ 小P和其他 bot、`@所有成员`。记录每条消息 ID、哪些 bot 实际回复和小P intake/run 日志。

Runtime PASS requires both config readback and Feishu behavior evidence；只通过单测、构建或进程存活不算完成。

## Verification Commands

```bash
pnpm install --frozen-lockfile
pnpm exec vitest run \
  tests/unit/bot/group-response-policy.test.ts \
  tests/integration/bot/bot-at-bot-context.test.ts \
  tests/unit/config/profile-schema.test.ts \
  tests/unit/config/profile-store.test.ts \
  tests/integration/config/profile-migration.test.ts \
  tests/integration/commands/profile-config-command.test.ts
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

部署后的命令以 live CLI/service discovery 为准，不复用失效的 `bridge_bugfix` 路径。

## Rollback

- 配置回滚：把 Codex profile 切回 `mention-only`，非 @ 消息立即停止进入 agent。
- 二进制回滚：旧二进制读取一致的 legacy boolean；`owner-default` 安全降级为 `mention-only`，`all-messages` 保持 `false` 语义。
- 如果非 @ scope 授权或事件投递不稳定，保持代码但不启用 `owner-default`。

## Review Gate

本 Plan 必须由独立 SubAgent 对照 confirmed Spec 和 live code review。只有 review 结论为 PASS，或所有阻塞项已修订并复审通过，才开始 Unit 1 实现。

Review result: PASS. 首轮 CONDITIONAL 的 strict owner predicate、intake 集成验收和 canonical config authority 三项问题均已修订并复审通过。
