# 小A Workspace Context Review

task_id: project-bootstrap-phase2-workspace-xiaoa
phase: prd_review
source_message_ids:
  - om_x100b6d88c0874c8cc198601f27a50a7
  - om_x100b6d88dffa0cb4c34f25561ab606e

## Conclusion

小A作为 non-CLI bridge bot 不应收到 `/cd` 或 `/invite group`。它应收到
machine-readable workspace context packet，并明确本机 local path 为唯一可执行工作区。

## Required Fields

```yaml
task_id: project-bootstrap-phase2-workspace-xiaoa
recipient_identity:
  target_bot: 小A
  target_open_id: ou_dc5994dda509f61e8e0a015a627e5530
role: non-bridge workspace-context recipient/reviewer
workspace:
  primary_workspace_kind: local
  local_workspace: /Users/bytedance/repo/lark-channel-bridge-fork
  devbox_workspace: /home/qinpeng.bobo/repo/lark-channel-bridge-fork
  devbox_usage: reference_only / not_executable_for_xiaoa
safety:
  must_not_run:
    - /cd
    - /invite group
  must_not_claim_native_mention_without_structured_mention: true
```

## Required Wording

```text
小A：请不要执行 /cd。你的项目工作区以本机路径为准：
/Users/bytedance/repo/lark-channel-bridge-fork。
读取/审查/生成文件均以该 local_workspace 为 primary；devbox path
仅用于理解其他 bridge bot 的环境，不作为小A运行路径。
```

## Blockers / Spec Followups

- Current PRD says 小A and 小小P use local workspace as primary, but does not yet define a
  machine-readable non-bridge bot packet schema.
- Startup checklist must distinguish non-bridge verification from bridge cwd verification.
  For 小A, verified means local workspace exists and is readable, not cwd changed.
- Add acceptance: 小A reply must include
  `local_workspace=/Users/bytedance/repo/lark-channel-bridge-fork` and explicitly say it
  will not execute `/cd`.
