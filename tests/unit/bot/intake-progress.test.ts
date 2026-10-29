import { afterEach, describe, expect, it, vi } from 'vitest';
import { CotClient } from '../../../src/bot/cot';
import { IntakeProgress } from '../../../src/bot/intake-progress';
import { PendingQueue } from '../../../src/bot/pending-queue';
import type { NormalizedMessage } from '@larksuite/channel';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function harness() {
  const client = new CotClient({ tenant: 'feishu', appId: 'test', appSecret: 'test' });
  const create = vi.spyOn(client, 'create').mockResolvedValue({ cot_id: 'cot', message_id: 'om_progress' });
  const update = vi.spyOn(client, 'update').mockResolvedValue();
  const complete = vi.spyOn(client, 'complete').mockResolvedValue();
  const owner = new IntakeProgress();
  const options = {
    client, chatId: 'oc_chat', scope: 'oc_chat:omt_topic', originMessageId: 'om_input',
    inputPreview: 'input', queued: false, onCreated: vi.fn(), onFailed: vi.fn(),
  };
  return { owner, options, create, update, complete };
}

async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }

describe('intake progress ownership', () => {
  it('publishes initialization immediately, without waiting for debounce or agent output', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.owner.ensure('unit', h.options);
    await settle();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0]?.[1].map(e => e.event_type)).toEqual(['RUN_STARTED', 'STEP_STARTED']);
    h.owner.closeAll(); await settle();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('shares one bubble for merged inputs and closes it when the queue is cancelled', async () => {
    vi.useFakeTimers();
    const h = harness();
    const queue = new PendingQueue(600, vi.fn(), {
      resolveOrAllocate: () => 'chain', acquire: () => {},
      release: lease => h.owner.close(lease.unitId),
    });
    const onQueued = (lease: { unitId: string } | undefined) => {
      if (lease) h.owner.ensure(lease.unitId, { ...h.options, queued: true });
    };
    queue.block('scope');
    queue.push('scope', { messageId: 'om_a' } as NormalizedMessage, { onQueued });
    queue.push('scope', { messageId: 'om_b' } as NormalizedMessage, { onQueued });
    await settle();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.update.mock.calls[0]?.[1])).toContain('排队等待');
    queue.cancel('scope'); await settle();
    expect(h.complete).toHaveBeenCalledWith(expect.anything(), 'error');
    expect(h.owner.get('u1')).toBeUndefined();
  });

  it('keeps active and queued progress separate and closes all on shutdown', async () => {
    const h = harness();
    h.owner.ensure('active', h.options);
    h.owner.ensure('queued', { ...h.options, queued: true });
    await settle();
    h.owner.close('active', 'done'); await settle();
    expect(h.owner.get('queued')?.controller.signal.aborted).toBe(false);
    h.owner.closeAll(); await settle();
    expect(h.complete).toHaveBeenCalledTimes(2);
  });

  it('closes a late create after cancellation without publishing stale initialization', async () => {
    const h = harness();
    let resolve!: (value: Record<string, unknown>) => void;
    h.create.mockReturnValue(new Promise(r => { resolve = r; }));
    h.owner.ensure('unit', h.options);
    h.owner.close('unit');
    resolve({ cot_id: 'late', message_id: 'om_late' }); await settle();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.options.onFailed).not.toHaveBeenCalled();
  });

  it('reports immediate update failure once and never blocks queue cancellation', async () => {
    const h = harness();
    h.update.mockRejectedValue(new Error('offline'));
    h.owner.ensure('unit', h.options); await settle();
    expect(h.options.onFailed).toHaveBeenCalledTimes(1);
    expect(h.options.onFailed).toHaveBeenCalledWith('update');
    h.owner.closeAll(); await settle();
    expect(h.owner.get('unit')).toBeUndefined();
  });

  it('closes progress immediately when preparation is cancelled, without waiting for preparation', async () => {
    const h = harness();
    const reservation = new AbortController();
    h.owner.ensure('unit', h.options); await settle();
    const unwatch = h.owner.watchCancellation('unit', reservation.signal);
    reservation.abort(); await settle();
    expect(h.owner.get('unit')).toBeUndefined();
    expect(h.complete).toHaveBeenCalledTimes(1);
    unwatch();
  });

  it('does not wait for a hung create and suppresses failure notices after cancellation', async () => {
    const h = harness();
    let reject!: (reason: Error) => void;
    h.create.mockReturnValue(new Promise((_, r) => { reject = r; }));
    h.owner.ensure('unit', h.options);
    h.owner.closeAll();
    expect(h.owner.get('unit')).toBeUndefined();
    reject(new Error('late network failure')); await settle();
    expect(h.options.onFailed).not.toHaveBeenCalled();
  });
});
