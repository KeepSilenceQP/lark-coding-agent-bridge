# Deferred Self-Restart And Post-Restart Receipt Coding Plan

Date: 2026-07-22
Status: revised after R2 CHANGES REQUIRED Plan Re-review — awaiting re-review
Authority: `docs/specs/20260722-deferred-self-restart-receipt.md` (confirmed by Qin Peng, commit `b906c8b`)
Branch: `fix/lark-bridge-followup`
Implementer: 小C
Plan Writer: 云上C总
Plan Reviewer: 小P

## Outcome

把 Bridge 同 profile 自部署重启收敛为跨进程闭环，receipt 投递 exactly-once：

1. Bridge-bound Agent 重启当前 profile 必须调用 `lark-channel-bridge restart --profile <current>`，禁止直接调用 `launchctl`/`systemctl`/`schtasks`/kill。
2. 当前 Bridge 等所有 active batch 完成、最终回复发送完毕后，才启动 detached helper（现有 drain 保留）。
3. marker 升级为 profile-private **原子状态机**，**文件名是状态权威**（`pending`→`claimed`→`completed`，另 `abandoned`/`delivery-failed` 终态），rename 为唯一状态迁移；唯一 pending（O_EXCL create/reject）；claim/complete 按 receiptId；stale pending 经 TTL+oldPid 死检后 quarantine 为 `abandoned`；cleanup 只作用同 receiptId。
4. return route 由 Bridge 在 `runAgentBatch` 为当前已验证 run 生成 **profile-private opaque route lease**，route = `firstMsg.chatId + firstMsg.threadId(已解析 topic) + lastMsg.messageId`；`routeId` 经 `AgentRunOptions` 传到每次实际 spawn/retry，Agent env 只拿 routeId；restart CLI 按 profile+bridgePid 校验 lease，**先 O_EXCL 创建 pending 成功再删 lease**（EEXIST/中断不得先丢 lease）。
5. 新 Bridge 在 `channel.connect` 成功后 claim 并发 success receipt；helper 在新 bridge 超时未注册时发 failure receipt。`claimed` 文件 immutable（kind/payload/uuid/claimer/claimedAt 固化）；recovery 以同 kind+uuid 恢复，不得 success↔failure 翻转；确定性凭据/API 失败落 `delivery-failed.<receiptId>` 终态。
6. receipt sender 回传 messageId 并落账（验收证据）。
7. Bridge System Prompt 新增自重启规则。

不负责：构建/安装/git 切换/service 定义修改/跨 profile 编排/自动重试部署/通知另一个 Bot（交接用 at-bot）/Agent turn 续跑。

## Review History

- **R1（小P，CHANGES REQUIRED）**：6 项（DD5 互斥不成立、return route 定稿、唯一 pending、Unit 6 failure 隔离、success 时序、裁定 Open Points）。已修订。
- **R2（小P，CHANGES REQUIRED，范围收敛，R1 findings 已关闭）**：6 项精确修正：
  1. DD2 route 取值事实错误：reply target 是 `runAgentBatch` 中 `lastMsg.messageId`（现有 `sendOpts.replyTo`），非 `firstMsg.replyTo`；route = `firstMsg.chatId + resolved topic threadId + lastMsg.messageId`，经 `AgentRunOptions.routeId` 传到每次 spawn/retry。
  2. 并发 run 与唯一 pending 冲突：两 run 各独立 lease，首个 O_EXCL 创建唯一 pending 且 route 正确，第二个 EEXIST/reject 不覆盖不串路由；顺序：校验 lease → O_EXCL 创建 pending → 再按 routeId 删 lease；EEXIST/中断不得先丢 lease。
  3. claimed 崩溃恢复未定稿：删除"二选一"，定唯一恢复语义（claimed immutable、本 sender 有界重试、recovery 同 kind+uuid 不翻转、delivery-failed 终态、写明互斥与触发点）。
  4. stale pending 永久 EEXIST：TTL 超时 + oldPid 已死 → 原子 quarantine `abandoned.<receiptId>.json`（诊断不发送）后才允许新请求；claimed/completed/delivery-failed 按 receiptId 安全 GC。
  5. 文件名已表达状态，rename 后 JSON 内 status 不自动变：以文件名为状态权威（JSON 不带可变 status）。
  6. DD4 `channel.connect` 成功时 botName 尚未在 registry 回填（updateEntry 在 startChannel 返回后）：修正文案；新 bridge connect 后 claim/send，helper 在随后 botName 回填后观察到它，边界仍由 claim+uuid 收敛。
- **R2 修订（本次）**：重写 DD1-DD5、Unit 1/2/6、Resolved，加本 Review History。Status awaiting re-review。Plan Writer 不自判 GO。

## Current Evidence

基于 `fix/lark-bridge-followup@b906c8b` live code（per-group + at-bot 已合入）：

- **marker** `src/runtime/deferred-service-restart.ts`：`MARKER_FILE='.deferred-service-restart.json'`（profileDir）；`DeferredServiceRestartMarker={profile, bridgePid?, requestedAt}`；`requestDeferredServiceRestart` 原子写（temp+rename）；`consumeDeferredServiceRestart` 读后删；`launchDeferredServiceRestart(profile)` detached spawn `node <cli> restart --profile <profile>`，strip LARK_CHANNEL，stdio ignore，unref。
- **drain** `src/bot/channel.ts:666-685` `maybeLaunchDeferredRestart`：门 `activeBatchCount!==0 || deferredRestartLaunching`；归零后 consume + launch helper；read 期间新 batch 写回延后。`:823` flush finally 调用。
- **runAgentBatch** `src/bot/channel.ts:1306`：`firstMsg=batch[0]`、`lastMsg=batch[batch.length-1]`（:1325-1326）；`chatId=firstMsg.chatId`、`threadId=firstMsg.threadId`（:1329-1330）；`sendOpts={ replyTo: lastMsg.messageId, ...(mode==='topic'&&threadId?{replyInThread:true}:{}) }`（:1435-1437）。即 reply target = **lastMsg.messageId**。
- **restart 命令** `src/cli/commands/service.ts:371-397` `runServiceRestart`：bridge-bound 同 profile → `requestDeferredServiceRestart` 写 marker @384 + "已安排"；否则 `reportConnectAfter('restarted', adapter.restart)`。
- **新 PID 观察** `service.ts:201-221` `waitForServiceConnect(appId, profile, beforePids, 30s)`：轮询 `readAndPrune()` 找 `appId+profile` 且 `pid∉beforePids` 且 `botName` 已填的新 bridge。
- **service adapter** `src/daemon/service-adapter.ts`：`restart()`/`waitUntilStopped()`/`parseStatus()`；三平台 launchd/systemd/schtasks。
- **agent 子进程 env** `src/agent/lark-channel-env.ts` `buildLarkChannelEnv`：注入 LARK_CHANNEL/PROFILE/BRIDGE_PID/HOME/CONFIG/LARKSUITE_CLI_CONFIG_DIR，无 chatId/routeId。调用点 `claude/adapter.ts:91`、`codex/adapter.ts:127,222`，`this.larkChannel` bridge-static。
- **registry botName 回填**：`updateEntry`（registry）在 `startChannel` 返回后由 channel 事件回填；`channel.connect` 成功时 botName 尚未在 registry。
- **in-process restart** `src/cli/commands/start.ts:254` `Controls.restart`：connect-before-disconnect，非 deferred，out of scope 不变。
- **Bridge System Prompt** `src/agent/bridge-system-prompt.ts`：无自重启段。
- profile 私有目录 `src/config/app-paths.ts` `profileDir`；registry `src/runtime/registry.ts` `readAndPrune`。
- 现有测试 `tests/unit/runtime/deferred-service-restart.test.ts`、`tests/unit/cli/service-profile.test.ts`、`tests/integration/bot/markdown-stream-startup-failure.test.ts`、`tests/unit/bot/channel-intake.test.ts`。
- receiptId/returnRoute/routeId/post-restart 在 live code 中均不存在。

## Design Decisions

### DD1 — Marker 原子状态机（文件名为状态权威，唯一 pending，同 receiptId cleanup，stale quarantine）

- profile-private **receipt 目录** `profileDir/restart-receipt/`，**文件名是状态权威**（状态迁移=原子 rename，JSON 不带可变 `status` 字段）：
  - `pending.json` — 唯一待处理请求。
  - `claimed.<receiptId>.json` — 某 sender 已 claim（immutable：kind/payload/uuid/claimer/claimedAt 固化）。
  - `completed.<receiptId>.json` — 已完成（含 messageId/reason）。
  - `abandoned.<receiptId>.json` — stale quarantine（诊断，不发送）。
  - `delivery-failed.<receiptId>.json` — 确定性发送失败终态（诊断，不发送）。
- **marker JSON payload**（无 status 字段）：`{ receiptId, profile, oldPid, requestedAt, returnRoute?:{chatId,threadId?,replyTo}, deployRevision?, kind?, uuid?, claimer?, claimedAt?, messageId?, failureReason? }`。状态由文件名表达，避免"claimed 文件内仍 status=pending"。
- **唯一 pending 原子 create/reject**：restart CLI 用 `open(pending.json, 'wx')`（O_CREAT\|O_EXCL）写。EEXIST → 拒绝新请求，回显现有 receiptId（"restart already pending, receiptId=…"），不覆盖。
- **原子 claim（CAS）**：sender 读 `pending.json` → 校验 receiptId + 文件确为 pending → `rename(pending.json, claimed.<receiptId>.json)`（rename 原子，唯一赢家；输家见 pending.json 不在 → 不发）。Windows 用 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` 或独占 create 等价。
- **原子 complete**：claimer 发送成功后 `rename(claimed.<receiptId>.json, completed.<receiptId>.json)`，写 messageId。
- **stale pending 过期恢复**：`pending.json` 会让所有后续 restart 永久 EEXIST。定稿：仅当 `TTL 超时 && oldPid 已死`（`process.kill(oldPid,0)` 抛 ESRCH）时，原子 `rename(pending.json, abandoned.<receiptId>.json)`（quarantine，诊断不发送），之后才允许新请求 O_EXCL。oldPid 仍活 → 不 quarantine（仍在途）。
- **cleanup 只作用同 receiptId**：TTL/GC/显式命令只删匹配指定 receiptId 的 `claimed/completed/abandoned/delivery-failed.<receiptId>.json`，**绝不**跨 receiptId 或清空他人 pending。
- **损坏**：JSON parse 失败 → 该文件 rename 为 `abandoned.<receiptId>.json`（或 receiptId 未知则 `abandoned.corrupt-<ts>.json`）+ 日志，不重启不补发。
- **兼容旧 marker**：旧 `.deferred-service-restart.json`（无 receiptId/returnRoute）→ 仅重启不发 receipt；新代码识别降级，不阻塞新格式。
- marker 内容不含 App Secret/token/cookie/完整用户消息/可执行 shell。

### DD2 — return route：opaque route lease + per-run 数据流（route 字段已修正）

完整 per-run 数据流（不留实现者）：

1. `runAgentBatch`（`channel.ts:1306`）取当前 batch：`firstMsg=batch[0]`、`lastMsg=batch[batch.length-1]`。**returnRoute = { chatId: firstMsg.chatId, threadId: firstMsg.threadId（已解析 topic）, replyTo: lastMsg.messageId }**（reply target = `sendOpts.replyTo = lastMsg.messageId`，非 firstMsg.replyTo）。
2. spawn agent 前，Bridge 在 profile-private **route lease store**（`profileDir/route-leases/`，每 lease 一文件 `<routeId>.json` 原子写）创建 lease：`{ routeId: <opaque uuid>, chatId, threadId?, replyTo, bridgePid: process.pid, runId?, createdAt, expiresAt }`（returnRoute 字段同上）。
3. **per-run routeId 经 `AgentRunOptions` 传递**：`AgentRunOptions` 增 `routeId`，`runAgentBatch` 把 lease.routeId 放入 AgentRunOptions；adapter 每次**实际 spawn/retry** 都从 AgentRunOptions 取 routeId，经 `buildLarkChannelEnv` overlay 进 env `LARK_CHANNEL_ROUTE_ID=<routeId>`（仅 routeId，不输出 chatId）。`claude/adapter.ts:91`、`codex/adapter.ts:127,222` spawn 站点 per-run overlay（覆盖 bridge-static `this.larkChannel`）。retry 重 spawn 也带同一 routeId。
4. Agent 跑 `lark-channel-bridge restart --profile <LARK_CHANNEL_PROFILE>`（不传 chatId/通知正文）。
5. restart CLI（`service.ts` bridge-bound 分支）读 env `LARK_CHANNEL_ROUTE_ID` + `LARK_CHANNEL_BRIDGE_PID` → 开 lease store 找 lease → 校验 `lease.bridgePid === LARK_CHANNEL_BRIDGE_PID` 且未过期 → 取 lease 的 returnRoute。
6. **lease 消费顺序（关键）**：校验 lease 通过 → **O_EXCL 创建 pending.json 成功**（含 returnRoute+receiptId）→ **再按 routeId 删除 lease**。若 O_EXCL 失败（EEXIST，已有 pending）或进程中断 → **不得先删 lease**（lease 保留，可重试或 TTL 清理；pending 未创建则 route 不丢）。校验 lease 失败 → 拒绝（no marker）。
- **routeId 非 chatId**：routeId opaque，泄露给模型输出也无用；chatId 由 Bridge/restart CLI 从 lease 解析并按 bridgePid 校验。模型/命令无法自行提供 chatId。
- **并发 run 不串路由（修正）**：两并发 run 各有独立 lease；首个 restart CLI O_EXCL 创建唯一 pending（route 正确），第二个 O_EXCL 得 EEXIST → 明确 reject、不覆盖、不串路由（其 lease 保留）。验收：两 run 不同 chat 各触发 restart → 恰一个 pending 且 returnRoute=首个 run 的 route，另一个 EEXIST reject。
- **lease 生命周期**：一次性消费（pending 创建成功后删）；未消费 lease 过期后 TTL 清理（按 routeId）。

### DD3 — helper 持久化协调者 + failure receipt + 崩溃恢复

- `launchDeferredServiceRestart` 仍 spawn `node <cli> restart --profile <profile>`（strip LARK_CHANNEL）。helper 从 `pending.json` 读 marker（已持久化）。
- helper 职责：
  1. 读 pending.json（receiptId/returnRoute/oldPid）。
  2. `adapter.restart()`；`!r.ok` → failure reason=`service-action-failure`。
  3. `waitForServiceConnect(appId, profile, beforePids, timeout)` 观察新 bridge（不以 adapter exit 0 判成功，以新 PID+botName 出现为准）。超时 → failure 判定前先 **final 短复查** `waitForServiceConnect(short)`：新 bridge 已上来 → 不发 failure（让新 bridge 发 success）；仍 down → reason=`startup-timeout`。
  4. 新 bridge 连接成功（registry botName 回填后 helper 观察到）→ helper 退出不发。
  5. failure → 原子 claim（rename pending→claimed.<receiptId>，固化 kind=failure/uuid/claimer/claimedAt）→ 有界重试 `sendRestartReceipt(kind='failure', reason)`（uuid=f(receiptId,'failure')）→ 成功则 complete（rename→completed）；确定性凭据/API 失败 → `rename(claimed→delivery-failed.<receiptId>)` 终态 + daemon/helper 日志。
- **崩溃恢复（唯一语义，不二选一）**：`claimed.<receiptId>.json` immutable（claim 时固化 kind/payload/uuid/claimer/claimedAt，后续不改）。本 sender（helper 或新 bridge）有界重试发送。若 send 结果不确定或 send→complete 间崩溃，recovery 以**同 kind+uuid** 恢复（重发同 uuid，Feishu 去重），**不得** success↔failure 翻转。确定性凭据/API 失败落 `delivery-failed.<receiptId>` 终态。
- **recovery 互斥与触发点**：recovery 由"发现 `claimed.<receiptId>.json` 存在但无对应 `completed`/`delivery-failed`"触发。新 bridge 启动时扫描 `claimed.*.json`：对每个 claimed，按其固化的 kind+uuid 恢复（重发+complete），不翻转。helper 自身 claim 后做有界重试（不依赖新 bridge）。互斥：`claimed→completed`/`claimed→delivery-failed` 的 rename 原子，唯一赢家。helper 重入/重复：claimed/completed/delivery-failed 已存在 → 不再发、不再重启。

### DD4 — 新 Bridge success receipt（channel.connect 成功后 claim；botName 回填时序修正）

- **时序事实修正**：`channel.connect` 成功时 botName 尚未在 registry 回填（`updateEntry` 在 `startChannel` 返回后由 channel 事件回填）。因此：
  - 新 bridge 在 `channel.connect` 成功后即可 claim/send success（它自身已知连接可用，不依赖 registry botName）。
  - helper 只在随后 registry botName 回填后（`waitForServiceConnect` 观察到）才观察到新 bridge。
  - 边界（新 bridge 已 connect 但 helper 尚未观察到 botName）由 **原子 claim + uuid** 收敛：新 bridge connect 后 claim success；helper final 复查 + claim 确保不双发。
- 新 bridge `channel.connect` 成功后检查 `pending.json`：存在、returnRoute 存在、`oldPid` 为已退出前序 bridge → 原子 claim（rename pending→claimed.<receiptId>，固化 kind=success/uuid/claimer/claimedAt）→ 有界重试 `sendRestartReceipt(kind='success', newPid=process.pid, deployRevision 回显)`（uuid=f(receiptId,'success')）→ complete（rename→completed，写 messageId）。
- 已 claimed/completed → 不补发（若 claimed 为 failure kind，新 bridge 不翻转）。
- 无 returnRoute（旧格式）→ 不发，同 receiptId cleanup。oldPid 不匹配/陈旧 → 不发，同 receiptId cleanup 或走 DD1 stale quarantine。
- receipt sender 回传 messageId → 写 `completed.<receiptId>.json` 作为验收证据。

### DD5 — exactly-once：原子 claim 状态机 + Feishu uuid + 唯一 recovery（不留 Open Point）

- **跨进程原子 claim 状态机**（DD1，文件名为权威）：`pending → claimed（CAS rename，唯一赢家）→ completed`。新 bridge 与 helper 边界同时读 pending 时，只有一方 claim 成功；另一方见 pending 不在 → 不发。success/failure 互斥由 claim + helper final 复查保证。
- **Feishu 服务端幂等**：每条 receipt send 带 `uuid = f(receiptId, kind)`（如 `restart-<receiptId>-success`）作 Feishu IM create/reply 的 `uuid` 参数。重复 send（同 uuid）→ Feishu 返回同一 messageId，不产生重复用户可见消息。
- **唯一 recovery 语义（删除"二选一"）**：
  - `claimed.<receiptId>.json` immutable（claim 时固化 kind/payload/uuid/claimer/claimedAt）。
  - 本 sender 有界重试。
  - send 不确定或 send→complete 崩溃 → recovery 以同 kind+uuid 恢复（重发去重），**绝不** success↔failure 翻转。
  - 确定性凭据/API 失败 → `delivery-failed.<receiptId>` 终态（不发送，诊断）。
  - recovery 互斥：`claimed→completed`/`claimed→delivery-failed` rename 原子，唯一赢家。
  - recovery 触发点：新 bridge 启动扫描 `claimed.*.json` 恢复；helper 自身有界重试。
- **exactly-once 保证**：claim（唯一发送者）+ uuid（重发去重）+ immutable claimed（不翻转）+ delivery-failed（确定性失败终态）。不留 Open Point。

### DD6 — 确定性 receipt sender（回传 messageId）

- `sendRestartReceipt({profile, returnRoute, kind:'success'|'failure', receiptId, newPid?, reason?, deployRevision?})`：从 profile config 解析 app 凭据（`resolveProfileRuntime`，不经 marker/env）；Feishu IM API 发到 `returnRoute.chatId`（threadId 话题、replyTo 回复），`uuid=f(receiptId,kind)`；固定文案模板（Spec UX），不接受模型文本/shell JSON；返回 `{ok, messageId}`。失败 → `{ok:false}`，caller 落 `delivery-failed` 终态。新 bridge 与 helper 共用，不启 Agent、不拼 shell。

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

Files：`tests/unit/runtime/deferred-service-restart.test.ts`、`tests/unit/cli/service-profile.test.ts`、`tests/integration/bot/markdown-stream-startup-failure.test.ts`、`tests/unit/bot/channel-intake.test.ts`，新增 receipt/route-lease/helper/recovery 专用测试。

Add failing coverage：
- 状态机（文件名权威）：pending 唯一（O_EXCL，二次 create EEXIST reject）；claim CAS 唯一赢家；complete 落 messageId；JSON 不带可变 status（claimed 文件内无 status=pending）；同 receiptId cleanup；跨 receiptId cleanup 拒绝；stale pending（TTL+oldPid 死）→ quarantine `abandoned.<receiptId>`；oldPid 仍活不 quarantine；损坏 marker quarantine；旧格式降级仅重启。
- route lease：runAgentBatch 用 `firstMsg.chatId + firstMsg.threadId + lastMsg.messageId` 建 lease；env 只含 routeId 不含 chatId；routeId 经 AgentRunOptions 传到每次 spawn/retry；restart CLI 按 routeId+bridgePid 校验+消费 lease；**消费顺序**：O_EXCL 创建 pending 成功后才删 lease，EEXIST/中断不先丢 lease；校验失败拒绝；**并发两 run 不同 chat 各触发 restart**：首个 O_EXCL 成功（route=首个 run），第二个 EEXIST reject 不覆盖不串路由。
- drain：active batch 未归零不调 adapter.restart；归零后只启一次 helper；drain 期间新 batch 写回延后。
- helper：adapter.restart 失败→failure(service-action-failure)；超时无新 PID→final 复查→failure(startup-timeout)；新 bridge botName 回填后 helper 观察到→不发；helper 重入/重复不重复发。
- new bridge：`channel.connect` 成功后 claim+发 success（newPid/receiptId/deployRevision 回显）；已 claimed 不补发；claimed 为 failure kind 不翻转；无 returnRoute 不发；messageId 落 completed。
- exactly-once + recovery：新 bridge 与 helper 边界并发 claim → 恰一条 receipt；send→complete 间崩溃 → recovery 同 kind+uuid 重发不重复、不翻转；确定性凭据/API 失败 → delivery-failed.<receiptId> 终态；recovery 互斥（claimed→completed/delivery-failed 唯一赢家）。
- System Prompt 契约：含禁直调 launchctl/systemctl/schtasks 规则；其它 profile 不误伤。
- 三平台：launchd/systemd/schtasks adapter 在 helper 流程等价（mock）。

Gate: targeted tests fail for missing behavior before production edits.

### Unit 2 — Marker 状态机 + route lease + return route 数据流  Owner: 小C  ☐

Files：`src/runtime/deferred-service-restart.ts`（receipt 目录 + 文件名权威状态机 + stale quarantine + 旧格式兼容）、新增 `src/runtime/route-lease.ts`（lease store）、`src/agent/lark-channel-env.ts`（routeId）、`src/agent/claude/adapter.ts`+`src/agent/codex/adapter.ts`（per-run routeId overlay，经 AgentRunOptions）、`src/cli/commands/service.ts`（restart CLI 校验 lease + O_EXCL 创建 pending + 创建成功后删 lease + EEXIST reject）、`src/bot/channel.ts`（runAgentBatch 建 lease 用 firstMsg.chatId/threadId + lastMsg.messageId + AgentRunOptions.routeId + drain 读 pending 不删）。

Changes：按 DD1 建文件名权威状态机（O_EXCL + rename CAS + stale quarantine + 同 receiptId cleanup + 旧格式降级）；按 DD2 建 lease store + per-run routeId（AgentRunOptions）+ restart CLI 校验消费（创建 pending 后删 lease）。`consumeDeferredServiceRestart` 改读不删。

Gate: 状态机 + route lease + 并发 EEXIST 不串路由 + lease 消费顺序 targeted tests pass；旧 marker 行为不变。

### Unit 3 — helper 协调者 + failure receipt + recovery  Owner: 小C  ☐

Files：`src/runtime/deferred-service-restart.ts`、`src/cli/commands/service.ts`（helper else 分支：读 pending + adapter.restart + waitForServiceConnect + final 复查 + claim + failure receipt + 有界重试 + delivery-failed）、`src/daemon/service-adapter.ts`（如需）。

Changes：按 DD3 重写 helper；failure reason 区分 service-action-failure/startup-timeout/receipt-delivery-failure；claimed immutable；有界重试；delivery-failed 终态。

Gate: helper targeted tests pass（failure 路径 + 新 PID 观察不误判 + final 复查 + recovery 不翻转）。

### Unit 4 — 新 Bridge success receipt + exactly-once + recovery  Owner: 小C  ☐

Files：`src/bot/channel.ts`（startChannel `channel.connect` 成功后读 pending + claim + 发 success + complete + 扫描 claimed.* 恢复）、`src/runtime/deferred-service-restart.ts`（claim/complete/recovery 原语）。

Changes：按 DD4/DD5 新 bridge `channel.connect` 成功后 claim+发 success+complete（messageId 落账）；recovery 扫描 claimed.* 同 kind+uuid 恢复不翻转；delivery-failed 终态。

Gate: new-bridge success + exactly-once + recovery targeted tests pass（含边界并发 + send→complete 崩溃恢复 + 不翻转 + delivery-failed）。

### Unit 5 — 确定性 receipt sender + Bridge System Prompt  Owner: 小C  ☐

Files：新增 `src/runtime/restart-receipt.ts`（sendRestartReceipt，uuid 幂等，回传 messageId）、`src/agent/bridge-system-prompt.ts`（自重启段）、`README.md`/`README.zh.md`。

Changes：按 DD6 实现 typed sender（从 config 解析凭据，固定文案，uuid，回传 messageId）；按 DD7 新增 System Prompt 段。

Gate: receipt-sender + system-prompt contract tests pass；docs contract tests pass。

### Code Review Gate  Owner: 云上C总  ☐

小C 完成 Unit 1-5 + 自检（`pnpm typecheck && pnpm test && pnpm build && git diff --check` 全绿）后交回小P。云上C总 对照 Spec（`b906c8b`）与本 Plan 独立 Code Review，GO 后才进 Unit 6。

### Unit 6 — 三平台测试 + 实机自部署（success 生产 Bot / failure 隔离 fixture）+ 回滚  Owner: 秦鹏+小P（小C 提供构建/配置/日志）  ☐

After Code Review GO：
1. 三平台自动化：mock adapter 证明 launchd/systemd/schtasks 在 helper 流程等价（drain→restart→新 PID 观察→claim→receipt）。
2. **Live success self-restart（当前生产 Bot，profile=claude 或指定）**：记录旧 PID、最终回复 message ID、receiptId、新 PID、post-restart receipt message ID；回读日志确认顺序：最终回复完成 → 旧进程退出 → 新进程 `channel.connect` 成功 → receipt 发送（messageId 落 completed）。不在生产 Bot 构造 failure。
3. **Live failure test（隔离 profile/service fixture，非生产 Bot）**：构造 service-action-failure（坏 service 定义）与 startup-timeout（启动即崩 binary）→ 验证恰好一条 failure receipt（正确 reason）或 `delivery-failed`/`abandoned` 终态日志；不污染生产 Bot。
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

1. return route 机制：route lease/routeId（DD2），Agent env 只拿 routeId，restart CLI 按 profile+bridgePid 校验消费。已定稿。
2. marker 生命周期：receipt 目录 + 文件名权威 rename CAS 状态机（DD1）。已定稿。
3. helper 取 marker 数据：helper 直读 pending.json（持久化）。已定稿。
4. send→status-write 崩溃：uuid=f(receiptId,kind) 服务端幂等 + immutable claimed + 唯一 recovery（DD5），exactly-once 定稿，不留 Open Point。
5. 三平台测试：mock adapter + 平台条件单元测试；live 仅当前平台（Linux）success + 隔离 fixture failure。真三平台 CI 不在 v1 范围。
6. new bridge 读 marker 时序：`channel.connect` 成功后（botName 回填前即可 claim/send）（DD4）。已定稿。
7. deployRevision：v1 optional（有则回显，无则不发）。

## Review Gate

本 Plan 经小P R1（CHANGES REQUIRED）→ R2（CHANGES REQUIRED，范围收敛，R1 已关闭）两轮 review，已按 R2 6 项修订（见 Review History）。修订后需小P 复审：结论 PASS（或所有阻塞项修订并复审通过）后小C 才开始 Unit 1。Plan Writer 不自判 GO。Unit 1-5 完成后另由云上C总 独立 Code Review，GO 后才进 Unit 6。
