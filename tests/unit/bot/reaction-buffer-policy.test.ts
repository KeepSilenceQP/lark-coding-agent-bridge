import type { ReactionEvent } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactionBuffer } from '../../../src/bot/reaction/buffer';
import { DEFAULT_REACTION_POLICY, parseReactionPolicy, type ReactionRule } from '../../../src/bot/reaction/policy';

function policy(rules: Record<string, ReactionRule>) {
  return parseReactionPolicy(JSON.stringify({ schemaVersion: 1, rules: { ...DEFAULT_REACTION_POLICY.rules, ...rules } }));
}
function event(emojiType: string): ReactionEvent {
  return { messageId: 'om_target', operator: { openId: 'ou_user' }, emojiType, action: 'added', actionTime: Date.now(), raw: {} };
}
const manual: ReactionRule = { behavior: 'agent', semanticKey: 'user_step_completed', emojiMeaning: '手动步骤已完成，请核对结果后继续' };

describe('reaction buffer policy boundaries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rebinds an unflushed batch consistently without splitting its authoritative snapshot', async () => {
    const flush = vi.fn(async () => {});
    const buffer = new ReactionBuffer(flush, 100, 500);
    buffer.push('key', event('CheckMark'));
    await vi.advanceTimersByTimeAsync(50);
    const next = policy({ CheckMark: manual });
    buffer.push('key', event('JIAYI'), next);
    await vi.advanceTimersByTimeAsync(100);
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith('key', [
      expect.objectContaining({ emojiType: 'CheckMark', semantics: expect.objectContaining({ semanticKey: 'user_step_completed' }) }),
      expect.objectContaining({ emojiType: 'JIAYI' }),
    ], next);
  });

  it('does not roll a batch back when older routing completes after a newer intake', async () => {
    const flush = vi.fn(async () => {});
    const buffer = new ReactionBuffer(flush, 100, 500);
    const next = policy({ CheckMark: manual });
    buffer.push('key', event('JIAYI'), next, 2);
    buffer.push('key', event('CheckMark'), DEFAULT_REACTION_POLICY, 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(flush).toHaveBeenCalledWith('key', [
      expect.objectContaining({ emojiType: 'JIAYI' }),
      expect.objectContaining({ emojiType: 'CheckMark', semantics: expect.objectContaining({ semanticKey: 'user_step_completed' }) }),
    ], next);
  });

  it.each(['passive', 'stop', 'restart'] as const)('does not retroactively dispatch a pending signal changed to %s', async behavior => {
    const flush = vi.fn(async () => {});
    const buffer = new ReactionBuffer(flush, 100, 500);
    buffer.push('key', event('CheckMark'));
    await vi.advanceTimersByTimeAsync(90);
    const next = policy({ CheckMark: { ...manual, behavior } });
    buffer.push('key', event('JIAYI'), next);
    await vi.advanceTimersByTimeAsync(100);
    expect(flush).toHaveBeenCalledWith('key', [expect.objectContaining({ emojiType: 'JIAYI', arrivalOrder: 0 })], next);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not extend the maximum merge window when a retained signal is rebound', async () => {
    const flush = vi.fn(async () => {});
    const buffer = new ReactionBuffer(flush, 100, 200);
    buffer.push('key', event('CheckMark'));
    await vi.advanceTimersByTimeAsync(90);
    buffer.push('key', event('JIAYI'), policy({ CheckMark: manual }));
    await vi.advanceTimersByTimeAsync(90);
    buffer.push('key', event('OK'));
    await vi.advanceTimersByTimeAsync(20);
    expect(flush).toHaveBeenCalledOnce();
    expect(buffer.pendingKeys).toBe(0);
  });

  it('keeps a flushed snapshot fixed while serializing later flushes for the same key', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const flush = vi.fn(async () => { await blocked; });
    const buffer = new ReactionBuffer(flush, 100, 500);
    buffer.push('key', event('CheckMark'));
    await vi.advanceTimersByTimeAsync(100);
    const next = policy({ CheckMark: manual });
    buffer.push('key', event('JIAYI'), next);
    await vi.advanceTimersByTimeAsync(100);
    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]).toEqual(['key', expect.any(Array), DEFAULT_REACTION_POLICY]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1]).toEqual(['key', expect.any(Array), next]);
  });
});
