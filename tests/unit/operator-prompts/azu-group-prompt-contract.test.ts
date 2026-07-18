import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { GROUP_PROMPT_MAX_BYTES } from '../../../src/session/group-prompt-files';

const PROMPT_URL = new URL(
  '../../../operator-prompts/groups/oc_726b2fdea1364b47aab6796ba5c9d764.md',
  import.meta.url,
);

describe('阿祖起来干活了 operator prompt contract', () => {
  it('keeps authenticated relay execution inside the reviewed MemoryData Bug boundary', async () => {
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

    expect(prompt).toMatch(/本地[^\n]*(?:分支|worktree)/u);
    expect(prompt).toMatch(/编辑|修改文件/u);
    expect(prompt).toMatch(/测试|静态检查/u);
    expect(prompt).toMatch(/本地构建|设备验证|真机/u);
    expect(prompt).toMatch(/commit|提交/u);
    expect(prompt).toMatch(/push|推送/u);
    expect(prompt).toMatch(/MR/u);
    expect(prompt).toMatch(/部署/u);
    expect(prompt).toMatch(/共享包|测试节点/u);
    expect(prompt).toMatch(/通知/u);
    expect(prompt).toMatch(/代替秦鹏回复|以秦鹏身份/u);

    expect(prompt).toContain('## MemoryData Bug 修复路由');
    expect(prompt).toMatch(/实际结果|实际表现/u);
    expect(prompt).toMatch(/预期结果|预期表现/u);
    expect(prompt).toMatch(/分支|branch/u);
    expect(prompt).toMatch(/release|发布分支/u);
    expect(prompt).toMatch(/remote|远端/u);
    expect(prompt).toMatch(/dirty|未提交|脏/u);
    expect(prompt).toMatch(/HEAD/u);
    expect(prompt).toMatch(/指纹/u);
    expect(prompt).toMatch(/并发|TOCTOU|写前复核/u);
    expect(prompt).toContain('## 降级与停止条件');
    expect(prompt).toMatch(/fixed[\s\S]*tested[\s\S]*runtime verified[\s\S]*pushed[\s\S]*MR opened[\s\S]*merged[\s\S]*deployed/u);
  });
});
