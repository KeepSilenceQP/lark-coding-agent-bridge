import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl';
import type { AgentEvent } from '../../../src/agent/types';
import { processAgentStream } from '../../../src/bot/channel';

afterEach(() => vi.useRealTimers());

describe('Codex tool lifecycle through the idle watchdog', () => {
  it('ignores a pending idle probe after new output and normal completion', async () => {
    vi.useFakeTimers();
    const resume = deferred();
    const probe = deferred();
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'text', delta: 'working' };
      await resume.promise;
      yield { type: 'done', terminationReason: 'normal' };
    })();
    const stop = vi.fn(async () => {});
    const checkIdleActivity = vi.fn(async () => { await probe.promise; return undefined; });
    const result = processAgentStream(
      { interrupted: false, run: { runId: 'probe-race', events, stop,
        waitForExit: async () => true, checkIdleActivity } },
      events, 'probe-race', 600_000, undefined, vi.fn(), vi.fn(async () => {}),
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(checkIdleActivity).toHaveBeenCalledOnce();
    resume.resolve();
    await expect(result).resolves.toMatchObject({ terminal: 'done' });
    probe.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it('fails closed when foreground activity cannot be checked', async () => {
    vi.useFakeTimers();
    const stopped = deferred();
    const events = (async function* (): AsyncGenerator<AgentEvent> { await stopped.promise; })();
    const stop = vi.fn(async () => stopped.resolve());
    const result = processAgentStream(
      { interrupted: false, run: { runId: 'probe-error', events, stop, waitForExit: async () => true,
        checkIdleActivity: async () => { throw new Error('unsupported'); } } },
      events, 'probe-error', 600_000, undefined, vi.fn(), vi.fn(async () => {}),
    );
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(result).resolves.toMatchObject({ terminal: 'idle_timeout' });
  });

  it('excludes blocked progress delivery but still times out a silent agent after delivery resumes', async () => {
    vi.useFakeTimers();
    const stopped = deferred();
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'text', delta: 'working' };
      await stopped.promise;
    })();
    const stop = vi.fn(async () => stopped.resolve());
    let firstFlush = true;
    const result = processAgentStream(
      { interrupted: false, run: { runId: 'delivery', events, stop, waitForExit: async () => true } },
      events, 'delivery', 600_000, undefined, vi.fn(), async () => {
        if (!firstFlush) return;
        firstFlush = false;
        await delay(660_000);
      },
    );
    await vi.advanceTimersByTimeAsync(660_000);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ terminal: 'idle_timeout', idleTimeoutMinutes: 10 });
  });

  it('retains the bounded tool silence deadline after subtracting blocked delivery time', async () => {
    vi.useFakeTimers();
    const stopped = deferred();
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'tool_use', id: 'tool', name: 'wait', input: {}, maxSilenceMs: 65 * 60_000 };
      await stopped.promise;
    })();
    const stop = vi.fn(async () => stopped.resolve());
    let firstFlush = true;
    const result = processAgentStream(
      { interrupted: false, run: { runId: 'bounded-delivery', events, stop, waitForExit: async () => true } },
      events, 'bounded-delivery', 600_000, undefined, vi.fn(), async () => {
        if (!firstFlush) return;
        firstFlush = false;
        await delay(10 * 60_000);
      },
    );
    await vi.advanceTimersByTimeAsync(75 * 60_000 - 1);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ terminal: 'idle_timeout', idleTimeoutMinutes: 65 });
  });

  it.each(['collab_tool_call', 'mcp_tool_call'])(
    'bounds a silent %s even when identical updates keep arriving', async (type) => {
      vi.useFakeTimers();
      const translator = new CodexJsonlTranslator();
      const stopped = deferred();
      const item = { id: 'hung', type, status: 'in_progress', tool: 'wait' };
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        yield* translator.translate({ type: 'item.started', item });
        for (let i = 0; i < 12; i++) {
          await delay(300_000);
          yield* translator.translate({ type: 'item.updated', item });
        }
        await stopped.promise;
      })();
      const stop = vi.fn(async () => stopped.resolve());
      const result = processAgentStream(
        { interrupted: false, run: { runId: 'hung-run', events, stop, waitForExit: async () => true } },
        events, 'hung-scope', 600_000, undefined, vi.fn(), vi.fn(async () => {}),
      );
      await vi.advanceTimersByTimeAsync(65 * 60_000 - 1);
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ terminal: 'idle_timeout', idleTimeoutMinutes: 65 });
    },
  );

  it('renews only the progressing call, not a concurrent silent tool', async () => {
    vi.useFakeTimers();
    const translator = new CodexJsonlTranslator();
    const stopped = deferred();
    const item = { id: 'hung', type: 'mcp_tool_call', status: 'in_progress', tool: 'read' };
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield* translator.translate({ type: 'item.started', item });
      yield* translator.translate({ type: 'item.started', item: { ...item, id: 'active' } });
      await delay(50 * 60_000);
      yield* translator.translate({
        type: 'item.updated', item: { ...item, id: 'active', result: { content: ['progress'] } },
      });
      await stopped.promise;
    })();
    const stop = vi.fn(async () => stopped.resolve());
    const result = processAgentStream(
      { interrupted: false, run: { runId: 'parallel-run', events, stop, waitForExit: async () => true } },
      events, 'parallel-scope', 600_000, undefined, vi.fn(), vi.fn(async () => {}),
    );
    await vi.advanceTimersByTimeAsync(65 * 60_000);
    await expect(result).resolves.toMatchObject({ terminal: 'idle_timeout', idleTimeoutMinutes: 65 });
  });

  it('allows genuine foreground progress to renew the bounded silence window', async () => {
    vi.useFakeTimers();
    const translator = new CodexJsonlTranslator();
    const stopped = deferred();
    const item = { id: 'active', type: 'collab_tool_call', status: 'in_progress', tool: 'wait' };
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield* translator.translate({ type: 'item.started', item });
      await delay(50 * 60_000);
      yield* translator.translate({
        type: 'item.updated', item: { ...item, agents_states: { child: { status: 'completed' } } },
      });
      await stopped.promise;
    })();
    const stop = vi.fn(async () => stopped.resolve());
    const result = processAgentStream(
      { interrupted: false, run: { runId: 'progress-run', events, stop, waitForExit: async () => true } },
      events, 'progress-scope', 600_000, undefined, vi.fn(), vi.fn(async () => {}),
    );
    await vi.advanceTimersByTimeAsync(65 * 60_000);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    await expect(result).resolves.toMatchObject({ terminal: 'idle_timeout', idleTimeoutMinutes: 65 });
  });

  it('keeps tool state private to each parent run even when IDs coincide', async () => {
    vi.useFakeTimers();
    const stopped = deferred();
    const finish = deferred();
    const parent = new CodexJsonlTranslator();
    const child = new CodexJsonlTranslator();
    const item = { id: 'same-id', type: 'collab_tool_call', status: 'in_progress', tool: 'wait' };
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield* parent.translate({ type: 'item.started', item });
      child.translate({ type: 'item.started', item });
      child.translate({ type: 'item.completed', item: { ...item, status: 'completed' } });
      await finish.promise;
      yield* parent.translate({ type: 'turn.completed' });
    })();
    const stop = vi.fn(async () => stopped.resolve());
    const result = processAgentStream(
      { interrupted: false, run: { runId: 'isolated-run', events, stop, waitForExit: async () => true } },
      events, 'isolated-scope', 600_000, undefined, vi.fn(), vi.fn(async () => {}),
    );
    await vi.advanceTimersByTimeAsync(660_000);
    expect(stop).not.toHaveBeenCalled();
    finish.resolve();
    await expect(result).resolves.toMatchObject({ terminal: 'done' });
  });

  it('does not stop a completed run while terminal delivery is slow', async () => {
    vi.useFakeTimers();
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'text', delta: 'done' };
      yield { type: 'done', terminationReason: 'normal' };
    })();
    const stop = vi.fn(async () => {});
    const result = processAgentStream(
      { interrupted: false, run: { runId: 'finished-run', events, stop, waitForExit: async () => true } },
      events, 'finished-scope', 600_000, undefined, vi.fn(),
      vi.fn(async (state) => { if (state.terminal === 'done') await delay(660_000); }),
    );
    await vi.advanceTimersByTimeAsync(1_320_000);
    await expect(result).resolves.toMatchObject({ terminal: 'done' });
    expect(stop).not.toHaveBeenCalled();
  });

  it.each(['command_execution', 'collab_tool_call', 'mcp_tool_call'])(
    'keeps a foreground %s alive past ten minutes, then resumes idle detection',
    async (type) => {
      vi.useFakeTimers();
      const translator = new CodexJsonlTranslator();
      const finished = deferred();
      const stopped = deferred();
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        yield* translator.translate({ type: 'thread.started', thread_id: 'parent' });
        yield* translator.translate({ type: 'agent_message', message: 'working' });
        yield* translator.translate({
          type: 'item.started',
          item: { id: 'foreground', type, status: 'in_progress', tool: 'wait', command: 'build' },
        });
        await finished.promise;
        yield* translator.translate({
          type: 'item.completed',
          item: { id: 'foreground', type, status: 'completed', exit_code: 0 },
        });
        await stopped.promise;
      })();
      const stop = vi.fn(async () => stopped.resolve());
      const handle = {
        interrupted: false,
        run: { runId: 'parent-run', events, stop, waitForExit: async () => true },
      };
      const result = processAgentStream(
        handle, events, 'parent-scope', 600_000, undefined, vi.fn(), vi.fn(async () => {}),
      );

      await vi.advanceTimersByTimeAsync(660_000);
      expect(stop).not.toHaveBeenCalled();
      finished.resolve();
      await vi.advanceTimersByTimeAsync(599_999);
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ terminal: 'idle_timeout' });
    },
  );

  it('does not let a completed background spawn keep its parent alive', async () => {
    vi.useFakeTimers();
    const translator = new CodexJsonlTranslator();
    const stopped = deferred();
    const item = {
      id: 'spawn', type: 'collab_tool_call', tool: 'spawn_agent',
      receiver_thread_ids: ['background-child'], agents_states: { 'background-child': { status: 'running' } },
    };
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield* translator.translate({ type: 'item.started', item: { ...item, status: 'in_progress' } });
      yield* translator.translate({ type: 'item.completed', item: { ...item, status: 'completed' } });
      await stopped.promise;
    })();
    const stop = vi.fn(async () => stopped.resolve());
    const result = processAgentStream(
      { interrupted: false, run: { runId: 'spawn-run', events, stop, waitForExit: async () => true } },
      events, 'spawn-scope', 600_000, undefined, vi.fn(), vi.fn(async () => {}),
    );
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(result).resolves.toMatchObject({ terminal: 'idle_timeout' });
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
