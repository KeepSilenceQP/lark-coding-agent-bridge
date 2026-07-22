# Deferred Self-Restart And Post-Restart Receipt Spec

Date: 2026-07-22
Status: confirmed by Qin Peng

## Recommendation

把 Bridge 自部署后的重启收敛为一个跨进程闭环：当前 Bot 必须通过 Bridge 自身的 deferred restart 入口重启，先完整发送本轮最终回复；现有 detached restart helper 扩展为持久化的重启协调者；新 Bridge 连接成功后向原会话发送一次 post-restart success receipt，启动失败或超时则由仍存活的 helper 发送 failure receipt。

该能力解决“自重启直接中断当前回复”和“重启后没有结果反馈”两个问题。它不是通用定时任务、部署系统或 Agent turn 续跑机制。

## Problem And Boundary

当前同 profile、bridge-bound 的 `lark-channel-bridge restart --profile <current-profile>` 已能写入 deferred marker。Bridge 在所有 active batch 完成后消费 marker，再启动 detached helper 执行实际服务重启；因此它已经能保证最终回复先于重启。

真实操作仍暴露两个缺口：

1. Agent 直接调用 `launchctl kickstart -k`、`systemctl restart` 或 `schtasks` 重启自身时，会绕过 deferred marker 和 active-batch drain，当前流式回复可能直接中断。
2. 现有 helper 能等待新服务注册，但只有被丢弃的 stdout/stderr；marker 不保存原会话路由，Bridge 新进程也不消费重启结果，因此用户无法收到可验证的重启完成通知。临时 shell 通知脚本曾因手写 JSON typo 在调用飞书 API 前失败。

本需求只覆盖 Bridge 管理的同 profile 自重启，以及该次重启返回原会话的 receipt。不负责构建、安装、切换 Git revision、修改 service definition、跨 profile 编排、自动重试部署或通知另一个 Bot。面向另一个 Bot 的交接继续使用 `at-bot`。

## Runtime Contract

### 1. Pre-Restart Drain

- Bridge-bound Agent 重启当前 profile 时必须调用 Bridge `restart` 命令，禁止直接调用底层 service manager。
- 命令只登记一次 pending restart，并立即返回“已安排在当前任务完成后重启”；它不得停止当前 Bridge。
- 当前 Bridge 必须等待所有 active batch 完成、最终消息成功结束其发送流程后，才允许 detached helper 执行重启。pending queue 中尚未开始的下一轮不应越过已经登记的 drain boundary。
- 对其它 profile 的外部运维重启保持现有行为；本需求不把所有 service-manager 操作改成 deferred。

### 2. Durable Handoff

重启请求必须在当前 profile 私有目录原子持久化，并至少携带：唯一 receipt ID、请求 profile、旧 Bridge PID、请求时间、原会话 return route，以及可选的非敏感部署标识。return route 由 Bridge 从当前已验证的 Agent run 自动绑定，Agent 不手工填写目标会话。它至少能恢复目标 `chatId`；话题或回复关系可用时应一并保存，不能依赖 Agent 在重启后恢复聊天上下文。

持久化内容不得包含 App Secret、token、cookie、完整用户消息或任意可执行 shell。只有当前 Bridge 为本轮已验证的 `bridge_context.chatId` 创建 return route；不得把任意模型文本当作目标或通知 payload。

### 3. Restart And Receipt Ownership

```text
当前 Bridge登记请求
→ 最终回复发送完成
→ detached helper执行并观察服务重启
→ 新 Bridge完成注册和飞书连接
→ 新 Bridge发送 success receipt并原子完成请求
```

- helper 负责跨越旧进程退出，执行平台 service restart，并观察是否出现不同于旧 PID 的新 Bridge 注册；不能仅以 service manager 返回 `0` 判定成功。
- success receipt 由新 Bridge 在自身飞书连接可用后发送。它至少包含 profile、success 状态、receipt ID 和新 PID；提供了部署 revision 时原样回显，但不自行猜测运行 artifact。
- 若规定时间内没有观察到新 Bridge 注册，或 service restart 明确失败，仍存活的 helper 负责发送 failure receipt。failure receipt 必须区分 service action failure、startup timeout 与 receipt delivery failure，不得发送 success 文案。
- helper 无法发送 failure receipt 时，必须保留终态记录并写入可定位的 daemon/helper 日志；下一次启动不得把该失败改写成成功。
- receipt 使用稳定 ID 做幂等。重复启动、helper 重入或“发送成功但清理前退出”不得产生多条用户可见 success/failure；完成后的 marker 应原子清理，陈旧请求不得在无关重启后重新发送。

## User Experience

当前轮最终回复明确区分“已完成部署前置动作”和“仅已安排重启”，例如：

```text
构建与配置已完成；已安排本轮回复结束后重启 codex。重启结果会另发一条确认。
```

随后由跨进程 receipt 给出终态：

```text
重启成功：profile=codex，newPid=12345，receiptId=restart-xxx。
```

或：

```text
重启失败：profile=codex，reason=startup-timeout，receiptId=restart-xxx。请查看指定日志。
```

“已安排重启”不等于“重启成功”；service active 不等于 Bridge 已连接飞书；success receipt 不等于后续业务功能验收完成。

## Bridge System Prompt Contract

共享 Bridge System Prompt 必须让所有 Agent 遵守同一条自重启规则：

- 重启当前 Bot/profile 时，只调用 `lark-channel-bridge restart --profile <current-profile>`；禁止直接调用 `launchctl`、`systemctl`、`schtasks`、kill 当前 Bridge PID 或其它等价的底层 service-manager 命令。
- `restart` 返回“已安排”后继续完成本轮最终回复，不在同一轮等待旧进程之外的 post-restart 结果，也不把 scheduled 表述成 restarted。
- 收到 post-restart receipt 前不得声称重启成功；receipt 失败或缺失时按实际状态报告，不猜测成功。
- 显式运维其它 profile 不属于自重启，可沿用现有外部重启路径；Agent 必须根据 `LARK_CHANNEL_PROFILE` 判断当前 profile，不能只按 Bot 显示名猜测。

System Prompt 只规定动作选择和完成语义。return route 捕获、active-batch drain、helper 生命周期、receipt 幂等与发送仍由 Bridge 确定性代码保证，不能只依赖模型遵循文字规则。

## Compatibility, Risk And Rollback

- 现有非 bridge-bound `start/restart`、其它 profile 重启和 service adapter 保持兼容；没有 return route 的旧 marker 继续只执行重启，不补发通知。
- 最大风险是跨进程重复通知或错误会话投递。通过 profile 私有原子状态、旧/new PID 约束、稳定 receipt ID、固定生成的通知正文和幂等发送收敛。
- failure receipt 需要在目标 Bridge 未启动时仍可发送，因此 helper 必须使用当前 profile 的确定性 Bot 发送能力，而不是再次启动 Agent 或拼接 shell JSON。
- 回滚时恢复当前 deferred restart marker 与 helper 行为，停止创建带 return route 的新请求；未完成的新格式请求保留为诊断记录或由显式清理命令处理，不能静默误发。

## Acceptance Criteria

- 同 profile 自重启的真实 Agent turn 能完整显示最终回复，之后 PID 才变化；不得出现“已被中断”。
- macOS、Linux 和 Windows 自动化测试均证明：当前 profile 使用 Bridge restart 时只登记请求，active batch 未归零前不会调用 service adapter，归零后只启动一次 helper。
- success 路径证明新 PID 不同于旧 PID、新 Bridge 已完成注册和飞书连接，并在原群或原话题发送恰好一条关联同一 receipt ID 的确认。
- service action failure 与 startup timeout 均不得产生 success receipt；helper 能发送一次 failure receipt，发送本身失败时保留可诊断终态。
- 覆盖 helper 重入、新进程重复启动、发送成功后清理前崩溃、陈旧 marker 和损坏 marker；不得重复通知、误删新的请求或泄露凭据。
- 系统 Prompt 或等价运行约束明确：Bot 重启自身必须使用 Bridge restart，禁止直接调用 `launchctl/systemctl/schtasks`；其它 profile 的显式运维操作不受该规则误伤。
- 实机验收至少完成一次当前 Bot 自部署：记录旧 PID、最终回复 message ID、receipt ID、新 PID 和 post-restart receipt message ID，并回读确认顺序为“最终回复完成 → 旧进程退出 → 新进程连接 → receipt 发送”。

## Design Constraint For Coding Plan

return route 必须由 Bridge 从当前已验证的 Agent run 自动绑定；不得要求 Agent 手工填写 `chatId`、私聊目标、话题 ID 或通知正文。Coding Plan 可以依据现有 CLI/Agent 进程边界选择内部 route token、受控 IPC 或等价的 profile-private 持久化机制，但不能改变三个约束：路由来自当前已验证入站上下文、marker 不包含任意消息正文、重启后不依赖 Agent 恢复上下文。

## Next Phase

本 Spec 已由秦鹏确认，下一阶段可以编写 Coding Plan。Plan 需要覆盖 deferred marker 兼容迁移、return-route 自动绑定、helper/new-process 职责、幂等发送、三平台生命周期测试、System Prompt 约束和一次真实自部署验收；Plan Review `GO` 前不修改运行代码或部署 Bridge。
