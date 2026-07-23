import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SYSTEM_PROMPT,
  buildBridgeSystemPrompt,
  composeBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';

describe('bridge system prompt bot collaboration rules', () => {
  it('states that bots only receive messages via a real structured mention', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('只有被真实 @');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('收不到');
  });

  it('scopes the mention requirement to bots, not human users', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('人类用户');
  });

  it('tells the agent not to mention other bots by default to avoid loops', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('默认不要 @ 其他 bot');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('死循环');
  });

  it('allows mentioning a bot when the user explicitly asks for a handoff', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('用户明确要求');
  });

  it('points self-identification at the bridge_context botOpenId field', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('botOpenId');
  });

  it('documents the senderType and mentions context fields', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('senderType');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('mentions');
  });

  it('uses platform-neutral actors when a target bot identity is missing', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('请用户、消息发起方补充');
    expect(BRIDGE_SYSTEM_PROMPT).not.toContain('小P');
  });

  it('tells the agent not to mimic the batch sender annotation format', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('[名字 (user|bot)]');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('不要模仿');
  });

  // ── at-bot primitive contract (RED: will fail until Unit 3 updates prompt) ──

  it('teaches the agent to use lark-channel-bridge at-bot for Bot handoffs', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('lark-channel-bridge at-bot');
  });

  it('maps @, mention, 通知, 转交, Return to, 完成后回给 to at-bot', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('@');
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/通知|转交/);
    expect(BRIDGE_SYSTEM_PROMPT).toContain('Return to');
  });

  it('gives the exact three-argument argv template', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('--chat-id');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('--bot-id');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('--message');
  });

  it('maps bridge_context.chatId to --chat-id parameter', () => {
    // The template shows them on separate lines in a code block.
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/bridge_context\.chatId[\s\S]*--chat-id/);
  });

  it('explains that senderId is a candidate only when senderType=bot', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/senderId.*candidate|senderType.*bot/);
  });

  it('explains that explicit mention openId is only a candidate', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('openId');
  });

  it('gives the bot-identity bot-list discovery command', () => {
    // Must use --as bot, not --as user
    expect(BRIDGE_SYSTEM_PROMPT).toContain('chat.members bots');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('--as bot');
  });

  it('requires unique NFC-normalized full-name match for name-based discovery', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/NFC|全名|精确匹配/);
  });

  it('blocks on zero or multiple name matches', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/停止|block|不能猜测/);
  });

  it('forbids using botOpenId as a target', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('botOpenId');
  });

  it('forbids defaulting mentions[0] or own mention as return target', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/mentions\[0\]|mentions 第一项|不能.*默认/);
  });

  it('states that plain @名字 text is not notification', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/不算通知|不是通知|不算已经通知/);
  });

  // ── old manual guidance must be absent ──

  it('no longer teaches direct lark-cli +messages-send for Bot notification', () => {
    expect(BRIDGE_SYSTEM_PROMPT).not.toMatch(/\+messages-send.*--as bot|messages-send.*at user_id/);
  });

  it('no longer contains hand-built <at user_id= mention XML', () => {
    expect(BRIDGE_SYSTEM_PROMPT).not.toContain('<at user_id=');
  });

  it('no longer contains hand-built tag:"at" post JSON', () => {
    expect(BRIDGE_SYSTEM_PROMPT).not.toContain('"tag":"at"');
  });

  it('no longer suggests --as user for bot-list discovery', () => {
    expect(BRIDGE_SYSTEM_PROMPT).not.toMatch(/chat\.members bots.*--as user/);
  });
});

describe('buildBridgeSystemPrompt', () => {
  it('returns the base prompt unchanged when no identity is available', () => {
    expect(buildBridgeSystemPrompt(undefined)).toBe(BRIDGE_SYSTEM_PROMPT);
  });

  it('appends a concrete identity line with open_id and name', () => {
    const prompt = buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: '尼莫' });
    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('ou_bot_self');
    expect(prompt).toContain('尼莫');
  });

  it('appends the identity line even when the bot name is missing', () => {
    const prompt = buildBridgeSystemPrompt({ openId: 'ou_bot_self' });
    expect(prompt).toContain('ou_bot_self');
  });
});

describe('composeBridgeSystemPrompt', () => {
  it('adds a lower-priority group layer before the concrete runtime identity', () => {
    const prompt = composeBridgeSystemPrompt(
      { openId: 'ou_bot_self', name: 'Bridge' },
      '你是这个群的项目协调者。',
    );

    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('<group_system_prompt>\n你是这个群的项目协调者。\n</group_system_prompt>');
    expect(prompt.indexOf('<group_system_prompt>')).toBeLessThan(prompt.indexOf('## 你的身份'));
  });
});

describe('prefixBridgeSystemPrompt', () => {
  it('prefixes the identity-aware system prompt before the user message', () => {
    const prompt = prefixBridgeSystemPrompt('hello world', { openId: 'ou_bot_self' });
    expect(prompt).toContain('ou_bot_self');
    expect(prompt.indexOf('ou_bot_self')).toBeLessThan(prompt.indexOf('## user_message'));
    expect(prompt.endsWith('hello world')).toBe(true);
  });

  it('keeps working without an identity', () => {
    const prompt = prefixBridgeSystemPrompt('hello world', undefined);
    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt.endsWith('hello world')).toBe(true);
  });
});

// ── Unit 5: Reaction section (RED first — will fail until prompt is updated) ──

describe('BRIDGE_SYSTEM_PROMPT Reaction section', () => {
  it('contains the ## Reaction heading', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('## Reaction');
  });

  it('documents reaction_contexts as the authoritative source, not bridge_context.source', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('reaction_contexts');
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/不.*依赖.*bridge_context\.source|bridge_context\.source.*判断/);
  });

  it('instructs reading triggerReactions, effectiveReactionSet, reactionRevision, and targetMessage first', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('triggerReactions');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('effectiveReactionSet');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('reactionRevision');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('targetMessage');
  });

  it('tells agent not to re-execute previously-handled semanticKeys from effectiveReactionSet', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/不要.*重新执行|不.*重放|此前已处理/);
  });

  it('documents predefined emojiMeaningSource with semanticKey as high-confidence hint', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('emojiMeaningSource');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('predefined');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('semanticKey');
  });

  it('requires checking target message fit even for predefined semanticKey', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/结合.*目标消息|检查.*目标消息.*适用|脱离上下文/);
  });

  it('instructs not to discard or ignore unmapped reactions', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('unmapped');
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/不要丢弃|不要.*忽略|不.*丢弃/);
  });

  it('requires clarification only when unmapped meaning is ambiguous AND high-risk', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/确实无法确定.*高风险|无法确定.*不可逆/);
  });

  it('treats added as a new semantic signal to combine with target message', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('added');
  });

  it('warns not to create new tasks for acknowledgment/appreciation reactions', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/赞赏|情绪|收到.*确认|不要.*制造.*新任务/);
  });

  it('requires brief clarification for ambiguous reactions, not guessing', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/多个.*合理解释.*澄清|多个.*可能.*澄清/);
  });

  it('documents removed as withdrawal only — no replay, no rollback', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('removed');
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/撤回|不.*重放|不.*回滚/);
  });

  it('requires agent to explain and not act when targetMessage.available=false', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('available');
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/无法读取|不.*执行.*依赖/);
  });

  it('states reactions cannot expand original task authorization or bypass destructive boundaries', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/不能.*扩大.*授权|破坏性.*操作.*边界|绕过.*边界/);
  });

  // ── Predefined semantics subsection ──

  it('documents approve_continue semanticKey', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('approve_continue');
  });

  it('documents explain_more semanticKey', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('explain_more');
  });

  it('documents user_step_completed semanticKey', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('user_step_completed');
  });

  it('documents stop_current_work as Bridge control-plane handled', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('stop_current_work');
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/Bridge.*控制面|控制面.*处理|不.*创建.*新的.*Agent.*turn/);
  });

  it('states that stop_current_work removal does not auto-restore work', () => {
    // "不要在后续会话中自动恢复、重放或回滚被停止的工作"
    expect(BRIDGE_SYSTEM_PROMPT).toMatch(/不要在后续会话中自动[\s\S]*恢复、重放或回滚被停止的工作/);
  });

  // ── Injection path tests (Claude + Codex both receive the rules) ──

  it('is injected through composeBridgeSystemPrompt (shared constant)', () => {
    const prompt = composeBridgeSystemPrompt({ openId: 'ou_test', name: 'Test' });
    expect(prompt).toContain('## Reaction');
    expect(prompt).toContain('approve_continue');
    expect(prompt).toContain('stop_current_work');
  });

  it('is injected through buildBridgeSystemPrompt (no group addendum)', () => {
    const prompt = buildBridgeSystemPrompt({ openId: 'ou_test', name: 'Test' });
    expect(prompt).toContain('## Reaction');
  });

  it('is injected through prefixBridgeSystemPrompt', () => {
    const prompt = prefixBridgeSystemPrompt('test', { openId: 'ou_test' });
    expect(prompt).toContain('## Reaction');
  });

  it('Reaction section lives in shared prompt, not group-level addendum', () => {
    const prompt = composeBridgeSystemPrompt(
      { openId: 'ou_test', name: 'Test' },
      'some group addendum',
    );
    const reactionIdx = prompt.indexOf('## Reaction');
    const groupIdx = prompt.indexOf('<group_system_prompt>');
    // Reaction section should come before group-level addendum
    expect(reactionIdx).toBeLessThan(groupIdx);
  });
});
