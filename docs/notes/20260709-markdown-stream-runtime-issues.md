# 2026-07-09 Markdown Stream Runtime Issues

This note records the recent Lark bridge markdown/card runtime issues reported by Qin Peng. It is a diagnosis log, not a fix plan approval.

## Current Boundary

- Confirmed problem area: Codex/Lark bridge markdown streaming replies, especially CardKit streaming card update/finalization and readback.
- Current branch: `fix/msg_break`
- Current HEAD at the time of writing: `719797a Merge remote-tracking branch 'origin/main' into fix/msg_break`
- Dropped bad fixes: `f107f89 fix: hard-timeout silent agent runs`, `757f99b Revert "fix: hard-timeout silent agent runs"`, `4ec93fc fix: serialize codex bridge runs`
- Important constraint: only count user-reported message interruption / incomplete / stale / stuck cases here. Later indirect issues introduced by bugfix attempts, such as visible UI changes or duplicate fallback sends, are excluded from the main issue list.

## Issue 1: Task Completed But Card Did Not Update To Final Content

### 1. Phenomenon

User saw a card stuck in an old/running state, while the actual Codex task had completed. Screenshot showed the card still around intermediate content such as tool calls / "正在调用工具".

### 2. Runtime / Trace / Session Info

Concrete confirmed case:

- User message: `om_x100b6bc2776ef0e4c22c3e0a38fe1de`
- Trace: `8k2mhyaz`
- Run ID: `82435a1d-8f2a-42c5-bfe0-22d2b10e880b`
- Session ID: `019f44a3-fa34-7452-803b-3e1f1284d094`
- Codex session file:
  `/Users/bytedance/.codex/sessions/2026/07/09/rollout-2026-07-09T10-10-25-019f44a3-fa34-7452-803b-3e1f1284d094.jsonl`
- Final answer existed in Codex session at 17:24, saying the test doc was updated to revision 13.
- Bridge log:
  - `run completed`, result `normal`, duration `1305310ms`
  - `card final`, terminal `done`
  - `markdown-producer-final`, `chars=20423`, `flushes=316`, `hasRunningFooter=false`
  - `markdown-terminal-resolved`, message `om_x100b6bc2771800acc39eba9f347d771`
  - `markdown-readback-mismatch`, same message ID, `didRollover=false`, `chunkIds=[]`

Important mismatch details:

- `liveTail` was still old running/intermediate card content, including `正在调用工具`, `stream_md`, `markdown`, `fast`, `2.0`.
- `expectedTail` was the final answer beginning with `已完成。测试文档已更新到 revision 13`.

Second confirmed case:

- User message: `om_x100b6bcc6dc0acb4c4a41658f8e1b1d`
- Trace: `clujpjym`
- Run ID: `68d30069-9409-4301-be10-2de9c3a67f5c`
- Session ID: `019f44a3-fa34-7452-803b-3e1f1284d094`
- Reply card message: `om_x100b6bcc6df0c484c4eca45347d1fc1`
- Chat: `oc_f89495c27df18efb279272477122c0cc`
- Codex session file:
  `/Users/bytedance/.codex/sessions/2026/07/09/rollout-2026-07-09T10-10-25-019f44a3-fa34-7452-803b-3e1f1284d094.jsonl`
- Codex final answer existed in the session, saying the `add_to_desktop`补测 was completed and the test document was updated to revision 22.
- Bridge log:
  - `completed`, result `normal`, duration `715969ms`
  - `markdown-producer-final`, `terminal=done`, `chars=11553`, `flushes=172`, `hasRunningFooter=false`
  - `exit`, PID `92360`, `code=0`, `signal=null`
  - `markdown-terminal-resolved`, message `om_x100b6bcc6df0c484c4eca45347d1fc1`
  - `markdown-readback-mismatch`, same message ID, `didRollover=false`, `chunkIds=[]`

Important mismatch details:

- `liveTail` was still old card content around `刚才更新命令的环境变量写法不兼容 zsh` and `正在调用工具`.
- `expectedTail` was the final answer around `这次补的是 add_to_desktop` and `本地仓库工作区是干净的`.
- Independent `lark-cli im +messages-mget --message-ids om_x100b6bcc6df0c484c4eca45347d1fc1 --as user --format json` still read the stale card content after the run.

Third confirmed case, captured after the CardKit probes were deployed:

- Source message: `om_x100b6a6b25fd9024c38fcee16b988ac`
- Trace: `9csdgepc`
- Run ID: `c3d2cc87-aa0d-49ab-b673-da8559b571c4`
- Card ID: `7662301595611106587`
- Reply card message: `om_x100b6a6b25903c88c0b6575f0f9f3e2`
- Chat: `oc_f89495c27df18efb279272477122c0cc`
- Card created successfully at `2026-07-14 16:43:33.413 +08:00`.
- Element updates sequence 1 through 42 returned `code=0`.
- The first failed update was sequence 43 at `16:53:39.197`, 605.784 seconds after card creation. It returned `code=300309`, `streaming mode is closed`.
- Every later element update through the final sequence 57 returned the same `300309` response.
- Codex still completed normally. The bridge rendered final markdown with `chars=5116`, `hash=9085df7d5ac2`, and no running footer.
- `card.settings` sequence 58 returned `code=0`, but it only finalized card settings; it did not restore the rejected element content.
- Readback remained on the old running content with `hash=d4bdbeaac704` and a running footer.

### 3. Current Analysis

This is not a Codex execution failure or a readback-only inconsistency. The root cause is now confirmed:

1. Feishu automatically closes CardKit streaming mode after 10 minutes.
2. `@larksuite/channel@0.3.0` knows about that limit in its source comments but does not recover the markdown controller when it is reached.
3. The Lark node SDK resolves CardKit business errors as response objects. `OutboundSender.updateCardElementContent()` ignored the response `code`, so `code=300309` was treated as success instead of an error.
4. The controller therefore continued sending rejected element updates, called `card.settings`, and returned a successful stream result. `card.settings` cannot restore markdown that the element API rejected.

The exact failure chain is: long run crosses the CardKit 10-minute streaming lifetime -> element updates return `300309` -> channel ignores the business error -> final settings succeeds -> stream falsely resolves -> readback exposes stale running content.

### 4. Fix Status

- Fix implemented in the bridge's CardKit boundary wrapper, because a dependency-local pnpm patch is not inherited by downstream/global installs.
- When `cardElement.content` returns the documented expiry codes `300309` or `200850`, the bridge immediately retries the same content and sequence through `card.update`, replacing the same card with `streaming_mode=false`.
- The bridge remembers that card as expired for the lifetime of the current stream. Later controller snapshots go directly through `card.update` instead of first repeating an element request that is guaranteed to fail.
- Recovery business responses are accepted only when `code=0`. A transient recovery failure can be cleared by a later successful snapshot; if the final recovery state is still failed, `channel.stream()` rejects and the bridge sends its existing final Markdown fallback.
- Recovery request/result logs include card ID, sequence, content hash, duration, and raw business result.
- Regression tests cover successful recovery, both expiry codes, rejected and malformed recovery responses, transient recovery, the normal streaming path, later full-card snapshots, and the real `channel.stream()` / final fallback path.
- Previous hard-timeout and serialized-Codex changes remain excluded; they did not address this root cause.

### 5. Next Plan

- Run the full bridge test/typecheck/build suite.
- Deploy the bridge recovery path to the active Codex profile.
- On the next run longer than 10 minutes, require direct proof of this sequence: expiry element response -> full `card.update code=0` -> later full-card snapshots without repeated element failures -> final readback match.

## Issue 2: Card/Readback Mismatch Recurs Across Multiple Normal Runs

### 1. Phenomenon

Several normal runs complete, but final readback does not match expected markdown. Sometimes the user-visible card appears stale; sometimes readback mismatch may only be a CardKit text rewrite.

### 2. Runtime / Trace / Session Info

Confirmed examples:

- `yp61vkyr`, message `om_x100b6bc7dfa6bcb4c1038a39343715c`, `final-readback-mismatch-no-fallback`
- `2lhybkem`, message `om_x100b6bc7d1486ca4c3ba41a96267ce2`, `final-readback-mismatch-no-fallback`
- `94dzimie`, message `om_x100b6bc7d55da8b0c3c95551fbea8b5`, `final-readback-mismatch-no-fallback`
- `4wemjyzo`, message `om_x100b6bc28d4078b4c444b4afc5850be`, `final-readback-mismatch-no-fallback`
- `8k2mhyaz`, message `om_x100b6bc2771800acc39eba9f347d771`, `final-readback-mismatch-no-fallback`

All examples have `didRollover=false` and `chunkIds=[]` in readback mismatch logs.

### 3. Current Analysis

There are at least two subtypes under the same log event:

1. Benign/canonicalization mismatch: readback rewrites markdown or returns downgraded card wrapper content.
2. Real stale-card mismatch: final content does not become visible, as in trace `8k2mhyaz`.

Current logs are not rich enough to reliably separate these subtypes without inspecting actual card update/finalization behavior.

### 4. Fix Status

- Duplicate fallback risk fixed by no longer sending text fallback.
- Stale final card not fixed.

### 5. Next Plan

- Split mismatch classification:
  - "readback canonicalized but final text present"
  - "readback stale and final text absent"
  - "readback unsupported/downgraded"
  - "readback timeout"
- Add enough runtime fields to classify without guessing.

## Issue 3: Codex Child Process Alive But No stdout / Card Stays Thinking

### 1. Phenomenon

The card stayed in a thinking/running state. Bridge logs showed the Codex child process remained alive, but stdout had no new terminal event.

### 2. Runtime / Trace / Session Info

Concrete case previously inspected:

- Trace: `7shw6nug`
- Run ID: `81c77a0c-7495-4a4d-8d29-bdfe473c4321`
- PID: `74358`, child PID `74359`
- Start time: `2026-07-09 15:49:29`
- Logs: repeated `agent.stdout-idle`, `childExitCode=null`, `childSignalCode=null`
- Manual action taken: killed stale `74358/74359`; bridge then unblocked the queue and removed reaction.

Additional possibly related but not yet classified case:

- Trace: `8fs7agd1`
- PID: `61625`
- `stdout-idle` occurred once with `idleMs=61006`, but later readback matched. This should not be grouped as the same confirmed hang without more evidence.

### 3. Current Analysis

This is a separate class from the stale final card issue. It may involve Codex child process/stdout/event stream behavior under bridge, but root cause is not proven.

Previous attempted fixes were wrong:

- Hard timeout only releases the queue; it does not explain why the child process stops producing events.
- Serializing all Codex runs reduces product capability and was not a proven root-cause fix.

### 4. Fix Status

- Not fixed.
- Bad fixes were dropped from branch history.
- Manual kill resolved the specific stuck run, but that was operational cleanup, not a root-cause fix.

### 5. Next Plan

- Gather multiple confirmed stdout-idle traces before proposing code changes.
- For each confirmed trace, record:
  - spawn command and cwd
  - session ID and resume state
  - whether first assistant/tool/card event was emitted
  - process tree and open file descriptors while stuck
  - Codex JSONL session tail
  - bridge queue state and scope
- Only propose a fix after the stuck layer is proven.

## Cross-Issue Notes

- Readback mismatch is currently a symptom, not a root cause.
- A final answer in Codex session JSONL is stronger evidence than the Lark card visual state.
- A Lark card staying stale after final answer means the failure is in outbound card update/finalization or readback/display consistency, not in agent task execution.
- Future fixes must be evidence-first and should be approved before implementation.

## 中文简表

| # | 问题 | 现象 | 关键 runtime 信息 | 当前结论 | 修复情况 | 下一步 |
|---|---|---|---|---|---|---|
| 1 | 任务完成但卡片没更新最终内容 | Codex 已完成，飞书卡片仍停在旧的工具调用/运行态内容 | `trace=8k2mhyaz` / `clujpjym` / `9csdgepc`；最新现场在卡片创建 605.784 秒后从 sequence 43 起持续返回 `300309` | 根因已确认：CardKit 10 分钟自动关闭 streaming；`@larksuite/channel@0.3.0` 忽略业务响应码，继续伪成功 finish | 已在 bridge CardKit 边界修复：`300309` / `200850` 后同卡全量更新；后续快照直达全量路径；最终恢复仍失败时触发 Markdown fallback | 全量测试、部署；下一次 >10 分钟 run 验证 `expiry -> card.update code=0 -> final readback match` |
| 2 | 多个正常 run 出现 final readback mismatch | run 正常结束，但 readback 和期望 markdown 不一致，有些可能是真 stale，有些只是 CardKit 改写 | `yp61vkyr`、`2lhybkem`、`94dzimie`、`4wemjyzo`、`8k2mhyaz`，均 `didRollover=false`、`chunkIds=[]` | `markdown-readback-mismatch` 是症状，不是单一根因；需要区分“内容存在但被改写”和“最终内容确实没落地” | 仅避免了后续重复 fallback；消息中断根因未闭环 | 把 mismatch 分类，并补充足够 runtime 字段 |
| 3 | Codex 子进程活着但 stdout 无终态 | 卡片一直 thinking/running，进程还在但没有 terminal event | `trace=7shw6nug`，`runId=81c77a0c...`，PID `74358/74359`，多次 `stdout-idle`；另有 `8fs7agd1` 仅疑似 | 和 stale card 是不同类问题；hard timeout 和串行化都不是根因修复 | 未修；当时只手动 kill 释放队列；错误的 hard-timeout/串行化提交已丢弃 | 收集多个确认 trace，记录进程树、session tail、fd、queue/scope 后再判断 |
