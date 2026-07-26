# Shared Bot Registry And Named Project Roles — Coding Plan

Date: 2026-07-26
Status: Plan Review GO（Implementation Ready）
Spec authority: `docs/specs/20260726-shared-bot-registry-and-named-project-roles.md`（branch `feat/project-role-assignment` @ `2d47a21`，Status: confirmed by Qin Peng）
Target branch: `feat/project-role-assignment`（本轮修订基线 `8df2991`；实现前必须先过 G0 base-sync gate）
Plan Writer: HistoryRedactedBot2（初稿，当前 unavailable）；本地 Codex subagent（接替本轮 Plan 修订；不实现、不自审、不部署）
Plan Reviewer: HistoryRedactedBot4（Coordinator，独立 Review）
Implementer: 按当前群绑定的 Implementer actor
Code Reviewer: 按 Harness 由 Plan Writer actor 派生，实现完成后独立审查增量

> 本 Plan 不重写需求。所有产品合同、兼容性断点与验收以 Spec 为准；本文件只把 Spec 落到真实模块、依赖、顺序、Execution Units、完成条件与 gate。Spec 与当前代码冲突处单列在「Resolved Decisions」与「Known Issues / Blockers」，不静默裁定。

## Outcome

交付 Spec 的两段不可分割变更：

1. Bot Registry 从 Bridge 源码迁移到安装级共享 Root Config：空默认值、fail-closed 校验、profile 自注册、`bot-registry` CLI 增删查、零 profile 与 export 语义。
2. `/project bootstrap` 切换为具名角色参数：`/project bootstrap <workspace> --plan-writer <bot-name> --implementer <bot-name>`，位置顺序不再承载角色语义，旧位置语法明确拒绝。

并完成发布卫生：当前内容隐私清理 + `npm pack` tarball denylist 扫描 + 远端坏 commit 可达范围记录。远端历史改写**不属于**本需求，只列为 Decision Owner 单独授权 gate（见文末 G11）。

## Review History

- 2026-07-26 HistoryRedactedBot2：基于 `2d47a21` 全文读取 Spec + 全量源码勘察（RootConfig、profile 生命周期、CLI、bootstrap runtime、tokenizer、测试与打包布局），产出本 Plan 草稿。Plan Writer 不自审。
- 2026-07-26 Coordinator Plan Review：结论为 CHANGES REQUESTED，共 5 条 finding，涉及 tracked tree 隐私口径、create-time 锁边界、真实 tarball 扫描生命周期、最终 Code Review 顺序和 Plan 进度责任。
- 2026-07-26 本地 Codex subagent：原 Writer HistoryRedactedBot2 unavailable 后临时接替 Plan Writer，逐条 Receiving 并修订本 Plan；未担任 Plan Reviewer，未实施代码、测试、配置、部署或远端历史操作。
- 2026-07-26 Coordinator 独立复审：5 条 finding 均已闭合，Plan Review `GO`；允许从 G0 开始，尚未授权或完成任何 Execution Unit。

## Current Code Evidence

以下事实来自本分支 `2d47a21` 真实源码（行号为撰写时位置，实现时以最新 base 为准）：

**Root Config 层**

- `src/config/profile-schema.ts:133-141`：`RootConfig` 接口为 `{schemaVersion: 2, activeProfile, preferences, secrets?, migrations?, profiles}`，**没有 `botRegistry`**。
- `src/config/profile-store.ts:24-38` `normalizeRootConfig()` 与 `:69-83` `serializeRootConfig()` 只重建已声明字段——手工塞进 JSON 的 `botRegistry` 会在读写后丢失（与 Spec Current Evidence 一致）。`:171-175` `isRootConfig()` 只校验 `schemaVersion === 2 && profiles`。
- `:102-122` `withConfigFileLock()` 基于 `proper-lockfile`（`config.json.lock`，stale 30s，retries 10）；`:40-42` `saveRootConfig()` 走 `writeFileAtomic` + `0600`。
- `:155-169` `createRootConfig()` 建初始 Root Config；`:223-270` `removeProfile()` 在最后一个 profile 删除后已会把 `activeProfile` 置 `''`（`:235-237`）。

**Profile 生命周期**

- `src/cli/commands/profile.ts:189-191`：**当前删除最后一个 profile 时会 `rm(configFile)` + `rm(activeProfileFile)` 整个 Root Config**——与 Spec「零 profile 保留安装级 Root Config 和 Registry」直接冲突，必须改。
- 同文件 `:245-253` `runProfileExport()` 是从零构造新 Root Config 再导出，按构造不含任何多余安装级字段——export 不携带 Registry 是构造性成立的，但需要测试锁定，防未来有人改成 spread。
- `src/runtime/profile-runtime.ts:452-460` `resolveBootstrapAppConfig()` 调 `validateAppCredentials()`（`src/utils/feishu-auth.ts:63` 返回 `{ok, botName, botOpenId}`），**botName 当前只用于打一行日志后被丢弃**——create-time 自注册的数据源已存在。
- 同文件 `:207-224` 全新创建路径 `createRootConfig()` → `saveRootConfig()`；`:227-271` `bootstrapProfileIntoExistingRoot()` 用 spread 保留既有 root 字段加新 profile，但**不设置 `activeProfile`、不写 active-profile 指针**——零 profile 状态下 create 会留下 `activeProfile: ''` 的缺口。
- 同文件 `:143-162`：`rootConfig` 存在但 profile 缺失时，只有 `allowBootstrap && explicitProfile` 才走补建；`run --allow-bootstrap` 不带 `--profile` 时会 `throw profile not found`——零 profile 状态下 `run --allow-bootstrap` 的直接缺口。
- `src/cli/commands/profile.ts:109-135` 只有 `runProfileCreate()` 在外层持有 `withConfigFileLock()` 后调用 `resolveProfileRuntime()`；`src/cli/commands/start.ts:85-91` 的 `runStart()` 与 `src/cli/commands/service.ts:116-136` 的 `ensureBridgeConfigured()` 均直接调用 `resolveProfileRuntime({allowBootstrap: true})`，当前 create/bootstrap 写路径本身不持锁。因 `proper-lockfile` 锁不是可重入锁，不能简单在 `resolveProfileRuntime()` 内再套锁而保留 `runProfileCreate()` 外层锁。

**CLI 层**

- `src/cli/index.ts:72-136` profile 命令组注册方式（commander）；新增 `bot-registry` 命令组照此模式。全 CLI 无 registry 相关命令。

**`/project bootstrap` runtime**

- `src/commands/index.ts:712-741` `parseProjectBootstrapRequest()`：**空白切分、要求恰好 3 个位置参数**，无引号 tokenization、无 flag 概念；`:696`、`:717` 两处用法文案均为旧位置语法。
- `:1034-1037`：Registry 来自 `mergeRegistry(defaultRegistry(), (profileConfig as {botRegistry?...}).botRegistry ?? [])`——hardcoded 个人默认值 + profile config 临时断言，**不读共享 Root Config**。
- `:780-794` `resolveCoordinatorBootstrapWorkspaceInput()`：相对路径用 coordinator entry 的 `machines[].local.root` 拼接——machines 删除后需改为直接透传。`src/policy/workspace.ts:26` `resolveWorkingDirectory()` 用 `realpath(trimmed)`，相对路径天然相对 Coordinator 进程 cwd 解析，与 Spec 语义一致。
- 副作用顺序现状（`:1072-1281`，per-chat `withProjectBootstrapLock` 内）：live discovery → workspace 解析 → `disableProjectRoleAssignment('bootstrap_incomplete')`（`:1127-1138`）→ cwd 切换 + session 清理（`:1140-1145`）→ 群准入（`:1147-1153`）→ 邀请缺席 Bot（`:1155-1164`）→ 有界重 discovery（`:1165-1177`，4 次 × 150ms）→ 三 actor open_id 互异检查（`:1179-1188`）→ 派发 `/invite group` + `/cd`（`:1207-1238`）→ 全部成功才 `updateProjectRoleAssignment`（`:1266-1281`）。**与 Spec canonical flow 已结构一致**，本轮只需换 Registry 来源、entry 形态与解析入口，不重排副作用。
- `src/project/bot-registry.ts:163-198` `defaultRegistry()` 含 4 条真实个人 entry（Bot 名 + App ID + 本机/devbox 路径 + projectRoot）；`:25-36` `BotRegistryEntry` 含 `role/machines/projectRoot`；`:111-119` `resolveWorkspacePath()`、`:121-159` pin 系列（`PinnedBinding/checkPinnedIdentity/pinBinding`，调用方只传空 Map，实质死代码）、`:200-209` `mergeRegistry()` 均随最小化删除。
- `src/project/dispatch.ts` `planBootstrap()` 依赖 entry 的 `role === 'bridge'`（`:312`）与 `resolveWorkspacePath` fallback（`:359-364`），随 entry 最小化收敛；`input.workspacePath` 原样透传语义保留（Spec 第 8 条）。

**首次 WS identity 落点**

- `src/bot/channel.ts:1769-1784`：`channel.connect()` 之后立即读 `channel.botIdentity` 并 `agent.setBotIdentity?.()`——首次取得可信 `botIdentity.name` 的唯一既有观察点，补登记 hook 落于此；该处可访问 `controls.configPath` 与 `cfg.accounts.app.id`。

**打包与文档**

- `package.json` `files` 仅 `dist/bin/README.md/README.zh.md/NOTICE.md/LICENSE/vendor`——docs、tests 不进 npm 包；但 `defaultRegistry()` 会编译进 `dist`，tarball 扫描是真实必要 gate。`prepack` 现有 `tools/check-npm-bundle.mjs` 只校验 `@larksuite/channel` 闭包，无隐私扫描；`.github/workflows/ci.yml` 的 `package-smoke` 已执行真实 `npm pack`，但尚未在 clean-install 前扫描其实际 `.tgz`。
- 旧语法文档：`README.md:199`、`README.zh.md:198` 命令表；`README.md:20`、`README.zh.md:19` feature 表。`src/agent/bridge-system-prompt.ts:29` 只提 `projectRoleAssignment` 注入语义，不含命令语法与个人值，无需改。
- 个人值当前分布（grep 实证）：源码 `src/project/bot-registry.ts`；测试 `tests/unit/project/bot-registry.test.ts`、`tests/unit/project/dispatch.test.ts`、`tests/integration/commands/commands-v1.test.ts:614-800`、`tests/acceptance/azu-group-prompt-router.live.test.ts`、`tests/acceptance/azu-group-prompt-router.worker.test.ts`；文档 `docs/plans/20260721-azu-group-prompt-bug-confirmation-gate-plan.md`、`docs/plans/20260722-bot-at-primitive-plan.md` 及 `docs/agent-context/**` 历史证据档案（14 个文件）。
- 坏 commit：`665ad74`（feat: add project bootstrap orchestration）、`a0464f7`（fix: validate project bootstrap bot targets），已在 `origin/main`。

**Base 差异（只读确认，未 merge/rebase）**

- merge-base：`9688914`；`origin/main` @ `593f0dc` 领先 6 commit，本分支领先 2 commit。
- main 侧 6 commit 触及 `src/card/text-renderer.ts`、`src/config/keystore.ts` 及测试等 8 文件；与本分支改动文件**零重叠**（`comm -12` 为空），预期 base-sync 无冲突。

## Design Decisions

### DD1 — Registry 类型与 domain 校验归属配置层

新增 `src/config/bot-registry.ts` 承载持久化合同与校验：`BotRegistryEntry = {name: string; aliases: string[]; appId: string}`（内部字段名与持久化合同完全一致，消除 dual naming）、`BotRegistry = {entries: BotRegistryEntry[]}`。domain 函数：`validateBotRegistry(input): BotRegistry`（结构/trim 非空/NFC 全局唯一：canonical 与 alias 跨 entry 唯一、appId 跨 entry 唯一，违反即 throw 可诊断错误）、`matchRegistryEntry(registry, name)`（NFC 完整精确匹配，返回 entry | notFound | ambiguous）、`normalizeRegistryName()`（trim + 去开头 `@` + NFC）。不依赖 `src/project/*`；`src/project/bot-registry.ts` 改为从这里 re-export 类型或删除后由调用方直引（实现可选，测试口径不变）。

### DD2 — fail-closed 边界：缺失归一化为空，存在即严格

`RootConfig` 增加可选 `botRegistry?: BotRegistry`。`normalizeRootConfig()`：字段缺失 → `botRegistry: {entries: []}`；字段存在 → 必须过 `validateBotRegistry()`，任何结构/entry/唯一性错误都 throw（load fail closed），**不得**归一化为空或部分保留。`serializeRootConfig()` 显式持久化该字段；`createRootConfig()` 初始写 `{entries: []}`。所有写路径（`saveRootConfig` 调用方）先在内存构造合法整体再写，校验失败时文件字节不变（锁内 read-modify-write，复用 `withConfigFileLock` + `writeFileAtomic`，不新建锁机制）。schemaVersion 保持 2。

### DD3 — Profile 生命周期与自注册（create 路径）

- `resolveBootstrapAppConfig()` 返回值扩展带出 `botName`（已有数据源，不新增权限/请求）。
- create/bootstrap 采用**单一锁拥有者**策略，复用现有 `withConfigFileLock`，不引入第二种锁，也不允许同一调用链嵌套获取同一个 config 锁：`resolveProfileRuntime()` 所有入口共同到达的 create/bootstrap 提交边界负责且只负责一次锁获取；`runProfileCreate()` 不再在调用该边界时持有外层同锁。交互式凭据取得、agent 探测等不依赖 Root Config 一致性的准备可在锁外完成，但最终提交必须在锁内重新 `loadRootConfig()`，重新校验目标 profile/Registry 冲突，并在同一份最新 root 上合并 profile、`botRegistry`、`activeProfile` 后一次 `saveRootConfig()`；锁外早先读取的 root 不能直接保存。
- 上述共同提交边界必须覆盖 `runStart()`、`service start` 的 `ensureBridgeConfigured()`、`profile create` 以及 existing-zero-profile bootstrap；全新 Root Config 与 `bootstrapProfileIntoExistingRoot()` 两条路径若取得 `botName`，均在这次**同一个受锁 Root Config 更新**内按 `{name: botName, aliases: [], appId}` 调 DD4 的幂等登记。实现可按现有控制流抽取内部 locked/unlocked seam，但 Plan 不预设未经源码验证的函数名或公开 API。
- 零 profile：`runProfileRemove` 删最后一个 profile 时改为**保留** Root Config：写 `activeProfile: ''`、`profiles: {}`、保留 `botRegistry` 与 `secrets`，仅 `rm(activeProfileFile)` 删除失效指针，不再 `rm(configFile)`。
- 零 profile 后续：`bootstrapProfileIntoExistingRoot()` 补「`activeProfile` 为空时置为新 profile 并 `writeActiveProfile`」；`resolveProfileRuntime()` 的 `!profileConfig` 分支放宽为 `allowBootstrap && (explicitProfile ?? 可推导 profile)`，使零 profile 下 `run --allow-bootstrap`（无 `--profile`）也能补建——两条修复都附回归测试。
- `runProfileExport()` 维持构造性排除 Registry（不 spread root），新增测试断言默认与 `--include-secrets` 两种导出都不含 `botRegistry`。

### DD4 — 自注册幂等合同（`upsertSelfRegistration(registry, {name, appId})`）

按 `appId` 幂等，三态：不存在 → 新增；存在且 `{name, aliases, appId}` 完全一致 → no-op；同 `appId` 不同 canonical name，或名称被另一 entry 占用 → 不静默覆盖，返回冲突结果由调用方给出可诊断错误并提示 `bot-registry` CLI 修正。该纯函数放 `src/config/bot-registry.ts`，create 路径（DD3）与 first-WS 路径（DD5）共用。

### DD5 — 首次 WS identity 补登记

在 `src/bot/channel.ts:1769` 既有 identity 观察点之后：若 `botIdentity.name` 与 `cfg.accounts.app.id` 齐备，调独立服务函数（建议 `src/project/self-registration.ts` 或 `src/config/bot-registry-service.ts`，实现可选）做锁内 load → DD4 upsert → save。失败只留可诊断错误日志（`log.warn/fail`），**不阻断**已建立的消息连接、不抛出到 connect 路径。成功 no-op 不打噪音日志。该路径不新增任何租户权限。

### DD6 — `bot-registry` CLI（新增 `src/cli/commands/bot-registry.ts`，注册于 `src/cli/index.ts`）

`add --name <name> --app-id <cli_xxx> [--alias <alias>...]` / `list` / `remove --name <canonical-name>`。合同：只操作当前 `LARK_CHANNEL_HOME` Root Config，不提供 `--profile`；`loadRootConfig()` 为 `undefined`（未初始化）→ 明确报错并引导先初始化；`profiles: {}` 的已初始化 root → 正常允许。`add`：完全相同 → 成功 no-op；任何名称/appId 冲突 → 失败且文件不变。`list`：只输出 canonical name、aliases、appId。`remove`：只接受 canonical name NFC 精确匹配（0 或多个候选都失败）；entry 的 `appId` 命中任一现存本地 profile 的 `accounts.app.id` → 拒绝并说明（删除 profile 不级联删 entry）。全部修改走锁 + 原子写，校验失败文件字节不变。

### DD7 — 具名参数 tokenizer/parser（新增 `src/project/bootstrap-args.ts`，纯函数）

两层纯函数：`tokenizeBootstrapArgs(input): {ok, tokens} | {ok: false, reason}`（单/双引号包裹含空格 token；引号只参与 tokenization，不展开 `$`、反引号、转义序列；未闭合引号报错）；`parseBootstrapCommand(tokens)`：恰好 1 个位置参数（workspace）+ `--plan-writer`、`--implementer` 各恰好一次且值非空；未知 flag、多余位置参数、重复 flag、空值均报错并返回 canonical 用法；flag 顺序任意、语义等价。Bot 名归一化（trim + 去 `@` + NFC）后交给 Registry 匹配。**旧位置语法显式拒绝**：第 2/3 个位置参数或非 flag token 序列命中旧形态时，错误文案明确「旧语法已废弃，请使用具名参数」，不做兼容映射。`handleProject`（`commands/index.ts:688-698`）与 `:696`/`:717` 用法文案同步切换；README en/zh 命令表与 feature 表同版本切换。

### DD8 — bootstrap runtime 迁移共享 Registry + entry 最小化

- `src/project/bot-registry.ts` 精简：`BotRegistryEntry` 收敛为 DD1 三字段；删除 `defaultRegistry()`、`mergeRegistry()`、`resolveWorkspacePath()`、`BotRole`、`MachineWorkspace`、pin 系列死代码（`PinnedBinding/checkPinnedIdentity/pinBinding` 及 `dispatch.ts` 内 `pinned` 参数与 `identity_changed` 分支——pinned 只被传空 Map，`identity_changed` 现实不可达；`BlockedReason` 同步收敛）。
- `commands/index.ts:1034-1037` 改为经 `loadRootConfig()` 读共享 Root Config 的 `botRegistry` 快照（读取失败/配置无效 → 副作用前 fail，文案含可诊断原因）；删除 profile config 断言路径。
- workspace 解析：`resolveCoordinatorBootstrapWorkspaceInput()` 删 machines 拼接——绝对/`~` 按现有 `expandTilde` 语义，相对路径直接透传给 `resolveWorkingDirectory()`（其 `realpath` 即相对进程 cwd，天然符合 Spec）。
- 两个角色解析、三 actor 互异（entry 层 + live open_id 层）、副作用顺序、`bootstrap_incomplete` 语义、有界重 discovery、派发与原子保存全部沿用现有实现；`/cd` 派发继续原样发送用户输入文本。
- `src/project/dispatch.ts`：`planBootstrap()` 随 entry 最小化收敛（删 role gate 与 workspace fallback）；invite 只用 `entry.appId`。

### DD9 — 隐私清理与 denylist 口径

清理范围是**全部 tracked current tree**：源码、全部测试/fixture、README、命令示例、新文档以及所有旧 tracked docs（含 `docs/plans/**`、`docs/agent-context/**`）。denylist = 4 个真实 App ID + 本机/devbox 两个机器根路径 + 4 个真实个人 Bot 名；四类真实值一律改为角色化或虚构占位，tree 扫描必须全树零命中，**不按历史证据目录、文件类型或叙述语义提供任何豁免**。旧文档的事件语义用 `Planner Bot`、`Implementer Bot`、`cli_example_*`、`/redacted/...` 等占位保留；真实值的追溯由 Git 历史及 G11 的远端可达范围记录承担，不在 current tree 复制一份“历史证据”。

新增 `tools/check-privacy-denylist.mjs`，tree/dist/tarball 三种输入均对完整 denylist 硬失败且无路径 allowlist。由于真实 denylist 自身也不得以明文进入 tracked tree，工具从受保护的仓外/未跟踪输入接收真实模式；仓内测试只使用明确虚构 fixture，发布 gate 缺少真实 denylist 输入即失败，不能退化成跳过。`prepack` 只做打包生成前的 tree + 当前 dist 门禁（并保留 `check-npm-bundle.mjs`），不得声称验证尚未产生的 `.tgz`。

另建真实 pack-and-verify 流程：在临时目录执行实际 `npm pack`，取得本次生成的 `.tgz` 后调用 tarball 模式解包扫描，再把**同一份已扫描 tarball**交给现有 `package-smoke` clean-install；该流程同时接入发布前 gate。最终验收报告必须给出 tracked tree、dist、实际 tarball 三者全 denylist 零命中，并将「当前内容清理」与 G11「历史 remediation」分开陈述。

### DD10 — 混合版本为安装级原子迁移，非滚动升级

schemaVersion 保持 2 只表示新版读旧配置兼容；旧版保存会丢 `botRegistry`，因此升级/回滚都按 Spec 的 stop-all-old-writers 门禁执行。本需求交付：升级 runbook（枚举停止旧 writers → 备份 → 升级 → 验证无旧 PID/artifact → 启动自注册 → 写入其它 entries → 回读验证）+ 回滚 runbook（停新 writers → 备份 → 恢复旧版 → Registry 暂只存于备份 → 重新升级时恢复）+ 受控进程验收证据。不在代码里造版本协商机制（Spec Non-Goals）。

## Execution Units

所有单元初始未完成。Implementer 每单元只正式回传结果、diff 边界与验证证据，不自行编辑本 Plan checkbox/status；Coordinator 按完成条件 Receiving，更新对应 checkbox/status并提交该同步后，才派发下一单元。未满足完成条件时由 Coordinator 保持未勾选并回传缺口。

### Gate G0 — Base-sync（实现前必须过） Owner: Implementer

- [ ] 完成

**目标**：把 `origin/main@593f0dc` 合入 `feat/project-role-assignment`，让实现在最新 base 上进行。
**依据**：merge-base `9688914`；main 领先 6、分支领先 2；改动文件零重叠（勘察实证），预期无冲突。
**步骤**：fetch → `git merge origin/main`（或等价 ff 不了的 rebase，由 Implementer 择一并说明）→ 全量 `pnpm ci:local` 基线绿。
**完成条件**：merge 后 HEAD 包含 `593f0dc` 全部祖先；`git diff --check`、`pnpm ci:local` 通过；若出现任何冲突或基线红 → 停止，把冲突文件与基线失败回传 Coordinator，不在冲突状态上开始 Unit 1。
**最小验证**：`git log --oneline --merges -1`；`pnpm ci:local` 输出存档。

### Unit 1 — RootConfig `botRegistry` 持久化合同 Owner: Implementer

- [ ] 完成

**目标**：DD1 + DD2。配置层类型、校验、归一化、序列化、锁内往返。
**准确落点**：新增 `src/config/bot-registry.ts`；改 `src/config/profile-schema.ts:133`（`RootConfig` 加字段）、`src/config/profile-store.ts:24-38`（normalize）、`:69-83`（serialize）、`:155-169`（createRootConfig 初始空 Registry）、`:171-175`（isRootConfig 语义不变）。
**依赖**：G0。
**完成条件**：缺失字段往返稳定归一化为 `{entries: []}`；字段存在但结构错误/entry 无效/名称或 appId 冲突时 load 与所有修改路径 fail closed 且文件不被重写；profile create/use/remove 往返 `botRegistry` 不丢失；不新增锁机制。
**最小测试**：新增 `tests/unit/config/bot-registry.test.ts`（validate/匹配/归一化矩阵）；扩展 `tests/unit/config/profile-store.test.ts` 往返用例（缺失→空、有效保留、无效 fail closed 且文件字节不变）。

### Unit 2 — Profile 生命周期：create 自注册、零 profile、export 排除 Owner: Implementer

- [ ] 完成

**目标**：DD3 + DD4。
**准确落点**：`src/runtime/profile-runtime.ts:429-470`（`resolveBootstrapAppConfig` 带出 botName）、`:207-224` 与 `:227-271`（两条创建路径锁内幂等登记 + `bootstrapProfileIntoExistingRoot` 补 activeProfile 语义）、`:143-162`（`!profileConfig` 分支放宽）、`src/cli/commands/profile.ts:189-191`（零 profile 保留 root）、`:245-253`（export 维持构造性排除）。
**依赖**：Unit 1。
**完成条件**：凭据校验返回 botName 时，新 profile 在 DD3 单一锁拥有者的同一更新内完成 `{name, aliases: [], appId}` 登记（含 QR wizard 未取得名字时不登记、不留半成品）；`runStart`、`service start`、`profile create` 与 existing-zero-profile bootstrap 都走同一锁内最终重读/冲突复核/合并/保存合同，且无嵌套死锁；同 appId 重复 create/冲突按 DD4 三态；删除最后 profile 后 root 存在（`activeProfile: ''`、`profiles: {}`、Registry 保留）、active-profile 指针删除、`bot-registry list/add/remove` 可用；零 profile 下 `profile create` 与 `run --allow-bootstrap` 均能新增 profile、保留旧 Registry 并恢复 active 指针；export 两种模式均不含 `botRegistry`。
**最小测试**：扩展 `tests/integration/cli/profile-create.test.ts`、`profile-retention.test.ts`（零 profile 往返）；新增 `tests/unit/config/bot-registry.test.ts` upsert 三态；export 排除断言（integration cli）；增加跨入口并发测试，至少并发覆盖 `runStart` / `service start` / `profile create` 对同一 Root Config 的 create/bootstrap 竞争及 existing-zero-profile 与另一入口竞争，断言超时内完成、无死锁、每个成功 profile 与 Registry entry 均保留、activeProfile 合法且最终配置可重新加载。

### Unit 3 — 首次 WS identity 幂等补登记 Owner: Implementer

- [ ] 完成

**目标**：DD5。
**准确落点**：登记服务函数（`src/config/bot-registry-service.ts` 或 `src/project/self-registration.ts`）；hook 于 `src/bot/channel.ts:1769` identity 观察点后。
**依赖**：Unit 2（复用已落地的 DD4 函数与锁边界）。
**完成条件**：首次 connect 取得 `botIdentity.name` 且 registry 无此 appId → 补登记成功；完全一致 → no-op；冲突 → 可诊断错误日志且不覆盖；登记失败（含锁超时、磁盘错误）不影响消息收发，connect 流程不因此失败。
**最小测试**：服务函数单测（新增/ no-op/冲突/失败不抛）；fake-channel 集成测试断言 connect 后 Root Config 出现 entry、消息流正常。

### Unit 4 — `bot-registry` CLI add/list/remove Owner: Implementer

- [ ] 完成

**目标**：DD6。
**准确落点**：新增 `src/cli/commands/bot-registry.ts`；`src/cli/index.ts` 注册命令组。
**依赖**：Unit 1；零 profile 语义依赖 Unit 2。
**完成条件**：DD6 全部合同成立，含未初始化 vs 零 profile 区分、add 幂等 no-op、冲突不改文件、remove 的 canonical-only 匹配与本机 profile 占用拒绝、list 输出不含 secret/完整配置。
**最小测试**：新增 `tests/unit/cli/bot-registry.test.ts`（参数与输出合同）+ `tests/integration/cli/bot-registry.test.ts`（锁内并发 add、冲突、零 profile、占用拒绝、文件字节不变）。

### Unit 5 — 具名参数 tokenizer/parser + 帮助文本 Owner: Implementer

- [ ] 完成

**目标**：DD7（纯解析层 + 文案，不接 runtime）。
**准确落点**：新增 `src/project/bootstrap-args.ts`；`src/commands/index.ts:688-741` 换用新 parser、更新 `:696`/`:717` 用法文案；`README.md:20,199`、`README.zh.md:19,198` 同版本切换。
**依赖**：无（纯函数独立）；与 Unit 6 并行可，合入顺序在 Unit 6 前。
**完成条件**：DD7 全部解析规则；旧位置语法显式拒绝且失败发生于任何 runtime 副作用前（由 Unit 6 集成测试最终锁定）；两处 README 与命令内 usage 均为具名语法。
**最小测试**：新增 `tests/unit/project/bootstrap-args.test.ts`：两种 flag 顺序等价、单/双引号名称与 workspace、`@` 前缀、NFC、缺失/重复/未知 flag、额外位置参数、空值、未闭合引号、旧语法拒绝、引号不触发展开（`$HOME`/反引号按字面保留）。

### Unit 6 — bootstrap runtime 迁移共享 Registry + entry 最小化 Owner: Implementer

- [ ] 完成

**目标**：DD8。
**准确落点**：`src/project/bot-registry.ts`（精简）、`src/project/dispatch.ts`（收敛）、`src/commands/index.ts:753-794,1034-1070,1072-1300`（Registry 来源、workspace 输入解析、角色解析接 Unit 5 parser）。
**依赖**：Unit 1、Unit 5。
**完成条件**：`defaultRegistry()` 及全部个人默认值从源码消失；命令只读共享 Root Config Registry；两个名称任一未登记即副作用前失败且错误含缺失名称与 `bot-registry add` 指引；三 actor 互异（entry + open_id 两层）保持；workspace 解析失败保持旧绑定不变、预检后失败旧绑定 `bootstrap_incomplete` 且副作用准确报告（现有语义回归）；`/cd` 文本原样发送；pin 死代码删除后无残留引用。
**最小测试**：重写 `tests/unit/project/bot-registry.test.ts`、`tests/unit/project/dispatch.test.ts`；扩展 `tests/integration/commands/commands-v1.test.ts:614-800`（具名语法、未登记含指引、旧语法拒绝且零副作用、workspace 失败绑定不变、`bootstrap_incomplete` 副作用报告、三 actor 互异、多匹配 blocked）——测试数据全部改用虚构 Bot 名/App ID（如 `Planner Bot`/`cli_test_planner`）。

### Unit 7 — 隐私清理 + denylist 工具 + 远端可达范围记录 Owner: Implementer

- [ ] 完成

**目标**：DD9。
**准确落点**：新增 `tools/check-privacy-denylist.mjs` 与真实 pack-and-verify runner；`package.json` 的 `prepack` 接 tree/dist 前置门禁、发布前 gate 接实际 pack-and-verify；`.github/workflows/ci.yml` 的 `package-smoke` 改为扫描实际产出的同一 `.tgz` 后再 clean-install；清理 Current Code Evidence 列出的全部命中（源码/测试已在 Unit 6 处理的部分除外）。
**依赖**：Unit 6（源码/单测/集成测试清零之后）；tarball 扫描依赖 `pnpm build`。
**完成条件**：tracked tree 扫描 4 个 App ID + 2 个机器根路径 + 4 个真实个人 Bot 名全仓零命中，覆盖源码、测试/fixture、README 与所有新旧 tracked docs，无历史文档豁免；dist 同样零命中；临时目录中实际 `npm pack` 产生的 tarball 解包扫描全 denylist 零命中，且同一已扫描 tarball 通过现有 package-smoke clean-install；`prepack` 不冒充 tarball 后验；发布前 gate 必须执行真实 pack-and-verify；`git ls-remote` + 已 fetch 全部 branches/tags 记录 `665ad74`/`a0464f7` 当前可达范围，报告分别陈述「当前内容清理」与「历史 remediation」状态，不把前者表述成后者。
**最小测试**：`tests/unit/tools/check-privacy-denylist.test.ts`（tree/dist/tarball 命中、无路径豁免、虚构占位、缺少真实 denylist 输入 fail closed）；真实 pack-and-verify 的流程测试；清理报告（markdown，随 PR 证据提交，内容本身同样不得复写真实 denylist）。

### Unit 9 — 混合版本升级/回滚 runbook + 受控验收 Owner: Implementer

- [ ] 完成

**目标**：DD10。
**准确落点**：`docs/` 下新增升级与回滚 runbook（归入实现文档目录约定）；受控进程验收脚本或手工记录。
**依赖**：Units 1–7 全部完成。
**完成条件**：runbook 覆盖 Spec Coordinated Upgrade Gate 全序列与 rollback 序列；受控验收证明：旧版 artifact 在运行中被全部停止前不写 `botRegistry`；升级后旧 PID/旧 artifact 不能再覆盖 Root Config（可用旧版二进制对备份配置实测其 save 丢字段行为并记录）；验收证据区分「新装」「升级」「回滚再升级」三路径。
**最小测试**：迁移测试或受控进程验收记录（证据附 PR）。

### Gate G8 — Final Code Review Owner: Code Reviewer（Plan Writer actor 派生）

- [ ] 通过

**依赖**：Unit 9。Unit 9 可能新增 tracked runbook、脚本或证据，必须先完成再进入本 Gate。

对 G0 之后的**全部**本需求增量做最终独立受限预算 Code Review，覆盖实现、测试、README、新旧文档清理、runbook、工具脚本、CI/package-smoke 与发布前 gate；只审本 Plan 对应 diff + 必要最小上下文，复用验证证据不无意义重复执行。重点 Registry fail-closed 边界、单一锁拥有者与跨入口并发、自注册幂等、tokenizer 安全、bootstrap 副作用顺序、tracked tree 零豁免和真实 tarball gate。无 blocker/high 且 finding 完成 Receiving 才 GO；Implementer 只回传修复与证据，Coordinator 更新 G8 checkbox/status 并提交同步。

### Unit 10 — live acceptance + 全量验证 Owner: Implementer（live 由 Decision Owner 在场授权执行）

- [ ] 完成

**目标**：Spec Runtime Acceptance 全行。
**步骤**：新装或按 Unit 9 runbook 升级的安装上：两 profile 首次取得身份后同 Root Config 出现两条 entry 且无 profile-local 副本；注册一个不在测试群的 Bridge Bot，仅凭名称完成邀请/discovery/原生派发/绑定；已注册 Bot 在群内时不重复邀请、直接用 live `open_id`；真实群验收记录命令文本、邀请前后 Bot 列表、解析出的 live `open_id`、两条派发结果、最终 `projectRoleAssignment`，证据区分「邀请成功」「派发成功」「绑定持久化成功」。
**依赖**：Gate G8。
**完成条件**：上述证据齐备；`pnpm ci:local` 通过；最终远端 commit CI 绿；对最终待发布 commit 重做 Unit 7 tree/dist + 实际 tarball 扫描。Unit 10 原则上只采集外部/未跟踪 live 证据；若为修复验收问题或沉淀证据产生任何 tracked 修改，必须回到 G8 对 G0 后最终全量 diff 重新 Review，通过后才能重新完成 Unit 10。

### Gate G11 — 远端历史 remediation（Decision Owner 单独授权，不属于本需求执行范围）

- [ ] Decision Owner 已确认 targets 与兼容影响（本需求内不执行）

删除/重写已共享的 main、tag、release 中 `665ad74`/`a0464f7` 可达的个人数据属破坏性 release remediation。未获 Decision Owner 对具体 targets 与兼容影响的单独确认前，任何人不得改写远端历史，也不得把 Unit 7 的「当前内容已清理」表述成「历史已清理」。

## Acceptance Coverage Matrix（Spec 验收行 → Unit/Gate）

**Source And Config**

| Spec 验收 | 覆盖 |
| --- | --- |
| 全部 tracked tree（源码/测试/fixture/README/新旧 docs）+ `git log origin/main..HEAD -p` 无真实个人 Bot 名/App ID/本机路径；无历史文档豁免；`defaultRegistry()` 不再返回个人条目 | Unit 6（删除）+ Unit 7（全树零命中 gate 与报告；Git 历史承担追溯） |
| RootConfig 新建/读/归一化/保存/profile 往返 `botRegistry` 不丢，缺失稳定归一化为空 | Unit 1 |
| 结构错误/entry 无效/冲突 fail closed，文件不被重写为空 | Unit 1 + Unit 4（CLI 修改路径） |
| 删最后 profile 后 RootConfig/Registry 存在且可继续 CLI；新建 profile 保留旧 Registry；export 不携带 | Unit 2 + Unit 4 |
| add/list/remove、自注册、冲突、跨 run/service/profile-create/zero-profile 入口并发锁、原子写入单测 | Unit 1/2/3/4 |
| 配置与 CLI 输出无 App Secret 泄露 | Unit 1/4（输出合同）+ Unit 7（denylist 含 secret 形态检查时可扩展，本版 denylist 不含 secret 值） |
| 混合版本迁移测试或受控进程验收 | Unit 9 |

**Parser And Command**

| Spec 验收 | 覆盖 |
| --- | --- |
| 两种 flag 顺序同结果 | Unit 5 |
| 引号/`@`/NFC/缺失/重复/未知 flag/额外位置/空值/未闭合引号 | Unit 5 |
| 旧位置语法明确拒绝，失败在副作用前 | Unit 5（拒绝）+ Unit 6（零副作用集成断言） |
| 未登记/冲突/群内多匹配/角色相同/角色等于 Coordinator fail closed | Unit 6（未登记含 `bot-registry add` 指引） |
| workspace 解析失败保持旧绑定；预检后失败 `bootstrap_incomplete` + 副作用准确报告 | Unit 6 |

**Runtime Acceptance**

| Spec 验收 | 覆盖 |
| --- | --- |
| 新装空共享 Registry；两 profile 首次身份后同 Root Config 无 profile-local 副本 | Unit 2/3 + Unit 10 |
| 仅名称邀请不在群 Bot 完成邀请/discovery/派发/绑定 | Unit 10（live） |
| 已在群不重复邀请，直接用 live `open_id` | Unit 10（live） |
| 真实群验收完整证据链 | Unit 10 |
| `pnpm ci:local` + 最终 commit CI + G0 后全部 tracked 增量独立 Review | G0 起每单元 + Unit 9 + G8 + Unit 10；Unit 10 有 tracked 修改则重跑 G8 |
| tracked tree/dist 零豁免扫描 + 实际 `npm pack` tarball 扫描 + 远端可达范围 + 两类状态分别报告 | Unit 7 + G8 + Unit 10 终审 |

**Spec 行为合同（非验收段）兜底**：Target Configuration Contract → Unit 1；Registry Lifecycle（初始化/自注册/remove 保护/零 profile/export）→ Unit 1-4；Command Contract（canonical syntax/解析规则/Runtime Flow 9 步与 9 条规则）→ Unit 5/6；Migration & Release Hygiene → Unit 7/9 + G11；Security And Privacy → Unit 1/4/6/7。

## Verification Commands

```bash
pnpm ci:local                                   # git diff --check && pnpm test && pnpm typecheck && pnpm build
pnpm test:unit                                  # 单元层
pnpm test:integration                           # 集成层
node tools/check-privacy-denylist.mjs --tree    # Unit 7 新增：受保护输入提供真实 denylist；工作树全量扫描
node tools/check-privacy-denylist.mjs --dist    # 已生成 dist 扫描
pnpm verify:package                             # Unit 7 新增：临时目录执行真实 npm pack，扫描实际 tgz；不得用 --dry-run
git log origin/main..HEAD -p | grep -E '<denylist 模式>'   # 增量历史扫描（应为空）
git ls-remote origin                            # 坏 commit 可达范围记录输入
```

## Rollback

代码回滚：revert 本分支增量（G0 merge 保持）。配置回滚按 Unit 9 runbook：停止全部新版 writers → 备份 Root Config → 恢复旧版 artifact → 接受 Registry 暂时只存在于备份 → 重新升级时恢复。不得重新发布含个人 Registry 的 commit。

## Resolved Decisions（不推迟实现）

1. **内部字段名与持久化合同一致**（`name/aliases/appId`，DD1），消除 canonicalName/name 双命名；`src/project/*` 存量引用随 Unit 6 收敛。
2. **pin-on-first-verify 系列作为死代码删除**（DD8）：调用方只传空 Map，`identity_changed` 不可达；Spec 明确 Registry 不持久化 `open_id`，每次 bootstrap 以 live 列表为准。
3. **current tracked tree 不保留历史文档豁免**（DD9）：真实个人 Bot 名、App ID 与机器路径在源码、测试、README 和全部新旧 tracked docs 中统一改为角色化/虚构占位并全树零命中；Git 历史承担追溯，G11 单独记录坏 commit 可达范围。
4. **denylist 与打包生命周期分层**（DD9）：隐私扫描独立于 `check-npm-bundle.mjs`；真实 denylist 来自不进入 tracked tree 的受保护输入且缺失时 fail closed。`prepack` 只做 tree/dist 前置门禁；实际 tarball 必须由临时目录中的真实 pack-and-verify 后验扫描，并接入 package-smoke 与发布前 gate。
5. **tokenizer 手写约 60 行纯函数**，不引入新依赖（引号语义简单且必须保证不展开）。
6. **base-sync 采用 merge 而非 rebase**（保留分支已 push 历史；Implementer 若选 rebase 须在回传中说明并确认无人基于旧分支工作）。

## Known Issues / Blockers

无（Planning 阶段）。G0 若出现非预期冲突或基线红，按 G0 完成条件停止并回传，即转为 blocker。

## Plan Review Gate

Coordinator 独立复审已确认首轮 5 条 finding 全部闭合，Plan Review `GO`。接替 Writer 未实现、未自审，也未作为 Reviewer；Implementation 只允许从 G0 开始，并按每单元正式回传、Coordinator 回写状态、再派下一单元的顺序推进。
