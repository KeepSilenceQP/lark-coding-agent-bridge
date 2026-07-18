import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { processAgentStream } from '../../../src/bot/channel';

afterEach(() => {
  vi.useRealTimers();
});

describe('Codex startup watchdog', () => {
  it('treats identifier persistence as a delivery barrier and discards later output on failure', async () => {
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'system', threadId: 'thread-uncommitted' };
      yield { type: 'text', delta: 'must not be delivered' };
      yield { type: 'done', terminationReason: 'normal' };
    })();
    const stop = vi.fn(async () => {});
    const waitForExit = vi.fn(async () => true);
    const handle = runHandle(events, stop, waitForExit);
    const recover = vi.fn(async () => undefined);
    const flush = vi.fn(async () => {});

    await expect(
      processAgentStream(
        handle,
        events,
        'oc_commit_failure',
        undefined,
        5 * 60_000,
        async () => {
          throw new Error('secret persistence details');
        },
        flush,
        recover,
      ),
    ).resolves.toMatchObject({
      blocks: [],
      terminal: 'error',
      errorMsg: '会话状态保存失败，请稍后重试。',
    });
    expect(handle.interrupted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(waitForExit).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
  });

  it('times out when resume emits only thread metadata and then stalls', async () => {
    vi.useFakeTimers();
    const stopped = deferred<void>();
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'system', threadId: 'thread-stuck' };
      await stopped.promise;
    })();
    const stop = vi.fn(async () => stopped.resolve(undefined));
    const handle = runHandle(events, stop);

    const resultPromise = processAgentStream(
      handle,
      events,
      'oc_stuck',
      undefined,
      5 * 60_000,
      vi.fn(),
      vi.fn(async () => {}),
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await expect(resultPromise).resolves.toMatchObject({ terminal: 'idle_timeout' });
    expect(stop).toHaveBeenCalled();
  });

  it('disarms the startup watchdog after substantive output so later compaction can continue', async () => {
    vi.useFakeTimers();
    const continueRun = deferred<void>();
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'text', delta: '已经开始处理。' };
      await continueRun.promise;
      yield { type: 'done', terminationReason: 'normal' };
    })();
    const stop = vi.fn(async () => {});
    const handle = runHandle(events, stop);

    const resultPromise = processAgentStream(
      handle,
      events,
      'oc_compacting',
      undefined,
      5 * 60_000,
      vi.fn(),
      vi.fn(async () => {}),
    );
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(stop).not.toHaveBeenCalled();
    continueRun.resolve(undefined);
    await expect(resultPromise).resolves.toMatchObject({ terminal: 'done' });
  });

  it('continues with one safe replacement run after a metadata-only startup timeout', async () => {
    vi.useFakeTimers();
    const stopped = deferred<void>();
    const firstEvents = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'system', threadId: 'thread-stuck' };
      await stopped.promise;
    })();
    const firstHandle = runHandle(firstEvents, vi.fn(async () => stopped.resolve(undefined)));
    const secondEvents = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'text', delta: '续跑后的结果。' };
      yield { type: 'done', terminationReason: 'normal' };
    })();
    const secondHandle = runHandle(secondEvents, vi.fn(async () => {}));
    const recover = vi.fn(async () => ({ handle: secondHandle, events: secondEvents }));

    const resultPromise = processAgentStream(
      firstHandle,
      firstEvents,
      'oc_retry',
      undefined,
      5 * 60_000,
      vi.fn(),
      vi.fn(async () => {}),
      recover,
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await expect(resultPromise).resolves.toMatchObject({ terminal: 'done' });
    expect(recover).toHaveBeenCalledTimes(1);
  });
});

function runHandle(
  events: AsyncIterable<AgentEvent>,
  stop: () => Promise<void>,
  waitForExit: (timeoutMs: number) => Promise<boolean> = async () => true,
): RunHandle {
  const run: AgentRun = {
    runId: 'run-test',
    events,
    stop,
    waitForExit,
  };
  return { run, interrupted: false };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
