import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../../src/agent/types.js';
import type { RunPolicyAllow } from '../../../src/policy/run-policy.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('run observability events', () => {
  afterEach(async () => {
    await closeLogger();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('records run started and completed events with low-sensitivity dimensions', async () => {
    const h = await createHarness();

    const execution = await h.executor.submit({
      scopeId: 'chat-1',
      policy: policy(h.tmp.workspace),
      observability: {
        profile: 'claude',
        agent: 'claude',
        source: 'im',
        stage: 'submit',
      },
    });
    await collect(execution.subscribe());
    await flushLogger();

    const lines = (await readLogLines(h.logsDir)).filter((line) => line.phase === 'run');
    expect(lines.map((line) => `${line.phase}.${line.event}`)).toEqual([
      'run.started',
      'run.completed',
    ]);
    expect(lines[0]).toMatchObject({
      runId: 'run-1',
      profile: 'claude',
      agent: 'claude',
      scope: 'chat-1',
      source: 'im',
      stage: 'submit',
      queueWaitMs: 0,
    });
    expect(lines[1]).toMatchObject({
      runId: 'run-1',
      result: 'normal',
      durationMs: 0,
    });
  });

  it('records a control-plane stop as interrupted when the agent reports a normal tail', async () => {
    const h = await createHarness(new StopCompletingAgent());

    const execution = await h.executor.submit({
      scopeId: 'chat-1',
      policy: policy(h.tmp.workspace),
      observability: {
        profile: 'claude',
        agent: 'claude',
        source: 'im',
        stage: 'submit',
      },
    });
    const collecting = collect(execution.subscribe());

    expect(h.activeRuns.interrupt('chat-1')).toBe(true);
    await collecting;
    await flushLogger();

    const lines = (await readLogLines(h.logsDir)).filter((line) => line.phase === 'run');
    expect(lines.at(-1)).toMatchObject({
      event: 'completed',
      runId: 'run-1',
      result: 'interrupted',
    });
  });
});

async function createHarness(
  agent: AgentAdapter = new FakeAgentAdapter({
    events: [[{ type: 'done', terminationReason: 'normal' }]],
  }),
): Promise<{
  tmp: TmpProfile;
  logsDir: string;
  executor: RunExecutor;
  activeRuns: ActiveRuns;
}> {
  const tmp = await createTmpProfile('run-events-');
  cleanups.push(tmp.cleanup);
  const logsDir = join(tmp.profile, 'logs');
  configureLogger({
    logsDir,
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  });
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns,
    createRunId: () => 'run-1',
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 1,
  });
  return { tmp, logsDir, executor, activeRuns };
}

function policy(cwd: string): RunPolicyAllow {
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
    expiresAt: 2_000_000_000_000,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function readLogLines(logsDir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class StopCompletingAgent implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(opts: AgentRunOptions): AgentRun {
    let releaseStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const events: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator]() {
        await stopped;
        yield { type: 'done', terminationReason: 'normal' };
      },
    };
    return {
      runId: opts.runId,
      events,
      async stop() {
        releaseStop();
      },
      async waitForExit() {
        return true;
      },
    };
  }
}
