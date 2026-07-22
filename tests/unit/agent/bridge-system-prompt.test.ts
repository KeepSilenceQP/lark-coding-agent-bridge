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
