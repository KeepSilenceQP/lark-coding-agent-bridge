import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { PendingQueue, type WorkLease } from '../../../src/bot/pending-queue';
import { WorkChainStore } from '../../../src/bot/reaction/work-chain';

function message(id: string, replyToMessageId?: string): NormalizedMessage {
  return {
    messageId: id,
    chatId: 'oc_scope',
    chatType: 'group',
    senderId: 'ou_user',
    content: id,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };
}

function harness(onFlush: (batch: NormalizedMessage[], lease?: WorkLease) => void = () => {}) {
  const store = new WorkChainStore();
  const resolveOrAllocate = vi.fn((scope: string, replyTo?: string) => {
    const chain = store.resolveOrAllocate(scope, replyTo);
    store.markCurrent(chain);
    return chain;
  });
  const acquire = vi.fn((lease: WorkLease) => store.acquireUnit(lease.workChainId, lease.unitId));
  const release = vi.fn((lease: WorkLease) => store.releaseUnit(lease.workChainId, lease.unitId));
  const queue = new PendingQueue(
    60_000,
    (_scope, batch, lease) => onFlush(batch, lease),
    { resolveOrAllocate, acquire, release },
  );
  return { store, queue, resolveOrAllocate, acquire, release };
}

describe('PendingQueue WorkLease ownership', () => {
  it('allocates one queued lease for a debounced top-level input unit and releases it on cancel', () => {
    const h = harness();
    h.queue.block('oc_scope');

    h.queue.push('oc_scope', message('om_1'));
    h.queue.push('oc_scope', message('om_2'));

    expect(h.resolveOrAllocate).toHaveBeenCalledTimes(1);
    expect(h.acquire).toHaveBeenCalledTimes(1);
    expect(h.store.hasCurrentWork('oc_scope')).toBe(true);
    expect(h.queue.cancel('oc_scope').map((item) => item.messageId)).toEqual(['om_1', 'om_2']);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.store.hasCurrentWork('oc_scope')).toBe(false);
  });

  it('merges replies to different Bot messages when both targets inherit the same chain', () => {
    const h = harness();
    const chain = h.store.resolveOrAllocate('oc_scope', undefined);
    h.store.registerOutbound(chain, 'om_bot_a');
    h.store.registerOutbound(chain, 'om_bot_b');
    h.store.markTerminal(chain);
    h.queue.block('oc_scope');

    h.queue.push('oc_scope', message('om_1', 'om_bot_a'));
    h.queue.push('oc_scope', message('om_2', 'om_bot_b'));

    expect(h.acquire).toHaveBeenCalledTimes(1);
    expect(h.queue.cancel('oc_scope').map((item) => item.messageId)).toEqual(['om_1', 'om_2']);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('keeps replies to different chains in separate leased units', () => {
    const h = harness();
    const chainA = h.store.resolveOrAllocate('oc_scope', undefined);
    h.store.registerOutbound(chainA, 'om_bot_a');
    h.store.markTerminal(chainA);
    const chainB = h.store.resolveOrAllocate('oc_scope', undefined);
    h.store.registerOutbound(chainB, 'om_bot_b');
    h.store.markTerminal(chainB);
    h.queue.block('oc_scope');

    h.queue.push('oc_scope', message('om_1', 'om_bot_a'));
    h.queue.push('oc_scope', message('om_2', 'om_bot_b'));

    expect(h.acquire).toHaveBeenCalledTimes(2);
    h.queue.cancel('oc_scope');
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it('transfers the lease to onFlush and does not release it until the run owner does', () => {
    let transferred: WorkLease | undefined;
    const h = harness((_batch, lease) => {
      transferred = lease;
      h.queue.block('oc_scope');
    });

    h.queue.push('oc_scope', message('om_1'));
    h.queue.pushBarrier('oc_scope', message('om_barrier'));

    expect(transferred).toBeDefined();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.store.hasCurrentWork('oc_scope')).toBe(true);
    h.queue.releaseLease(transferred!);
    expect(h.store.hasCurrentWork('oc_scope')).toBe(false);
    h.queue.cancelAll();
  });
});
