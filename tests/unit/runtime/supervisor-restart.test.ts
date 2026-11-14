import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardSupervisorHandlers, SupervisorRestartBarrier } from '../../../src/runtime/supervisor-restart';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import type { NormalizedMessage } from '@larksuite/channel';

afterEach(() => vi.useRealTimers());

describe('supervisor restart barrier', () => {
  it('waits for all profiles, reservations, and queued work before one service restart', async () => {
    vi.useFakeTimers();
    const barrier = new SupervisorRestartBarrier();
    const runs = new ActiveRuns();
    const queue = new PendingQueue(60_000, () => {});
    const pause = vi.fn(() => runs.pauseNewRuns('restart'));
    barrier.register({ isIdle: () => runs.isIdle() && !queue.hasPending(), pause });
    const reservation = runs.reserve('another-bot')!;
    queue.push('another-chat', { messageId: 'queued', chatId: 'another-chat' } as NormalizedMessage);
    const launch = vi.fn();
    const duplicate = vi.fn();
    barrier.request(launch);
    barrier.request(duplicate);
    await vi.advanceTimersByTimeAsync(500);
    expect(launch).not.toHaveBeenCalled();
    reservation.release();
    await vi.advanceTimersByTimeAsync(500);
    expect(launch).not.toHaveBeenCalled();
    queue.cancelAll();
    await vi.advanceTimersByTimeAsync(500);
    expect(launch).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();
    expect(runs.newRunsPaused()).toBe(true);
    expect(barrier.enter()).toBeUndefined();
    barrier.dispose();
  });

  it('keeps an inbound reply alive and rejects new intake once the helper starts', async () => {
    const barrier = new SupervisorRestartBarrier();
    const launch = vi.fn();
    let finish!: () => void;
    const sending = new Promise<void>((resolve) => { finish = resolve; });
    const original = vi.fn(async () => {
      barrier.request(launch);
      await sending;
    });
    const rejected = vi.fn(async () => {});
    const handlers = guardSupervisorHandlers({ message: original }, barrier, rejected);
    const msg = { messageId: 'request' } as NormalizedMessage;
    const response = handlers.message!(msg);
    expect(launch).not.toHaveBeenCalled();
    finish();
    await response;
    expect(launch).toHaveBeenCalledOnce();
    await handlers.message!(msg);
    expect(original).toHaveBeenCalledOnce();
    expect(rejected).toHaveBeenCalledWith('message', [msg]);
    barrier.dispose();
  });

  it('restores admission after launch failure and supports a later retry', () => {
    const error = vi.fn();
    const barrier = new SupervisorRestartBarrier(error);
    const runs = new ActiveRuns();
    barrier.register({ isIdle: () => runs.isIdle(), pause: () => runs.pauseNewRuns('restart') });
    const reset = vi.fn();
    barrier.request(() => { throw new Error('spawn failed'); }, reset);
    expect(reset).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(runs.newRunsPaused()).toBe(false);
    const launch = vi.fn();
    barrier.request(launch);
    expect(launch).toHaveBeenCalledOnce();
    barrier.dispose();
  });

  it('never launches a queued restart after supervisor shutdown begins', () => {
    const barrier = new SupervisorRestartBarrier();
    const leave = barrier.enter()!;
    const launch = vi.fn();
    barrier.request(launch);
    barrier.dispose();
    leave();
    expect(launch).not.toHaveBeenCalled();
  });

  it('resumes all hosted profiles when the detached helper later fails', () => {
    const barrier = new SupervisorRestartBarrier();
    const a = new ActiveRuns();
    const b = new ActiveRuns();
    for (const runs of [a, b]) barrier.register({
      isIdle: () => runs.isIdle(), pause: () => runs.pauseNewRuns('restart'),
    });
    const failed = vi.fn();
    barrier.request(vi.fn(), failed);
    expect(a.newRunsPaused()).toBe(true);
    expect(b.newRunsPaused()).toBe(true);
    barrier.fail(new Error('service action failed'));
    barrier.fail(new Error('duplicate exit notification'));
    expect(failed).toHaveBeenCalledOnce();
    expect(a.newRunsPaused()).toBe(false);
    expect(b.newRunsPaused()).toBe(false);
    const leave = barrier.enter();
    expect(leave).toBeTypeOf('function');
    leave?.();
    barrier.dispose();
  });
});
