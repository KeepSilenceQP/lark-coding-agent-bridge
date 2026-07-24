import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCapability } from '../../../src/agent/capability';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { startRunFlow } from '../../../src/bot/run-flow';
import { ProcessPool } from '../../../src/bot/process-pool';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionCatalog } from '../../../src/session/catalog';
import { PromptSessionService } from '../../../src/session/prompt-session-service';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('IM run flow', () => {
  it('rejects missing cwd without falling back to the user home', async () => {
    const h = await createHarness();

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'empty-requested-cwd',
      },
    });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('submits cwd through RunExecutor and resumes matching sessions', async () => {
    const h = await createHarness();
    const workspaceRealpath = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', h.tmp.workspace);
    h.sessions.set('chat-1', 'sess-1', workspaceRealpath);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(result.resumeFrom).toBe('sess-1');
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      cwd: workspaceRealpath,
      sessionId: 'sess-1',
    });
  });

  it('uses the profile default workspace when a scope has no explicit binding', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const workspaceRealpath = await realpath(h.tmp.workspace);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(h.agent.runOptions[0]?.cwd).toBe(workspaceRealpath);
  });

  it('keeps a trusted group system addendum separate from the user prompt', async () => {
    const h = await createHarness({ defaultWorkspace: true });

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'dynamic turn',
      systemPromptAddendum: 'group contract',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      prompt: 'dynamic turn',
      systemPromptAddendum: 'group contract',
    });
  });

  it('resolves and admits a fresh group binding after policy identity is known', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    await mkdir(join(h.tmp.profile, 'prompts', 'groups'), { recursive: true });
    await writeFile(join(h.tmp.profile, 'prompts', 'groups', 'chat-1.md'), 'group contract');
    const service = await PromptSessionService.open({
      profileDir: h.tmp.profile,
      profile: 'test',
      sessionCatalog: h.sessionCatalog,
      sessionStore: h.sessions,
    });

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'dynamic turn',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      sessionCatalog: h.sessionCatalog,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
      promptSession: {
        service,
        origin: {
          source: 'im',
          scopeId: 'chat-1',
          chatId: 'chat-1',
          chatType: 'group',
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.promptSession?.decision).toMatchObject({
      kind: 'fresh',
      binding: { kind: 'pinned' },
    });
    expect(h.agent.runOptions[0]).toMatchObject({
      prompt: 'dynamic turn',
      systemPromptAddendum: 'group contract',
    });
  });

  it('reuses the in-memory binding for a startup retry after the live file changes', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const groupsDir = join(h.tmp.profile, 'prompts', 'groups');
    const liveFile = join(groupsDir, 'chat-1.md');
    await mkdir(groupsDir, { recursive: true });
    await writeFile(liveFile, 'version one');
    const service = await PromptSessionService.open({
      profileDir: h.tmp.profile,
      profile: 'test',
      sessionCatalog: h.sessionCatalog,
      sessionStore: h.sessions,
    });
    const base = {
      scopeId: 'chat-1',
      scope: { source: 'im' as const, chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'dynamic turn',
      attachments: [],
      access: { ok: true as const, reason: 'allowed-user' as const },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      sessionCatalog: h.sessionCatalog,
      workspaces: h.workspaces,
      now: 1000,
    };
    const origin = {
      source: 'im' as const,
      scopeId: 'chat-1',
      chatId: 'chat-1',
      chatType: 'group' as const,
    };
    const first = await startRunFlow({
      ...base,
      executor: h.executor,
      promptSession: { service, origin },
    });
    if (!first.ok || !first.promptSession) throw new Error('expected prompt session');
    await writeFile(liveFile, 'version two');
    const retryExecutor = new RunExecutor({
      agent: h.agent,
      pool: new ProcessPool(() => 2),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-retry',
      now: () => 1001,
    });

    const retry = await startRunFlow({
      ...base,
      executor: retryExecutor,
      now: 1001,
      promptSession: {
        service,
        origin,
        reuseDecision: first.promptSession.decision,
      },
    });

    expect(retry.ok).toBe(true);
    expect(h.agent.runOptions.at(-1)).toMatchObject({
      systemPromptAddendum: 'version one',
    });
  });

  it('reserves the scope before prompt preparation so /new can cancel the pending run', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const service = await PromptSessionService.open({
      profileDir: h.tmp.profile,
      profile: 'test',
      sessionCatalog: h.sessionCatalog,
      sessionStore: h.sessions,
    });
    let releasePreparation!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      vi.spyOn(service, 'prepareSession').mockImplementation(async (input) => {
        resolve();
        await new Promise<void>((release) => {
          releasePreparation = release;
        });
        if (input.signal?.aborted) {
          const error = new Error('prompt session preparation interrupted');
          error.name = 'AbortError';
          throw error;
        }
        return { kind: 'dormant' };
      });
    });

    const pending = startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'dynamic turn',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      sessionCatalog: h.sessionCatalog,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
      promptSession: {
        service,
        origin: {
          source: 'im',
          scopeId: 'chat-1',
          chatId: 'chat-1',
          chatType: 'group',
        },
      },
    });

    await preparationStarted;
    expect(h.activeRuns.interrupt('chat-1')).toBe(true);
    releasePreparation();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      rejectReason: { code: 'run-interrupted' },
    });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('reuses a queue-handoff reservation so stop during pre-prompt work prevents Agent start', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const service = await PromptSessionService.open({
      profileDir: h.tmp.profile,
      profile: 'test',
      sessionCatalog: h.sessionCatalog,
      sessionStore: h.sessions,
    });
    const handoffReservation = h.executor.reserveScope('chat-1');
    expect(handoffReservation).toBeDefined();

    let releasePreparation!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      vi.spyOn(service, 'prepareSession').mockImplementation(async (input) => {
        resolve();
        await new Promise<void>((release) => {
          releasePreparation = release;
        });
        if (input.signal?.aborted) {
          const error = new Error('prompt session preparation interrupted');
          error.name = 'AbortError';
          throw error;
        }
        return { kind: 'dormant' };
      });
    });

    const pending = startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'dynamic turn',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      sessionCatalog: h.sessionCatalog,
      workspaces: h.workspaces,
      executor: h.executor,
      reservation: handoffReservation,
      now: 1000,
      promptSession: {
        service,
        origin: {
          source: 'im',
          scopeId: 'chat-1',
          chatId: 'chat-1',
          chatType: 'group',
        },
      },
    });

    await preparationStarted;
    expect(h.activeRuns.interrupt('chat-1')).toBe(true);
    releasePreparation();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      rejectReason: { code: 'run-interrupted' },
    });
    expect(h.agent.runOptions).toEqual([]);
  });

});

async function createHarness(options: { defaultWorkspace?: boolean } = {}): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  activeRuns: ActiveRuns;
  sessions: SessionStore;
  sessionCatalog: SessionCatalog;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('bridge-im-run-flow-');
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns,
    createRunId: () => 'run-1',
    now: () => 1000,
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
  });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const sessionCatalog = new SessionCatalog(join(tmp.profile, 'sessions.json.catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), sessionCatalog.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor,
    activeRuns,
    sessions,
    sessionCatalog,
    workspaces,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        ...(options.defaultWorkspace ? { default: tmp.workspace } : {}),
      },
    },
  };
}
