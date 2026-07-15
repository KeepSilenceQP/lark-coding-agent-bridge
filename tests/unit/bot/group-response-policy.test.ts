import { describe, expect, it } from 'vitest';
import { decideGroupResponse } from '../../../src/bot/group-response-policy';

const base = {
  chatType: 'group' as const,
  mode: 'owner-default' as const,
  senderId: 'ou-owner',
  botOwnerId: 'ou-owner',
  ownerRefreshState: 'ok' as const,
  mentionedBot: false,
  mentionCount: 0,
  mentionAll: false,
};

describe('group response policy', () => {
  it('accepts an owner message with no structured mention', () => {
    expect(decideGroupResponse(base)).toEqual({ accept: true, reason: 'owner-default' });
  });

  it.each([
    ['a mentioned person', { mentionCount: 1 }],
    ['another mentioned bot', { mentionCount: 1 }],
    ['mention all', { mentionAll: true }],
    ['another sender', { senderId: 'ou-other' }],
    ['unknown owner state', { ownerRefreshState: 'unknown' as const }],
    ['failed owner refresh with stale owner id', { ownerRefreshState: 'failed' as const }],
  ])('skips owner-default for %s', (_label, override) => {
    expect(decideGroupResponse({ ...base, ...override })).toEqual({
      accept: false,
      reason: 'owner-default-not-eligible',
    });
  });

  it('preserves explicit mention behavior even when other accounts are also mentioned', () => {
    expect(
      decideGroupResponse({
        ...base,
        mentionedBot: true,
        mentionCount: 2,
      }),
    ).toEqual({ accept: true, reason: 'mentioned-bot' });
  });

  it('keeps mention-only and all-messages behavior', () => {
    expect(decideGroupResponse({ ...base, mode: 'mention-only' })).toEqual({
      accept: false,
      reason: 'mention-required',
    });
    expect(decideGroupResponse({ ...base, mode: 'all-messages', senderId: 'ou-other' })).toEqual({
      accept: true,
      reason: 'all-messages',
    });
  });

  it('does not redefine mention-all behavior outside owner-default', () => {
    expect(decideGroupResponse({ ...base, mode: 'mention-only', mentionAll: true })).toEqual({
      accept: false,
      reason: 'mention-required',
    });
    expect(decideGroupResponse({ ...base, mode: 'all-messages', mentionAll: true })).toEqual({
      accept: true,
      reason: 'all-messages',
    });
    expect(decideGroupResponse({ ...base, mentionedBot: true, mentionAll: true })).toEqual({
      accept: true,
      reason: 'mentioned-bot',
    });
  });

  it('leaves p2p routing unchanged', () => {
    expect(decideGroupResponse({ ...base, chatType: 'p2p' })).toEqual({
      accept: true,
      reason: 'p2p',
    });
  });
});
