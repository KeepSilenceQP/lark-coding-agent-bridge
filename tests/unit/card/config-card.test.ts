import { describe, expect, it } from 'vitest';
import { configFormCard, configSavedCard } from '../../../src/card/config-card';
import type { ConfigFormOpts } from '../../../src/card/config-card';

describe('config group response mode cards', () => {
  it('renders the canonical tri-state picker with owner-default selected', () => {
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
    ]);
    expect(findNamed(card, 'require_mention_in_group')).toBeUndefined();
  });

  it('reports owner-default in the saved result card', () => {
    expect(JSON.stringify(configSavedCard(options('owner-default')))).toContain(
      '应用所有者未 @ 任何账号时响应',
    );
  });
});

function options(groupResponseMode: ConfigFormOpts['groupResponseMode']): ConfigFormOpts {
  return {
    agentKind: 'claude',
    model: 'default',
    messageReply: 'markdown',
    showToolCalls: true,
    cotMessages: 'off',
    maxConcurrentRuns: 10,
    runIdleTimeoutMinutes: 0,
    groupResponseMode,
    larkCliIdentity: 'bot-only',
    allowedUsers: [],
    allowedChats: [],
    admins: [],
    botAdmins: [],
    knownChats: [],
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
