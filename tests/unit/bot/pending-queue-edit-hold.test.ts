import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue';

function message(id: string): NormalizedMessage {
  return {
    messageId: id,
    chatId: 'scope',
    chatType: 'group',
    senderId: 'user',
    content: id,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1,
  };
}

afterEach(() => vi.useRealTimers());

describe('PendingQueue edited-message holds', () => {
  it('survives legacy unblock and releases independently', () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const queue = new PendingQueue(10, (_scope, batch) => {
      flushed.push(batch.map((item) => item.messageId));
    });
    queue.block('scope');
    const hold = queue.acquireEditHold('scope');
    queue.push('scope', message('first'));
    queue.push('scope', message('second'));

    queue.unblock('scope');
    vi.advanceTimersByTime(20);
    expect(queue.isBlocked('scope')).toBe(true);
    expect(flushed).toEqual([]);

    hold.release();
    hold.release();
    vi.advanceTimersByTime(20);
    expect(queue.isBlocked('scope')).toBe(false);
    expect(flushed).toEqual([['first', 'second']]);
  });

  it('keeps FIFO units intact while an edit hold is active', () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const queue = new PendingQueue(10, (_scope, batch) => {
      flushed.push(batch.map((item) => item.messageId));
    });
    const hold = queue.acquireEditHold('scope');
    queue.push('scope', message('regular'));
    queue.pushBarrier('scope', message('barrier'));
    queue.push('scope', message('later'));

    vi.advanceTimersByTime(20);
    expect(queue.pendingCount('scope')).toBe(3);
    expect(flushed).toEqual([]);

    hold.release();
    vi.advanceTimersByTime(10);
    vi.advanceTimersByTime(10);
    vi.advanceTimersByTime(10);
    expect(flushed).toEqual([['regular'], ['barrier'], ['later']]);
  });
});
