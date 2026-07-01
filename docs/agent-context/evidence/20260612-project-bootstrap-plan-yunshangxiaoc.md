# 云上小C Implementation Plan And Devbox Feasibility

task_id: project-bootstrap-phase2-plan-yunshangxiaoc
phase: plan_draft -> plan_delivered
source_message_id: om_x100b6d88d4f21890c38349db739ddeb
result: FEASIBLE with prerequisite caveat

## Plan Summary

云上小C proposes:

- Bot registry and live bot discovery.
- Workspace path mapping.
- Dispatch engine for bridge and non-bridge bots.
- Startup checklist.
- Tests for registry, dispatch, workspace mapping, and `/project` integration.

## Important Correction: open_id Scope

云上小C reported that all Context Pack open_ids differ from its live API result. Local
re-verification from 小P's current bridge-bound profile returned the same open_ids as the
Context Pack:

```text
小A: ou_dc5994dda509f61e8e0a015a627e5530
小小P: ou_0e58ef3ecdf6401d66c34122bdd1711a
小P: ou_cc7a2bbc1be9e7f6054282ae918b9249
小C: ou_324e9fce8ef80022821ca29ae594e45c
云上C总: ou_a73add268438eb388b31e559a4fa846f
云上小C: ou_f017ffff038aa3c6a4e5beb711be495d
```

Previous dispatched messages from 小P also fetched back with sender `app` and structured
mentions for each target.

Conclusion: this is not a stale Context Pack by itself. Feishu open_ids are app/profile scoped.
The bootstrap registry must be scoped to the dispatching profile/app. 小P dispatch must use
小P's own live `chat.members bots` result, not another bot's app-scoped result.

## Plan Items To Keep

- Live discovery first; static registry only as fallback/config for role and workspace metadata.
- User identity caveat for `chat.members bots` remains relevant.
- Workspace aliasing is required because Mac and devbox repo names differ:
  - macOS: `/Users/bytedance/repo/lark-channel-bridge-fork`
  - devbox: `/home/qinpeng.bobo/repo/lark-coding-agent-bridge`
- Dispatch and checklist should remain mockable.

## Spec Corrections Needed

- Model bot identity as dispatcher-scoped:
  `profile/app -> chat_id -> bot_name/open_id`.
- Do not compare open_ids produced by different bot apps as if they share one namespace.
- If implementation supports remote planners/reviewers, include a field such as
  `open_id_source_profile` or `dispatcher_profile` in evidence/checklists.
