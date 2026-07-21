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
  chatId: 'oc_any',
  ownerNoMentionChats: [] as string[],
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

// ────────────── owner-allowlist mode ──────────────

const allowlistBase = {
  chatType: 'group' as const,
  mode: 'owner-allowlist' as const,
  senderId: 'ou-owner',
  botOwnerId: 'ou-owner',
  ownerRefreshState: 'ok' as const,
  mentionedBot: false,
  mentionCount: 0,
  mentionAll: false,
  chatId: 'oc_listed',
  ownerNoMentionChats: ['oc_listed', 'oc_other'],
};

describe('group response policy — owner-allowlist', () => {
  it('accepts owner in listed chat with no structured mention', () => {
    expect(decideGroupResponse(allowlistBase)).toEqual({
      accept: true,
      reason: 'owner-allowlist',
    });
  });

  it('skips owner in non-listed chat (chat-not-listed)', () => {
    expect(
      decideGroupResponse({ ...allowlistBase, chatId: 'oc_not_listed' }),
    ).toEqual({
      accept: false,
      reason: 'owner-allowlist-chat-not-listed',
    });
  });

  it('accepts owner reply/quote with no structured mention in listed chat', () => {
    // Reply and quote are the same as no-mention — the policy doesn't
    // distinguish the message source as long as mentions are empty.
    expect(
      decideGroupResponse({
        ...allowlistBase,
        mentionCount: 0,
        mentionAll: false,
      }),
    ).toEqual({ accept: true, reason: 'owner-allowlist' });
  });

  it.each([
    ['only @ other person', { mentionCount: 1 }],
    ['only @ other bot', { mentionCount: 1 }],
    ['mention all', { mentionAll: true }],
    ['non-owner sender', { senderId: 'ou-other' }],
    ['unknown owner state', { ownerRefreshState: 'unknown' as const }],
    ['failed owner refresh', { ownerRefreshState: 'failed' as const }],
    ['missing botOwnerId', { botOwnerId: undefined }],
    ['stale botOwnerId on failed state', { ownerRefreshState: 'failed' as const, botOwnerId: 'ou-owner' }],
  ])('skips owner-allowlist for %s', (_label, override) => {
    expect(decideGroupResponse({ ...allowlistBase, ...override })).toEqual({
      accept: false,
      reason: 'owner-allowlist-not-eligible',
    });
  });

  it('accepts explicit @bot regardless of mode (mentionedBot wins)', () => {
    expect(
      decideGroupResponse({
        ...allowlistBase,
        mentionedBot: true,
        mentionCount: 1,
      }),
    ).toEqual({ accept: true, reason: 'mentioned-bot' });
  });

  it('accepts explicit @bot with other accounts mentioned', () => {
    expect(
      decideGroupResponse({
        ...allowlistBase,
        mentionedBot: true,
        mentionCount: 2,
      }),
    ).toEqual({ accept: true, reason: 'mentioned-bot' });
  });

  it('does not regress mention-only, owner-default, all-messages', () => {
    // mention-only still rejects
    expect(
      decideGroupResponse({ ...allowlistBase, mode: 'mention-only' as const }),
    ).toEqual({ accept: false, reason: 'mention-required' });

    // owner-default still accepts owner with no mention (no chatId/ownerNoMentionChats needed)
    expect(
      decideGroupResponse({
        chatType: 'group' as const,
        mode: 'owner-default' as const,
        senderId: 'ou-owner',
        botOwnerId: 'ou-owner',
        ownerRefreshState: 'ok' as const,
        mentionedBot: false,
        mentionCount: 0,
        mentionAll: false,
        chatId: 'oc_any',
        ownerNoMentionChats: [] as string[],
      }),
    ).toEqual({ accept: true, reason: 'owner-default' });

    // all-messages still accepts anyone
    expect(
      decideGroupResponse({
        ...allowlistBase,
        mode: 'all-messages' as const,
        senderId: 'ou-other',
      }),
    ).toEqual({ accept: true, reason: 'all-messages' });
  });

  it('uses strict owner state predicate (fail-closed)', () => {
    // Even with a matching botOwnerId, if state is not 'ok', reject
    expect(
      decideGroupResponse({
        ...allowlistBase,
        ownerRefreshState: 'unknown' as const,
        botOwnerId: 'ou-owner',
      }),
    ).toEqual({ accept: false, reason: 'owner-allowlist-not-eligible' });
  });

  it('rejects owner when ownerNoMentionChats is empty', () => {
    expect(
      decideGroupResponse({
        ...allowlistBase,
        chatId: 'oc_any',
        ownerNoMentionChats: [],
      }),
    ).toEqual({ accept: false, reason: 'owner-allowlist-chat-not-listed' });
  });
});
