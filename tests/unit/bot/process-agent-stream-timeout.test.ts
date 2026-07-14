import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { processAgentStream } from '../../../src/bot/channel';

afterEach(() => {
  vi.useRealTimers();
});

describe('Codex startup watchdog', () => {
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
});

function runHandle(events: AsyncIterable<AgentEvent>, stop: () => Promise<void>): RunHandle {
  const run: AgentRun = {
    runId: 'run-test',
    events,
    stop,
    waitForExit: async () => true,
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
