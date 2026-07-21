import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret, listSecretIds } from '../../../src/config/keystore';
import {
  createDefaultProfileConfig,
  type GroupResponseMode,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import {
  getGroupResponseMode,
  getMessageReplyMode,
  getRequireMentionInGroup,
  secretKeyForApp,
} from '../../../src/config/schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: vi.fn(async () => ({
    ok: true,
    botName: 'Updated Bot',
    botOpenId: 'ou-bot',
  })),
}));

const identityPolicyMocks = vi.hoisted(() => ({
  applyLarkCliIdentityPolicy: vi.fn(async () => true),
}));

vi.mock('../../../src/lark-cli/identity-policy', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lark-cli/identity-policy')>(
    '../../../src/lark-cli/identity-policy',
  );
  return {
    ...actual,
    applyLarkCliIdentityPolicy: identityPolicyMocks.applyLarkCliIdentityPolicy,
  };
});

const roots: string[] = [];

beforeEach(() => {
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockReset();
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValue(true);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile-aware account and config commands', () => {
  it('saves /config submit into the active v2 profile without flattening root config', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.messageReply === 'text',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.activeProfile).toBe('claude');
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.preferences).toMatchObject({
      messageReply: 'text',
      messageReplyMigrated: true,
      showToolCalls: false,
      maxConcurrentRuns: 7,
      runIdleTimeoutMinutes: 15,
    });
    expect(root.profiles.claude?.access.requireMentionInGroup).toBe(false);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('user-default');
    expect(root.profiles.claude?.larkCli.localUserImport).toMatchObject({
      status: 'not-needed',
      reason: 'manual-user-default',
    });
    expect(getRequireMentionInGroup(runtimeProfileConfig(root, 'claude'))).toBe(false);
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it('saves owner-default as the canonical group response mode', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      group_response_mode: 'owner-default',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.access.groupResponseMode === 'owner-default',
    );
    expect(root.profiles.claude?.access.groupResponseMode).toBe('owner-default');
    expect(root.profiles.claude?.access.requireMentionInGroup).toBe(true);
    expect(getGroupResponseMode(runtimeProfileConfig(root, 'claude'))).toBe('owner-default');
  });

  it('persists the picked model and clears it when "default" is chosen', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      model: 'claude-opus-4-8',
      message_reply: 'text',
    });
    const withModel = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.model === 'claude-opus-4-8',
    );
    expect(withModel.profiles.claude?.preferences.model).toBe('claude-opus-4-8');

    await h.command('/config submit', {
      model: 'default',
      message_reply: 'text',
    });
    const cleared = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.model === undefined,
    );
    expect(cleared.profiles.claude?.preferences.model).toBeUndefined();
  });

  it('keeps the current message reply mode when the config submit payload omits it', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      preferences: {
        messageReply: 'text',
        messageReplyMigrated: true,
      },
    });

    await h.command('/config submit', {
      show_tool_calls: 'show',
      max_concurrent_runs: '8',
      run_idle_timeout_minutes: '20',
      require_mention_in_group: 'yes',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.maxConcurrentRuns === 8,
    );
    expect(root.profiles.claude?.preferences.messageReply).toBe('text');
    expect(root.profiles.claude?.preferences.messageReplyMigrated).toBe(true);
    expect(getMessageReplyMode(runtimeProfileConfig(root, 'claude'))).toBe('text');
  });

  it('does not save a lark-cli identity change when applying the runtime policy fails', async () => {
    vi.useFakeTimers();
    identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValueOnce(false);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('bot-only');
    expect(root.profiles.claude?.preferences.messageReply).not.toBe('text');
    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('lark-cli 身份策略');
    expect(card).not.toContain('偏好已保存');
  });

  it('rolls back lark-cli identity when saving config fails after applying the runtime policy', async () => {
    vi.useFakeTimers();
    const applied = deferred<boolean>();
    identityPolicyMocks.applyLarkCliIdentityPolicy
      .mockImplementationOnce(async () => applied.promise)
      .mockResolvedValue(true);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await writeFile(resolveAppPaths({ rootDir: h.rootDir }).configFile, '{invalid json', 'utf8');
    applied.resolve(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('已回滚');
    expect(card).not.toContain('未做任何修改');
    expect(card).not.toContain('偏好已保存');
  });

  // ────────────── /invite|/remove owner-default group ──────────────

  async function createGroupHarness(mode: string = 'owner-allowlist', opts: {
    senderId?: string;
    senderType?: 'user' | 'bot';
    mentionedBot?: boolean;
    botAdmins?: string[];
    admins?: string[];
  } = {}): Promise<{
    rootDir: string;
    channel: ReturnType<typeof createFakeChannel>;
    command(content: string): Promise<boolean>;
    readRoot(): Promise<RootConfig>;
    controls: Controls;
  }> {
    const rootDir = await mkdtemp(join(tmpdir(), 'bridge-owner-default-group-'));
    roots.push(rootDir);
    const workspace = join(rootDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const root: RootConfig = {
      schemaVersion: 2,
      activeProfile: 'claude',
      preferences: {},
      profiles: {
        claude: createDefaultProfileConfig({
          agentKind: 'claude',
          accounts: { app: { id: 'cli_old', secret: '${APP_SECRET}', tenant: 'feishu' } },
          access: {
            admins: opts.admins ?? ['ou-admin'],
            groupResponseMode: mode as GroupResponseMode,
            botAdmins: opts.botAdmins ?? [],
          },
        }),
      },
    };
    root.profiles.claude!.workspaces.default = workspace;
    await writeJson(resolveAppPaths({ rootDir }).configFile, root);
    await writeFile(join(rootDir, 'active-profile'), 'claude\n', 'utf8');

    const profileConfig = root.profiles.claude!;
    const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
    const channel = createFakeChannel();
    const sessions = new SessionStore(appPaths.sessionsFile);
    const workspaces = new WorkspaceStore(appPaths.workspacesFile);
    const controls: Controls = {
      profile: 'claude',
      profileConfig,
      botOwnerId: 'ou-admin',
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      restart: vi.fn(async () => {}),
      exit: vi.fn(async () => {}),
      configPath: appPaths.configFile,
      cfg: runtimeProfileConfig(root, 'claude'),
      processId: 'proc-1',
    };

    return {
      rootDir,
      channel,
      controls,
      readRoot: () => readRoot(rootDir),
      command: (content: string) =>
        tryHandleCommand({
          channel: channel as unknown as CommandContext['channel'],
          msg: {
            messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
            chatId: 'oc_test_group',
            chatType: opts.senderType === 'bot' ? 'group' : 'group',
            senderId: opts.senderId ?? 'ou-admin',
            senderName: 'Admin',
            content,
            resources: [],
            mentions: opts.mentionedBot
              ? [{ openId: 'ou-bot', name: '小C', isBot: true }]
              : [],
            mentionedBot: opts.mentionedBot ?? false,
          } as unknown as NormalizedMessage,
          scope: 'oc_test_group',
          chatMode: 'group',
          sessions,
          workspaces,
          agent: new FakeAgentAdapter(),
          activeRuns: new ActiveRuns(),
          controls,
        }),
    };
  }

  it('adds current group to ownerNoMentionChats with @bot', async () => {
    const h = await createGroupHarness('owner-allowlist', { mentionedBot: true });

    const handled = await h.command('/invite owner-default group');
    expect(handled).toBe(true);

    // Small delay to let async file writes complete
    await new Promise((r) => setTimeout(r, 200));

    const root = await h.readRoot();
    expect(root.profiles.claude?.access.ownerNoMentionChats).toContain('oc_test_group');
    // allowedChats unchanged
    expect(root.profiles.claude?.access.allowedChats).toEqual([]);
    // groupResponseMode unchanged
    expect(root.profiles.claude?.access.groupResponseMode).toBe('owner-allowlist');
    // Reply sent
    const lastContent = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(lastContent).toContain('owner');
  });

  it('removes current group from ownerNoMentionChats with @bot', async () => {
    const h = await createGroupHarness('owner-allowlist', { mentionedBot: true });

    // First add
    const added = await h.command('/invite owner-default group');
    expect(added).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    let root = await h.readRoot();
    expect(root.profiles.claude?.access.ownerNoMentionChats).toContain('oc_test_group');

    // Then remove
    const removed = await h.command('/remove owner-default group');
    expect(removed).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    root = await h.readRoot();
    expect(root.profiles.claude?.access.ownerNoMentionChats).not.toContain('oc_test_group');
  });

  it('rejects /invite owner-default group without @bot (mentionedBot guard)', async () => {
    const h = await createGroupHarness('owner-allowlist', { mentionedBot: false });

    const handled = await h.command('/invite owner-default group');
    expect(handled).toBe(true);

    const root = await h.readRoot();
    expect(root.profiles.claude?.access.ownerNoMentionChats).not.toContain('oc_test_group');

    // Should get a response about needing to @ the bot
    const lastContent = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(lastContent).toContain('@');
  });

  it('rejects /invite owner-default group in p2p before mentionedBot check', async () => {
    const h = await createGroupHarness('owner-allowlist', { mentionedBot: false });
    const called = await tryHandleCommand({
      channel: h.channel as unknown as CommandContext['channel'],
      msg: {
        messageId: 'om-p2p-invite',
        chatId: 'p2p-chat',
        chatType: 'p2p',
        senderId: 'ou-admin',
        senderName: 'Admin',
        content: '/invite owner-default group',
        resources: [],
        mentions: [],
        mentionedBot: false,
      } as unknown as NormalizedMessage,
      scope: 'p2p-chat',
      chatMode: 'p2p',
      sessions: new SessionStore(join(h.rootDir, 'profiles', 'claude', 'sessions.json')),
      workspaces: new WorkspaceStore(join(h.rootDir, 'profiles', 'claude', 'workspaces.json')),
      agent: new FakeAgentAdapter(),
      activeRuns: new ActiveRuns(),
      controls: h.controls,
    });
    expect(called).toBe(true);
    const lastContent = JSON.stringify(h.channel.sent.at(-1)?.content);
    // Must mention group, not just "please @ bot"
    expect(lastContent).toContain('群');
  });

  it('rejects /invite all owner-default group (precise grammar negative)', async () => {
    const h = await createGroupHarness('owner-allowlist', { mentionedBot: true });

    const handled = await h.command('/invite all owner-default group');
    expect(handled).toBe(true);

    const root = await h.readRoot();
    expect(root.profiles.claude?.access.ownerNoMentionChats).not.toContain('oc_test_group');
    expect(root.profiles.claude?.access.allowedChats).toEqual([]);
  });

  it('rejects /invite owner-default group extra (precise grammar negative)', async () => {
    const h = await createGroupHarness('owner-allowlist', { mentionedBot: true });

    const handled = await h.command('/invite owner-default group extra');
    expect(handled).toBe(true);

    const root = await h.readRoot();
    expect(root.profiles.claude?.access.ownerNoMentionChats).not.toContain('oc_test_group');
  });

  it('is idempotent for /invite owner-default group', async () => {
    const h = await createGroupHarness('owner-allowlist', { mentionedBot: true });

    await h.command('/invite owner-default group');
    await new Promise((r) => setTimeout(r, 100));

    // Second invite — should be idempotent
    await h.command('/invite owner-default group');
    await new Promise((r) => setTimeout(r, 100));

    const root = await h.readRoot();
    expect(root.profiles.claude?.access.ownerNoMentionChats?.filter((id: string) => id === 'oc_test_group').length).toBe(1);
  });

  it('allows botAdmin to execute /invite owner-default group', async () => {
    const h = await createGroupHarness('owner-allowlist', {
      mentionedBot: true,
      senderId: 'ou-bot-admin',
      botAdmins: ['ou-bot-admin'],
    });

    await h.command('/invite owner-default group');
    await new Promise((r) => setTimeout(r, 100));

    const root = await h.readRoot();
    expect(root.profiles.claude?.access.ownerNoMentionChats).toContain('oc_test_group');
  });

  it('rejects /invite owner-default group if sender lacks permission', async () => {
    const h = await createGroupHarness('owner-allowlist', {
      mentionedBot: true,
      senderId: 'ou-stranger',
      admins: ['ou-admin'],
    });

    const handled = await h.command('/invite owner-default group');
    expect(handled).toBe(true);

    const root = await h.readRoot();
    expect(root.profiles.claude?.access.ownerNoMentionChats).not.toContain('oc_test_group');
  });

  it('shows non-owner-allowlist mode hint when pre-maintaining list', async () => {
    const h = await createGroupHarness('mention-only', { mentionedBot: true });

    await h.command('/invite owner-default group');
    await new Promise((r) => setTimeout(r, 100));

    const root = await h.readRoot();
    expect(root.profiles.claude?.access.ownerNoMentionChats).toContain('oc_test_group');
    const lastContent = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(lastContent).toContain('切换');
  });

  it('mentions @bot requirement in usage help', async () => {
    const h = await createGroupHarness('owner-allowlist', { mentionedBot: true });

    await h.command('/invite');

    const lastContent = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(lastContent).toContain('owner-default');
  });

  it('saves /account submit into the active v2 profile and profile-local keystore', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/account submit', {
      app_id: 'cli_new',
      app_secret: 'new-secret',
      tenant: 'lark',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.accounts.app.id === 'cli_new',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.accounts.app).toMatchObject({
      id: 'cli_new',
      tenant: 'lark',
      secret: {
        source: 'exec',
        provider: 'bridge',
        id: secretKeyForApp('cli_new'),
      },
    });
    expect(root.secrets?.providers?.bridge?.command).toContain('secrets-getter');
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
    await expect(
      getSecret(secretKeyForApp('cli_new'), resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' })),
    ).resolves.toBe('new-secret');
    const claudePaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' });
    const codexPaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'codex-dev' });
    expect(claudePaths.secretsFile).not.toBe(codexPaths.secretsFile);
    await expect(
      listSecretIds(codexPaths),
    ).resolves.not.toContain(secretKeyForApp('cli_new'));
  });
});

async function createHarness(options: {
  preferences?: RootConfig['profiles'][string]['preferences'];
} = {}): Promise<{
  rootDir: string;
  channel: ReturnType<typeof createFakeChannel>;
  command(content: string, formValue?: Record<string, unknown>): Promise<boolean>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-profile-config-command-'));
  roots.push(rootDir);
  const workspace = join(rootDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const root = await writeRoot(rootDir, workspace, options.preferences);
  const profileConfig = root.profiles.claude!;
  const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
  const channel = createFakeChannel();
  const sessions = new SessionStore(appPaths.sessionsFile);
  const workspaces = new WorkspaceStore(appPaths.workspacesFile);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-admin',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: appPaths.configFile,
    cfg: runtimeProfileConfig(root, 'claude'),
    processId: 'proc-1',
  } satisfies Controls;

  return {
    rootDir,
    channel,
    command: (content: string, formValue?: Record<string, unknown>) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent: new FakeAgentAdapter(),
        activeRuns: new ActiveRuns(),
        controls,
        formValue,
        fromCardAction: true,
      }),
  };
}

async function writeRoot(
  rootDir: string,
  workspace: string,
  preferences: RootConfig['profiles'][string]['preferences'] = {},
): Promise<RootConfig> {
  const root: RootConfig = {
    schemaVersion: 2,
    activeProfile: 'claude',
    preferences: {},
    profiles: {
      claude: createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: {
          app: { id: 'cli_old', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        access: { admins: ['ou-admin'] },
      }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: {
          app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        codex: { binaryPath: 'codex' },
      }),
    },
  };
  root.profiles.claude!.workspaces.default = workspace;
  root.profiles.claude!.preferences = {
    ...root.profiles.claude!.preferences,
    ...preferences,
  };
  await writeJson(resolveAppPaths({ rootDir }).configFile, root);
  await writeFile(join(rootDir, 'active-profile'), 'claude\n', 'utf8');
  return root;
}

async function readRoot(rootDir: string): Promise<RootConfig> {
  return JSON.parse(await readFile(resolveAppPaths({ rootDir }).configFile, 'utf8')) as RootConfig;
}

async function waitForRoot(
  rootDir: string,
  predicate: (root: RootConfig) => boolean,
): Promise<RootConfig> {
  let lastRoot = await readRoot(rootDir);
  await vi.waitFor(async () => {
    lastRoot = await readRoot(rootDir);
    expect(predicate(lastRoot)).toBe(true);
  }, { timeout: 5000 });
  return lastRoot;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function appliedLarkCliIdentities(): unknown[] {
  return (
    identityPolicyMocks.applyLarkCliIdentityPolicy.mock.calls as unknown as Array<[unknown, unknown]>
  ).map((call) => call[1]);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
