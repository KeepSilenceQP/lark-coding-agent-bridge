import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import {
  ActiveRuns,
  type ReplacementReservation,
  type RunHandle,
  type RunReservation,
} from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
}

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  systemPromptAddendum?: string;
  model?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  routeId?: string;
  reservation?: RunReservation;
  replacement?: ReplacementReservation;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /** Stop and release lifecycle ownership only after process exit is confirmed. */
  stopAndConfirmExit(): Promise<boolean>;
  /** Resolve only after the underlying process has authoritatively exited. */
  waitForConfirmedExit(): Promise<void>;
  /** Monotonic tool-start observation from the authoritative event source. */
  toolStartedEver(): boolean;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
  }

  reserveScope(scopeId: string): RunReservation | undefined {
    return this.activeRuns.reserve(scopeId);
  }

  interruptEpoch(scopeId: string): number {
    return this.activeRuns.interruptEpoch(scopeId);
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.reservation && input.replacement) {
      input.reservation.release();
      input.replacement.release();
      throw new RunRejected('run-interrupted', 'submission cannot use two reservations');
    }
    const suppliedReservation = input.replacement ?? input.reservation;
    if (input.policy.expiresAt <= this.now()) {
      suppliedReservation?.release();
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      suppliedReservation?.release();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const reservation = suppliedReservation ?? this.activeRuns.reserve(input.scopeId);
    if (!reservation) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }
    if (reservation.scopeId !== input.scopeId) {
      reservation.release();
      throw new RunRejected('run-interrupted', 'run reservation scope does not match submission');
    }
    if (input.replacement && input.replacement.phase !== 'exit-confirmed') {
      reservation.release();
      throw new RunRejected('run-interrupted', 'replacement reservation is not exit-confirmed');
    }

    let release: (() => void) | undefined;
    try {
      release = input.nowait
        ? this.pool.tryAcquire()
        : await this.pool.acquire(reservation.signal);
    } catch (err) {
      reservation.release();
      if (reservation.signal.aborted) {
        throw new RunRejected('run-interrupted', 'run was interrupted before spawn');
      }
      throw err;
    }
    if (!release) {
      reservation.release();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (reservation.signal.aborted) {
      release();
      reservation.release();
      throw new RunRejected('run-interrupted', 'run was interrupted before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      reservation.release();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      systemPromptAddendum: input.systemPromptAddendum,
      model: input.model,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
      routeId: input.routeId,
    };
    let run: AgentRun;
    try {
      await this.agent.prepareRun?.(runOptions);
    } catch (err) {
      release();
      reservation.release();
      if (reservation.signal.aborted) {
        throw new RunRejected('run-interrupted', 'run was interrupted before spawn');
      }
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (reservation.signal.aborted) {
      release();
      reservation.release();
      throw new RunRejected('run-interrupted', 'run was interrupted before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      reservation.release();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      release();
      reservation.release();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    try {
      handle = input.replacement
        ? input.replacement.register(run)
        : this.activeRuns.register(input.scopeId, run, reservation as RunReservation);
    } catch (err) {
      reservation.release();
      release();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    if (!input.replacement) reservation.release();
    let cleaned = false;
    let explicitStopRequested = false;
    let confirmedExitPromise: Promise<void> | undefined;
    let toolStartedEver = false;
    const cleanupConfirmedExit = (): void => {
      if (cleaned) return;
      cleaned = true;
      this.activeRuns.unregister(input.scopeId, run);
      release();
    };
    const waitForConfirmedExit = (): Promise<void> => {
      if (!confirmedExitPromise) {
        confirmedExitPromise = (async () => {
          while (!(await run.waitForExit(this.postDoneExitGraceMs))) {
            // waitForExit itself provides the bounded delay. Keep ownership
            // fail-closed until the adapter observes the OS process exit.
            await new Promise<void>((resolve) => {
              setTimeout(resolve, Math.max(1, this.postDoneExitGraceMs));
            });
          }
          cleanupConfirmedExit();
        })();
      }
      return confirmedExitPromise;
    };
    const cleanupAfterTerminalEvent = async (): Promise<void> => {
      if (cleaned) return;
      const exited = await run.waitForExit(this.postDoneExitGraceMs);
      if (exited) {
        cleanupConfirmedExit();
        return;
      }
      log.warn('run', 'post-done-exit-timeout', {
        ...dimensions,
        graceMs: this.postDoneExitGraceMs,
      });
      await run.stop().catch((err) => {
        log.warn('run', 'post-done-stop-failed', {
          ...dimensions,
          err: err instanceof Error ? err.message : String(err),
        });
      });
      void waitForConfirmedExit().catch(() => {
        // Unknown exit state remains fail-closed in ActiveRuns and the pool.
      });
    };
    const fanout = new EventFanout(
      observeRunEvents(run.events, {
        dimensions,
        startedAt,
        now: this.now,
        wasControlPlaneInterrupted: () => handle.controlPlaneInterrupted === true,
      }),
      async () => {
        if (!handle.interrupted) {
          await cleanupAfterTerminalEvent();
        } else if (!explicitStopRequested) {
          void waitForConfirmedExit().catch(() => {
            // Unknown exit state remains fail-closed in ActiveRuns and the pool.
          });
        }
      },
      (event) => {
        if (event.type === 'tool_use') toolStartedEver = true;
      },
    );

    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: async () => {
        explicitStopRequested = true;
        handle.interrupted = true;
        handle.controlPlaneInterrupted = true;
        await run.stop();
        const exited = await run.waitForExit(this.postDoneExitGraceMs);
        if (exited) cleanupConfirmedExit();
        else await waitForConfirmedExit();
      },
      stopAndConfirmExit: async () => {
        explicitStopRequested = true;
        handle.interrupted = true;
        handle.controlPlaneInterrupted = true;
        await run.stop();
        const exited = await run.waitForExit(this.postDoneExitGraceMs);
        if (!exited) return false;
        if (!(await fanout.waitForDrain(this.postDoneExitGraceMs))) return false;
        cleanupConfirmedExit();
        return true;
      },
      waitForConfirmedExit,
      toolStartedEver: () => toolStartedEver,
    };
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
    wasControlPlaneInterrupted: () => boolean;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: opts.wasControlPlaneInterrupted()
              ? 'interrupted'
              : event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;
  private resolveDrained!: () => void;
  private readonly drained = new Promise<void>((resolve) => {
    this.resolveDrained = resolve;
  });

  constructor(
    source: AsyncIterable<AgentEvent>,
    onDone: () => Promise<void>,
    onEvent: (event: AgentEvent) => void = () => {},
  ) {
    this.source = source;
    this.onDone = onDone;
    this.onEvent = onEvent;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  async waitForDrain(timeoutMs: number): Promise<boolean> {
    this.start();
    if (this.done) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      void this.drained.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.onEvent(event);
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      try {
        await this.onDone();
      } finally {
        this.done = true;
        this.resolveDrained();
        this.wakeAll();
      }
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
