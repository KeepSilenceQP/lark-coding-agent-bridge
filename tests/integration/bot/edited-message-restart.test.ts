import type { ApiMessageItem, NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import {
  EditedMessageRestartRegistry,
  handleEditedMessageRestartReaction,
} from '../../../src/bot/edited-message-restart';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';

function normalized(content = 'old text'): NormalizedMessage {
  return {
    messageId: 'om_edit', chatId: 'oc_chat', chatType: 'group', threadId: 'omt_topic',
    senderId: 'ou_author', senderType: 'user', content, rawContentType: 'text',
    resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: 1,
  };
}

function fetched(content = 'corrected text', revision = '2'): ApiMessageItem {
  return {
    message_id: 'om_edit', msg_type: 'text',
    sender: { id: 'ou_author', sender_type: 'user' },
    body: { content: JSON.stringify({ text: content }) },
    ...({ chat_id: 'oc_chat', thread_id: 'omt_topic', update_time: revision } as object),
  };
}

function createHarness(options: {
  stopConfirmed?: boolean;
  toolStarted?: boolean;
  toolStartsDuringStop?: boolean;
} = {}) {
  const trace: string[] = [];
  const activeRuns = new ActiveRuns();
  const reservation = activeRuns.reserve('oc_chat:omt_topic')!;
  const run: AgentRun = {
    runId: 'old-run',
    events: { async *[Symbol.asyncIterator]() {} },
    stop: vi.fn(async () => { trace.push('stop'); }),
    waitForExit: vi.fn(async () => options.stopConfirmed !== false),
  };
  const handle = activeRuns.register('oc_chat:omt_topic', run, reservation);
  reservation.release();
  const registry = new EditedMessageRestartRegistry();
  let confirmAuthoritativeExit!: () => void;
  const authoritativeExit = options.stopConfirmed === false
    ? new Promise<void>((resolve) => { confirmAuthoritativeExit = resolve; })
    : Promise.resolve();
  const execution = {
    runId: run.runId, scopeId: 'oc_chat:omt_topic', run, handle,
    subscribe: () => run.events,
    stop: async () => {},
    stopAndConfirmExit: async () => {
      trace.push('stop-request');
      if (options.toolStartsDuringStop) registry.markToolStarted(handle);
      await run.stop();
      const exited = await run.waitForExit(2_000);
      trace.push(exited ? 'exit-confirmed' : 'exit-unconfirmed');
      if (exited) activeRuns.unregister('oc_chat:omt_topic', run);
      return exited;
    },
    waitForConfirmedExit: async () => {
      await authoritativeExit;
      activeRuns.unregister('oc_chat:omt_topic', run);
    },
    toolStartedEver: () => false,
  };
  registry.registerRun({
    scope: 'oc_chat:omt_topic', chatId: 'oc_chat', chatType: 'group', threadId: 'omt_topic',
    messages: [normalized()], handle, execution, cwdRealpath: '/repo',
    policyFingerprint: 'policy', codexThreadId: 'thread-1',
    workChainId: 'chain-1', lifecycleUnitId: 'unit-old',
  });
  if (options.toolStarted) registry.markToolStarted(handle);
  const pending = new PendingQueue(100_000, () => { trace.push('pending-flush'); });
  pending.push('oc_chat:omt_topic', normalized('ordinary pending'));
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  const fetchRawMessage = vi.fn(async () => [fetched()]);
  const send = vi.fn(async (..._args: unknown[]) => ({}));
  const deps = {
    enabled: true,
    botOpenId: 'ou_bot',
    registry,
    activeRuns: {
      get: (scope: string) => activeRuns.get(scope),
      reserveReplacement: (scope: string, expected: typeof handle) => {
        trace.push('replacement-held');
        return activeRuns.reserveReplacement(scope, expected);
      },
    },
    pending: {
      acquireEditHold: (scope: string) => {
        trace.push('queue-held');
        return pending.acquireEditHold(scope);
      },
    },
    channel: { botIdentity: { openId: 'ou_bot', name: 'Bot' }, fetchRawMessage, send },
    checkAccess: vi.fn(() => true),
    prepare: vi.fn(async () => { trace.push('prepared'); return { ok: true as const, prepared: {} }; }),
    materializePrepared: vi.fn((_record, corrected, _prepared) => ({
      prompt: JSON.stringify({ corrected_message: corrected }),
    })),
    startCorrected: vi.fn(async ({ replacement, corrected, prepared }: {
      replacement: NonNullable<ReturnType<ActiveRuns['reserveReplacement']>>;
      corrected: { text: string; oldRunStartedTool: boolean };
      prepared: { prompt: string };
    }) => {
      trace.push('start-corrected');
      const nextRun: AgentRun = {
        runId: 'corrected-run', events: { async *[Symbol.asyncIterator]() {} },
        async stop() {}, async waitForExit() { return true; },
      };
      const nextHandle = replacement.register(nextRun);
      registry.registerRun({
        scope: 'oc_chat:omt_topic', chatId: 'oc_chat', chatType: 'group', threadId: 'omt_topic',
        messages: [normalized(corrected.text)], handle: nextHandle, cwdRealpath: '/repo',
        policyFingerprint: 'policy', codexThreadId: 'thread-1',
        workChainId: 'chain-1', lifecycleUnitId: 'unit-new',
      });
      return { ok: true as const, completion };
    }),
  };
  return {
    trace, activeRuns, registry, pending, run, deps, finish,
    finishExit: () => confirmAuthoritativeExit?.(), fetchRawMessage, send,
  };
}

const loudspeaker = {
  messageId: 'om_edit', operator: { openId: 'ou_author' },
  emojiType: 'Loudspeaker', action: 'added' as const,
};

describe('edited message restart transaction', () => {
  it('orders fetch/precheck/hold/CAS/stop/exit/direct start and retains ordinary pending work', async () => {
    const h = createHarness();
    const outcome = await handleEditedMessageRestartReaction(loudspeaker, h.deps);
    expect(outcome).toEqual({ handled: true, code: 'started' });
    expect(h.fetchRawMessage).toHaveBeenCalledOnce();
    expect(h.run.stop).toHaveBeenCalledOnce();
    expect(h.deps.startCorrected).toHaveBeenCalledOnce();
    expect(h.trace).toEqual([
      'prepared', 'queue-held', 'replacement-held', 'stop-request', 'stop',
      'exit-confirmed', 'start-corrected',
    ]);
    expect(h.pending.pendingCount('oc_chat:omt_topic')).toBe(1);
    expect(h.trace).not.toContain('pending-flush');
    expect(h.registry.get('om_edit')).toMatchObject({
      state: 'active', deliveredFingerprint: expect.any(String), lifecycleUnitId: 'unit-new',
    });
    h.finish();
    await Promise.resolve();
  });

  it('joins duplicate in-flight events into one fetch/stop/start transaction', async () => {
    const h = createHarness();
    let releaseFetch!: () => void;
    h.fetchRawMessage.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseFetch = resolve; });
      return [fetched()];
    });
    const first = handleEditedMessageRestartReaction(loudspeaker, h.deps);
    await vi.waitFor(() => expect(h.fetchRawMessage).toHaveBeenCalledOnce());
    const duplicate = handleEditedMessageRestartReaction(loudspeaker, h.deps);
    releaseFetch();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { handled: true, code: 'started' }, { handled: true, code: 'started' },
    ]);
    expect(h.fetchRawMessage).toHaveBeenCalledOnce();
    expect(h.run.stop).toHaveBeenCalledOnce();
    expect(h.deps.startCorrected).toHaveBeenCalledOnce();
    h.finish();
  });

  it('keeps silent prechecks fetch-free and exact removal a no-op', async () => {
    const h = createHarness();
    await expect(handleEditedMessageRestartReaction({
      ...loudspeaker, operator: { openId: 'ou_other' },
    }, h.deps)).resolves.toMatchObject({ code: 'ignored' });
    await expect(handleEditedMessageRestartReaction({
      ...loudspeaker, operator: { openId: 'ou_bot' },
    }, h.deps)).resolves.toMatchObject({ code: 'ignored' });
    await expect(handleEditedMessageRestartReaction({
      ...loudspeaker, action: 'removed',
    }, h.deps)).resolves.toMatchObject({ code: 'ignored' });
    expect(h.fetchRawMessage).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('falls through unchanged when the Codex-only feature flag is off', async () => {
    const h = createHarness();
    await expect(handleEditedMessageRestartReaction(loudspeaker, {
      ...h.deps,
      enabled: false,
    })).resolves.toEqual({ handled: false, code: 'ignored' });
    expect(h.fetchRawMessage).not.toHaveBeenCalled();
    expect(h.run.stop).not.toHaveBeenCalled();
  });

  it('distinguishes no-edit, unsupported, ended, unreadable, and startup failure outcomes', async () => {
    const noEdit = createHarness();
    noEdit.fetchRawMessage.mockResolvedValue([fetched('old text')]);
    await expect(handleEditedMessageRestartReaction(loudspeaker, noEdit.deps))
      .resolves.toMatchObject({ code: 'no-edit' });
    expect(noEdit.run.stop).not.toHaveBeenCalled();

    const unsupported = createHarness();
    unsupported.registry.get('om_edit')!.eligibility = 'unsupported-original';
    await expect(handleEditedMessageRestartReaction(loudspeaker, unsupported.deps))
      .resolves.toMatchObject({ code: 'unsupported-original' });
    expect(unsupported.fetchRawMessage).not.toHaveBeenCalled();

    const ended = createHarness();
    ended.registry.markTerminal(ended.registry.get('om_edit')!.handle);
    await expect(handleEditedMessageRestartReaction(loudspeaker, ended.deps))
      .resolves.toMatchObject({ code: 'original-ended' });
    expect(ended.fetchRawMessage).not.toHaveBeenCalled();

    const unreadable = createHarness();
    unreadable.fetchRawMessage.mockRejectedValue(new Error('read failed'));
    await expect(handleEditedMessageRestartReaction(loudspeaker, unreadable.deps))
      .resolves.toMatchObject({ code: 'latest-unreadable' });
    expect(unreadable.run.stop).not.toHaveBeenCalled();

    const failedStart = createHarness();
    const rejectStart = vi.fn(async () => ({ ok: false as const }));
    await expect(handleEditedMessageRestartReaction(loudspeaker, {
      ...failedStart.deps,
      startCorrected: rejectStart,
    }))
      .resolves.toMatchObject({ code: 'corrected-start-failed' });
    expect(failedStart.run.stop).toHaveBeenCalledOnce();
    expect(failedStart.pending.isBlocked('oc_chat:omt_topic')).toBe(false);
  });

  it('never stops a newer scope owner that wins during the fetch', async () => {
    const h = createHarness();
    let releaseFetch!: () => void;
    h.fetchRawMessage.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseFetch = resolve; });
      return [fetched()];
    });
    const transaction = handleEditedMessageRestartReaction(loudspeaker, h.deps);
    await vi.waitFor(() => expect(h.fetchRawMessage).toHaveBeenCalledOnce());
    h.activeRuns.unregister('oc_chat:omt_topic', h.run);
    const reservation = h.activeRuns.reserve('oc_chat:omt_topic')!;
    const newerRun: AgentRun = {
      runId: 'newer', events: { async *[Symbol.asyncIterator]() {} },
      stop: vi.fn(async () => {}), async waitForExit() { return true; },
    };
    h.activeRuns.register('oc_chat:omt_topic', newerRun, reservation);
    reservation.release();
    releaseFetch();
    await expect(transaction).resolves.toMatchObject({ code: 'window-closed' });
    expect(h.run.stop).not.toHaveBeenCalled();
    expect(newerRun.stop).not.toHaveBeenCalled();
  });

  it('keeps the exact handle and queue hold until an initially unconfirmed exit becomes authoritative', async () => {
    const h = createHarness({ stopConfirmed: false });
    await expect(handleEditedMessageRestartReaction(loudspeaker, h.deps)).resolves.toEqual({
      handled: true, code: 'stop-not-confirmed',
    });
    expect(h.deps.startCorrected).not.toHaveBeenCalled();
    expect(h.activeRuns.get('oc_chat:omt_topic')).toBe(h.registry.get('om_edit')?.handle);
    expect(h.activeRuns.hasReplacement('oc_chat:omt_topic')).toBe(true);
    expect(h.pending.isBlocked('oc_chat:omt_topic')).toBe(true);

    h.finishExit();
    await vi.waitFor(() => {
      expect(h.activeRuns.get('oc_chat:omt_topic')).toBeUndefined();
      expect(h.activeRuns.hasReplacement('oc_chat:omt_topic')).toBe(false);
      expect(h.pending.isBlocked('oc_chat:omt_topic')).toBe(false);
    });
  });

  it('warns about non-rolled-back side effects iff a tool started', async () => {
    const withTool = createHarness({ toolStarted: true });
    await handleEditedMessageRestartReaction(loudspeaker, withTool.deps);
    expect(withTool.send).toHaveBeenCalledWith('oc_chat', {
      markdown: expect.stringContaining('副作用可能仍然存在'),
    }, expect.any(Object));
    withTool.finish();

    const withoutTool = createHarness();
    await handleEditedMessageRestartReaction(loudspeaker, withoutTool.deps);
    expect(withoutTool.send.mock.calls.at(-1)?.[1]).toEqual({
      markdown: expect.not.stringContaining('副作用可能仍然存在'),
    });
    withoutTool.finish();
  });

  it('materializes the adapter prompt after exit with tool use observed during stopping', async () => {
    const h = createHarness({ toolStartsDuringStop: true });

    await expect(handleEditedMessageRestartReaction(loudspeaker, h.deps)).resolves.toEqual({
      handled: true, code: 'started',
    });

    const startInput = h.deps.startCorrected.mock.calls[0]![0];
    expect(startInput.corrected.oldRunStartedTool).toBe(true);
    expect(startInput.prepared.prompt).toContain('"oldRunStartedTool":true');
    expect(h.send).toHaveBeenCalledWith('oc_chat', {
      markdown: expect.stringContaining('副作用可能仍然存在'),
    }, expect.any(Object));
    h.finish();
  });

  it('captures a buffered tool_use even when the render subscriber stops pulling before exit', async () => {
    const activeRuns = new ActiveRuns();
    const agent = new BufferedToolAgent();
    const executor = new RunExecutor({
      agent,
      activeRuns,
      pool: new ProcessPool(() => 2),
      createRunId: () => 'old-run',
      postDoneExitGraceMs: 10,
    });
    const execution = await executor.submit({
      scopeId: 'oc_chat:omt_topic',
      policy: allowPolicy(),
    });
    const render = execution.subscribe()[Symbol.asyncIterator]();
    await expect(render.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'text', delta: 'render-blocker' },
    });
    await agent.currentRun!.toolYielded;
    await Promise.resolve();

    const registry = new EditedMessageRestartRegistry();
    registry.registerRun({
      scope: 'oc_chat:omt_topic', chatId: 'oc_chat', chatType: 'group', threadId: 'omt_topic',
      messages: [normalized()], handle: execution.handle, execution, cwdRealpath: '/repo',
      policyFingerprint: 'policy', codexThreadId: 'thread-1',
      workChainId: 'chain-1', lifecycleUnitId: 'unit-old',
    });
    const pending = new PendingQueue(100_000, () => {});
    const send = vi.fn(async () => ({}));
    const startCorrected = vi.fn(async ({ replacement, prepared }: {
      replacement: NonNullable<ReturnType<ActiveRuns['reserveReplacement']>>;
      prepared: { prompt: string };
    }) => {
      replacement.register({
        runId: 'corrected-run', events: { async *[Symbol.asyncIterator]() {} },
        async stop() {}, async waitForExit() { return true; },
      });
      return { ok: true as const, completion: Promise.resolve() };
    });

    await expect(handleEditedMessageRestartReaction(loudspeaker, {
      enabled: true,
      botOpenId: 'ou_bot',
      registry,
      activeRuns,
      pending,
      channel: {
        botIdentity: { openId: 'ou_bot', name: 'Bot' },
        fetchRawMessage: vi.fn(async () => [fetched()]),
        send,
      },
      checkAccess: () => true,
      prepare: vi.fn(async () => ({ ok: true as const, prepared: { prompt: '' } })),
      materializePrepared: (_record, corrected) => ({
        prompt: JSON.stringify({ corrected_message: corrected }),
      }),
      startCorrected,
    })).resolves.toEqual({ handled: true, code: 'started' });

    expect(startCorrected.mock.calls[0]![0].prepared.prompt)
      .toContain('"oldRunStartedTool":true');
    expect(send).toHaveBeenCalledWith('oc_chat', {
      markdown: expect.stringContaining('副作用可能仍然存在'),
    }, expect.any(Object));
  });
});

function allowPolicy(): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'old prompt',
    requestedCwd: '/repo',
    cwdRealpath: '/repo',
    accessMode: 'read-only',
    sandbox: 'read-only',
    permissionMode: 'plan',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'policy',
    expiresAt: Date.now() + 60_000,
  };
}

class BufferedToolAgent implements AgentAdapter {
  readonly id = 'buffered-tool';
  readonly displayName = 'Buffered Tool';
  currentRun: BufferedToolRun | undefined;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(opts: AgentRunOptions): AgentRun {
    this.currentRun = new BufferedToolRun(opts.runId);
    return this.currentRun;
  }
}

class BufferedToolRun implements AgentRun {
  readonly events: AsyncIterable<AgentEvent>;
  readonly toolYielded: Promise<void>;
  private stopped = false;
  private resolveStopped!: () => void;
  private resolveToolYielded!: () => void;
  private readonly stoppedSignal = new Promise<void>((resolve) => { this.resolveStopped = resolve; });

  constructor(readonly runId: string) {
    this.toolYielded = new Promise<void>((resolve) => { this.resolveToolYielded = resolve; });
    const self = this;
    this.events = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', delta: 'render-blocker' };
        self.resolveToolYielded();
        yield { type: 'tool_use', id: 'tool-1', name: 'exec', input: {} };
        await self.stoppedSignal;
      },
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.resolveStopped();
  }

  async waitForExit(): Promise<boolean> {
    return this.stopped;
  }
}
