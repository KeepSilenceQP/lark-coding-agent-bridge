import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { GROUP_PROMPT_MAX_BYTES } from '../../../src/session/group-prompt-files';

const PROMPT_URL = new URL(
  '../../../operator-prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md',
  import.meta.url,
);
const MEMORYDATA_BUG_SOP_URL = new URL(
  '../../../operator-prompts/routes/memorydata-bug.md',
  import.meta.url,
);
const OPERATOR_PROMPTS_README_URL = new URL(
  '../../../operator-prompts/README.md',
  import.meta.url,
);

describe('阿祖起来干活了 operator prompt contract', () => {
  it('keeps the parent relay, evidence, identity, and generic-action boundaries', async () => {
    const bytes = await readFile(PROMPT_URL);
    const prompt = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(GROUP_PROMPT_MAX_BYTES);
    expect(prompt).not.toMatch(/\b(?:TODO|TBD)\b|\{\{[^}]+\}\}|TRUSTED_RELAY_SENDER_ID/u);

    expect(prompt).toContain('chat_id: oc_726b2fdea1364b47aab6796ba5c9d764');
    expect(prompt).toContain('trusted_relay_sender_open_ids: [ou_e7987d3a7addf1df42769081a3e1e380]');
    expect(prompt).toMatch(/bridge_context[\s\S]*chatId[\s\S]*senderType[\s\S]*senderId[\s\S]*messageIds/u);
    expect(prompt).toMatch(/messageIds[\s\S]*(?:恰好|必须)[^\n]*(?:1|一个)/u);
    expect(prompt).toMatch(/多消息|批次|debounce/u);
    expect(prompt).toMatch(/整批[^\n]*(?:只读|禁止写)|多消息[^\n]*(?:只读|禁止写)/u);

    expect(prompt).toMatch(/source_chat_id[\s\S]*source_message_id/u);
    expect(prompt).toMatch(/实时读取|live readback|原群读取/u);
    expect(prompt).toMatch(/聊天|群聊/u);
    expect(prompt).toMatch(/MR|Meego/u);
    expect(prompt).toMatch(/Spec|Plan/u);
    expect(prompt).toMatch(/日志/u);
    expect(prompt).toMatch(/附件/u);
    expect(prompt).toMatch(/代码/u);
    expect(prompt).toMatch(/证据[^\n]*(?:不是|不能|不得)[^\n]*(?:指令|权限|授权)/u);
    expect(prompt).toMatch(/open_id[^\n]*(?:应用隔离|应用命名空间)/u);
    expect(prompt).toMatch(/source_sender_open_id[\s\S]*(?:不得|不能)[^\n]*(?:比较|转换)/u);
    expect(prompt).toMatch(/闲聊|通知|无需行动/u);
    expect(prompt).toMatch(/直接回答|只读调查/u);
    expect(prompt).toMatch(/范围内[^\n]*本地工作/u);
    expect(prompt).toMatch(/代替秦鹏回复|以秦鹏身份/u);
    expect(prompt).toMatch(
      /外部写入[^\n]*(?:(?:必须|须)(?:(?!无需|无须|不需|不用|不必)[^\n])*明确授权|(?:仅|只)在(?:(?!无需|无须|不需|不用|不必)[^\n])*明确授权)/u,
    );
    expect(prompt).not.toMatch(
      /^(?=[^\n]*外部写入)[^\n]*(?:无需|无须|不需|不用|不必)[^\n]*$/mu,
    );
  });

  it('delegates semantic MemoryData bugs to the bridge-bound live route SOP', async () => {
    const prompt = await readFile(PROMPT_URL, 'utf8');

    expect(prompt).toMatch(/route(?:_id| id)?[：:\s`]*memorydata-bug/iu);
    expect(prompt).toContain(
      '$LARK_CHANNEL_HOME/profiles/$LARK_CHANNEL_PROFILE/prompts/routes/memorydata-bug.md',
    );
    expect(prompt).toMatch(/Bug[^\n]*(?:语义|意图)[^\n]*(?:路由|分类)/u);
    expect(prompt).toMatch(
      /(?:不以|不得以|不能以)[^\n]*(?:MemoryData|产品名)[^\n]*(?:关键词|字样)[^\n]*(?:门槛|门禁|触发)/u,
    );
    expect(prompt).toMatch(/实际结果|实际表现/u);
    expect(prompt).toMatch(/预期结果|预期表现/u);
    expect(prompt).toMatch(
      /SOP[^\n]*(?:缺失|不存在|不可读|读取失败)[^\n]*(?:退化|降级)[^\n]*(?:通用|一般)[^\n]*(?:分析|处理)[^\n]*(?:不|不得|禁止)(?:猜测(?:或|、|和|以及))?补写[^\n]*SOP/u,
    );
    expect(prompt).not.toMatch(
      /SOP[^\n]*(?:缺失|不存在|不可读|读取失败)(?:(?!\n\s*\n)[\s\S]){0,400}(?:执行|修复|修改|写入)/u,
    );
    expect(prompt).toMatch(
      /^(?=[^\n]*(?:只|仅)做[^\n]*(?:通用|一般)[^\n]*(?:分析|处理))(?:(?!\n).)*(?:只|仅)做[^\n]*(?:通用|一般)[^\n]*(?:分析|处理)(?:[，,](?:必要时)?(?:只|仅)(?:问|提问|提出)[^\n]*(?:问题|疑问))?[：:]?\s*$[\s\S]{0,400}^(?:-\s*)?(?:live\s*)?SOP[^\n]*(?:缺失|不存在|不可读|读取失败)[。.]?\s*$/imu,
    );
    expect(prompt).toMatch(/未命中[^\n]*memorydata-bug[\s\S]*(?:通用|原有)[^\n]*(?:分类|处理|路由)/u);
  });

  it('contains no retired controller or interactive-card workflow', async () => {
    const prompt = await readFile(PROMPT_URL, 'utf8');

    expect(prompt).not.toMatch(
      /\bcontroller\b|controller_user_open_ids|CardKit|卡片|按钮|bridge_token|\[card-click\]|二阶段确认|继续修改/iu,
    );
  });

  it('guides a persona-led, evidence-valued MemoryData investigation without forcing a workflow', async () => {
    const sop = await readFile(MEMORYDATA_BUG_SOP_URL, 'utf8');

    expect(sop).toMatch(/你是[^\n]*专业[^\n]*MemoryData Android Bug[^\n]*(?:调查|修复)[^\n]*Agent/u);
    expect(sop).toMatch(/目标[^\n]*(?:可信|可验证)[^\n]*因果链[^\n]*(?:正确|可信)[^\n]*(?:代码谱系|lineage)/iu);
    expect(sop).toMatch(/(?:不是|而不是)[^\n]*(?:填表|表单|清单)/u);
    expect(sop).toMatch(
      /第一波[^\n]*(?:Bug 描述|实际与预期)[^\n]*(?:受影响版本|开发阶段)[^\n]*(?:lineage|代码谱系)/iu,
    );
    expect(sop).toMatch(/现有上下文[^\n]*(?:足够|充分)[^\n]*(?:停止扩张|不再扩张|停止取证)/u);

    expect(sop).toMatch(
      /Feishu[^\n]*GBrain[^\n]*worktree[^\n]*(?:branch|分支)[^\n]*MR[^\n]*(?:log|日志)[^\n]*版本[^\n]*关联仓库/iu,
    );
    expect(sop).toMatch(/按[^\n]*信息价值[^\n]*(?:可选|选择)/u);
    expect(sop).toMatch(/(?:不是|并非|不得作为)[^\n]*(?:必填|固定顺序|固定流程)/u);
    expect(sop).toMatch(
      /只有[^\n]*(?:不确定性|未知)[^\n]*(?:改变|影响)[^\n]*(?:诊断|代码选择|安全执行)[^\n]*(?:最小问题|提问)/u,
    );

    expect(sop).toMatch(/线上|发布/u);
    expect(sop).toMatch(/需求开发|开发测试/u);
    expect(sop).toMatch(/已合入[^\n]*未发布/u);
    expect(sop).toMatch(/(?:host|宿主)[^\n]*(?:memory_package|责任仓库)|memory_package[^\n]*(?:host|宿主|责任仓库)/iu);

    expect(sop).toMatch(/Harness[^\n]*(?:按需|可选)[^\n]*(?:角色|流程|知识)/iu);
    expect(sop).toMatch(/Fix Loop[\s\S]{0,160}Review[\s\S]{0,160}WDA/iu);
    expect(sop).not.toMatch(/targeted[-_ ]bugfix/iu);
    expect(sop).toMatch(/(?:不|无须|无需|不必)[^\n]*(?:完整|全量)[^\n]*Workflow/iu);

    for (const reference of [
      'MemoryData AGENTS',
      'ai_proactive README',
      'AGENT_LOOP_GUIDE',
      'module-map',
      'coding-guidelines',
      'runtime-plugin',
      'host-protocol',
      'scripts/push_plugin.sh',
      '../memory_package',
    ]) {
      expect(sop).toContain(reference);
    }
    for (const path of [
      '<MemoryData>/AGENTS.md',
      '<MemoryData>/ai_proactive_api/agent_md/README.md',
      '<MemoryData>/ai_proactive_api/agent_md/AGENT_LOOP_GUIDE.md',
      '<MemoryData>/ai_proactive_api/agent_md/context/module-map.md',
      '<MemoryData>/ai_proactive_api/agent_md/context/coding-guidelines.md',
      '<MemoryData>/ai_proactive_api/agent_md/sop/runtime-plugin-build-push-open.md',
      '<MemoryData>/ai_proactive_api/agent_md/sop/host-protocol-alignment.md',
      '<MemoryData>/scripts/push_plugin.sh',
      '<MemoryData>/../memory_package',
    ]) {
      expect(sop).toContain(path);
    }
    expect(sop).toMatch(
      /插件推送[^\n]*(?:必须|只能)[^\n]*<MemoryData>\/scripts\/push_plugin\.sh/u,
    );
    expect(sop).toMatch(
      /直接[^\n]*adb install[^\n]*(?:插件 APK|插件APK)[^\n]*(?:不能|不得)[^\n]*(?:替代|代替)/u,
    );
    expect(sop).not.toMatch(
      /(?:不|无需|无须|不必|不用|禁止|不得)[^\n]{0,8}(?:使用|读取|查看|参考|遵循)[^\n]*<MemoryData>\//u,
    );
    expect(sop).not.toMatch(
      /插件推送[^\n]*(?:不必须|不只能|无需|无须|不必|不用|禁止要求|不得要求)[^\n]*(?:push_plugin|<MemoryData>\/scripts\/push_plugin\.sh)/u,
    );
    expect(sop).toMatch(/验证[^\n]*(?:可观察性|观察面)[^\n]*(?:决定|选择)/u);
    expect(sop).toMatch(/本地[^\n]*(?:测试|构建)[^\n]*(?:不能|不得|不等于)[^\n]*(?:真机|设备)/u);
  });

  it('maps delivery intents to the smallest authorized effect and reports lifecycle states separately', async () => {
    const sop = await readFile(MEMORYDATA_BUG_SOP_URL, 'utf8');

    expect(sop).toMatch(
      /分析结论[^\n]*需上下文[^\n]*无需本地修复[^\n]*已有可执行方案/u,
    );
    expect(sop).toMatch(
      /^(?=[^\n]*执行)(?=[^\n]*(?:仅|只)[^\n]*本地[^\n]*最小修复)(?=[^\n]*相称验证)(?=[^\n]*(?:不|不得|禁止)[^\n]*(?:commit|提交)[^\n]*(?:push|推送)[^\n]*MR[^\n]*(?:deploy|部署))[^\n]*$/imu,
    );
    expect(sop).toMatch(
      /执行[^\n]*(?:绑定|仅适用于)[^\n]*当前[^\n]*(?:已说明|已确认)[^\n]*(?:baseline|基线)[^\n]*(?:scope|范围)/iu,
    );
    expect(sop).toMatch(
      /写入前[^\n]*(?:重新|再次)[^\n]*(?:核对|复核)[^\n]*(?:branch|分支)[^\n]*worktree[^\n]*(?:dirty|未提交|脏状态)[^\n]*(?:baseline|基线)[^\n]*(?:scope|范围)/iu,
    );
    expect(sop).toMatch(
      /保护[^\n]*用户[^\n]*(?:改动|修改)[^\n]*(?:禁止|不得)[^\n]*reset[^\n]*clean[^\n]*(?:覆盖|改写)[^\n]*(?:无关|范围外)/iu,
    );
    expect(sop).toMatch(
      /事实[^\n]*(?:变化|改变)[^\n]*(?:根因|代码来源|范围)[^\n]*(?:实质|重大)[^\n]*(?:变化|改变)[^\n]*(?:停止|中止)[^\n]*(?:重新|再次)[^\n]*(?:等待|获得)[^\n]*执行/u,
    );
    expect(sop).toMatch(
      /提交 Bits[^\n]*(?:只|仅)[^\n]*memory-bits-mr[^\n]*dry-run/iu,
    );
    expect(sop).toMatch(
      /确认提交[^\n]*(?:匹配|对应)[^\n]*(?:intent|意图)[^\n]*(?:必要|最小)[^\n]*(?:commit|提交)[^\n]*(?:push|推送)[^\n]*(?:create MR|创建 MR)[^\n]*(?:readback|回读)/iu,
    );
    expect(sop).toMatch(
      /确认提交[^\n]*(?:前|之前)[^\n]*(?:重新|再次)[^\n]*(?:核对|复核)[^\n]*(?:最终|final)[^\n]*diff[^\n]*dry-run[^\n]*(?:参数|arguments)[^\n]*(?:只|仅)[^\n]*(?:匹配|对应)[^\n]*(?:intent|意图)/iu,
    );
    expect(sop).toMatch(
      /(?:unknown|未知)[^\n]*(?:先|首先)[^\n]*(?:search|搜索)[^\n]*(?:readback|回读)/iu,
    );
    expect(sop).toMatch(
      /(?:已成功|已经成功)[^\n]*(?:停止|不得)[^\n]*(?:返回|回报)[^\n]*(?:结果|状态)/u,
    );
    expect(sop).toMatch(
      /只有[^\n]*(?:证明|证据)[^\n]*(?:未产生|没有产生)[^\n]*(?:副作用|外部写入)[^\n]*(?:才)[^\n]*(?:允许)?[^\n]*(?:retry|重试)/iu,
    );
    expect(sop).toMatch(
      /(?:禁止|不得)[^\n]*(?:自动|无条件)[^\n]*(?:重复|再次)[^\n]*(?:创建 )?MR/iu,
    );
    expect(sop).not.toMatch(
      /(?:unknown|未知)[^\n]*(?:自动|直接|立即)[^\n]*(?:retry|重试)/iu,
    );
    expect(sop).toMatch(
      /(?:merge|合入)[^\n]*(?:deploy|部署)[^\n]*(?:reviewer|审阅人)[^\n]*(?:通知|notify)[^\n]*(?:另行|分别|单独)[^\n]*(?:授权|确认)/iu,
    );
    expect(sop).toMatch(
      /investigated[^\n]*fixed[^\n]*tested[^\n]*runtime(?: verified)?[^\n]*committed[^\n]*pushed[^\n]*MR[^\n]*merged[^\n]*deployed/iu,
    );
    expect(sop).toMatch(/(?:分别|逐项)[^\n]*(?:报告|回报)[^\n]*(?:不得|不能|不可)[^\n]*(?:合并|混为)/u);
  });

  it('rejects negated and double-negated MemoryData safety contracts', async () => {
    const sop = await readFile(MEMORYDATA_BUG_SOP_URL, 'utf8');
    const mutations: Array<{
      name: string;
      positive: RegExp;
      deny: RegExp;
      unsafe: string;
    }> = [
      {
        name: 'execution baseline and scope binding',
        positive:
          /执行[^\n]*(?:绑定|仅适用于)[^\n]*当前[^\n]*(?:已说明|已确认)[^\n]*(?:baseline|基线)[^\n]*(?:scope|范围)/iu,
        deny:
          /执行[^\n]*(?:不|无需|无须|不必|不用)[^\n]{0,8}(?:绑定|适用于)[^\n]*(?:baseline|基线)[^\n]*(?:scope|范围)/iu,
        unsafe: '执行不绑定当前已说明的 baseline/基线 与 scope/范围',
      },
      {
        name: 'pre-write state recheck',
        positive:
          /写入前[^\n]*(?:重新|再次)[^\n]*(?:核对|复核)[^\n]*(?:branch|分支)[^\n]*worktree[^\n]*(?:dirty|未提交|脏状态)[^\n]*(?:baseline|基线)[^\n]*(?:scope|范围)/iu,
        deny:
          /写入前[^\n]*(?:不需要|无需|无须|不必|不用)[^\n]*(?:重新|再次)[^\n]*(?:核对|复核)/u,
        unsafe:
          '写入前不需要重新核对 branch/分支、worktree、dirty/脏状态、baseline/基线与 scope/范围',
      },
      {
        name: 'user-change protection',
        positive:
          /保护[^\n]*用户[^\n]*(?:改动|修改)[^\n]*(?:禁止|不得)[^\n]*reset[^\n]*clean[^\n]*(?:覆盖|改写)[^\n]*(?:无关|范围外)/iu,
        deny:
          /(?:不|无需|无须|不必|不用)[^\n]{0,8}保护[^\n]*用户[^\n]*(?:改动|修改)|(?:禁止|不得)[^\n]*(?:阻止|避免|防止)[^\n]*(?:reset|clean|覆盖|改写)/iu,
        unsafe: '不保护用户改动；禁止阻止 reset、clean、覆盖无关内容',
      },
      {
        name: 'unknown success stop',
        positive:
          /(?:已成功|已经成功)[^\n]*(?:停止|不得)[^\n]*(?:返回|回报)[^\n]*(?:结果|状态)/u,
        deny:
          /(?:已成功|已经成功)[^\n]*(?:(?:也|仍|依然)?[^\n]{0,8}不停止|继续[^\n]*(?:retry|重试)|返回[^\n]*(?:后|之后)[^\n]*继续)/iu,
        unsafe: '已成功也不停止，返回结果后继续重试',
      },
      {
        name: 'automatic duplicate MR prohibition',
        positive:
          /(?:禁止|不得)[^\n]*(?:自动|无条件)[^\n]*(?:重复|再次)[^\n]*(?:创建 )?MR/iu,
        deny:
          /(?:禁止|不得)[^\n]*(?:阻止|避免|防止)[^\n]*(?:自动|无条件)[^\n]*(?:重复|再次)[^\n]*(?:创建 )?MR/iu,
        unsafe: '不得阻止自动重复创建 MR',
      },
    ];

    for (const mutation of mutations) {
      expect(mutation.positive.test(sop), `${mutation.name}: current positive`).toBe(true);
      expect(mutation.deny.test(sop), `${mutation.name}: current deny`).toBe(false);
      expect(mutation.positive.test(mutation.unsafe), `${mutation.name}: mutation proof`).toBe(true);
      expect(
        mutation.positive.test(mutation.unsafe) && !mutation.deny.test(mutation.unsafe),
        `${mutation.name}: full contract`,
      ).toBe(false);
    }
  });

  it('documents an atomic Group Prompt plus route SOP deployment without inventing session binding', async () => {
    const readme = await readFile(OPERATOR_PROMPTS_README_URL, 'utf8');

    expect(readme).toContain('operator-prompts/groups/<chatId>.md');
    expect(readme).toContain('operator-prompts/routes/memorydata-bug.md');
    expect(readme).toContain('<profileDir>/prompts/groups/<chatId>.md');
    expect(readme).toContain('<profileDir>/prompts/routes/memorydata-bug.md');
    expect(readme).toMatch(
      /一次部署[^\n]*(?:同时|一并)[^\n]*(?:最新|当前)[^\n]*(?:reviewed|已审阅)[^\n]*Group Prompt[^\n]*(?:SOP|memorydata-bug)/iu,
    );
    expect(readme).toMatch(/未部署[^\n]*(?:修改|变更)[^\n]*(?:不会|不能|不得)[^\n]*(?:live|生效)/iu);
    expect(readme).toMatch(
      /\/new[^\n]*(?:只|仅)[^\n]*(?:激活|固定|装载)[^\n]*Group Prompt[^\n]*snapshot/iu,
    );
    expect(readme).toMatch(
      /(?:新 topic|新话题|新主题)[^\n]*(?:读取|使用)[^\n]*(?:latest|最新)[^\n]*(?:deployed|已部署)[^\n]*SOP/iu,
    );
    expect(readme).toMatch(
      /(?:旧 topic|旧话题|旧主题)[^\n]*(?:不承诺|不保证|不得承诺)[^\n]*(?:热切换|hot[- ]?switch)/iu,
    );
    expect(readme).toMatch(
      /(?:不引入|不依赖|没有)[^\n]*Bridge include[^\n]*(?:version|版本)[^\n]*SHA[^\n]*(?:session binding|会话绑定)/iu,
    );
    expect(readme).not.toMatch(
      /SOP[^\n]*(?:写入|嵌入|拼接|include)[^\n]*(?:Group Prompt snapshot|Group Prompt 快照)|SOP[^\n]*(?:绑定|pin)[^\n]*(?:session|会话)/iu,
    );
  });
});
