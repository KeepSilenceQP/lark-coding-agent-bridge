# Deferred Self-Restart And Post-Restart Receipt Coding Plan

Date: 2026-07-22
Status: revised after CHANGES REQUIRED Plan Review — awaiting re-review
Authority: `docs/specs/20260722-deferred-self-restart-receipt.md` (confirmed by Qin Peng, commit `b906c8b`)
Branch: `fix/lark-bridge-followup`
Implementer: 小C
Plan Writer: 云上C总
Plan Reviewer: 小P

## Outcome

把 Bridge 同 profile 自部署重启收敛为一个跨进程闭环，且 receipt 投递 **exactly-once**：

1. Bridge-bound Agent 重启当前 profile 必须调用 `lark-channel-bridge restart --profile <current>`（deferred 路径），禁止直接调用 `launchctl`/`systemctl`/`schtasks`/kill。
2. 当前 Bridge 等所有 active batch 完成、最终回复发送完毕后，才启动 detached helper 执行服务重启（现有 drain 行为保留）。
3. marker 升级为 profile-private **原子状态机**（rename-based CAS：pending → claimed → completed），携带 receiptId、return route、旧 PID、请求时间、可选部署标识。唯一 pending（新请求原子 create/reject）；claim/complete 按 receiptId；cleanup 只作用同 receiptId。
4. return route 由 Bridge 在 `runAgentBatch` 为当前已验证 run 生成 **profile-private opaque route lease**，Agent env 只拿 `routeId`；restart CLI 按 profile+bridgePid 校验并消费 lease，模型/命令无法自行提供 chatId。
5. 新 Bridge 在 `channel.connect` 成功后 claim 并发 success receipt；helper 在新 bridge 超时未注册时发 failure receipt。两者由原子 claim + Feishu `uuid=f(receiptId,kind)` 服务端幂等收敛到恰好一条用户可见 receipt。
6. receipt sender 回传 messageId 并落账（验收证据）。
7. Bridge System Prompt 新增自重启规则。

不负责：构建/安装/git 切换/service 定义修改/跨 profile 编排/自动重试部署/通知另一个 Bot（交接仍用 at-bot）/Agent turn 续跑。

## Review History

- **R1（小P，CHANGES REQUIRED）**：现有代码落点核对正确，但 6 项需修订：
  1. DD5「超时天然互斥」不成立（新 bridge 与 helper 边界可同时读 pending 各发 success/failure；send→status-write 崩溃重复）→ 定义跨进程原子 claim/状态机 + Feishu `uuid=f(receiptId,kind)` 服务端幂等，exactly-once 不留 Open Point。
  2. return route 不得留给实现者 → 定稿 per-run 数据流（runAgentBatch→AgentRunOptions/spawn overlay）；Bridge 生成 profile-private opaque route lease/routeId，Agent env 只拿 routeId，restart CLI 按 profile+bridgePid 校验消费；测试并发不串路由。
  3. 单 marker 新请求覆盖/旧发送者清理新请求风险 → 唯一 pending 原子 create/reject（transaction 文件）+ 按 receiptId CAS/claim/complete，cleanup 只同 receiptId。
  4. Unit 6 不得在生产 Bot 构造 failure → failure live test 用隔离 profile/service fixture，生产 Bot 只做 success self-restart。
  5. success 时序：channel.connect 成功后发送/claim，registry botName 回填与 helper 观察竞态由 claim+uuid 收敛；receipt messageId 回传落账。
  6. 删除/裁定 Open Points，不把 v1 关键一致性留实现；deployRevision v1 optional。
- **R1 修订（本次）**：重写 DD1-DD7、Unit 6、Open Points（→ Resolved），加本 Review History。Status 置为 awaiting re-review。Plan Writer 不自判 GO。

## Current Evidence

基于 `fix/lark-bridge-followup@b906c8b` live code（per-group + at-bot 已合入）：

- **marker** `src/runtime/deferred-service-restart.ts`：`MARKER_FILE='.deferred-service-restart.json'`（profileDir）；`DeferredServiceRestartMarker={profile, bridgePid?, requestedAt}`（无 receiptId/returnRoute）；`requestDeferredServiceRestart` 原子写（temp+rename）；`consumeDeferredServiceRestart` **读后删**，bridgePid 匹配返回 true；`launchDeferredServiceRestart(profile)` detached spawn `node <cli> restart --profile <profile>`，**strip LARK_CHANNEL**，stdio ignore，unref。
- **drain** `src/bot/channel.ts:666-685` `maybeLaunchDeferredRestart`：门 `activeBatchCount!==0 || deferredRestartLaunching`；归零后 consume marker + `launchDeferredServiceRestart`；read 期间新 batch 启动则写回 marker 延后。`:823` flush `finally` 调用。
- **restart 命令** `src/cli/commands/service.ts:371-397` `runServiceRestart`：bridge-bound 同 profile → `requestDeferredServiceRestart` 写 marker @384 + 打印"已安排"；否则 `reportConnectAfter('restarted', adapter.restart)` 直接重启 + 等连接。
- **新 PID 观察** `service.ts:201-221` `waitForServiceConnect(appId, profile, beforePids, 30s)`：轮询 `readAndPrune()`（registry）找 `appId+profile` 且 `pid∉beforePids` 且 `botName` 已填的新 bridge。
- **service adapter** `src/daemon/service-adapter.ts`：`restart()`/`waitUntilStopped()`/`parseStatus()`；三平台 `launchd.kickstart`/`systemd.restart`/`schtasks.restartTask`。
- **agent 子进程 env** `src/agent/lark-channel-env.ts` `buildLarkChannelEnv`：注入 LARK_CHANNEL/PROFILE/BRIDGE_PID/HOME/CONFIG/LARKSUITE_CLI_CONFIG_DIR，无 chatId/routeId。调用点 `claude/adapter.ts:91`、`codex/adapter.ts:127,222`，`this.larkChannel` 为 **bridge-static**。
- **runAgentBatch** `src/bot/channel.ts` flush 回调内：`firstMsg.chatId/threadId/replyTo` 为当前已验证入站上下文（= `bridge_context.chatId`）。
- **in-process restart** `src/cli/commands/start.ts:254` `Controls.restart`：connect-before-disconnect in-process 重连，非 deferred 路径，out of scope 不变。
- **Bridge System Prompt** `src/agent/bridge-system-prompt.ts`：无自重启段。
- **profile 私有目录** `src/config/app-paths.ts` `profileDir`；registry `src/runtime/registry.ts` `readAndPrune`。
- **现有测试** `tests/unit/runtime/deferred-service-restart.test.ts`、`tests/unit/cli/service-profile.test.ts`、`tests/integration/bot/markdown-stream-startup-failure.test.ts`、`tests/unit/bot/channel-intake.test.ts`。
- receiptId/returnRoute/routeId/post-restart 在 live code 中均不存在（新概念）。

## Design Decisions

### DD1 — Marker 原子状态机（rename-based CAS，唯一 pending，同 receiptId cleanup）

- profile-private **receipt 目录** `profileDir/restart-receipt/`，文件：
  - `pending.json` — 唯一待处理请求。
  - `claimed.<receiptId>.json` — 某 sender 已 claim（原子 rename 自 pending.json）。
  - `completed.<receiptId>.json` — 已完成（rename 自 claimed），保留 messageId/reason 落账 + TTL 清理。
- **marker schema**：`{ receiptId, profile, oldPid, requestedAt, returnRoute?:{chatId,threadId?,replyTo?}, deployRevision?, status:'pending'|'claimed'|'completed', claimer?, kind?, messageId?, failureReason? }`。
- **唯一 pending 原子 create/reject**：restart CLI 用 `open(pending.json, 'wx')`（O_CREAT\|O_EXCL）写。若已存在（EEXIST）→ **拒绝新请求**，回显现有 receiptId（"restart already pending, receiptId=…"），不覆盖。陈旧 pending 不被新请求自动清理（见 cleanup 规则）。
- **原子 claim（CAS）**：sender 读 pending.json → 校验 `receiptId` 匹配 + `status==='pending'` → `rename(pending.json, claimed.<receiptId>.json)`。rename 原子，唯一赢家；输家见 pending.json 不在（或 claimed 存在）→ 不发。Windows 用 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` 或独占 create 等价。
- **原子 complete**：claimer 发送成功后 `rename(claimed.<receiptId>.json, completed.<receiptId>.json)`，写入 messageId。completed 保留作验收证据 + TTL 清理。
- **cleanup 只作用同 receiptId**：TTL 过期/显式清理命令只删除匹配指定 receiptId 的 `claimed.<receiptId>.json`/`completed.<receiptId>.json`，**绝不**跨 receiptId 删除或清空 `pending.json`（除非同 receiptId）。
- **陈旧/损坏**：pending.json 的 `oldPid` 不匹配当前/前序 bridge、或过期 → 新 bridge/helper 不 claim、不补发；损坏 JSON → 删除该文件 + 日志，不重启、不补发。
- **兼容旧 marker**：旧 `.deferred-service-restart.json`（无 receiptId/returnRoute）→ 仅执行重启、不发 receipt（Spec compat）。新代码识别旧格式降级，不阻塞新格式。
- marker 内容不含 App Secret/token/cookie/完整用户消息/可执行 shell。

### DD2 — return route：opaque route lease + per-run 数据流（定稿）

完整 per-run 数据流（不留实现者）：

1. `runAgentBatch`（`channel.ts` flush 回调）拿到当前 batch 的 `firstMsg.chatId/threadId/replyTo`（已验证 `bridge_context.chatId`）。
2. spawn agent 前，Bridge 在 profile-private **route lease store**（`profileDir/route-leases/`，每 lease 一文件 `<routeId>.json` 原子写）创建 lease：`{ routeId: <opaque uuid>, chatId, threadId?, replyTo?, bridgePid: process.pid, runId?, createdAt, expiresAt }`。
3. **per-run spawn overlay**：`buildLarkChannelEnv` 增 `routeId?` 入参 → 输出 env `LARK_CHANNEL_ROUTE_ID=<routeId>`（仅 routeId，**不输出 chatId**）。`claude/adapter.ts:91`、`codex/adapter.ts:127,222` spawn 站点把当前 run 的 routeId overlay 进 env（覆盖 bridge-static `this.larkChannel`，必须 per-run）。
4. Agent 跑 `lark-channel-bridge restart --profile <LARK_CHANNEL_PROFILE>`（**不传 chatId/通知正文**）。
5. restart CLI（`service.ts` bridge-bound 分支）读 env `LARK_CHANNEL_ROUTE_ID` + `LARK_CHANNEL_BRIDGE_PID` → 开 lease store 找 lease → 校验 `lease.bridgePid === LARK_CHANNEL_BRIDGE_PID` 且未过期 → 取 `lease.{chatId,threadId,replyTo}` 为 returnRoute，**消费（删除）该 lease**（一次性），写 pending.json（receiptId+returnRoute+oldPid）。校验失败 → 拒绝（no marker，error）。
- **routeId 非 chatId**：routeId opaque，泄露给模型输出也无用（无 lease store 解不开）；chatId 由 Bridge/restart CLI 从 lease 解析并按 bridgePid 校验。模型/命令无法自行提供 chatId。
- **并发 run 不串路由**：每个 run 独立 lease/routeId；restart CLI 消费指定 routeId 的 lease。**必须测试**：两个并发 run（不同 chat）各触发 restart → 各自 pending.json 的 returnRoute 匹配各自 chat，不串。
- **lease 生命周期**：一次性消费；未消费的 lease 过期（run 最大时长 + buffer）后 TTL 清理（按 routeId）。

### DD3 — helper 持久化协调者 + failure receipt

- `launchDeferredServiceRestart` 仍 spawn `node <cli> restart --profile <profile>`（strip LARK_CHANNEL）。helper 从 `profileDir/restart-receipt/pending.json` 读 marker（已持久化，无需经 env/args 传数据）。
- helper 职责：
  1. 读 pending.json（receiptId/returnRoute/oldPid）。
  2. `adapter.restart()`；`!r.ok` → failure reason=`service-action-failure`。
  3. `waitForServiceConnect(appId, profile, beforePids, timeout)` 观察新 bridge（**不以 adapter exit 0 判成功**，以新 PID+botName 出现为准）。超时 → 进入 failure 判定前先做 **final 短复查** `waitForServiceConnect(short)`：若新 bridge 已上来 → 不发 failure（让新 bridge 发 success）；仍 down → failure reason=`startup-timeout`。
  4. 新 bridge 连接成功 → helper **退出不发**（新 bridge 发 success）。
  5. failure → 原子 claim（rename pending→claimed.<receiptId>）→ `sendRestartReceipt(kind='failure', reason)`（uuid=f(receiptId,'failure')）→ complete（rename→completed，写 reason）。
  6. helper 无法发送 failure（receipt delivery failure）→ 保留 completed.<receiptId>.json 终态 + 写可定位 daemon/helper 日志；下次启动不得改写为成功。
- helper 重入 / 重复启动：`claimed.<receiptId>` 或 `completed.<receiptId>` 已存在 → 不再发、不再重启。

### DD4 — 新 Bridge success receipt（channel.connect 成功后 claim）

- 新 bridge 在 `startChannel` **`channel.connect` 成功后**（Feishu WS 连接 + 注册 + botName 回填）检查 pending.json：
  - 存在、returnRoute 存在、`oldPid` 为已退出的前序 bridge、`status==='pending'` → 原子 claim（rename pending→claimed.<receiptId>）→ `sendRestartReceipt(kind='success', newPid=process.pid, deployRevision 回显)`（uuid=f(receiptId,'success')）→ complete（rename→completed，写 messageId）。
  - 已 claimed/completed → 不补发。
  - 无 returnRoute（旧格式）→ 不发，按同 receiptId cleanup。
  - `oldPid` 不匹配/陈旧 → 不发，同 receiptId cleanup。
- **时序**：send/claim 在 `channel.connect` 成功**之后**。registry botName 回填（helper 的 waitForServiceConnect 观察依据）与新 bridge connect 之间的竞态，由 **原子 claim（唯一赢家）+ uuid 幂等** 收敛：helper final 复查减少误判 failure，claim 确保只有一方发，uuid 确保重发不重复。
- receipt sender 回传 messageId → 写入 `completed.<receiptId>.json` 作为验收证据。

### DD5 — exactly-once：原子 claim 状态机 + Feishu uuid（不留 Open Point）

- **跨进程原子 claim 状态机**（DD1）：`pending → claimed（CAS rename，唯一赢家）→ completed`。新 bridge 与 helper 边界同时读 pending 时，只有一方 claim 成功；另一方见 claimed → 不发。success/failure 互斥由 claim + helper final 复查保证。
- **Feishu 服务端幂等**：每条 receipt send（success 或 failure）带 `uuid = f(receiptId, kind)`（如 `restart-<receiptId>-success`）作为 Feishu IM create/reply 的 `uuid` 参数。重复 send（同 uuid）→ Feishu 返回同一 messageId，不产生重复用户可见消息。
- **send→status-write 崩溃**：claimer 发送成功（Feishu 已受理）但 complete（rename）前崩溃 → marker 留 `claimed`。重启后同 sender（或 claim 释放后另一 sender）重发 → 同 uuid → Feishu 去重 → 不重复 → 再 complete。exactly-once 由 **claim（唯一发送者）+ uuid（重发去重）** 共同保证。
- **claim 释放**：若 claimer 发送失败（Feishu 拒绝/网络），可 `rename(claimed→pending)` 释放让另一 sender 重试（同 uuid 仍幂等）；或保留 claimed 由同 sender 重试。实现选其一，保证不卡死。
- **不留 Open Point**：exactly-once 在本节定稿，不推迟实现。

### DD6 — 确定性 receipt sender（回传 messageId）

- 新增 `sendRestartReceipt({profile, returnRoute, kind:'success'|'failure', receiptId, newPid?, reason?, deployRevision?})`：
  - 从 profile config 解析 app 凭据（`resolveProfileRuntime`），不经 marker/env。
  - Feishu IM API 发送到 `returnRoute.chatId`（threadId 话题、replyTo 回复），`uuid=f(receiptId,kind)`。
  - 固定文案模板（Spec UX），**不接受模型文本/shell JSON**。杜绝 shell 手写 JSON typo。
  - 返回 `{ok, messageId}`。失败 → 返回 `{ok:false}`，caller 保留终态日志。
- 新 bridge（success）与 helper（failure）共用此函数。不启 Agent、不拼 shell。

### DD7 — Bridge System Prompt 自重启规则

- `src/agent/bridge-system-prompt.ts` 新增 `## 自重启（deferred restart + receipt）` 段：
  - 重启当前 Bot/profile 只调 `lark-channel-bridge restart --profile <LARK_CHANNEL_PROFILE>`；**禁止**直接 `launchctl`/`systemctl`/`schtasks`/kill 当前 bridge PID 或等价 service-manager 命令。
  - `restart` 返回"已安排"后继续完成本轮最终回复，不在同一轮等待 post-restart 结果，不把 scheduled 说成 restarted。
  - 收到 post-restart receipt 前不得声称重启成功；receipt 失败/缺失按实际状态报告。
  - 显式运维**其它** profile 不属自重启，沿用现有外部路径；按 `LARK_CHANNEL_PROFILE` 判当前 profile，不按 Bot 显示名猜。
- System Prompt 只规定动作选择与完成语义；route lease/drain/claim/receipt 由 Bridge 确定性代码保证。

## Execution Units

Owner：Unit 1-5 小C 实现；Unit 1-5 + 自检后交回小P，由云上C总 独立 Code Review GO 后才进 Unit 6。Unit 6 live success self-restart owner = 秦鹏+小P（小C 提供构建/配置/日志），failure live test 在隔离 fixture。Plan Review GO 前不修改运行代码、不部署。

### Unit 1 — RED：失败测试先行  Owner: 小C  ☐

Files：`tests/unit/runtime/deferred-service-restart.test.ts`、`tests/unit/cli/service-profile.test.ts`、`tests/integration/bot/markdown-stream-startup-failure.test.ts`、`tests/unit/bot/channel-intake.test.ts`，新增 receipt/route-lease/helper 专用测试。

Add failing coverage：
- 状态机：pending 唯一（O_EXCL，二次 create reject）；claim CAS 唯一赢家；complete 落 messageId；同 receiptId cleanup；跨 receiptId cleanup 拒绝；陈旧/损坏 marker 不补发不重启；旧格式降级仅重启。
- route lease：runAgentBatch 为当前 run 建 lease；env 只含 routeId 不含 chatId；restart CLI 按 routeId+bridgePid 校验+消费 lease；校验失败拒绝；**并发两 run 不同 chat 各触发 restart 不串路由**。
- drain：active batch 未归零不调 adapter.restart；归零后只启一次 helper；drain 期间新 batch 写回延后。
- helper：adapter.restart 失败→failure(service-action-failure)；超时无新 PID→final 复查→failure(startup-timeout)；新 PID+botName 出现→不发；helper 重入/重复不重复发。
- new bridge：channel.connect 成功后 claim+发 success（newPid/receiptId/deployRevision 回显）；已 claimed 不补发；无 returnRoute 不发；messageId 落 completed。
- exactly-once：新 bridge 与 helper 边界并发 claim → 恰一条 receipt；send→complete 间崩溃重发同 uuid 不重复；uuid=f(receiptId,kind)。
- System Prompt 契约：含禁直调 launchctl/systemctl/schtasks 规则；其它 profile 不误伤。
- 三平台：launchd/systemd/schtasks adapter 在 helper 流程等价（mock）。

Gate: targeted tests fail for missing behavior before production edits.

### Unit 2 — Marker 状态机 + route lease + return route 数据流  Owner: 小C  ☐

Files：`src/runtime/deferred-service-restart.ts`（receipt 目录 + 状态机 + 旧格式兼容）、新增 `src/runtime/route-lease.ts`（lease store）、`src/agent/lark-channel-env.ts`（routeId）、`src/agent/claude/adapter.ts`+`src/agent/codex/adapter.ts`（per-run routeId overlay）、`src/cli/commands/service.ts`（restart CLI 校验消费 lease + 唯一 pending create）、`src/bot/channel.ts`（runAgentBatch 建 lease + drain 读 pending 不删）。

Changes：按 DD1 建状态机（O_EXCL create + rename CAS + 同 receiptId cleanup + 旧格式降级）；按 DD2 建 lease store + per-run routeId + restart CLI 校验消费。`consumeDeferredServiceRestart` 改读不删（drain 只读 pending 判定是否本 bridge 请求）。

Gate: 状态机 + route lease + 并发不串路由 targeted tests pass；旧 marker 行为不变。

### Unit 3 — helper 协调者 + failure receipt  Owner: 小C  ☐

Files：`src/runtime/deferred-service-restart.ts`（launchDeferredServiceRestart 仍 strip LARK_CHANNEL）、`src/cli/commands/service.ts`（helper else 分支重写：读 pending + adapter.restart + waitForServiceConnect + final 复查 + claim + failure receipt）、`src/daemon/service-adapter.ts`（如需）。

Changes：按 DD3 重写 helper；failure reason 区分 service-action-failure/startup-timeout/receipt-delivery-failure。

Gate: helper targeted tests pass（failure 路径 + 新 PID 观察不误判 + final 复查）。

### Unit 4 — 新 Bridge success receipt + exactly-once  Owner: 小C  ☐

Files：`src/bot/channel.ts`（startChannel connect 后读 pending + claim + 发 success + complete）、`src/runtime/deferred-service-restart.ts`（claim/complete 原语）。

Changes：按 DD4/DD5 新 bridge channel.connect 后 claim+发 success+complete（messageId 落账）；原子 claim 状态机 + uuid 幂等。

Gate: new-bridge success + exactly-once targeted tests pass（含边界并发 + send→complete 崩溃重发）。

### Unit 5 — 确定性 receipt sender + Bridge System Prompt  Owner: 小C  ☐

Files：新增 `src/runtime/restart-receipt.ts`（sendRestartReceipt，uuid 幂等，回传 messageId）、`src/agent/bridge-system-prompt.ts`（自重启段）、`README.md`/`README.zh.md`。

Changes：按 DD6 实现 typed sender（从 config 解析凭据，固定文案，uuid，回传 messageId）；按 DD7 新增 System Prompt 段。

Gate: receipt-sender + system-prompt contract tests pass；docs contract tests pass。

### Code Review Gate  Owner: 云上C总  ☐

小C 完成 Unit 1-5 + 自检（`pnpm typecheck && pnpm test && pnpm build && git diff --check` 全绿）后交回小P。云上C总 对照 Spec（`b906c8b`）与本 Plan 独立 Code Review，GO 后才进 Unit 6。

### Unit 6 — 三平台测试 + 实机自部署（success 生产 Bot / failure 隔离 fixture）+ 回滚  Owner: 秦鹏+小P（小C 提供构建/配置/日志）  ☐

After Code Review GO：
1. 三平台自动化：mock adapter 证明 launchd/systemd/schtasks 在 helper 流程等价（drain→restart→新 PID 观察→claim→receipt）。
2. **Live success self-restart（当前生产 Bot，profile=claude 或指定）**：记录旧 PID、最终回复 message ID、receiptId、新 PID、post-restart receipt message ID；回读日志确认顺序：最终回复完成 → 旧进程退出 → 新进程连接飞书 → receipt 发送（messageId 落 completed）。**不在生产 Bot 上构造 failure**。
3. **Live failure test（隔离 profile/service fixture，非生产 Bot）**：构造 service-action-failure（坏 service 定义）与 startup-timeout（启动即崩的 binary）→ 验证恰好一条 failure receipt（正确 reason）或终态日志；不污染生产 Bot。
4. 回滚演练：恢复旧 marker + helper 行为，停止创建带 returnRoute/route lease 的新请求；在途新格式 → 诊断记录或显式 cleanup（同 receiptId），不静默误发。

Gate: 三平台测试 pass + 生产 Bot success 顺序证据齐全 + 隔离 fixture failure 两条路径证据齐全。Runtime PASS 需日志顺序 + receipt messageId，仅单测/进程存活不算完成。

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

- 代码回滚：恢复旧 `DeferredServiceRestartMarker`（无 receiptId/returnRoute）+ 旧 `consumeDeferredServiceRestart`（读后删）+ 旧 helper（不发 receipt）；停止创建带 returnRoute/route lease 的新请求。
- 在途新格式 marker/lease：保留为诊断记录，或由显式 cleanup 命令（同 receiptId/routeId）处理，不静默误发。
- System Prompt 自重启段可单独保留（约束 Agent 走 deferred 路径，与 receipt 解耦）。
- 旧 binary 读新格式：忽略未知字段，按旧语义仅重启（向后兼容）。

## Resolved Decisions（原 Open Points 已裁定，不推迟实现）

1. return route 机制：**route lease/routeId**（DD2），Agent env 只拿 routeId，restart CLI 按 profile+bridgePid 校验消费。已定稿。
2. marker 生命周期：**receipt 目录 + rename CAS 状态机**（DD1），consume→read+claim+complete。已定稿。
3. helper 取 marker 数据：**helper 直读 pending.json**（持久化）。已定稿。
4. send→status-write 崩溃：**uuid=f(receiptId,kind) 服务端幂等**（DD5），exactly-once 定稿，不留 Open Point。
5. 三平台测试：**mock adapter + 平台条件单元测试**；live 仅当前平台（Linux）success + 隔离 fixture failure。真三平台 CI 不在 v1 范围。
6. new bridge 读 marker 时序：**channel.connect 成功后**（DD4）。已定稿。
7. deployRevision：**v1 optional**（有则回显，无则不发）。

## Review Gate

本 Plan 经小P R1 Review 为 CHANGES REQUIRED，已按 6 项修订重写（见 Review History）。修订后需小P 复审：结论 PASS（或所有阻塞项修订并复审通过）后小C 才开始 Unit 1。Plan Writer 不自判 GO。Unit 1-5 完成后另由云上C总 独立 Code Review，GO 后才进 Unit 6。
