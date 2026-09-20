import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { RunRejected, SpawnFailed } from '../../../src/runtime/errors';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';
import {
  FakeAgentAdapter,
  type FakeAgentEvents,
  type FakeAgentRun,
} from '../../helpers/fake-agent';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('RunExecutor', () => {
  it('generates one runId and wires it through adapter, record, and active runs', async () => {
    const h = await createHarness({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });

    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
      stopGraceMs: 123,
    });

    expect(execution.runId).toBe('run-1');
    expect(execution.run.runId).toBe('run-1');
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      prompt: 'hello',
      cwd: h.tmp.workspace,
      stopGraceMs: 123,
    });
    expect(h.activeRuns.get('scope-1')?.run.runId).toBe('run-1');

    await collect(execution.subscribe());
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
  });

  it('fans out one agent event stream to multiple consumers without spawning twice', async () => {
    const events = [
      { type: 'system' as const, sessionId: 'sess-1', cwd: '/repo' },
      { type: 'text' as const, delta: 'hello' },
      { type: 'done' as const, sessionId: 'sess-1', terminationReason: 'normal' as const },
    ];
    const h = await createHarness({ events });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    const [rendererEvents, sessionEvents] = await Promise.all([
      collect(execution.subscribe()),
      collect(execution.subscribe()),
    ]);

    expect(h.agent.runs).toHaveLength(1);
    expect(rendererEvents).toEqual(events);
    expect(sessionEvents).toEqual(events);
  });

  it('fast-fails nowait when the pool is full and queues normal submissions FIFO', async () => {
    const h = await createHarness({
      events: [
        [{ type: 'done', terminationReason: 'normal' }],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      poolCap: 1,
    });
    const first = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await expect(
      h.executor.submit({
        scopeId: 'scope-nowait',
        policy: policy(h.tmp.workspace),
        nowait: true,
      }),
    ).rejects.toMatchObject({ code: 'pool-full' });

    const secondPromise = h.executor.submit({
      scopeId: 'scope-2',
      policy: policy(h.tmp.workspace),
    });
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });

    await collect(first.subscribe());
    const second = await secondPromise;
    expect(second.runId).toBe('run-2');
    await collect(second.subscribe());
  });

  it('rejects expired policy before spawning the adapter', async () => {
    const h = await createHarness({ events: [] });
    const reservation = h.executor.reserveScope('scope-1');
    expect(reservation).toBeDefined();

    await expect(
      h.executor.submit({
        scopeId: 'scope-1',
        policy: policy(h.tmp.workspace, { expiresAt: 999 }),
        reservation,
      }),
    ).rejects.toBeInstanceOf(RunRejected);
    expect(h.agent.runs).toHaveLength(0);
    h.executor.reserveScope('scope-1')?.release();
  });

  it('rejects new submissions while reconnect is draining active runs', async () => {
    const h = await createHarness({ events: [] });
    const reservation = h.executor.reserveScope('scope-1');
    expect(reservation).toBeDefined();
    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      await expect(
        h.executor.submit({
          scopeId: 'scope-1',
          policy: policy(h.tmp.workspace),
          reservation,
        }),
      ).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(h.agent.runs).toHaveLength(0);
      expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
      h.executor.reserveScope('scope-1')?.release();
    } finally {
      resume();
    }
  });

  it('rejects duplicate submissions for a scope that already has a run', async () => {
    const h = await createHarness({ events: [{ type: 'done', terminationReason: 'normal' }] });

    const first = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await expect(
      h.executor.submit({
        scopeId: 'scope-1',
        policy: policy(h.tmp.workspace),
      }),
    ).rejects.toMatchObject({ code: 'run-already-active' });
    expect(h.agent.runs).toHaveLength(1);

    await collect(first.subscribe());
  });

  it('accepts new submissions after reconnect drain is released', async () => {
    const h = await createHarness({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const resume = h.activeRuns.pauseNewRuns('reconnect');
    resume();

    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    expect(execution.runId).toBe('run-1');
    await collect(execution.subscribe());
  });

  it('rejects submissions that were queued before reconnect drain started', async () => {
    const h = await createHarness({
      events: [
        [{ type: 'done', terminationReason: 'normal' }],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      poolCap: 1,
    });
    const first = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    const second = h.executor.submit({
      scopeId: 'scope-2',
      policy: policy(h.tmp.workspace),
    });
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });

    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      await collect(first.subscribe());
      await expect(second).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(h.agent.runs).toHaveLength(1);
      expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      resume();
    }
  });

  it('cancels a scope reservation that is still waiting for a pool slot', async () => {
    const h = await createHarness({
      events: [
        [{ type: 'done', terminationReason: 'normal' }],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      poolCap: 1,
    });
    const first = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });
    const queued = h.executor.submit({
      scopeId: 'scope-2',
      policy: policy(h.tmp.workspace),
    });
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });

    expect(h.activeRuns.interrupt('scope-2')).toBe(true);
    await expect(queued).rejects.toMatchObject({ code: 'run-interrupted' });
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });
    expect(h.agent.runs).toHaveLength(1);

    await collect(first.subscribe());
  });

  it('rejects submissions paused while prepareRun is still pending', async () => {
    const agent = new DelayedPrepareAgent({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const h = await createHarness({ agent });

    const submit = h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });
    await agent.prepareStarted;

    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      agent.releasePrepare();
      await expect(submit).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(agent.runs).toHaveLength(0);
      expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      resume();
    }
  });

  it('releases pool and active run state when adapter spawn fails', async () => {
    const h = await createHarness({ agent: new ThrowingAgent() });

    await expect(
      h.executor.submit({
        scopeId: 'scope-1',
        policy: policy(h.tmp.workspace),
      }),
    ).rejects.toBeInstanceOf(SpawnFailed);
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
  });

  it('stops and waits for the underlying run when execution is interrupted', async () => {
    const h = await createHarness({
      events: [{ type: 'text', delta: 'running' }],
      waitForExit: true,
    });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await execution.stop();

    const run = execution.run as FakeAgentRun;
    expect(run.stopped).toBe(true);
    expect(run.waitForExitCalls).toBe(1);
  });

  it('only releases an execution for replacement after exit is confirmed', async () => {
    const h = await createHarness({
      events: [[{ type: 'text', delta: 'running' }], [{ type: 'done', terminationReason: 'normal' }]],
      waitForExit: [true, true],
    });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });
    const replacement = h.activeRuns.reserveReplacement('scope-1', execution.handle)!;
    expect(replacement.beginStop()).toBe(true);

    await expect(execution.stopAndConfirmExit()).resolves.toBe(true);
    expect(replacement.confirmExit()).toBe(true);
    const corrected = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
      replacement,
    });

    expect(h.agent.runs.map((run) => run.runId)).toEqual(['run-1', 'run-2']);
    expect(h.activeRuns.get('scope-1')).toBe(corrected.handle);
    await collect(corrected.subscribe());
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('keeps the old execution authoritative when replacement exit is unconfirmed', async () => {
    const h = await createHarness({ events: [{ type: 'text', delta: 'running' }], waitForExit: false });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });
    const replacement = h.activeRuns.reserveReplacement('scope-1', execution.handle)!;
    expect(replacement.beginStop()).toBe(true);

    await expect(execution.stopAndConfirmExit()).resolves.toBe(false);

    expect(h.activeRuns.get('scope-1')).toBe(execution.handle);
    expect(h.activeRuns.hasReplacement('scope-1')).toBe(true);
    expect(h.agent.runs).toHaveLength(1);
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });
  });

  it('does not release the scope or pool when stream cleanup wins before process exit', async () => {
    const agent = new ControlledExitAgent();
    const h = await createHarness({ agent });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });
    const replacement = h.activeRuns.reserveReplacement('scope-1', execution.handle)!;
    expect(replacement.beginStop()).toBe(true);
    const collecting = collect(execution.subscribe());

    await expect(execution.stopAndConfirmExit()).resolves.toBe(false);
    expect(h.activeRuns.get('scope-1')).toBe(execution.handle);
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });

    agent.currentRun!.confirmExit();
    await execution.waitForConfirmedExit();
    await collecting;
    expect(h.activeRuns.get('scope-1')).toBe(execution.handle);
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });

    expect(replacement.confirmExit()).toBe(true);
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
    replacement.release();
  });

  it('keeps authoritative tool observation isolated to each execution', async () => {
    const h = await createHarness({
      events: [
        [
          { type: 'tool_use', id: 'tool-1', name: 'exec', input: {} },
          { type: 'done', terminationReason: 'normal' },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
    });
    const first = await h.executor.submit({ scopeId: 'scope-1', policy: policy(h.tmp.workspace) });
    await collect(first.subscribe());
    const second = await h.executor.submit({ scopeId: 'scope-1', policy: policy(h.tmp.workspace) });
    await collect(second.subscribe());

    expect(first.toolStartedEver()).toBe(true);
    expect(second.toolStartedEver()).toBe(false);
  });

  it('fails closed instead of deadlocking when an exited run event source cannot drain', async () => {
    const h = await createHarness({ agent: new NonDrainingExitAgent() });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await expect(execution.stopAndConfirmExit()).resolves.toBe(false);
    expect(h.activeRuns.get('scope-1')).toBe(execution.handle);
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });
  });

  it('stops the underlying process when it does not exit after a terminal event', async () => {
    const agent = new TerminalDelayedExitAgent();
    const h = await createHarness({ agent });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await collect(execution.subscribe());

    const run = agent.currentRun!;
    expect(run.waitForExitCalls).toBe(2);
    expect(run.stopped).toBe(true);
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });
});

async function createHarness(options: {
  events?: FakeAgentEvents;
  waitForExit?: boolean | readonly boolean[];
  poolCap?: number;
  agent?: AgentAdapter;
}): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  executor: RunExecutor;
}> {
  const tmp = await createTmpProfile('bridge-executor-');
  cleanups.push(tmp.cleanup);
  let nextRun = 1;
  const agent =
    options.agent ??
    new FakeAgentAdapter({
      events: options.events ?? [],
      waitForExit: options.waitForExit,
    });
  const pool = new ProcessPool(() => options.poolCap ?? 2);
  const activeRuns = new ActiveRuns();
  return {
    tmp,
    agent: agent as FakeAgentAdapter,
    pool,
    activeRuns,
    executor: new RunExecutor({
      agent,
      pool,
      activeRuns,
      createRunId: () => `run-${nextRun++}`,
      now: () => 1000,
      postDoneExitGraceMs: 10,
    }),
  };
}

function policy(cwd: string, overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: cwd,
    cwdRealpath: cwd,
    accessMode: 'read-only',
    sandbox: 'read-only',
    permissionMode: 'plan',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

class ThrowingAgent implements AgentAdapter {
  readonly id = 'throwing';
  readonly displayName = 'Throwing';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(_opts: AgentRunOptions): AgentRun {
    throw new Error('spawn failed');
  }
}

class DelayedPrepareAgent extends FakeAgentAdapter {
  readonly prepareStarted: Promise<void>;
  private resolvePrepareStarted!: () => void;
  private resolvePrepare!: () => void;

  constructor(options: ConstructorParameters<typeof FakeAgentAdapter>[0]) {
    super(options);
    this.prepareStarted = new Promise((resolve) => {
      this.resolvePrepareStarted = resolve;
    });
  }

  async prepareRun(): Promise<void> {
    this.resolvePrepareStarted();
    await new Promise<void>((resolve) => {
      this.resolvePrepare = resolve;
    });
  }

  releasePrepare(): void {
    this.resolvePrepare();
  }
}

class ControlledExitAgent implements AgentAdapter {
  readonly id = 'controlled-exit';
  readonly displayName = 'Controlled Exit';
  currentRun: ControlledExitRun | undefined;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(opts: AgentRunOptions): AgentRun {
    this.currentRun = new ControlledExitRun(opts.runId);
    return this.currentRun;
  }
}

class ControlledExitRun implements AgentRun {
  readonly events: AsyncIterable<never>;
  private streamEnded = false;
  private exited = false;
  private waitCalls = 0;
  private resolveStreamEnd!: () => void;
  private resolveExit!: () => void;
  private readonly streamEnd = new Promise<void>((resolve) => { this.resolveStreamEnd = resolve; });
  private readonly processExit = new Promise<void>((resolve) => { this.resolveExit = resolve; });

  constructor(readonly runId: string) {
    this.events = {
      [Symbol.asyncIterator]: async function* (this: ControlledExitRun): AsyncIterator<never> {
        await this.streamEnd;
      }.bind(this),
    };
  }

  async stop(): Promise<void> {
    if (!this.streamEnded) {
      this.streamEnded = true;
      this.resolveStreamEnd();
    }
  }

  async waitForExit(): Promise<boolean> {
    this.waitCalls += 1;
    if (this.exited) return true;
    // The first bounded confirmation attempt times out; later callers wait
    // for the test-controlled authoritative process-exit signal.
    if (!this.streamEnded || this.waitCalls === 1) return false;
    await this.processExit;
    return true;
  }

  confirmExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit();
  }
}

class TerminalDelayedExitAgent implements AgentAdapter {
  readonly id = 'terminal-delayed-exit';
  readonly displayName = 'Terminal Delayed Exit';
  currentRun: TerminalDelayedExitRun | undefined;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(opts: AgentRunOptions): AgentRun {
    this.currentRun = new TerminalDelayedExitRun(opts.runId);
    return this.currentRun;
  }
}

class TerminalDelayedExitRun implements AgentRun {
  stopped = false;
  waitForExitCalls = 0;
  readonly events: AsyncIterable<import('../../../src/agent/types').AgentEvent> = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done' as const, terminationReason: 'normal' as const };
    },
  };

  constructor(readonly runId: string) {}

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async waitForExit(): Promise<boolean> {
    this.waitForExitCalls += 1;
    return this.waitForExitCalls >= 2;
  }
}

class NonDrainingExitAgent implements AgentAdapter {
  readonly id = 'non-draining-exit';
  readonly displayName = 'Non Draining Exit';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(opts: AgentRunOptions): AgentRun {
    const never = new Promise<void>(() => {});
    return {
      runId: opts.runId,
      events: {
        async *[Symbol.asyncIterator]() {
          await never;
        },
      },
      async stop() {},
      async waitForExit() { return true; },
    };
  }
}
