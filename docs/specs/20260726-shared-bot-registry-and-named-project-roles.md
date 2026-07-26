# Shared Bot Registry And Named Project Roles Spec

Date: 2026-07-26
Status: confirmed by Qin Peng

## Recommendation And Decision Requested

把 `/project bootstrap` 依赖的 Bot 清单从 Bridge 源码迁移到当前 Bridge 安装根目录的共享 Root Config，并把 Plan Writer、Implementer 从位置参数改为显式具名参数：

```text
/project bootstrap <workspace> --plan-writer <bot-name> --implementer <bot-name>
```

两个角色参数的先后顺序不影响语义；角色只由 key 决定。安装初始化时生成空 Registry，当前安装中的 profile 在取得可信 Bot 显示名后自动登记自身，其它 Bot 通过本地 CLI 显式增删。

本 Spec 请求确认上述产品合同、兼容性断点和迁移边界。确认后再编写 Coding Plan；本阶段不修改运行代码、不部署 Bridge。

## Context, Goals And Non-Goals

### Problem

当前分支已能让 `/project bootstrap` 按 Bot 名称查找、邀请 Bot、获取当前群 live `open_id` 并保存角色绑定，但 Registry 默认值包含特定用户的 Bot 名、App ID、机器路径和仓库路径。该信息属于某次安装的运行配置，不应进入 npm 包、源码或远端 Git 历史。

当前命令还使用：

```text
/project bootstrap <workspace> <implementer> <plan-writer>
```

这让角色含义依赖参数顺序。相同的两个名字交换位置就会交换角色，不符合显式角色绑定的要求。

### Goals

- 同一 Bridge 安装根目录下的所有 profiles 共享一份 Bot Registry。
- 官方源码、发布包和远端 Git 历史的默认 Registry 为空，不包含用户环境信息。
- profile 能在安装/创建流程中自动登记自身；其它 Bot 可通过稳定 CLI 管理。
- 用户仅凭已登记的 Bot 名就能让 `/project bootstrap` 在当前群查找或邀请该 Bot。
- Plan Writer 与 Implementer 通过具名 key 绑定，参数顺序不再承载角色语义。
- 所有参数和 Registry 预检在邀请、派发、覆盖绑定等副作用之前完成。

### Non-Goals

- 不申请或依赖 `admin:app.info:readonly`，不做租户级“我创建的全部应用”搜索。
- 不从任意飞书显示名自动发现未登记 Bot。
- 不在 Registry 中保存 App Secret、token、cookie、`open_id` 或其它凭据。
- 不在 Registry 中保存 workspace、本机/devbox 根目录或项目路径映射。
- 不改变 sayToLittleP Harness Core、角色职责或工作流启动语义。
- 不提供跨设备的中心化 Registry 同步服务；“共享”只指同一 Bridge 安装根目录内跨 profile 共享。

## Current Evidence

以下事实来自本分支 `7697b591040842e3f47ab5be73ac027ed99151bc` 和
`origin/main@593f0dce7e75a446a7cb811a04194ca2c9291499`：

- `src/project/bot-registry.ts` 的 `defaultRegistry()` 直接包含特定 Bot 名、App ID、本机/devbox 路径和项目根。
- `BotRegistryEntry` 仍包含 `role`、`machines`、`projectRoot`，超出了“按名称邀请 Bridge Bot”所需的最小数据。
- `RootConfig` 当前没有 `botRegistry`；`normalizeRootConfig()` 和 `serializeRootConfig()`只重建已声明字段，因此仅把字段手工塞进 JSON 会在读写后丢失。
- `/project bootstrap` 当前用空白切分并要求恰好三个位置参数，帮助文本也仍以位置表达 Implementer 与 Plan Writer。
- 命令当前从 profile config 的临时类型断言读取 Registry，而不是从共享 Root Config 读取。
- Bridge 在凭据校验或 WebSocket 连接成功后已经能取得 Bot 显示名；自注册无需新增租户应用列表权限。
- hardcoded 个人 Registry 已经通过 `665ad74` / `a0464f7` 进入 `origin/main`，并非只存在于本地 checkpoint。清理当前源码只能阻止后续包继续携带；远端历史和既有发布物的处置必须作为显式 release remediation，不能再以“从未 push”作为默认前提。

已知能力边界：群 Bot live discovery 返回当前群中的 Bot 身份，可用于获取当次绑定的 `open_id`；配置中的 `appId` 只用于邀请不在群内的 Bot，不能替代 live discovery。

## Target Configuration Contract

### Ownership And Shape

Registry 是 Root Config 的正式字段，与 `profiles` 同级：

```json
{
  "schemaVersion": 2,
  "botRegistry": {
    "entries": [
      {
        "name": "Example Planner",
        "aliases": ["Planner"],
        "appId": "cli_example"
      }
    ]
  },
  "profiles": {}
}
```

`BotRegistryEntry` 的持久化合同只有：

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Bot 的 canonical display name |
| `aliases` | yes | 可用于命令输入和 live 全名匹配的其它名称；可为空数组 |
| `appId` | yes | Bot 不在当前群时使用的邀请目标 |

Root Config 继续使用 schema version 2，但这只表示新版本对旧配置文件兼容，不表示新旧 Bridge 进程可以在同一安装根目录混合写入。旧版本会在保存 Root Config 时丢弃未知字段，因此启用 Registry 必须经过下文的 stop-all-old-writers 升级门禁。

缺失 `botRegistry` 时归一化为 `{entries: []}`，不能回退到源码内置个人数据。字段一旦存在但其结构、entry 内容或全局唯一性无效，整个 Root Config 加载必须 fail closed，报告可诊断配置错误且不得保存；不能把损坏 Registry 当成空 Registry。Root Config 的读取、归一化、序列化和 profile 创建/使用/删除路径都必须显式保留该字段。

Registry 文件沿用 Root Config 的原子写入、文件锁和 `0600` 权限。`appId` 不是 Secret，但不得把 Root Config 内容作为普通日志输出。

### Validation And Identity Rules

- `name`、每个 alias 和 `appId` 去除首尾空白后必须非空；名称统一按 NFC 比较。
- 一个名称（canonical 或 alias）只能属于一个 entry；一个 `appId` 只能属于一个 entry。
- 名称匹配只允许 NFC-normalized 的完整精确匹配，不做 substring、前缀或模糊匹配。
- Registry 不持久化 `open_id`。每次 bootstrap 都从当前群 live Bot 列表获得当次 `open_id`。
- `appId` 是受信本地配置的邀请 locator，不宣称能够从群成员 `open_id` 反向证明 App ID。
- live 列表中对某个 entry 出现零个或多个名称匹配时，不得猜测：零个时进入邀请流程，多个时立即 blocked。

## Registry Lifecycle And CLI

### Initialization And Self-Registration

- 新安装或首次创建 Root Config 时必须生成 `botRegistry: { entries: [] }`，源码默认值也必须为空。
- 新 profile 的凭据校验若已返回 Bot 显示名，则在同一个受锁的 Root Config 更新中按 `{name, aliases: [], appId}` 登记自身。
- 若初始化阶段尚未得到显示名，则在该 profile 第一次成功建立 Bridge 连接、取得可信 `botIdentity.name` 后补登记；登记失败不得伪装成成功，应留下可诊断错误，但不能阻断已经建立的消息连接。
- 自注册以 `appId` 幂等：不存在则新增；完全相同则 no-op；同一 `appId` 已绑定不同 canonical name，或名称已被另一 entry 占用时不得静默覆盖，提示使用 CLI 显式修正。
- Registry entry 的 `appId` 对应仍存在的本地 profile 时，`remove` 必须拒绝，避免下一次使用出现“本机 Bot 未登记”的隐性状态。删除 profile 不自动删除共享 entry，因为同一 Bot 可能仍在另一设备运行。
- 删除最后一个 profile 后仍保留安装级 Root Config 和 Registry，写成 `activeProfile: ""`、`profiles: {}`，并删除失效的 `active-profile` 指针。后续 `profile create`/`run --allow-bootstrap` 必须能从该零 profile 状态新增 profile，而不是把现有 Registry 当成未初始化配置覆盖。
- `profile export <name>` 是单 profile 导出，默认且在 `--include-secrets` 下都不携带安装级 Bot Registry，避免把其它 Bot 清单意外带出。Registry 导入/导出不属于本 Spec；本版通过 CLI 管理并通过 Root Config 备份完成安装级迁移。

### Local Management Commands

提供以下本地 CLI：

```text
lark-channel-bridge bot-registry add --name <name> --app-id <cli_xxx> [--alias <alias>...]
lark-channel-bridge bot-registry list
lark-channel-bridge bot-registry remove --name <canonical-name>
```

合同：

- 三个命令只操作当前 `LARK_CHANNEL_HOME`/安装根目录的共享 Root Config，不接受 `--profile` 来制造 profile-local Registry。
- `add` 的完全相同重复调用成功 no-op；任何名称或 App ID 冲突都失败且不改文件。
- `list` 输出 canonical name、aliases、App ID；不输出 profile Secret 或完整 Root Config。
- `remove` 只接受 canonical name 的 NFC 精确匹配；0 个或多个候选都失败。
- 所有修改都使用现有 Root Config 文件锁和原子写入，校验失败时保持原文件字节语义不变。
- 未初始化 Root Config 时，`list/add/remove` 明确报错并引导先初始化 Bridge，不另建一个缺少 profile 的半成品配置。
- 已初始化但 `profiles: {}` 的安装级 Root Config 不是“未初始化”；此时允许管理和保留 Registry。

## `/project bootstrap` Command Contract

### Canonical Syntax

```text
/project bootstrap <workspace> --plan-writer <bot-name> --implementer <bot-name>
```

示例：

```text
/project bootstrap /repo/demo --plan-writer "Cloud Planner" --implementer LocalCoder
/project bootstrap /repo/demo --implementer LocalCoder --plan-writer "Cloud Planner"
```

两条命令语义完全相同。解析规则：

- `<workspace>` 是唯一位置参数；角色 flag 的排列顺序任意。
- `--plan-writer` 与 `--implementer` 必须各出现且只出现一次，值不能为空。
- Bot 名或 workspace 含空格时支持单引号或双引号包裹；引号只参与 tokenization，不触发 shell 展开或命令执行。
- Bot 名开头的一个或多个 `@` 可继续被归一化移除，之后按 NFC 精确匹配 Registry。
- 未知 flag、多余位置参数、缺失/重复 flag、未闭合引号、空名称都在副作用前失败，并返回 canonical 用法。
- 旧位置参数形式 `/project bootstrap <workspace> <implementer> <plan-writer>` 明确拒绝，不做自动猜测或兼容映射。
- 两个角色必须解析为不同 Registry entries、不同 live `open_id`，且都不能等于当前 Coordinator Bot。

### Runtime Flow

```text
解析并完整校验命令
→ 读取共享 Registry 快照并解析两个具名角色
→ 读取当前群 live Bot 列表
→ 在 Coordinator 当前机器解析并验证 workspace
→ 禁用旧角色绑定
→ 切换 Coordinator cwd、清理旧会话并准备当前群准入
→ 对缺席角色按 Registry appId 邀请
→ 重新读取 live Bot 列表并唯一匹配 open_id
→ 向两个角色派发 workspace 准备命令
→ 两边都成功后原子保存群角色绑定
```

具体规则：

1. 两个名称任一未登记时立即失败，错误必须包含缺失名称和对应 `bot-registry add` 指引；不邀请、不派发、不修改既有绑定。
2. 两个 Registry entries 都解析成功后才允许进入邀请阶段。
3. Coordinator 直接在当前机器按现有 workspace 安全策略解析用户输入；不再读取 Registry 的 machine/root 元数据。绝对路径和 `~` 路径按当前语义解析；相对路径只相对 Coordinator 进程的当前工作目录解析，不做跨机器映射。解析失败发生在旧绑定禁用和其它准备副作用之前。
4. workspace 与 live discovery 预检成功后，先把旧角色绑定标为 `bootstrap_incomplete`，再切换 Coordinator cwd、清理当前 scope 的旧 session/active run，并把当前群加入 Coordinator 准入列表。此后任一步失败，旧绑定保持禁用，错误必须列出已发生副作用；不能继续注入旧 assignment。
5. Bot 已在群内时，使用该 entry 的 canonical name/aliases 在 live Bot 列表唯一精确匹配并取得 `open_id`。
6. Bot 不在群内时，用 entry 的 `appId` 邀请；邀请后按有界重试重新发现。仍为零命中或多命中时 blocked，不猜测 ID。
7. 部分邀请已经发生而后续步骤失败时，保留真实群成员副作用并在错误中报告；不得保存半完成的新角色绑定。
8. workspace 输入文本原样发送给两个角色，不从 Registry 推导或替换成本机/devbox 路径。每个目标 Bot 在自己的机器上负责执行和回传 `/cd` 结果；路径在不同机器上是否一致由用户输入保证。
9. 只有两个角色的群准入与 workspace 准备派发都成功，才保存 Decision Owner、Coordinator、Plan Writer、Implementer 的完整群绑定；这不自动启动 Harness 工作流。

## Migration, Compatibility And Release Hygiene

- 旧 Root Config 缺少 `botRegistry` 时原位兼容为 `{entries: []}`；下一次受控保存会写出正式字段。
- 现有 profiles 通过自注册规则补入各自 Bot；其它设备上的 Bot 需要用户执行一次 `bot-registry add`。
- 不把当前源码中的 hardcoded Registry 迁移进用户配置，也不根据 Bot 名猜测 App ID。
- `/project bootstrap` 的旧位置参数语法是有意的 breaking change；README、帮助文本和测试必须在同一版本切换到具名语法。
- 当前 `origin/main` 已包含不得继续发布的个人默认值。下一次代码提交必须先从源码、测试 fixture、文档示例和构建产物移除这些值；下一次 npm 发布前必须完成该内容清理并通过实际 tarball 扫描。
- 发布前必须对真实 `npm pack` tarball 解包扫描，而不是只扫描源码目录。还必须用 `git ls-remote` 和已 fetch 的全部远端 branches/tags 记录坏 commits 当前可达范围。删除/重写已共享的 main、tag 或 release 属于破坏性 release remediation，必须由 Decision Owner 单独确认具体 targets 和兼容影响；未获确认时不得擅自改写远端历史，也不得把“当前源码已清理”表述成“历史已清理”。
- Rollback 可以恢复上一发布版本和旧命令，但不能重新发布含个人 Registry 的 commit。旧版本会丢弃 `botRegistry`，因此 rollback 前必须停止全部新版本 writers、备份当前 Root Config，并接受恢复旧版后 Registry 暂时只存在于备份；重新升级时再恢复。

### Coordinated Upgrade Gate

同一 `LARK_CHANNEL_HOME` 不支持新旧版本并行写 Root Config。首次启用共享 Registry 必须按以下顺序：

```text
枚举并停止该安装根目录下全部旧 profile writers
→ 备份 Root Config
→ 升级全部 profile/service definitions 到新版本
→ 验证没有旧 PID/旧 artifact 仍持有该 Root Config
→ 启动新版本 profiles 并完成 self-registration
→ 写入其它 Registry entries
→ 回读并验证 Registry
```

任一步失败都不得在仍有旧 writer 时启用或修改 `botRegistry`。升级完成后的验收必须证明旧进程不能再次写该 Root Config；这是一项安装级原子迁移门禁，不是可滚动升级。

## Security And Privacy

- Root Config 中只保存名称、aliases 和 App ID；App Secret 继续走现有 secret 存储，不得复制进 Registry。
- CLI 参数、报错和普通日志不得打印 Secret。`list` 可显示 App ID，因为它是该管理命令的明确输出合同。
- 邀请和 live discovery 使用当前 Coordinator profile 的现有身份与权限，不引入 admin app-list scope。
- Registry 是本机受信配置，不是租户目录或身份认证服务；若用户登记错误 App ID 或名称，系统 fail closed，不通过相似名称猜测纠正。
- 群内同名/别名冲突、Registry 内跨 entry 名称冲突、角色同 Bot、角色等于 Coordinator 都必须阻断。

## Validation And Acceptance

### Source And Config

- 全仓和 `git log origin/main..HEAD -p` 扫描确认没有真实个人 Bot 名、App ID、本机/devbox路径；`defaultRegistry()` 不再返回个人条目。
- Root Config 新建、读取、归一化、保存以及 profile create/use/remove 往返测试证明 `botRegistry` 不丢失，缺失字段稳定归一化为空。
- 字段存在但结构错误、entry 无效、名称/App ID 冲突时，加载与所有修改路径 fail closed，且文件不被重写为空。
- 删除最后一个 profile 后 Root Config/Registry 仍存在且可继续 `bot-registry list/add/remove`；随后创建新 profile 会保留旧 Registry。`profile export` 无论是否包含 secrets 都不携带共享 Registry。
- Registry add/list/remove、自注册、冲突、并发锁和原子写入均有单元测试。
- 配置与 CLI 输出中不存在 App Secret 泄露。
- 混合版本迁移测试或受控进程验收证明：旧 writers 全部停止后才首次写 `botRegistry`，升级完成后没有旧 PID/旧 artifact 能再次覆盖 Root Config。

### Parser And Command

- 两种 flag 顺序产生相同 Plan Writer/Implementer 结果。
- 覆盖单/双引号名称和 workspace、`@` 前缀、Unicode NFC、缺失/重复/未知 flag、额外位置参数、空值和未闭合引号。
- 旧位置语法被明确拒绝，且失败发生在群邀请、派发、cwd 修改和绑定写入之前。
- 两个角色未登记、Registry 冲突、群内多匹配、角色相同、角色等于 Coordinator 均 fail closed。
- workspace 解析失败保持旧绑定不变；workspace 预检成功后发生任一准备失败，旧绑定保持 `bootstrap_incomplete`，Coordinator cwd/session/群准入/邀请等已发生副作用被准确报告。

### Runtime Acceptance

- 新安装创建空共享 Registry；两个不同 profiles 首次取得 Bot 身份后都出现在同一 Root Config，且没有 profile-local 副本。
- 注册一个不在测试群中的 Bridge Bot 后，只提供其名称即可完成邀请、live discovery、原生派发和角色绑定。
- 注册 Bot 已在群内时不重复邀请，直接使用 live `open_id`。
- 至少一次真实群验收同时记录：命令文本、邀请前后 Bot 列表、解析出的 live `open_id`、两条派发结果和最终 `projectRoleAssignment`；证据必须区分“邀请成功”“派发成功”“绑定持久化成功”。
- 运行 `pnpm ci:local`，并在最终远端 commit 上通过 CI。
- 对实际 `npm pack` tarball、待发布 commit 的当前文件树做隐私 denylist 扫描；用全部远端 branches/tags 记录既有坏 commits 的可达范围，并分别报告“当前内容清理”和“历史 remediation”状态。

## Risks And Open Decisions

- **Bot 改名：** 本版不静默覆盖同一 App ID 的 canonical name；需要显式 remove/add 修正。后续可独立设计安全 rename 命令。
- **App ID 与 live `open_id` 的可证明映射：** 现有群成员发现只提供 live 身份，Registry App ID 主要是邀请 locator。本版通过受信本地登记、邀请后唯一全名匹配和歧义阻断收敛，但不声称具备租户目录级身份认证。
- **旧版本回滚重写配置：** 当前 Root Config normalizer 会丢未知字段。本 Spec 通过 stop-all-old-writers 升级门禁和 rollback 前备份收敛，不支持新旧版本对同一 Root Config 的滚动混跑。

除以上已明确接受的限制外，本 Spec 不保留需要 Decision Owner 选择的产品分支。确认后，Plan Writer 应把配置 schema、CLI CRUD、self-registration、命令 tokenizer、bootstrap 迁移、隐私历史清理和 live acceptance 拆成可独立验证的实施单元。
