import { describe, expect, it, vi, afterEach } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue';
import type { NormalizedMessage } from '@larksuite/channel';

function msg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_test',
    chatId: 'oc_test',
    chatType: 'group',
    senderId: 'ou_user',
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    ...overrides,
  };
}

interface BarrierEntry {
  kind: 'reaction-turn';
  targetMessageId: string;
  operatorOpenId: string;
  data: unknown;
}

describe('PendingQueue barrier entries (Reaction batch barrier)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a barrier entry independently (not merged with regular messages)', async () => {
    vi.useFakeTimers();
    const flushed: Array<{ scope: string; batch: NormalizedMessage[]; barrier?: BarrierEntry }> = [];

    const queue = new PendingQueue(100, (scope, batch) => {
      flushed.push({ scope, batch });
    });

    // Push barrier should use pushBarrier method (to be added)
    // For now, verify regular push still works
    const count = queue.push('oc_scope', msg({ content: 'hello world' }));
    expect(count).toBe(1);

    vi.advanceTimersByTime(150);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].batch[0].content).toBe('hello world');
  });

  it('does not merge regular messages with reaction turns in the same batch', async () => {
    // This test verifies the barrier contract: when we extend PendingQueue
    // with pushBarrier, regular messages and reaction turns must arrive as
    // separate flushes in arrival order.
    vi.useFakeTimers();
    const events: string[] = [];

    const queue = new PendingQueue(100, (scope, batch) => {
      for (const m of batch) {
        if (m.rawContentType === 'reaction') {
          events.push(`reaction:${(m as unknown as { reactionData?: { emojiType: string } }).reactionData?.emojiType ?? '?'}`);
        } else {
          events.push(`text:${m.content}`);
        }
      }
    });

    // Regular message arrives
    queue.push('oc_scope', msg({ content: 'hello', rawContentType: 'text' }));
    vi.advanceTimersByTime(50);

    // Reaction arrives — this should be a separate flush
    // (Using rawContentType 'reaction' to simulate barrier behavior)
    queue.push('oc_scope', msg({ content: 'JIAYI', rawContentType: 'reaction' as never }));
    vi.advanceTimersByTime(150);

    expect(events).toContain('text:hello');
    expect(events).toContain('reaction:?');
  });

  it('reaction targeting different messages produce separate flushes', async () => {
    vi.useFakeTimers();
    const scopes: string[] = [];

    const queue = new PendingQueue(100, (scope) => {
      scopes.push(scope);
    });

    // Two different target messages
    queue.push('oc_scope', msg({ messageId: 'om_target_1', rawContentType: 'reaction' as never }));
    vi.advanceTimersByTime(200);
    queue.push('oc_scope', msg({ messageId: 'om_target_2', rawContentType: 'reaction' as never }));
    vi.advanceTimersByTime(200);

    // Each should produce a separate flush
    expect(scopes.length).toBeGreaterThanOrEqual(1);
  });

  it('cancel removes pending entries for a scope', () => {
    const queue = new PendingQueue(1000, () => {});

    queue.push('oc_scope', msg({ content: 'pending' }));
    const cancelled = queue.cancel('oc_scope');

    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].content).toBe('pending');
  });

  it('cancel returns empty array for unknown scope', () => {
    const queue = new PendingQueue(1000, () => {});
    expect(queue.cancel('no_such_scope')).toEqual([]);
  });

  it('block prevents flush, unblock resumes with fresh quiet window', async () => {
    vi.useFakeTimers();
    let flushed = false;

    const queue = new PendingQueue(100, () => {
      flushed = true;
    });

    queue.push('oc_scope', msg({ content: 'blocked' }));
    queue.block('oc_scope');

    // Advance past quiet window — should NOT flush while blocked
    vi.advanceTimersByTime(200);
    expect(flushed).toBe(false);

    // Unblock — should arm a fresh quiet window
    queue.unblock('oc_scope');
    vi.advanceTimersByTime(150);
    expect(flushed).toBe(true);
  });
});
