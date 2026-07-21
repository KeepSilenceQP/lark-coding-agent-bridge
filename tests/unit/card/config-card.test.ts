import { describe, expect, it } from 'vitest';
import { configFormCard, configSavedCard } from '../../../src/card/config-card';
import type { ConfigFormOpts } from '../../../src/card/config-card';

describe('config group response mode cards', () => {
  it('renders the 4-mode picker with owner-default selected', () => {
    const card = configFormCard(options('owner-default'));
    const field = findNamed(card, 'group_response_mode') as {
      initial_option?: string;
      options?: Array<{ value?: string }>;
    };

    expect(field.initial_option).toBe('owner-default');
    expect(field.options?.map((option) => option.value)).toEqual([
      'mention-only',
      'owner-default',
      'all-messages',
      'owner-allowlist',
    ]);
    expect(findNamed(card, 'require_mention_in_group')).toBeUndefined();
  });

  it('reports owner-default in the saved result card', () => {
    expect(JSON.stringify(configSavedCard(options('owner-default')))).toContain(
      '应用所有者未 @ 任何账号时响应',
    );
  });

  it('includes owner-allowlist as the 4th picker option', () => {
    const card = configFormCard(options('owner-allowlist' as ConfigFormOpts['groupResponseMode']));
    const field = findNamed(card, 'group_response_mode') as {
      initial_option?: string;
      options?: Array<{ value?: string }>;
    };

    expect(field.initial_option).toBe('owner-allowlist');
    expect(field.options?.map((option) => option.value)).toEqual([
      'mention-only',
      'owner-default',
      'all-messages',
      'owner-allowlist',
    ]);
  });

  it('shows ownerNoMentionChats in the access panel when owner-allowlist is active', () => {
    const card = configFormCard(opts({
      groupResponseMode: 'owner-allowlist' as ConfigFormOpts['groupResponseMode'],
      ownerNoMentionChats: ['oc_chat_a'],
    }));
    const text = JSON.stringify(card);
    // ownerNoMentionChats should appear separately from allowedChats.
    // chatList() truncates IDs to last 6 chars: ...chat_a
    expect(text).toContain('chat_a');
    // The maintenance commands should be mentioned
    expect(text).toContain('owner-default');
  });

  it('reports owner-allowlist label in the saved result card', () => {
    expect(
      JSON.stringify(configSavedCard(
        opts({ groupResponseMode: 'owner-allowlist' as ConfigFormOpts['groupResponseMode'] }),
      )),
    ).toContain('仅在指定群响应 owner 无 @ 消息');
  });

  it('shows ownerNoMentionChats summary in the saved result card', () => {
    const card = configSavedCard(opts({
      groupResponseMode: 'owner-allowlist' as ConfigFormOpts['groupResponseMode'],
      ownerNoMentionChats: ['oc_a', 'oc_b'],
    }));
    const text = JSON.stringify(card);
    expect(text).toContain('2 项');
  });
});

function options(groupResponseMode: ConfigFormOpts['groupResponseMode']): ConfigFormOpts {
  return opts({ groupResponseMode });
}

function opts(overrides: Partial<ConfigFormOpts> & { groupResponseMode: ConfigFormOpts['groupResponseMode'] }): ConfigFormOpts {
  return {
    agentKind: 'claude',
    model: 'default',
    messageReply: 'markdown',
    showToolCalls: true,
    cotMessages: 'off',
    maxConcurrentRuns: 10,
    runIdleTimeoutMinutes: 0,
    groupResponseMode: overrides.groupResponseMode,
    larkCliIdentity: 'bot-only',
    allowedUsers: [],
    allowedChats: [],
    admins: [],
    botAdmins: [],
    knownChats: [],
    ownerNoMentionChats: overrides.ownerNoMentionChats ?? [],
  };
}

function findNamed(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  if (!Array.isArray(value) && (value as { name?: unknown }).name === name) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findNamed(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}
