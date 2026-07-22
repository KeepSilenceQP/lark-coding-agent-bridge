# Deferred Self-Restart And Post-Restart Receipt Coding Plan

Date: 2026-07-22
Status: draft — awaiting independent Plan Review
Authority: `docs/specs/20260722-deferred-self-restart-receipt.md` (confirmed by Qin Peng, commit `b906c8b`)
Branch: `fix/lark-bridge-followup`
Implementer: 小C
Plan Writer: 云上C总
Plan Reviewer: 小P

## Outcome

把 Bridge 同 profile 自部署重启收敛为一个跨进程闭环：

1. Bridge-bound Agent 重启当前 profile 必须调用 `lark-channel-bridge restart --profile <current>`（deferred marker 路径），禁止直接调用 `launchctl`/`systemctl`/`schtasks`/kill。
2. 当前 Bridge 等所有 active batch 完成、最终回复发送完毕后，才启动 detached helper 执行服务重启（现有 drain 行为保留）。
3. marker 扩展为持久化跨进程 receipt 状态，携带 receipt ID、return route（由 Bridge 从当前已验证 Agent run 自动绑定）、旧 PID、请求时间、可选部署标识。
4. 新 Bridge 在飞书连接可用后发送**恰好一条** success receipt；规定时间内未观察到新 Bridge 注册或 service restart 明确失败时，仍存活的 helper 发送 failure receipt。
5. receipt 用稳定 ID 幂等，原子清理，不重复通知、不误发陈旧请求。
6. Bridge System Prompt 新增自重启规则，约束所有 Agent。

不负责：构建/安装/git 切换/service 定义修改/跨 profile 编排/自动重试部署/通知另一个 Bot（交接仍用 at-bot）/Agent turn 续跑。

## Current Evidence

基于 `fix/lark-bridge-followup@b906c8b` 的 live code（`b7563f2`/`77b6b42` per-group 工作已合入，PR #2 at-bot 原语已合入）：

- **marker** `src/runtime/deferred-service-restart.ts`：`MARKER_FILE='.deferred-service-restart.json'`（profileDir）；`DeferredServiceRestartMarker={profile, bridgePid?, requestedAt}`（**无 receiptId/returnRoute/deployRevision**）；`requestDeferredServiceRestart` 原子写（temp+rename）；`consumeDeferredServiceRestart(profileDir, bridgePid)` **读后即删**，仅当 `bridgePid` 匹配返回 true；`launchDeferredServiceRestart(profile)` detached spawn `node <cli> restart --profile <profile>`，**strip LARK_CHANNEL env**，stdio ignore，unref。
- **drain** `src/bot/channel.ts:666-685` `maybeLaunchDeferredRestart`：门 `activeBatchCount!==0 || deferredRestartLaunching`；归零后 `consume` marker，再 `launchDeferredServiceRestart(controls.profile)`；若 read 期间新 batch 启动则**写回 marker** 延后。`:823` 在 flush `finally` 调用。
- **restart 命令** `src/cli/commands/service.ts:371-397` `runServiceRestart`：bridge-bound 同 profile（`LARK_CHANNEL==='1' && LARK_CHANNEL_PROFILE===profile`）→ `requestDeferredServiceRestart` 写 marker @384 + 打印"已安排"；否则 `reportConnectAfter('restarted', adapter.restart)` 直接重启 + 等连接。
- **新 PID 观察** `src/cli/commands/service.ts:201-221` `waitForServiceConnect(appId, profile, beforePids, 30s)`：轮询 `readAndPrune()`（registry）找 `appId+profile` 且 `pid∉beforePids` 且 `botName` 已填（=WS 握手成功）的新 bridge。
- **service adapter** `src/daemon/service-adapter.ts`：`restart()`/`waitUntilStopped()`/`parseStatus()`（提取 PID）；三平台 `launchd.kickstart`/`systemd.restart`/`schtasks.restartTask`。
- **agent 子进程 env** `src/agent/lark-channel-env.ts` `buildLarkChannelEnv`：注入 `LARK_CHANNEL/LARK_CHANNEL_PROFILE/LARK_CHANNEL_BRIDGE_PID/LARK_CHANNEL_HOME/LARK_CHANNEL_CONFIG/LARKSUITE_CLI_CONFIG_DIR`，**无 chatId/threadId**。调用点 `src/agent/claude/adapter.ts:91`、`src/agent/codex/adapter.ts:127,222`，`this.larkChannel` 为 **bridge-static**（构造时设置，非 per-run）。
- **in-process restart** `src/cli/commands/start.ts:254` `Controls.restart`：connect-before-disconnect 的 in-process 重连（keepalive/forceReconnect 用），**非** deferred marker 路径，本需求 out of scope，保持不变。
- **Bridge System Prompt** `src/agent/bridge-system-prompt.ts`：已有 bridge_context / at-bot / quoted_message / interactive_card / lark-cli / OAuth 等段，**无自重启段**。
- **profile 私有目录** `src/config/app-paths.ts` `profileDir`（marker 落点）；registry `src/runtime/registry.ts` `readAndPrune`（新 PID 观察）。
- **现有测试** `tests/unit/runtime/deferred-service-restart.test.ts`、`tests/unit/cli/service-profile.test.ts`、`tests/integration/bot/markdown-stream-startup-failure.test.ts`、`tests/unit/bot/channel-intake.test.ts`。
- receiptId / returnRoute / post-restart 在 live code 中**均不存在**（新概念）。

## Design Decisions

### DD1 — Marker schema 扩展 + 生命周期（read-on-drain，clear-on-receipt）

- 扩展 `DeferredServiceRestartMarker`（`deferred-service-restart.ts`）为：
  ```ts
  {
    receiptId: string;            // 稳定 ID，restart 命令生成，如 restart-<ts>-<rand>
    profile: string;
    oldPid?: number;              // 旧 bridge PID（原 bridgePid）
    requestedAt: string;
    returnRoute?: { chatId: string; threadId?: string; replyTo?: string };
    deployRevision?: string;      // 可选非敏感部署标识
    status?: 'pending' | 'success-sent' | 'failure-sent';  // 幂等状态
    failureReason?: string;       // failure 时由 helper 填
  }
  ```
- **生命周期改为 read-on-drain + clear-on-receipt**：
  - restart 命令写 marker（status=pending）。
  - 旧 bridge drain 归零时**只读不删** marker，把 marker 数据传给 helper（见 DD3），并保持 marker 存在。
  - 新 bridge 启动后读 marker（见 DD4）；helper 超时/失败时读 marker（见 DD3）。
  - receipt 发送成功后**原子完成** marker（temp+rename 写 status=sent，或原子 rm）。陈旧 marker（oldPid 不匹配已退出进程 / 过期）不补发。
- **兼容**：旧 marker（无 receiptId/returnRoute）→ 只执行重启、不发 receipt（Spec compat）。`consumeDeferredServiceRestart` 的"读后删"语义改为"读不删 + 由 receipt 完成时删"；保留对无 returnRoute 旧 marker 的降级（仅重启不通知）。损坏 marker（JSON parse 失败）→ 删除 + 日志，不补发、不重启（防误重启）。
- marker **不得**包含 App Secret/token/cookie/完整用户消息/可执行 shell。returnRoute 仅 chatId/threadId/replyTo（来自 bridge 验证入站上下文，非模型文本）。

### DD2 — return route 由 Bridge 从当前已验证 Agent run 自动绑定

- 在 `buildLarkChannelEnv`（`lark-channel-env.ts`）扩展 `LarkChannelEnvContext` 增加 `returnRoute?: {chatId, threadId?, replyTo?}`，输出 env `LARK_CHANNEL_RETURN_CHAT_ID` / `LARK_CHANNEL_RETURN_THREAD_ID` / `LARK_CHANNEL_RETURN_REPLY_TO`（仅当存在）。
- **per-run 注入**：当前 `this.larkChannel` 是 bridge-static（adapter 构造时设置）。需在 adapter spawn 站点（`claude/adapter.ts:91`、`codex/adapter.ts:127/222`）把**当前 batch 的 return route**（`firstMsg.chatId`/`threadId`/`replyTo`，来自已验证入站 `bridge_context.chatId`）overlay 进 spawn env。实现方式由小C 定（如 spawn 前合并 per-run env override，或 buildLarkChannelEnv 接受 per-run route 参数），但**必须 per-run**，不得用 bridge-static chatId。
- restart 命令（`service.ts:384`）读 env 里的 return route，写入 marker。Agent 只跑 `lark-channel-bridge restart --profile <current>`，**不传 chatId/通知正文**。
- return route 来源约束：仅当前 Bridge 为本轮已验证 `bridge_context.chatId` 创建；不得把任意模型文本当作 returnRoute 或通知 payload。

### DD3 — helper 扩为持久化重启协调者（跨旧进程退出 + failure receipt）

- `launchDeferredServiceRestart`（`deferred-service-restart.ts`）扩展：把 marker 数据（receiptId、returnRoute、oldPid、profile、deployRevision）传给 helper。**推荐方式**：helper 直接从 profileDir 读 marker 文件（marker 已持久化，见 DD1），无需经 env/CLI args 传敏感长数据。helper 仍 strip LARK_CHANNEL（非 bridge-bound）。
- helper（`runServiceRestart` else 分支，`service.ts:392`）职责重写：
  1. 读 marker（receiptId/returnRoute/oldPid）。
  2. `adapter.restart()`；若 `!r.ok` → failure reason=`service-action-failure`。
  3. `waitForServiceConnect(appId, profile, beforePids, timeout)` 观察新 bridge 注册（**不以 adapter 返回 0 判成功**，以新 PID+botName 出现为准）。超时 → failure reason=`startup-timeout`。
  4. 新 bridge 连接成功 → helper **退出不发**（新 bridge 发 success，见 DD4）。
  5. failure → helper 用确定性 Bot 发送能力（DD6）发 failure receipt（含 profile/reason/receiptId），原子完成 marker（status=failure-sent）。
  6. helper 无法发送 failure receipt → 保留 marker 终态 + 写可定位 daemon/helper 日志；下次启动不得改写为成功。
- helper 重入 / 重复启动：marker status 已 sent 或已 completed → 不再发、不再重启。

### DD4 — 新 Bridge 发 success receipt（飞书连接可用后）

- 新 bridge 在 `startChannel` 启动早期（飞书 WS 连接可用后）读 profileDir marker：
  - marker 存在、returnRoute 存在、oldPid 是已退出的前序 bridge、status=pending → 发 success receipt（含 profile/success/receiptId/newPid；deployRevision 原样回显），原子完成 marker（status=success-sent）。
  - marker status 已 sent → 不补发，清理。
  - marker 无 returnRoute（旧格式）→ 不发，清理。
  - marker oldPid 不匹配 / 陈旧 → 不发，清理。
- success receipt 必须在新 bridge 自身飞书连接可用后发（不能在连接前猜测）。newPid = `process.pid`。
- "service active ≠ bridge 已连接飞书；success receipt ≠ 业务功能验收完成"——receipt 仅证明重启+连接闭环。

### DD5 — 幂等 receipt（稳定 ID + 原子完成 + 互斥）

- 稳定 `receiptId`：restart 命令生成一次，写 marker，receipt 回显同一 ID。
- success / failure 互斥：helper 仅在新 bridge**未在超时内连接**时发 failure；新 bridge 仅在自身连接后且 status=pending 时发 success。两者由超时边界天然互斥。
- 原子完成：发送成功后 temp+rename 写 status=sent（或 rm marker）。重复启动 / helper 重入 / "发送成功但清理前退出"：status 已 sent → 不重复发；status=pending 但发送者已退出 → 由存活方（新 bridge 或 helper）按规则唯一发送。
- 陈旧 marker（oldPid 不匹配 / 过期）不在无关重启后补发；损坏 marker 删除+日志。
- 不误删新请求：新 restart 命令写 marker 时若已有 pending marker，按"唯一 pending"合并或拒绝（实现者定，保证不覆盖在途请求）。

### DD6 — 确定性 Bot 发送能力（helper failure receipt）

- 新增 typed TS 函数 `sendRestartReceipt({profile, returnRoute, kind:'success'|'failure', receiptId, newPid?, reason?, deployRevision?})`，从 profile config 解析 app 凭据（`resolveProfileRuntime`，不经 marker），用飞书 IM API/SDK 发送到 returnRoute.chatId（话题群用 threadId，有 replyTo 则回复）。
- 通知正文由代码固定生成（Spec 文案模板），**不接受模型文本/shell JSON**。杜绝"临时 shell 脚本手写 JSON typo"类失败。
- helper（非 bridge-bound 进程）直接调此函数；新 bridge 也调此函数发 success。不启动 Agent、不拼 shell。
- 凭据解析失败 → failure receipt 发送失败 → 保留终态日志（DD3 步骤 6）。

### DD7 — Bridge System Prompt 自重启规则

- `src/agent/bridge-system-prompt.ts` 新增 `## 自重启（deferred restart + receipt）` 段，规定：
  - 重启当前 Bot/profile 只调 `lark-channel-bridge restart --profile <LARK_CHANNEL_PROFILE>`；**禁止**直接 `launchctl`/`systemctl`/`schtasks`/kill 当前 bridge PID 或等价 service-manager 命令。
  - `restart` 返回"已安排"后继续完成本轮最终回复，不在同一轮等待 post-restart 结果，不把 scheduled 说成 restarted。
  - 收到 post-restart receipt 前不得声称重启成功；receipt 失败/缺失按实际状态报告。
  - 显式运维**其它** profile 不属自重启，沿用现有外部路径；按 `LARK_CHANNEL_PROFILE` 判当前 profile，不按 Bot 显示名猜。
- System Prompt 只规定动作选择与完成语义；return route 捕获/drain/helper 生命周期/receipt 幂等由 Bridge 确定性代码保证。

### DD8 — 三平台 service adapter 处理

- helper 通过 `ServiceAdapter.restart()` + `waitUntilStopped()` + `waitForServiceConnect`（registry 新 PID）观察，**不依赖 adapter 返回 0**。
- launchd（kickstart）/systemd（restart）/schtasks（restartTask=end+wait+run）三路径在 helper 中行为一致：restart → 等新 PID+botName。
- 三平台测试（Unit 6）覆盖：marker 写入/drain/receipt 在三个 adapter 上的等价行为（mock adapter 或平台条件测试）。

## Execution Units

Owner：Unit 1-5 由小C 实现；Unit 1-5 完成 + 自检后交回小P，由云上C总独立 Code Review GO 后才进 Unit 6。Unit 6 实机自部署 owner = 秦鹏 + 小P，小C 提供构建/配置/日志支持。Plan Review GO 前不修改运行代码、不部署。

### Unit 1 — RED：失败测试先行  Owner: 小C  ☐

Files：`tests/unit/runtime/deferred-service-restart.test.ts`、`tests/unit/cli/service-profile.test.ts`、`tests/integration/bot/markdown-stream-startup-failure.test.ts`、`tests/unit/bot/channel-intake.test.ts`，新增 helper/receipt 专用测试文件。

Add failing coverage：
- marker schema：receiptId/returnRoute/oldPid/deployRevision/status 写入与读回；旧 marker（无新字段）降级仅重启不通知；损坏 marker 删除+日志不重启。
- return route：bridge-bound restart 从 env 自动绑定 chatId/threadId/replyTo；Agent 不传 route；returnRoute 仅来自验证入站上下文。
- drain：active batch 未归零不调 adapter.restart；归零后只启动一次 helper；drain 期间新 batch 写回 marker 延后。
- helper：adapter.restart 失败→failure(service-action-failure)；超时无新 PID→failure(startup-timeout)；新 PID+botName 出现→不发（让新 bridge 发 success）；不以 adapter exit 0 判成功。
- new bridge：飞书连接后发 success（newPid/receiptId/deployRevision 回显）；status=pending 才发；无 returnRoute 不发。
- 幂等：helper 重入/新进程重复启动/发送成功后清理前崩溃/陈旧 marker/损坏 marker → 不重复通知、不误删新请求、不泄露凭据。
- System Prompt 契约：含禁止 launchctl/systemctl/schtasks 直调规则；其它 profile 不受误伤。
- 三平台：launchd/systemd/schtasks adapter 在 helper 流程中等价（mock 或条件测试）。

Gate: targeted tests fail for missing behavior before production edits.

### Unit 2 — Marker schema + return route 绑定 + 兼容迁移  Owner: 小C  ☐

Files：`src/runtime/deferred-service-restart.ts`、`src/agent/lark-channel-env.ts`、`src/agent/claude/adapter.ts`、`src/agent/codex/adapter.ts`、`src/cli/commands/service.ts`、`src/bot/channel.ts`（drain read 不删）。

Changes：按 DD1 扩 marker schema + 生命周期（read-on-drain/clear-on-receipt）+ 兼容降级；按 DD2 扩 env + per-run return route overlay + restart 命令写 returnRoute。`consumeDeferredServiceRestart` 改读不删（保留旧 marker 降级）。

Gate: marker/env/return-route targeted tests pass；旧 marker 行为不变（仅重启不通知）。

### Unit 3 — helper 持久化协调者 + failure receipt  Owner: 小C  ☐

Files：`src/runtime/deferred-service-restart.ts`（launchDeferredServiceRestart 传 marker 数据/读 marker）、`src/cli/commands/service.ts`（helper else 分支重写）、`src/daemon/service-adapter.ts`（如需 observe 新 PID 辅助）。

Changes：按 DD3 重写 helper：读 marker → adapter.restart → waitForServiceConnect 新 PID → failure receipt 或退出。failure reason 区分 service-action-failure/startup-timeout/receipt-delivery-failure。

Gate: helper targeted tests pass（failure 路径 + 新 PID 观察不误判）。

### Unit 4 — 新 Bridge success receipt + 幂等完成  Owner: 小C  ☐

Files：`src/bot/channel.ts`（startChannel 启动早期读 marker + 连接后发 success）、`src/runtime/deferred-service-restart.ts`（marker 完成原语）。

Changes：按 DD4/DD5 新 bridge 读 marker + 飞书连接后发 success + 原子完成；幂等状态机；陈旧/损坏 marker 处理。

Gate: new-bridge receipt + idempotency targeted tests pass。

### Unit 5 — 确定性 receipt 发送 + Bridge System Prompt  Owner: 小C  ☐

Files：新增 receipt 发送模块（如 `src/runtime/restart-receipt.ts`）、`src/agent/bridge-system-prompt.ts`（新增自重启段）、`README.md`/`README.zh.md`（自重启规则说明）。

Changes：按 DD6 实现 typed `sendRestartReceipt`（从 config 解析凭据，固定文案，无 shell JSON）；按 DD7 新增 System Prompt 段。

Gate: receipt-sender + system-prompt contract tests pass；docs contract tests pass。

### Code Review Gate  Owner: 云上C总  ☐

小C 完成 Unit 1-5 + 自检（`pnpm typecheck && pnpm test && pnpm build && git diff --check` 全绿）后交回小P。云上C总 对照 Spec（`b906c8b`）与本 Plan 独立 Code Review，GO 后才进 Unit 6。小C 不得自行进入实机验收。

### Unit 6 — 三平台测试 + 实机自部署验收 + 回滚  Owner: 秦鹏+小P（小C 提供构建/配置/日志）  ☐

After Code Review GO：
1. 三平台自动化：mock/条件测试证明 launchd/systemd/schtasks 在 helper 流程等价（drain→restart→新 PID 观察→receipt）。
2. 实机自部署（当前 Bot，profile=claude 或验收指定 profile）：
   - 记录旧 PID、最终回复 message ID、receipt ID、新 PID、post-restart receipt message ID。
   - 回读日志确认顺序：最终回复完成 → 旧进程退出 → 新进程连接飞书 → receipt 发送。
   - success 路径：新 PID≠旧 PID，恰好一条 success receipt 关联同一 receiptId。
   - failure 路径（构造 service-action-failure 或 startup-timeout）：不产生 success receipt，helper 发一条 failure receipt（或保留终态日志）。
3. 回滚演练：恢复旧 deferred marker + helper 行为，停止创建带 returnRoute 的新请求；未完成新格式请求保留为诊断记录或显式清理，不静默误发。

Gate: 三平台测试 pass + 实机 success/failure 两条路径证据齐全。Runtime PASS 需日志顺序证据 + receipt message ID，仅单测/进程存活不算完成。

## Verification Commands

```bash
pnpm install --frozen-lockfile
pnpm exec vitest run \
  tests/unit/runtime/deferred-service-restart.test.ts \
  tests/unit/cli/service-profile.test.ts \
  tests/integration/bot/markdown-stream-startup-failure.test.ts \
  tests/unit/bot/channel-intake.test.ts
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

部署后命令以 live CLI / service discovery 为准。

## Rollback

- 代码回滚：恢复旧 `DeferredServiceRestartMarker`（无 receiptId/returnRoute）+ 旧 `consumeDeferredServiceRestart`（读后删）+ 旧 helper（不发 receipt）。停止创建带 returnRoute 的新请求。
- 在途新格式 marker：保留为诊断记录，或由显式清理命令处理（`lark-channel-bridge` 提供 cleanup），不静默误发。
- System Prompt 自重启段可单独保留（约束 Agent 走 deferred 路径，与 receipt 解耦）。
- 旧 binary 读新格式 marker：忽略未知字段，按旧语义仅重启（向后兼容）。

## Open Points / For Plan Review

1. **return route 注入机制**：本 Plan 推荐 env（`LARK_CHANNEL_RETURN_*`）+ per-run overlay（因 `this.larkChannel` bridge-static）。若 Review 倾向 profile-private route token / 受控 IPC，请裁定。约束不变：route 来自验证入站上下文、marker 不含消息正文、重启后不依赖 Agent 恢复上下文。
2. **marker 生命周期变更**：`consume`（读后删）→ read-on-drain + clear-on-receipt。改变现有语义，需 Review 确认兼容（旧 marker 降级仅重启）。
3. **helper 获取 marker 数据**：推荐 helper 直接读 profileDir marker 文件（已持久化）。若 Review 要求经 CLI args / 独立 in-flight state 文件，请裁定。
4. **"发送成功但清理前退出"残余窗口**：用 status 状态机 + success/failure 超时互斥收敛，但 send→status-write 间崩溃理论上可重复发送。若 Review 要求严格 at-most-once，需引入发送前原子占位（status=sending）+ 启动时歧义处理策略，请裁定可接受的残余风险。
5. **三平台测试环境**：CI/本机为 Linux，macOS/Windows adapter 无法原生跑。推荐 mock adapter + 平台条件测试。若 Review 要求真三平台 CI，需额外基础设施。
6. **新 bridge 何时读 marker**：本 Plan 定为 `startChannel` 启动早期、飞书连接可用后发 success。需确认连接可用的判定点（WS 握手成功 / botName 注册）与 `waitForServiceConnect` 一致。
7. **deployRevision 来源**：可选非敏感部署标识（如 git short SHA / 版本号）。由 restart 命令从 env 或参数取（Agent 不填），或留空。请裁定是否 v1 必需。

## Review Gate

本 Plan 需由独立 SubAgent（小P）对照 confirmed Spec（`b906c8b`）与 live code review。结论 PASS（或所有阻塞项修订并复审通过）后小C 才开始 Unit 1。Plan Writer 不自判 GO。Unit 1-5 完成后另由云上C总 独立 Code Review，GO 后才进 Unit 6 实机自部署。
