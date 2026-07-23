# Operator-managed Group Prompts

Files in this directory are reviewed deployment inputs for profile-local Group
Prompts. The bridge package does not install them automatically.

A MemoryData Bug route deployment is one reviewed pair. 一次部署必须同时安装最新 reviewed Group Prompt 与 route SOP:

```text
repo source: operator-prompts/groups/<chatId>.md
repo source: operator-prompts/routes/memorydata-bug.md
profile live: <profileDir>/prompts/groups/<chatId>.md
profile live: <profileDir>/prompts/routes/memorydata-bug.md
```

Copy both reviewed repo sources to their matching profile live paths in the same
deployment operation. 未部署的修改不会进入 live，也不会影响运行中的 profile。

## Activation boundary

`/new` 只激活 Group Prompt snapshot；它不会把 route SOP 拼进该 snapshot。新 topic 读取 latest deployed SOP。旧 topic 不承诺热切换/hot-switch；需要确定采用新规则时，开启新 topic。

本契约不引入 Bridge include、version/版本元数据、SHA pinning 或 SOP session binding/会话绑定。The Group Prompt snapshot remains the existing activation mechanism:

```text
<profileDir>/prompts/groups/<chatId>.md
```

Never copy a Codex-targeted prompt into a Claude profile unless that prompt has
been reviewed and approved for Claude separately.
