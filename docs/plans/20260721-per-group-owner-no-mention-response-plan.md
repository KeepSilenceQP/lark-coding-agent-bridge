# Per-Group Owner No-Mention Response Coding Plan

Date: 2026-07-21
Status: draft — awaiting independent Plan Review
Authority: `docs/specs/20260721-per-group-owner-no-mention-response.md` (confirmed, commit `c1b148b`)
Branch: `feat/per-group-response-mode`
Implementer: 小C

## Outcome

为每个 bridge profile 增加第四种群响应策略 `owner-allowlist`：只有应用 owner 在独立名单 `ownerNoMentionChats` 命中的群里发送「没有结构化 @ 任何账号」的消息时，当前 Bot 才默认响应。现有 `mention-only`、`owner-default`、`all-messages` 及其真值表、配置迁移、`allowedChats` 语义全部不变。显式 @ 当前 Bot、多 Bot 同时 @、`@全员`、私聊、评论、卡片回调、reaction 沿用既有路径。

新增 `/invite owner-default group` 与 `/remove owner-default group` 维护 `ownerNoMentionChats`，不复用 `allowedChats`，不改 `groupResponseMode`。多 Bot 各自独立配置，不做中央互斥。

## Current Evidence

基于 `c1b148b` 的 live code（`owner-default` 第 3 模式已落地于 `b7563f2`，本需求在其之上加第 4 模式）：

- **配置 schema 权威** `src/config/profile-schema.ts`
  - `GroupResponseMode` 类型在 `:20`，当前为 `'mention-only' | 'owner-default' | 'all-messages'`。
  - `ProfileAccess` 接口在 `:22-29`，含 `allowedChats: string[]`（`:24`）与 `groupResponseMode` / `requireMentionInGroup`。
  - `normalizeAccess` 在 `:252-272`：用 `isGroupResponseMode`（`:274-276`）校验模式，`stringArray(...)` 归一化各名单，`requireMentionInGroup = groupResponseMode !== 'all-messages'`（`:270`）。
- **运行时 getter** `src/config/schema.ts:237-263`：`getGroupResponseMode(cfg)` 在 `:244-248` 逐字校验三种模式，`getRequireMentionInGroup` 复用之（`:261-263`）。
- **群响应 policy（纯函数）** `src/bot/group-response-policy.ts:24-42`：顺序 `p2p → mentionedBot → all-messages → mention-only(skip) → owner-default 资格`。owner-default 资格 = `ownerRefreshState==='ok' && botOwnerId===senderId && mentionCount===0 && mentionAll===false`。返回 `{accept, reason}`，reason 含 `'owner-default'` / `'owner-default-not-eligible'`。
- **intake 接入点** `src/bot/channel.ts:1188-1235`：`canUseGroup/canUseDm` access gate → 必要时 bypass → `decideGroupResponse`（`:1218-1227`）→ `tryHandleCommand` → `pending.push`。policy 在命令、排队、run、卡片之前。调用点已有 `msg.chatId`、`controls.profileConfig.access.groupResponseMode`、`controls.botOwnerId`、`controls.ownerRefreshState`、`msg.mentionedBot`、`msg.mentions.length`、`msg.mentionAll`。
- **未开放群 intake bypass** `src/bot/channel.ts:1270-1279` `shouldBypassDeniedChatForInviteGroup`：仅当 `mentionedBot && /\/invite[ \t]+group$/` 且 `canRunBotAdminCommand` 通过时放行。正则严格（尾部 `$`，多一个 token 即不匹配）。
- **access gate** `src/policy/access.ts:43-53` `canUseGroup`：owner（`isCreator`）→ allow；`admins.includes` → allow；`allowedChats.includes` → allow；否则 deny。owner/人类管理员在任何群都过 gate，bypass 主要服务 botAdmin。
- **命令族** `src/commands/index.ts`
  - `handleInvite` `:2213-2330` / `handleRemove` `:2332-2420`：token 小写化，`kind = tokens.find(/^(user|admin|group)$/)`，`group` 分支改 `allowedChats`，幂等回显，p2p 拦截，botAdmin 仅限 `group`。
  - `saveAccessConfig` `:2636-2685`：v2 分支 `:2663-2672` 用 `{...profile, access}` 保留全字段；**legacy 无 root 分支 `:2649-2658` 只投影 `allowedUsers/allowedChats/admins/botAdmins` 四字段**，会丢新字段。
  - `showConfigForm` `:2703-2736` 传 `groupResponseMode/allowedChats/...` 给 `configFormCard`。
  - `submitConfig` `:2766-2956`：`group_response_mode` 解析在 `:2821-2837`（逐字校验三种 + legacy `require_mention_in_group yes/no`）；`savePreferencesConfig` `:3078-3122` 用 `{...profile.access, groupResponseMode, requireMentionInGroup}` 保留其余 access 字段；`promptGroupMsgScopeIfMissing` `:2952` 在 `!== 'mention-only'` 时触发。
- **配置卡** `src/card/config-card.ts`
  - `ConfigFormOpts` `:10-28` 含 `groupResponseMode/allowedChats/...`。
  - mode picker 在 `:233-251`（三选一），描述在 `:225-232`。
  - `configSavedCard` `:310-347` 回显，`groupResponseModeLabel` `:355-359`。
  - 访问控制折叠面板 `accessElements` `:67-107`，`chatList` `:57-63` 渲染群名单。
- **policy fingerprint** `src/policy/fingerprint.ts:47-55` `accessPolicyDigest`：当前 digest `admins/allowedChats/allowedUsers/groupResponseMode/requireMentionInGroup`，名单排序后入指纹。
- **scope** `src/bot/app-scope.ts:7-10` `GROUP_MSG_SCOPE = 'im:message.group_msg'`，注释提到 `owner-default|all-messages`；`hasGroupMsgScope` 与模式无关。
- **迁移** `src/config/migrate-v2.ts:122-132`：v1→v2 经 `createDefaultProfileConfig` + `normalizeAccess`，新字段缺省由 `stringArray` 兜底。

## Design Decisions

### DD1 — 配置模型：第 4 模式 + 独立名单

- `GroupResponseMode` 扩为 `'mention-only' | 'owner-default' | 'all-messages' | 'owner-allowlist'`（`profile-schema.ts:20`）。
- `ProfileAccess` 新增 `ownerNoMentionChats: string[]`（`:22-29`），与 `allowedChats` 相互独立。
- `normalizeAccess` 增加 `ownerNoMentionChats: stringArray(access?.ownerNoMentionChats)`（`:262-272`）；旧配置缺该字段 → `[]`，行为不变。
- `isGroupResponseMode` 增加 `value === 'owner-allowlist'`（`:274-276`）。
- `requireMentionInGroup` 投影不变（`!== 'all-messages'` → owner-allowlist 为 `true`），旧二进制回滚安全降级为 `mention-only`（Spec）。
- `getGroupResponseMode`（`schema.ts:244-248`）校验增加 `owner-allowlist`。
- 模式切换保留名单：`savePreferencesConfig` 已用 `{...profile.access, ...}` 展开，`ownerNoMentionChats` 自然保留；`normalizeAccess` 不会清除。Spec「切换到其他模式时保留名单但不生效，切回后恢复」由路由层（DD2 只在 `owner-allowlist` 分支读名单）保证，无需额外存储。
- `saveAccessConfig` legacy 无 root 分支（`:2649-2658`）需在投影里补 `ownerNoMentionChats: access.ownerNoMentionChats`，否则旧单 profile 路径重载丢失；`access-mutated` 日志（`:2673-2678`）补 `ownerNoMentionChats` 计数。

### DD2 — 群响应 policy：owner-allowlist 分支

- 扩展 `GroupResponsePolicyInput`（`group-response-policy.ts:4-13`）增加 `chatId: string` 与 `ownerNoMentionChats: string[]`。两者在 `channel.ts:1218` 调用点均可用（`msg.chatId`、`controls.profileConfig.access.ownerNoMentionChats`）。
- `GroupResponsePolicyDecision`（`:15-17`）增加 accept reason `'owner-allowlist'`；skip 建议拆两个可检索 reason：`'owner-allowlist-not-eligible'`（owner 身份或 mention 条件不满足）、`'owner-allowlist-chat-not-listed'`（chat 不在名单）。具体先后顺序由实现者定，只要 reason 可检索且行为符合真值表即可。
- 在 `mention-only` skip 之后、owner-default 分支处按 mode 分流：`owner-default` 沿用既有资格；`owner-allowlist` = 既有 owner 资格（`ownerRefreshState==='ok' && botOwnerId===senderId && mentionCount===0 && mentionAll===false`）**且** `ownerNoMentionChats.includes(chatId)`。
- 严格 owner state predicate 不复用宽松 `isCreator`：`ownerRefreshState` 非 `ok` 一律 fail closed（与 owner-default 一致）。显式 @ 当前 Bot 不受影响（`mentionedBot` 分支在前）。
- `msg.chatId` 是群级 id（topic 群 `thread_id` 在 `channel.ts:1173-1175` 单独剥离），按 `chat_id` 命中即覆盖该群主会话与所有话题，无需 `thread_id` 逻辑（Spec：话题群全部 thread 生效）。
- 资格判断发生在命令、排队、agent run、工作状态卡片之前（现有接入点 `:1218` 已满足，不挪位）。

### DD3 — Runtime 真值表（owner-allowlist 下）

| 场景 | 结果 | reason |
| --- | --- | --- |
| owner 在名单群，`mentions=[]` 且 `mentionAll=false` | 响应 | `owner-allowlist` |
| owner 在非名单群发无 @ 消息 | 静默 | `owner-allowlist-chat-not-listed` |
| owner 在名单群回复/引用且无结构化 @ | 响应 | `owner-allowlist` |
| owner 在名单群只 @ 其他人或其他 Bot | 静默 | `owner-allowlist-not-eligible` |
| owner 明确 @ 当前 Bot | 沿用显式唤醒 | `mentioned-bot` |
| owner 同时 @ 当前 Bot 和其他账号 | 沿用多 mention | `mentioned-bot` |
| 非 owner 在名单群发无 @ 消息 | 静默 | `owner-allowlist-not-eligible` |
| `@所有成员` / `@全员` | 沿用现有行为（不走免 @ 路径） | `owner-allowlist-not-eligible`（`mentionAll=true`） |
| 私聊、评论、卡片回调、reaction | 行为不变 | `p2p` 等 |

路由优先级不变：私聊 / 显式 @ 当前 Bot 优先，其后按 profile 模式分支。

### DD4 — 命令：`/invite|/remove owner-default group`

- 在 `handleInvite` / `handleRemove` 中识别 `owner-default` 限定 token。当 tokens 含 `owner-default` 且含 `group` 时，改写 `ownerNoMentionChats` 而非 `allowedChats`。
  - 注意现有 `kind = tokens.find(/^(user|admin|group)$/)` 会把 `group` 选为 kind；需在 `kind==='group'` 分支前先判断 `owner-default` 限定，或扩展 kind 判定。保持 `owner-default` 写法与 Spec 命令契约一致。
- 行为对齐 Spec 命令契约：
  - 只能在目标群执行；`chatType==='p2p'` 返回明确错误（复用现有 `:2273-2276` / `:2357-2360` 文案风格）。
  - 添加/删除幂等，回显当前群是否已在名单。
  - **只改 `ownerNoMentionChats`**，不动 `allowedChats`、不动 `groupResponseMode`。经 `saveAccessConfig` 持久化。
  - 当 `groupResponseMode !== 'owner-allowlist'` 时仍允许维护名单，回显追加「名单已保存，切换到 owner-allowlist 模式后生效」。
  - 权限与 `/invite group` 对齐：owner / 人类管理员 / Bot 管理员可执行。botAdmin 限制（`:2266-2270` / `:2350-2354`）对 `owner-default group` **不触发**（属 group 类操作）。
  - 「不接受未 @ 的初始化命令」由路由策略自然保证：owner-allowlist 下，未入名单群的无 @ 消息被 `owner-allowlist-chat-not-listed` skip，命令无法触达；首次加入必须显式 @ 当前 Bot。命令层不额外加 @ 校验。
  - 回显与配置卡必须明确操作的是「本 Bot」（Spec：多 Bot 同群风险，提示需指明当前 Bot），如「✅ 已把当前群加入**本 Bot** 的 owner 免 @ 名单」。
  - v1 不提供「一次加入 Bot 所在全部群」批量命令；`all group` 批量路径不扩展到 `owner-default`。
- `handleInvite` 用法帮助（`:2256-2263`）/ `handleRemove`（`:2340-2347`）补 `/invite owner-default group` 与 `/remove owner-default group` 说明。

### DD5 — 未开放群 intake bypass 扩展

- `shouldBypassDeniedChatForInviteGroup`（`channel.ts:1270-1279`）正则扩展，使 `@当前Bot /invite owner-default group` 与 `@当前Bot /remove owner-default group` 在未开放群（不在 `allowedChats`）也能经显式 @ 触发，权限仍走 `canRunBotAdminCommand`（owner + 人类管理员 + Bot 管理员）。
- 保持 bypass 窄：仍要求 `mentionedBot`、`chatType!=='p2p'`、内容精确匹配（尾部锚定，拒绝多余 token / 多命令拼接），与现有 `tests/unit/bot/channel-intake.test.ts` 的「keeps the bypass narrow」用例一致。
- 该 bypass 只解决 access gate 拦截；group response policy 仍按 DD2 判断（显式 @ 走 `mentioned-bot` accept，命令可达）。

### DD6 — 配置卡 UX

- `ConfigFormOpts`（`config-card.ts:10-28`）增加 `ownerNoMentionChats: string[]`；`showConfigForm`（`commands/index.ts:2715-2733`）与 `submitConfig` 的 `configSavedCard`（`:2931-2946`）传 `ownerNoMentionChats: access.ownerNoMentionChats`。
- mode picker（`config-card.ts:233-251`）增加第 4 项 `owner-allowlist`「仅在指定群响应 owner 无 @ 消息」；现有三项 value/文案/行为不动。mode 描述（`:225-232`）补第 4 项说明。
- 访问控制折叠面板 `accessElements` 增加独立块展示 `ownerNoMentionChats`（复用 `chatList` 渲染）+ 维护命令 `/invite owner-default group` `/remove owner-default group`，与「允许响应的群」分列，明示两者独立。
- `configSavedCard` 回显（`:335-341`）增加 `ownerNoMentionChats` 摘要与 mode label。
- `groupResponseModeLabel`（`:355-359`）增加 `owner-allowlist` 文案。
- `submitConfig` 的 `group_response_mode` 解析（`:2821-2837`）增加 `owner-allowlist` 接受值；legacy `require_mention_in_group` 兜底不变。
- `promptGroupMsgScopeIfMissing`（`:2952` `!== 'mention-only'`）自动覆盖 `owner-allowlist`，不新增 scope（Spec）。

### DD7 — policy fingerprint

- `accessPolicyDigest`（`fingerprint.ts:47-55`）增加 `ownerNoMentionChats: [...access.ownerNoMentionChats].sort()`，使名单变化产生新指纹，不复用旧 session policy（Spec）。

## Execution Units

每个 Unit 是一个可独立提交的粒度。Unit 1 先 RED，Unit 2-5 实现，Unit 6 实机验收。实现者按序推进，每 Unit 满足自身 Gate 后再进下一个。

### Unit 1 — RED：失败测试先行

Files：
- `tests/unit/bot/group-response-policy.test.ts`（扩 `base` 加 `chatId`/`ownerNoMentionChats`）
- `tests/unit/policy/fingerprint.test.ts`
- `tests/unit/config/profile-schema.test.ts`
- `tests/unit/config/profile-store.test.ts`
- `tests/unit/bot/channel-intake.test.ts`
- `tests/unit/card/config-card.test.ts`
- `tests/integration/config/profile-migration.test.ts`
- `tests/integration/commands/profile-config-command.test.ts`
- `tests/integration/commands/access-config-race.test.ts`（`/invite owner-default group` 并发）
- `tests/integration/bot/bot-at-bot-context.test.ts`（多 Bot 同群独立配置）

Add failing coverage for：
- owner 在名单群无 @ → `owner-allowlist` accept；在非名单群 → skip（chat-not-listed）。
- owner 在名单群只 @ 人/其他 bot、`mentionAll=true`、非 owner、owner state `unknown`/`failed`（含残留 botOwnerId）→ skip（not-eligible）。
- owner 在名单群回复/引用且无结构化 @ → accept。
- 显式 @ 当前 Bot（含同时 @ 其他账号）→ `mentioned-bot` accept，不受模式影响。
- `mention-only` / `owner-default` / `all-messages` 行为与真值表无回归。
- `ownerNoMentionChats` 缺省归一化为 `[]`；load→save→reload 双字段一致；切到其他模式名单保留、切回恢复。
- `ownerNoMentionChats` 进 `accessPolicyDigest`，名单增删改变指纹；`allowedChats` 不变时指纹仍随名单变。
- `/invite owner-default group` / `/remove owner-default group`：幂等、回显已在/不在、p2p 拦截、只改 `ownerNoMentionChats`（断言 `allowedChats` 与 `groupResponseMode` 不变）、非 `owner-allowlist` 模式下回显「切换后生效」、botAdmin 可执行、人类管理员可执行。
- bypass 放行 `@bot /invite owner-default group` 与 `@bot /remove owner-default group`，仍拒绝多余 token / 无 @ / 非 botAdmin。
- 配置卡：第 4 选项存在、回显含 `ownerNoMentionChats`、access 面板分列展示。
- intake skip 在 command / pending queue / agent run / card 之前；显式 @ 仍走既有 run 路径。

Gate: targeted tests must fail for missing behavior before production edits.

### Unit 2 — 配置模型 + 指纹 + 迁移

Files：
- `src/config/profile-schema.ts`（类型、`ProfileAccess`、`normalizeAccess`、`isGroupResponseMode`）
- `src/config/schema.ts`（`getGroupResponseMode` 校验）
- `src/policy/fingerprint.ts`（`accessPolicyDigest`）
- `src/commands/index.ts`（`saveAccessConfig` legacy 分支投影 + 日志，`:2649-2658` / `:2673-2678`）

Changes：
- 按 DD1 扩 schema 与归一化；按 DD7 扩指纹。
- legacy 投影补 `ownerNoMentionChats`，日志补计数。
- `getRequireMentionInGroup` 无需改（投影天然正确）。

Gate: `profile-schema` / `profile-store` / `fingerprint` / `profile-migration` targeted tests pass；旧配置（无 `ownerNoMentionChats`、三种旧模式）digest 与归一化结果不变。

### Unit 3 — 路由 policy + intake 接入

Files：
- `src/bot/group-response-policy.ts`（input 字段、reason、owner-allowlist 分支）
- `src/bot/channel.ts`（`:1218-1227` 调用点传 `chatId` + `ownerNoMentionChats`）

Changes：
- 按 DD2/DD3 实现 owner-allowlist 分支与严格 owner state predicate。
- 不挪动 access gate / 显式 mention / 命令 / queue / topic scope 顺序。
- skip 仅打可检索日志 reason，不发提示、不建状态卡。

Gate: `group-response-policy` 单测与 `bot-at-bot-context` / `access-gate` 集成测试通过；现有 owner-default / topic 测试无回归；集成测试证明 skip 在 command/queue/run/card 之前。

### Unit 4 — 命令 + bypass

Files：
- `src/commands/index.ts`（`handleInvite` / `handleRemove` 的 `owner-default group` 分支、用法帮助）
- `src/bot/channel.ts`（`shouldBypassDeniedChatForInviteGroup` 正则扩展）

Changes：
- 按 DD4 实现命令族：识别 `owner-default` 限定、幂等、p2p 拦截、只改 `ownerNoMentionChats`、非 owner-allowlist 模式回显提示、权限对齐 `/invite group`、回显指明「本 Bot」。
- 按 DD5 扩 bypass，保持窄匹配。
- v1 不加批量命令。

Gate: `profile-config-command` / `access-config-race` / `channel-intake` targeted tests pass；`/invite group` / `/remove group` 旧命令无回归。

### Unit 5 — 配置卡 + echo + 文档

Files：
- `src/card/config-card.ts`（`ConfigFormOpts`、mode picker、access 面板、`configSavedCard`、`groupResponseModeLabel`）
- `src/commands/index.ts`（`showConfigForm` / `submitConfig` 传 `ownerNoMentionChats`、`group_response_mode` 解析接受 `owner-allowlist`）
- `src/bot/app-scope.ts`（注释补 `owner-allowlist`，仅文档）
- `README.md` / `README.zh.md`（四种模式说明、默认值、owner-allowlist 边界、新命令）

Changes：按 DD6 实现第 4 选项、独立面板、回显与 label；现有三项不动。文档说明四种模式、`ownerNoMentionChats` 与 `allowedChats` 独立、多 Bot 独立配置。

Gate: `config-card` / `profile-config-command` / `readme-contract` 测试通过。

### Unit 6 — 实机验收

After code gates pass：
1. 构建本 worktree 产物，先核对全局 CLI 软链 / daemon 入口可解析（不复用失效路径），再重启目标 profile。
2. 仅把验收用 Bot profile 切为 `owner-allowlist`，其他 access 不变；`/invite owner-default group` 把测试群加入名单。
3. 验证 daemon、profile config readback、日志无启动错误；`/config` 卡回显第 4 选项与名单正确。
4. 真实消息矩阵（记录每条 msgId、哪些 Bot 实际回复、intake/run 日志 reason）：
   - owner 在名单群无 @ → 仅本 Bot 回复。
   - owner 在非名单群无 @ → 静默。
   - owner 在名单群只 @ 其他人/其他 Bot → 静默。
   - owner 明确 @ 本 Bot → 走显式路由。
   - 非 owner 在名单群无 @ → 静默。
   - `@全员` → 沿用现有行为。
5. 多 Bot 验收（Spec 实机验收）：同群放两个 Bot，仅其中一个选 `owner-allowlist` 并加入当前群；owner 无 @ 发言时只该 Bot 回复，显式 @ 另一个 Bot 时仍只走显式路由。

Runtime PASS 需 config readback + Feishu 行为证据双全；仅单测 / 构建 / 进程存活不算完成。

## Verification Commands

```bash
pnpm install --frozen-lockfile
pnpm exec vitest run \
  tests/unit/bot/group-response-policy.test.ts \
  tests/unit/policy/fingerprint.test.ts \
  tests/unit/config/profile-schema.test.ts \
  tests/unit/config/profile-store.test.ts \
  tests/unit/bot/channel-intake.test.ts \
  tests/unit/card/config-card.test.ts \
  tests/integration/config/profile-migration.test.ts \
  tests/integration/commands/profile-config-command.test.ts \
  tests/integration/commands/access-config-race.test.ts \
  tests/integration/bot/bot-at-bot-context.test.ts
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

部署后命令以 live CLI / service discovery 为准。

## Rollback

- 配置回滚：profile 切回 `mention-only` 或 `owner-default`，owner 无 @ 消息立即停止经 owner-allowlist 进入 agent；`ownerNoMentionChats` 保留但失效。
- 二进制回滚：旧二进制读 `requireMentionInGroup`（owner-allowlist 下为 `true`）→ 安全降级为 `mention-only`；`ownerNoMentionChats` 字段被旧 `normalizeAccess` 忽略（`stringArray` 兜底），不破坏加载。
- 若 `im:message.group_msg` 授权或事件投递不稳定，保留代码但不启用 `owner-allowlist`。

## Known Risks / Open Points（供 Plan Review 裁）

- **多 Bot 同群同时响应**：v1 接受，不做中央互斥（Spec）。配置卡与命令回显已要求指明「本 Bot」，但同群多 Bot 都开 `owner-allowlist` 且都加入名单时，owner 无 @ 消息会被多 Bot 同时响应——这是 Spec 明确接受的 v1 结果，非缺陷。
- **「不接受未 @ 的初始化命令」的实现位置**：本 Plan 选择不在命令层加额外 @ 校验，而是由路由策略自然保证（未入名单群的无 @ 消息被 skip）。一旦某群已在名单内，owner 无 @ 的 `/remove owner-default group` 会被路由接受并执行（owner 自移除）。若 Review 认为「任何 `/remove owner-default group` 都必须显式 @」，需在命令层补 `mentionedBot` 守卫——这会与 owner-allowlist 路由语义产生边角交互，请 Review 明确。
- **bypass 正则扩展范围**：本 Plan 让 bypass 覆盖 `/invite|/remove owner-default group`。现有 bypass 不覆盖 `/remove group`（移除 allowedChats）。若 Review 要求 `/remove owner-default group` 与 `/remove group` 对齐（都不走 bypass），botAdmin 在未开放群移除 ownerNoMentionChats 将被 access gate 拦截——需 Review 定边界。
- **legacy 无 root 配置路径**：`saveAccessConfig` legacy 分支需补投影，否则旧单 profile 安装重载丢失名单。该路径在 v2 安装下不可达，但为正确性仍修。

## Review Gate

本 Plan 必须由独立 SubAgent（小P）对照 confirmed Spec（`c1b148b`）与 live code review。只有 review 结论为 PASS，或所有阻塞项已修订并复审通过，才开始 Unit 1 实现。Plan Writer 不给自己的 Plan 判 GO。
