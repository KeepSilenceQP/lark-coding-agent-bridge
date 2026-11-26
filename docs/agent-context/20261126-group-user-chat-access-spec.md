# 群内用户对话授权 — Confirmed Spec

确认日期：2026-11-26。需求与权限边界已由 Decision Owner 在当前会话确认。

## 产品行为

- Owner 在目标群内通过 `@Bot /invite @用户 group` 为该用户授权。
- 授权范围是当前群、当前 Bot/profile 和指定用户，不扩展到其他群、其他 Bot 或私聊。
- 获准用户必须明确 @ 指定 Bot 才能进行普通对话。
- 获准用户不能执行任何指令，包括 `/new`、授权、撤销授权及其他管理指令；这些请求不得作为普通对话交给 Agent 绕过限制。
- Owner 原有的指令权限继续有效，包括 `/new` 和权限管理。
- 同一群、同一 Bot 的 Owner 与所有获准用户共享该群已有 session，不按发送者拆分。
- Owner 执行 `/new` 后，所有上述用户后续对话使用新的群共享 session。
- 不同群之间、不同 Bot/profile 之间保持会话隔离。
- 支持撤销指定用户的群内授权，未获准用户不能通过 @ 使用 Bot。

## 验收事实

1. Owner 在 A 群为用户甲授权后，甲可在 A 群 @ 该 Bot 对话。
2. 相同授权不使甲自动获得 B 群、其他 Bot 或私聊访问权。
3. Owner、甲和随后获准的乙在 A 群使用相同群 session 和上下文。
4. 甲、乙不能执行任何指令，且拒绝不改变会话或权限状态。
5. Owner 的 `/new` 仍有效，随后 Owner、甲、乙共同使用新 session。
6. 撤销授权后，指定用户不能再触发该 Bot 的普通对话。

## 执行状态与实现约束

- Source of truth：本 worktree 的 `feat/group-user-chat-access` 分支。
- 基线：`origin/main` / `6b9bc38c7e8ae814411d41dca389fd0dc0d3e26f`。
- Decision Owner 随后明确要求“你直接全做了吧”，本轮改为单 Agent 实现、自检，不再等待群内 Harness 角色绑定；不宣称经过独立 actor Review。
- 定向名单使用当前 profile 的 `access.groupUsers[chatId]`；首次授权对该群启用指定用户准入，优先于全群白名单和 team 使用模式。Owner 权限保留；名单中的非 Owner 在该群均只有对话权限。
- 撤销最后一人保留空名单，以保持普通成员关闭状态。
- 获准用户的未知斜杠命令同样被拒绝，不进入 Agent；共享卡片和 Reaction 不能绕过限制。
- 群 session 复用既有 Owner 的 policy fingerprint；其他资源、目录、权限和话题边界保持实时校验。
- 话题继续沿用既有 topic session 隔离，普通群使用 chat session。
- 验证范围包括持久化授权、跨群/跨 profile/私聊隔离、Owner 与两位用户共享会话、Owner `/new`、指令与控制回调拒绝、排队期间撤销。
- 完成状态与验证结果以分支最终提交和测试记录为准；真实飞书多用户验证尚未执行。

## 验证结果

- 冻结最终代码后执行 `pnpm exec vitest run --maxWorkers=2 --minWorkers=1`：182 个测试文件通过，2105 项通过、33 项跳过。
- `pnpm typecheck`、`pnpm build`、`git diff --check` 均通过。
- `pnpm privacy:tree` 因缺少私有 denylist 输入无法执行；未使用替代规则绕过该发布检查。
- 未更改运行 profile 的授权、未安装部署、未合入主干；真实飞书多用户验证仍待部署后执行。
