import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCapability, codexCapability } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import {
  preparePinnedCodexRun,
  recordRunSessionEvent,
  startPreparedPinnedCodexRun,
  startRunFlow,
  type StartRunFlowInput,
} from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { PromptSessionService } from '../../../src/session/prompt-session-service.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware run-flow resume', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('resumes Claude only when scope, agent, cwd, and policy fingerprint match', async () => {
    const h = await createHarness('claude');
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.execution.subscribe());

    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: first.policy.policyFingerprint,
      sessionId: 'sess-catalog',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected resumed run');
    expect(second.resumeFrom).toBe('sess-catalog');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: 'sess-catalog',
      threadId: undefined,
    });
  });

  it('falls back to legacy Claude sessions when the agent-aware catalog has no match', async () => {
    const h = await createHarness('claude');
    const cwdRealpath = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'legacy-session', cwdRealpath);

    const run = await start(h);

    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('expected resumed legacy run');
    expect(run.resumeFrom).toBe('legacy-session');
    expect(h.agent.runOptions[0]).toMatchObject({
      sessionId: 'legacy-session',
      threadId: undefined,
    });
  });

  it('resumes Codex thread from catalog and ignores legacy Claude SessionStore entries', async () => {
    const h = await createHarness('codex');
    const cwdRealpath = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'legacy-claude-session', cwdRealpath);
    const probe = await start(h);
    expect(probe.ok).toBe(true);
    if (!probe.ok) throw new Error('expected probe run');
    await collect(probe.execution.subscribe());
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: probe.cwdRealpath,
      policyFingerprint: probe.policy.policyFingerprint,
      threadId: 'thread-catalog',
      now: 1000,
    });

    const resumed = await start(h);

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed run');
    expect(resumed.resumeFrom).toBe('thread-catalog');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
      threadId: 'thread-catalog',
    });
  });

  it('keeps the Codex thread when access lists change without revoking the accepted request', async () => {
    const h = await createHarness('codex');
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.execution.subscribe());
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: first.policy.policyFingerprint,
      threadId: 'thread-catalog',
      now: 1000,
    });

    h.profileConfig.access.allowedChats.push('chat-other');
    h.profileConfig.access.ownerNoMentionChats.push('chat-1');
    const resumed = await start(h);

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed run');
    expect(resumed.resumeFrom).toBe('thread-catalog');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
      threadId: 'thread-catalog',
    });
  });

  it('adopts a pre-fix Codex catalog fingerprint without starting fresh', async () => {
    const h = await createHarness('codex');
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.execution.subscribe());
    const legacyFingerprint = first.policy.compatiblePolicyFingerprints?.[0];
    expect(legacyFingerprint).toBeTruthy();
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: legacyFingerprint!,
      threadId: 'thread-before-fix',
      now: 1000,
    });

    const resumed = await start(h);

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed run');
    expect(resumed.resumeFrom).toBe('thread-before-fix');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
      threadId: 'thread-before-fix',
    });
  });

  it('migrates a dormant old group after another group changes access and the bridge restarts', async () => {
    const h = await createHarness('codex');
    const probe = await start(h);
    if (!probe.ok) throw new Error('expected probe run');
    await collect(probe.execution.subscribe());
    const oldIdentity = {
      scopeId: 'chat-1', agentId: 'codex' as const, cwdRealpath: probe.cwdRealpath,
      policyFingerprint: probe.policy.compatiblePolicyFingerprints![0]!,
    };
    const origin = { source: 'im' as const, scopeId: 'chat-1', chatId: 'chat-1', chatType: 'group' as const };
    await mkdir(join(h.tmp.profile, 'prompts/groups'), { recursive: true });
    await writeFile(join(h.tmp.profile, 'prompts/groups/chat-1.md'), 'keep the original pinned role');
    const openService = () => PromptSessionService.open({
      profileDir: h.tmp.profile, profile: 'work', sessionCatalog: h.catalog, sessionStore: h.sessions,
    });
    const service = await openService();
    const fresh = await service.prepareSession({ identity: oldIdentity, origin });
    if (fresh.kind !== 'fresh') throw new Error('expected fresh legacy session');
    await service.recordIdentifier({ identity: oldIdentity, origin, binding: fresh.binding,
      generation: fresh.generation, agentSessionId: 'thread-before-upgrade' });

    // The group remains idle while another group is invited, then the process restarts.
    const configPath = join(h.tmp.profile, 'config.json');
    await saveRootConfig(createRootConfig('work', h.profileConfig), configPath);
    const root = (await loadRootConfig(configPath))!;
    root.profiles.work!.access.ownerNoMentionChats.push('chat-other');
    await saveRootConfig(root, configPath);
    h.profileConfig = (await loadRootConfig(configPath))!.profiles.work!;
    const reopened = await openService();
    const resumed = await start(h, { promptSession: { service: reopened, origin } });
    if (!resumed.ok) throw new Error('expected resumed run');
    expect(resumed.resumeFrom).toBe('thread-before-upgrade');
    expect(resumed.promptSession?.decision).toMatchObject({ kind: 'resume', binding: fresh.binding });
    expect(h.agent.runOptions.at(-1)?.threadId).toBe('thread-before-upgrade');
    await collect(resumed.execution.subscribe());
    const identity = { ...oldIdentity, policyFingerprint: resumed.policy.policyFingerprint };
    expect(h.catalog.activeFor(identity)?.threadId).toBe('thread-before-upgrade');

    await reopened.resetSession({ identity, origin });
    const reset = await start(h, { promptSession: { service: reopened, origin } });
    if (!reset.ok) throw new Error('expected fresh run after reset');
    expect(reset.resumeFrom).toBeUndefined();
  });

  it('does not resume when the policy fingerprint changes', async () => {
    const h = await createHarness('claude');
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.execution.subscribe());
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: 'stale-fingerprint',
      sessionId: 'sess-stale',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected fresh run');
    expect(second.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
      threadId: undefined,
    });
  });

  it('records system session identifiers into the agent-aware catalog', async () => {
    const claude = await createHarness('claude');
    const claudeRun = await start(claude);
    expect(claudeRun.ok).toBe(true);
    if (!claudeRun.ok) throw new Error('expected claude run');
    await collect(claudeRun.execution.subscribe());

    await recordRunSessionEvent({
      scopeId: 'chat-1',
      sessions: claude.sessions,
      sessionCatalog: claude.catalog,
      capability: claudeCapability(claude.profileConfig),
      policy: claudeRun.policy,
      event: { type: 'system', sessionId: 'sess-recorded', cwd: claudeRun.cwdRealpath },
    });

    expect(
      claude.catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: claudeRun.cwdRealpath,
        policyFingerprint: claudeRun.policy.policyFingerprint,
      }),
    ).toMatchObject({ sessionId: 'sess-recorded' });
    expect(claude.sessions.resumeFor('chat-1', claudeRun.cwdRealpath)).toBe('sess-recorded');

    const codex = await createHarness('codex');
    const codexRun = await start(codex);
    expect(codexRun.ok).toBe(true);
    if (!codexRun.ok) throw new Error('expected codex run');
    await collect(codexRun.execution.subscribe());

    await recordRunSessionEvent({
      scopeId: 'chat-1',
      sessions: codex.sessions,
      sessionCatalog: codex.catalog,
      capability: codexCapability(codex.profileConfig),
      policy: codexRun.policy,
      event: { type: 'system', threadId: 'thread-recorded' },
    });

    expect(
      codex.catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: codexRun.cwdRealpath,
        policyFingerprint: codexRun.policy.policyFingerprint,
      }),
    ).toMatchObject({ threadId: 'thread-recorded' });
    expect(codex.sessions.getRaw('chat-1')).toBeUndefined();
  });

  it('validates cwd, policy, and catalog before pinning the exact Codex thread into replacement', async () => {
    const h = await createHarness('codex');
    const probe = await start(h);
    if (!probe.ok) throw new Error('expected probe run');
    await collect(probe.execution.subscribe());
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: probe.cwdRealpath,
      policyFingerprint: probe.policy.policyFingerprint,
      threadId: 'thread-pinned',
      now: 1000,
    });
    const prepared = await preparePinnedCodexRun({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'corrected prompt',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: codexCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      sessionCatalog: h.catalog,
      workspaces: h.workspaces,
      expected: {
        cwdRealpath: probe.cwdRealpath,
        policyFingerprint: probe.policy.policyFingerprint,
        threadId: 'thread-pinned',
      },
      now: 1000,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('expected pinned plan');

    const activeRuns = new ActiveRuns();
    const oldReservation = activeRuns.reserve('chat-1')!;
    const oldRun = {
      runId: 'old',
      events: { async *[Symbol.asyncIterator]() {} },
      async stop() {},
      async waitForExit() { return true; },
    };
    const oldHandle = activeRuns.register('chat-1', oldRun, oldReservation);
    oldReservation.release();
    const replacement = activeRuns.reserveReplacement('chat-1', oldHandle)!;
    expect(replacement.beginStop()).toBe(true);
    expect(replacement.confirmExit()).toBe(true);
    const replacementExecutor = new RunExecutor({
      agent: h.agent,
      pool: new ProcessPool(() => 10),
      activeRuns,
      createRunId: () => 'corrected-run',
      now: () => 1000,
    });
    const started = await startPreparedPinnedCodexRun({
      prepared: prepared.prepared,
      executor: replacementExecutor,
      replacement,
      profileConfig: h.profileConfig,
    });
    expect(started.ok).toBe(true);
    expect(h.agent.runOptions.at(-1)).toMatchObject({
      runId: 'corrected-run',
      threadId: 'thread-pinned',
      sessionId: undefined,
      prompt: 'corrected prompt',
    });
  });

  it('rejects a missing or different pinned Codex thread before a replacement can start', async () => {
    const h = await createHarness('codex');
    const probe = await start(h);
    if (!probe.ok) throw new Error('expected probe run');
    await collect(probe.execution.subscribe());
    const base = {
      scopeId: 'chat-1',
      scope: { source: 'im' as const, chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'corrected prompt',
      attachments: [],
      access: { ok: true as const, reason: 'allowed-user' as const },
      capability: codexCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      sessionCatalog: h.catalog,
      workspaces: h.workspaces,
      expected: {
        cwdRealpath: probe.cwdRealpath,
        policyFingerprint: probe.policy.policyFingerprint,
        threadId: 'thread-old',
      },
      now: 1000,
    };
    await expect(preparePinnedCodexRun(base)).resolves.toMatchObject({
      ok: false,
      rejectReason: { code: 'pinned-restart-thread-unavailable' },
    });
    h.catalog.upsertActive({
      scopeId: 'chat-1', agentId: 'codex', cwdRealpath: probe.cwdRealpath,
      policyFingerprint: probe.policy.policyFingerprint, threadId: 'thread-new', now: 1000,
    });
    await expect(preparePinnedCodexRun(base)).resolves.toMatchObject({
      ok: false,
      rejectReason: { code: 'pinned-restart-thread-changed' },
    });
  });
});

async function createHarness(agentKind: 'claude' | 'codex'): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  profileConfig: ProfileConfig;
}> {
  const tmp = await createTmpProfile(`resume-${agentKind}-test-`);
  const agent = new FakeAgentAdapter({
    id: agentKind,
    displayName: agentKind,
    events: [[{ type: 'done', terminationReason: 'normal' }]],
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor: new RunExecutor({
      agent,
      pool: new ProcessPool(() => 10),
      activeRuns: new ActiveRuns(),
      createRunId: () => `run-${agent.runOptions.length + 1}`,
      now: () => 1000,
    }),
    sessions,
    workspaces,
    catalog,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: tmp.workspace,
      },
    },
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    /* drain */
  }
}

async function start(h: Awaited<ReturnType<typeof createHarness>>, overrides: Partial<StartRunFlowInput> = {}) {
  const input = {
    scopeId: 'chat-1',
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true, reason: 'allowed-user' },
    capability:
      h.profileConfig.agentKind === 'codex'
        ? codexCapability(h.profileConfig)
        : claudeCapability(h.profileConfig),
    profileConfig: h.profileConfig,
    sessions: h.sessions,
    sessionCatalog: h.catalog,
    workspaces: h.workspaces,
    executor: h.executor,
    now: 1000,
    ...overrides,
  } satisfies StartRunFlowInput & { sessionCatalog: SessionCatalog };
  return startRunFlow(input);
}
