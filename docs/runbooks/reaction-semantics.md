# Reaction 运行时配置

Reaction 的 emoji、含义和处理行为由当前 profile 的 `reaction-semantics.json` 配置。
首次启动时，Bridge 在文件不存在的情况下写入默认配置；已有文件不会被覆盖。
编辑后从下一次 Reaction 事件开始读取，无需重启服务或重新建立 Agent 会话。

## 配置文件位置

文件位置为 `<profileDir>/reaction-semantics.json`，通常是：

```text
~/.lark-channel/profiles/<profile>/reaction-semantics.json
```

若设置了 `LARK_CHANNEL_HOME`，根目录改为该变量的值。每个 profile 独立保存、读取自己的
文件；修改一个 profile 不影响其他 Bot。不要把这份配置放入项目目录或主 `config.json`。

## 文件格式

配置是 UTF-8 JSON，顶层只有 `schemaVersion` 和 `rules`：

```json
{
  "schemaVersion": 1,
  "rules": {
    "DONE": {
      "behavior": "agent",
      "semanticKey": "user_step_completed",
      "emojiMeaning": "用户已完成目标消息要求的手动步骤，请核对结果并从当前进度继续",
      "emojiDisplay": "完成"
    }
  }
}
```

这是只有一条映射的完整配置示例。`rules` 是**全量映射**，不会与默认规则合并；如果
直接用该示例替换文件，其他 emoji 都会成为未映射状态。保留现有规则时，只修改对应条目。
空的 `rules: {}` 合法，表示不配置任何 emoji 映射。

| 字段 | 要求 | 含义 |
|---|---|---|
| `schemaVersion` | 必填，当前只能是数字 `1` | 配置格式版本 |
| `rules` | 必填，对象，最多 256 条 | key 是大小写敏感的飞书 `emojiType` |
| `behavior` | 必填，见下表 | Bridge 处理该 Reaction 的方式 |
| `semanticKey` | 必填，自定义标识 | 小写字母开头，仅小写字母、数字、下划线，最多 128 字符；没有固定名称对应的隐藏动作 |
| `emojiMeaning` | 必填，非空字符串，最多 4096 字符 | 当前语义解释；Agent 以它结合目标消息理解用户意图 |
| `emojiDisplay` | 可选，非空字符串，最多 128 字符 | 供 Agent 阅读的名称或符号 |

emoji type 必须以字母或数字开头，后续仅允许字母、数字、`_`、`.`、`:`、`-`，总长最多
128 字符。`Typing` 留给 Bridge 工作态使用，不能配置；`__proto__`、`prototype` 和
`constructor` 等保留键不可使用。未知字段、不支持的版本、空语义、非法控制字符和超过
128 KiB 的文件都会被拒绝。JSON 不支持注释和尾逗号。

## 行为与权限

| `behavior` | 处理方式 |
|---|---|
| `agent` | 将配置的含义和完整目标消息交给 Agent。是否执行取决于目标内容、当前进度及原有授权；普通目标范围仍为当前 Bot 的消息。 |
| `passive` | 作为静默标记，在事件入口和快照中排除。添加和移除都不唤起 Agent、不回复、不打断任务、不关闭话题。 |
| `stop` | Bridge 控制面使用现有 `/stop` 能力，校验权限与目标工作链后中断运行、取消待执行任务，并回复处理结果。撤回不自动恢复。 |
| `continue` | 保留原任务续执行入口：仅原消息作者可继续当前 Bot 已处理、仍有有效关联的原任务；从当前进度继续，不扩大授权。 |
| `restart` | 在重跑控制能力启用时，校验原作者、权限、消息和活动运行，读取编辑后的消息，确认旧运行停止后重启对应任务。未启用时静默过滤，不回退为 Agent 任务；不是重启 Bridge 服务。 |

配置不会取消权限检查、当前 Bot/目标关联限制、防重、撤回规则或破坏性操作边界。
修改 `semanticKey` 不改变控制流；例如，把它命名为 `stop_current_work`，但保留
`behavior: "agent"`，不会调用 Bridge 的停止控制面。停止、重跑等控制动作必须通过
对应的 `behavior` 选择，`emojiMeaning` 应与所选行为一致。

删除规则表示取消显式映射，**不等于禁用该 emoji**。符合目标及权限条件的未映射
Reaction 仍以 `emojiMeaningSource: "unmapped"` 交给 Agent 根据上下文分析；若希望某个
emoji 完全静默，应保留条目并设置 `behavior: "passive"`。配置中的条目继续使用
`emojiMeaningSource: "predefined"`，这里指“由配置明确指定”，不表示写死在代码中。
已有的 restart Reaction 可以出现在其他事件带来的有效集合中，仍保留配置的
`behavior`、`emojiMeaning` 和 `predefined` 标记；它只是当前上下文，不会因此再次重跑
或交由 Agent 执行重跑。

## 默认配置

首次生成的配置包含 13 个 emoji，其中 12 条为非 passive 规则（7 个 agent、3 个
stop、1 个 continue、1 个 restart），另有 1 个 passive 标记：

| emoji type | 默认 `behavior` | 默认意图 |
|---|---|---|
| `OK`, `LGTM`, `Yes`, `CheckMark`, `JIAYI` | `agent` | 同意目标消息中的下一步 |
| `WHAT`, `THINKING` | `agent` | 进一步解释目标消息 |
| `No`, `CrossMark`, `MinusOne` | `stop` | 停止当前工作 |
| `DONE` | `passive` | 标记已处理 |
| `GoGoGo` | `continue` | 继续自己的原任务 |
| `Loudspeaker` | `restart` | 按编辑后的原消息重跑 |

这些是初始默认值，都可通过配置修改；共享 System Prompt 不再定义具体 emoji 或
`semanticKey` 的固定含义。默认模板见仓库中的 [default-policy.json](https://github.com/KeepSilenceQP/lark-coding-agent-bridge/blob/main/src/bot/reaction/default-policy.json)。

## 示例：用 DONE 表示手动步骤已完成，用「看」静默标记

在当前文件的 `rules` 中，将 `DONE` 条目改成下面的内容，并加入 `GLANCE`。
保留 `CheckMark` 的默认规则，它仍表示同意目标消息中的下一步：

```json
"DONE": {
  "behavior": "agent",
  "semanticKey": "user_step_completed",
  "emojiMeaning": "用户已完成目标消息要求的手动步骤，请核对结果并从当前进度继续",
  "emojiDisplay": "完成"
},
"GLANCE": {
  "behavior": "passive",
  "semanticKey": "handled_marker",
  "emojiMeaning": "仅作为已处理标记；添加或撤回都不启动 Agent、不回复、不打断任务，也不关闭话题",
  "emojiDisplay": "看"
}
```

保存完整 JSON 后，对 Bot 请求你执行手动步骤的那条消息新增 DONE。Agent 会读取这条
消息和新含义，核对结果后继续原任务。这不是对任意完成通知重复执行任务的授权。
「看」对应飞书 emoji type `GLANCE`，添加或撤回都仅作为静默标记。
示例不改变默认配置；只有实际编辑当前 profile 文件后才生效。

建议先把完整 JSON 写到同目录临时文件，再原子替换正式文件，避免编辑中间态被读取。
无需停止 Bot。单纯修改文件不构成新的 Reaction，也不会重放消息上已经存在的表情。

## 热更新与故障处理

- 后续 Reaction 事件读取文件并校验；有效配置整体替换，不会部分应用。待合并批
  保持一致的配置快照，已处理或执行中的任务不因文件编辑而重放、中断或回滚。
- 动态 `reaction_contexts` 带有 `policyVersion`，每项带有当前 `behavior` 和
  `emojiMeaning`。`policyVersion` 由有效内容计算，不是需要手工填写的配置字段；只改
  缩进或字段顺序不会改变版本。
- 运行期间 JSON 无效、文件丢失或不可读，Bridge 保留上一次有效配置并记录告警。
  修正文件后，下一次 Reaction 事件会重新加载。告警不代表错误配置已经生效。
- 首次启动若文件不存在，会创建默认配置；若已有文件无效或不可读，没有可用的有效
  配置可回退，Bridge 启动报错，不会静默覆盖文件或恢复默认含义。

核验自定义含义时，查看实际 Reaction 输入中的 `policyVersion`、`behavior`、
`emojiMeaning` 与目标消息，再检查对应 Agent 或控制面结果。不要仅凭文件保存成功判断
运行行为已验证。
