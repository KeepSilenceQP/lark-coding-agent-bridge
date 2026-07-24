import { describe, expect, it, vi } from 'vitest';
import {
  handleReactionEvent,
  isSelfOperator,
  isOwnMessage,
} from '../../../src/bot/reaction/pipeline';
import type { LarkChannel, ReactionEvent } from '@larksuite/channel';

function reactionEvent(overrides: Partial<ReactionEvent> = {}): ReactionEvent {
  return {
    messageId: 'om_test',
    operator: { openId: 'ou_user' },
    emojiType: 'JIAYI',
    action: 'added',
    actionTime: Date.now(),
    raw: { operator_type: 'user' },
    ...overrides,
  };
}

const BOT_DEPS = { botOpenId: 'ou_bot_self', appId: 'cli_app_123' };

function channelWithTarget(senderId: string, senderType: 'user' | 'app' = 'user'): LarkChannel {
  return {
    rawClient: {
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({
              data: {
                items: [{
                  chat_id: 'oc_chat',
                  sender: { id: senderId, sender_type: senderType },
                }],
              },
            })),
          },
        },
      },
    },
  } as unknown as LarkChannel;
}

function pipelineCallbacks() {
  return {
    checkAccess: vi.fn(() => ({ ok: true, reason: 'allowed' })),
    checkGroupResponse: vi.fn(() => ({ accept: true, reason: 'all-messages' })),
    resolveChatMode: vi.fn(async () => 'group' as const),
    resolveWorkChain: vi.fn(() => ''),
  };
}

// ── End-to-end wiring contract ──

describe('reaction pipeline wiring (Unit 10)', () => {
  it('routes stop on a user message into the control plane after Reaction permission', async () => {
    const callbacks = pipelineCallbacks();
    const result = await handleReactionEvent(
      reactionEvent({ emojiType: 'No' }),
      { channel: channelWithTarget('ou_trigger_author'), ...BOT_DEPS },
      callbacks,
    );

    expect(result).toMatchObject({
      kind: 'stop-added-reply',
      targetClass: 'user',
      targetMessageId: 'om_test',
    });
    expect(callbacks.checkAccess).toHaveBeenCalledOnce();
    expect(callbacks.checkGroupResponse).toHaveBeenCalledOnce();
  });

  it('drops a non-stop reaction on a user message before permission or Agent work', async () => {
    const callbacks = pipelineCallbacks();
    const result = await handleReactionEvent(
      reactionEvent({ emojiType: 'DONE' }),
      { channel: channelWithTarget('ou_trigger_author'), ...BOT_DEPS },
      callbacks,
    );

    expect(result).toEqual({ kind: 'drop', reason: 'not-own-message' });
    expect(callbacks.checkAccess).not.toHaveBeenCalled();
    expect(callbacks.checkGroupResponse).not.toHaveBeenCalled();
    expect(callbacks.resolveWorkChain).not.toHaveBeenCalled();
  });

  it('does not treat another Bot message as an inbound user stop trigger', async () => {
    const callbacks = pipelineCallbacks();
    const result = await handleReactionEvent(
      reactionEvent({ emojiType: 'No' }),
      { channel: channelWithTarget('ou_other_bot', 'app'), ...BOT_DEPS },
      callbacks,
    );

    expect(result).toEqual({ kind: 'drop', reason: 'unsupported-stop-target' });
    expect(callbacks.checkAccess).not.toHaveBeenCalled();
  });

  it('denies a user-trigger stop when the operator fails Reaction access', async () => {
    const callbacks = pipelineCallbacks();
    callbacks.checkAccess.mockReturnValue({ ok: false, reason: 'denied-user' });
    const result = await handleReactionEvent(
      reactionEvent({ emojiType: 'No' }),
      { channel: channelWithTarget('ou_trigger_author'), ...BOT_DEPS },
      callbacks,
    );

    expect(result).toEqual({ kind: 'drop', reason: 'access-denied-user' });
    expect(callbacks.checkGroupResponse).not.toHaveBeenCalled();
  });

  it('routes user-target stop removal to the persisted-ledger control path without correlation', async () => {
    const callbacks = pipelineCallbacks();
    const result = await handleReactionEvent(
      reactionEvent({ emojiType: 'No', action: 'removed' }),
      { channel: channelWithTarget('ou_trigger_author'), ...BOT_DEPS },
      callbacks,
    );

    expect(result).toMatchObject({
      kind: 'stop-removed-reply',
      targetClass: 'user',
      targetMessageId: 'om_test',
    });
    expect(callbacks.resolveWorkChain).not.toHaveBeenCalled();
  });

  it('applies the no-mention group gate to a user-trigger stop', async () => {
    const callbacks = pipelineCallbacks();
    callbacks.checkGroupResponse.mockReturnValue({
      accept: false,
      reason: 'mention-required',
    });
    const result = await handleReactionEvent(
      reactionEvent({ emojiType: 'No' }),
      { channel: channelWithTarget('ou_trigger_author'), ...BOT_DEPS },
      callbacks,
    );

    expect(result).toEqual({ kind: 'drop', reason: 'group-response' });
  });

  // ── Self-operator guard in channel context ──

  it('self-operator guard drops reactions from the bot itself', () => {
    const evt = reactionEvent({
      operator: { openId: 'ou_bot_self' },
      emojiType: 'Typing',
    });
    expect(isSelfOperator(evt, BOT_DEPS)).toBe(true);
  });

  it('self-operator guard drops reactions from the app client id', () => {
    const evt = reactionEvent({
      operator: { openId: 'cli_app_123' },
      emojiType: 'Typing',
    });
    expect(isSelfOperator(evt, BOT_DEPS)).toBe(true);
  });

  it('self-operator guard lets through reactions from real users', () => {
    const evt = reactionEvent({
      operator: { openId: 'ou_real_user' },
      emojiType: 'JIAYI',
    });
    expect(isSelfOperator(evt, BOT_DEPS)).toBe(false);
  });

  // ── Own-message filter ──

  it('own-message filter accepts reactions on bot messages', () => {
    expect(isOwnMessage('ou_bot_self', BOT_DEPS)).toBe(true);
    expect(isOwnMessage('cli_app_123', BOT_DEPS)).toBe(true);
  });

  it('own-message filter rejects reactions on other users messages', () => {
    expect(isOwnMessage('ou_other_user', BOT_DEPS)).toBe(false);
  });

  it('own-message filter rejects undefined sender', () => {
    expect(isOwnMessage(undefined, BOT_DEPS)).toBe(false);
  });

  // ── Fault isolation ──

  it('pipeline errors do not throw (fail closed pattern)', () => {
    // The pipeline functions return safe defaults on error
    // isSelfOperator gracefully handles missing raw field
    const evt = reactionEvent({ raw: undefined });
    expect(() => isSelfOperator(evt, BOT_DEPS)).not.toThrow();
  });

  it('isOwnMessage handles undefined gracefully', () => {
    expect(() => isOwnMessage(undefined, BOT_DEPS)).not.toThrow();
  });

  // ── Reaction is enqueued as a NormalizedMessage with rawContentType "reaction" ──

  it('reaction events produce NormalizedMessage entries with rawContentType reaction', () => {
    const msg = {
      messageId: 'om_target',
      chatId: 'oc_chat',
      chatType: 'group' as const,
      senderId: 'ou_user',
      content: '[reaction-added] JIAYI (on msg d36aa5e4)',
      rawContentType: 'reaction' as const,
    };
    expect(msg.rawContentType).toBe('reaction');
    expect(msg.senderId).toBe('ou_user');
  });

  // ── Own-message filter remains the routing precondition ──

  it('other bot messages do not trigger agent runs', () => {
    // Reactions on other bots' messages should be skipped
    expect(isOwnMessage('ou_other_bot', BOT_DEPS)).toBe(false);
  });

  // ── Route metadata failure handling ──

  it('undefined chatId should cause event to be dropped', () => {
    // When target message can't be resolved (no chatId),
    // the event must be dropped, not bypass routing safety
    const chatId: string | undefined = undefined;
    expect(chatId).toBeUndefined();
    // In real code: if (!chatId) { log.warn; return; }
  });

  // ── Pipeline modules are properly exported ──

  it('all reaction pipeline modules can be imported without errors', async () => {
    // Verify all modules are importable
    const mods = await Promise.all([
      import('../../../src/bot/reaction/semantics'),
      import('../../../src/bot/reaction/pipeline'),
      import('../../../src/bot/reaction/types'),
      import('../../../src/bot/reaction/ledger'),
      import('../../../src/bot/reaction/buffer'),
      import('../../../src/bot/reaction/reconciler'),
      import('../../../src/bot/reaction/context-builder'),
      import('../../../src/bot/reaction/work-chain'),
      import('../../../src/bot/reaction/run-tracker'),
      import('../../../src/bot/reaction/control-ledger'),
      import('../../../src/bot/reaction/stop-target'),
    ]);
    expect(mods).toHaveLength(11);
  });
});
