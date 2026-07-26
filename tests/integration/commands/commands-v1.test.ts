import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import {
  tryHandleCommand,
  type CommandContext,
  type Controls,
} from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { resolveAppPaths } from '../../../src/config/app-paths.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { ProjectStore } from '../../../src/project/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface RunOverrides {
  scope?: string;
  senderId?: string;
  chatId?: string;
  chatMode?: CommandContext['chatMode'];
  mentions?: NormalizedMessage['mentions'];
  rawContent?: string;
}

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: ReturnType<typeof createFakeAgent>;
  controls: Controls;
  run(content: string, overrides?: RunOverrides): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('Bridge command contracts', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('switches /cd to any existing non-risk working directory', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'plain-workdir');
    const file = join(h.tmp.workspace, 'not-a-directory.txt');
    await mkdir(target, { recursive: true });
    await writeFile(file, 'not a directory', 'utf8');

    await expect(h.run('/cd relative')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('绝对路径');

    await expect(h.run(`/cd ${file}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('路径不是目录');

    await expect(h.run(`/cd ${target}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换 cwd');
    expect(lastMarkdown(h.channel)).not.toContain('允许访问目录');
    await expect(realpath(target)).resolves.toBe(h.workspaces.cwdFor('chat-1'));

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换 cwd');
    await expect(realpath(h.tmp.workspace)).resolves.toBe(h.workspaces.cwdFor('chat-1'));
  });

  it('scopes named workspaces by profile, scope, and owner', async () => {
    const h = await createHarness();
    const alternate = join(h.tmp.root, 'alternate');
    await mkdir(alternate, { recursive: true });

    h.workspaces.setCwd('chat-a', h.tmp.workspace);
    await expect(h.run('/ws save main', { scope: 'chat-a', chatId: 'chat-a' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('工作目录别名已保存');

    h.workspaces.setCwd('chat-b', alternate);
    await expect(h.run('/ws', { scope: 'chat-b', chatId: 'chat-b' })).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('main');

    await expect(h.run('/ws use main', { scope: 'chat-b', chatId: 'chat-b' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('未找到工作目录别名');
    expect(h.workspaces.cwdFor('chat-b')).toBe(alternate);
  });

  it('continues to support legacy unscoped workspace aliases', async () => {
    const h = await createHarness();
    const legacy = join(h.tmp.root, 'legacy-alias');
    await mkdir(legacy, { recursive: true });
    h.workspaces.saveNamed('legacy', legacy);

    await expect(h.run('/ws')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('legacy');

    await expect(h.run('/ws use legacy')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换到 `legacy`');
    await expect(realpath(legacy)).resolves.toBe(h.workspaces.cwdFor('chat-1'));

    await expect(h.run('/ws remove legacy')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
    expect(h.workspaces.getNamed('legacy')).toBeUndefined();
  });

  it('removes scoped workspace aliases without deleting same-name legacy aliases', async () => {
    const h = await createHarness();
    const legacy = join(h.tmp.root, 'legacy-main');
    await mkdir(legacy, { recursive: true });
    h.workspaces.saveNamed('main', legacy);

    await expect(h.run('/ws save main')).resolves.toBe(true);
    await expect(h.run('/ws remove main')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
    expect(h.workspaces.getNamed('main')).toBe(legacy);

    await expect(h.run('/ws use main')).resolves.toBe(true);
    await expect(realpath(legacy)).resolves.toBe(h.workspaces.cwdFor('chat-1'));
  });

  it('keeps directory commands admin-only', async () => {
    const h = await createHarness();

    await expect(h.run(`/cd ${h.tmp.workspace}`, { senderId: 'ou-not-admin' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');

    await expect(h.run('/ws save mine', { senderId: 'ou-not-admin' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('does not expose authorization root management commands', async () => {
    const h = await createHarness();
    const plain = join(h.tmp.root, 'plain-nongit');
    await mkdir(plain, { recursive: true });

    await expect(h.run(`/ws add ${plain} docs`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('用法');
    expect(lastMarkdown(h.channel)).not.toContain('允许访问目录');

    await expect(h.run(`/ws remove --root ${plain}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('未找到工作目录别名');
  });

  it('keeps /ws remove as alias removal by default', async () => {
    const h = await createHarness();

    await expect(h.run('/ws save main')).resolves.toBe(true);
    await expect(h.run('/ws remove main')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
  });

  it('shows workspace paths in group-visible workspace replies', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-client-name');
    await mkdir(target, { recursive: true });
    const targetRealpath = await realpath(target);

    await expect(h.run(`/cd ${target}`, { chatMode: 'group' })).resolves.toBe(true);
    await expect(h.run('/ws save client', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('client');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws save main', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('工作目录别名已保存');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws', { chatMode: 'group' })).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain(jsonStringFragment(targetRealpath));
    expect(card).not.toContain('使用 $HOME');

    await expect(h.run('/ws use main', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换到 `main`');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);
  });

  it('shows full workspace paths in p2p workspace replies', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-p2p-client');
    await mkdir(target, { recursive: true });
    const targetRealpath = await realpath(target);

    await expect(h.run(`/cd ${target}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws save client')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws')).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain(jsonStringFragment(targetRealpath));
  });

  it('shows invalid /cd paths in group-visible replies', async () => {
    const h = await createHarness();
    const file = join(h.tmp.root, 'sensitive-client-name', 'not-a-directory.txt');
    await mkdir(join(h.tmp.root, 'sensitive-client-name'), { recursive: true });
    await writeFile(file, 'not a directory', 'utf8');

    await expect(h.run(`/cd ${file}`, { chatMode: 'group' })).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('路径不是目录');
    expect(lastMarkdown(h.channel)).toContain(await realpath(file));
  });

  it('treats legacy document workspace commands as informational no-ops', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-doc-root');
    await mkdir(target, { recursive: true });

    await expect(h.run(`/doc ws bind doc-token ${target}`, { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不需要绑定工作区');
    expect(lastMarkdown(h.channel)).not.toContain(target);
  });

  it('keeps Claude resume history details out of group chats', async () => {
    const h = await createHarness();

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('私聊');
    expect(lastMarkdown(h.channel)).not.toContain(h.tmp.workspace);
  });

  it('renders /status passively with policy and owner state', async () => {
    const h = await createHarness();

    await expect(h.run('/status')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(0);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('Fake Agent');
    expect(status).toContain('工作目录');
    expect(status).toContain('**session**');
    expect(status).toContain('(无)');
    expect(status).not.toContain('**conversation**');
    expect(status).toContain('permission');
    expect(status).toContain('plan');
    expect(status).not.toContain('bypassPermissions');
    expect(status).not.toContain('workspace-write/workspace-write');
    expect(status).toContain('owner');
    expect(status).toContain(jsonStringFragment(await realpath(h.tmp.workspace)));
  });

  it('shows workspace paths in group-visible /status replies', async () => {
    const h = await createHarness();

    await expect(h.run('/status', { chatMode: 'group' })).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain(jsonStringFragment(await realpath(h.tmp.workspace)));
    expect(status).toContain('chat-1');
  });

  it('rejects admin-only commands for non owner/admin users', async () => {
    const h = await createHarness();

    await expect(
      h.run('/ps', { senderId: 'ou-not-admin' }),
    ).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('does not expose access allowlists through the Lark /config form', async () => {
    const h = await createHarness();

    await expect(h.run('/config')).resolves.toBe(true);

    const configCard = JSON.stringify(lastContent(h.channel));
    expect(configCard).not.toContain('allowed_users');
    expect(configCard).not.toContain('allowed_chats');
    expect(configCard).not.toContain('admins');
  });

  it('manages profile access lists through /invite and /remove', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite user @Alice', { mentions: [mention('ou-alice', 'Alice')] }),
    ).resolves.toBe(true);
    await expect(
      h.run('/invite admin @Bob', { mentions: [mention('ou-bob', 'Bob')] }),
    ).resolves.toBe(true);
    await expect(
      h.run('/invite group', {
        chatId: 'oc-group-1',
        scope: 'oc-group-1',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    let root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedUsers).toContain('ou-alice');
    expect(root?.profiles.claude?.access.admins).toEqual(['ou-admin', 'ou-bob']);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-group-1');
    expect(root?.profiles.claude?.preferences).not.toHaveProperty('access');

    await expect(
      h.run('/remove user @Alice', { mentions: [mention('ou-alice', 'Alice')] }),
    ).resolves.toBe(true);
    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedUsers).not.toContain('ou-alice');
  });

  it('adds every known bot group through /invite all group', async () => {
    const h = await createHarness();
    h.controls.knownChats = [
      { id: 'oc-group-1', name: 'Group One' },
      { id: 'oc-group-2', name: 'Group Two' },
    ];

    await expect(h.run('/invite all group')).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toEqual(['oc-group-1', 'oc-group-2']);
  });

  // ── /botAdmin command tests ──

  it('adds and removes bot admins through /botAdmin add/remove', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFallback(h);

    // Add bot admin
    await expect(
      h.run('/botAdmin add CoordinatorBot', { chatMode: 'group' }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已把 CoordinatorBot 加入 Bot 管理员');

    let root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toContain('ou-self');

    // Add same bot again (idempotent)
    await expect(
      h.run('/botAdmin add CoordinatorBot', { chatMode: 'group' }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已经在 Bot 管理员里');

    // List
    await expect(h.run('/botAdmin list')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('<at user_id="ou-self">ou-self</at>');

    // Remove
    await expect(
      h.run('/botAdmin remove CoordinatorBot', { chatMode: 'group' }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('移出 Bot 管理员');

    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).not.toContain('ou-self');
  });

  it('shows empty list for /botAdmin list when no bot admins', async () => {
    const h = await createHarness();
    await expect(h.run('/botAdmin list')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('无 Bot 管理员');
  });

  it('requires target name for /botAdmin add and /botAdmin remove', async () => {
    const h = await createHarness();
    await expect(h.run('/botAdmin add')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没检测到 add 后面的 Bot 名称');

    await expect(h.run('/botAdmin remove')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没检测到 remove 后面的 Bot 名称');
  });

  it('rejects names that are not current group bots as /botAdmin targets', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFallback(h);

    await expect(
      h.run('/botAdmin add Human', { chatMode: 'group' }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).not.toContain('ou-human');
    expect(lastMarkdown(h.channel)).toContain('没检测到 add 后面的 Bot 名称');
  });

  it('reports bot list discovery failure for named /botAdmin targets', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFailure(h);

    await expect(
      h.run('/botAdmin add CoordinatorBot', { chatMode: 'group' }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).not.toContain('ou-self');
    expect(lastMarkdown(h.channel)).toContain('无法读取当前群内 Bot 列表');
    expect(lastMarkdown(h.channel)).toContain('CoordinatorBot');
  });

  it('rejects @-prefixed names as /botAdmin targets', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFallback(h);
    h.controls.profileConfig.access.botAdmins = ['ou-self'];
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);

    await expect(
      h.run('/botAdmin remove @CoordinatorBot', {
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toEqual(['ou-self']);
    expect(lastMarkdown(h.channel)).toContain('没检测到 remove 后面的 Bot 名称');
  });

  it('maps group /botAdmin targets to receiver-view bot ids through live bot discovery', async () => {
    const h = await createHarness();
    const logFile = join(h.tmp.root, 'lark-cli.log');
    await installFakeLarkCliDiscoveryFallback(h, logFile);
    h.controls.profileConfig.access.botAdmins = ['ou-self'];
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);

    await expect(
      h.run('/botAdmin remove CoordinatorBot', {
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toEqual([]);
    expect(await readFile(logFile, 'utf8')).toContain(
      'chat.members bots --params {"chat_id":"chat-1"} --as bot',
    );
    expect(lastMarkdown(h.channel)).toContain('已把 CoordinatorBot 移出 Bot 管理员');
  });

  it('uses only names after /botAdmin add as bot admin targets', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFallback(h);

    await expect(
      h.run('/botAdmin add CoordinatorBot', { chatMode: 'group' }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toEqual(['ou-self']);
    expect(lastMarkdown(h.channel)).toContain('已把 CoordinatorBot 加入 Bot 管理员');
    expect(lastMarkdown(h.channel)).not.toContain('ImplementerBot');
  });

  it('uses only names after /botAdmin remove as bot admin targets', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFallback(h);
    h.controls.profileConfig.access.botAdmins = ['ou_implementer', 'ou-self'];
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);

    await expect(
      h.run('/botAdmin remove CoordinatorBot', { chatMode: 'group' }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toEqual(['ou_implementer']);
    expect(lastMarkdown(h.channel)).toContain('已把 CoordinatorBot 移出 Bot 管理员');
    expect(lastMarkdown(h.channel)).not.toContain('ImplementerBot');
  });

  it('strips only leading wake mentions when raw command text contains parameter mentions', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFallback(h);
    h.controls.profileConfig.access.botAdmins = ['ou-self'];
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);

    await expect(
      h.run('/botAdmin remove', {
        mentions: [
          { ...botMention('ou-xiaoc', 'ImplementerBot'), key: '@_user_1' },
        ],
        rawContent: JSON.stringify({ text: '@ImplementerBot /botAdmin remove CoordinatorBot' }),
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toEqual([]);
    expect(lastMarkdown(h.channel)).toContain('已把 CoordinatorBot 移出 Bot 管理员');
  });

  // ── botAdmin permission split tests ──

  it('allows botAdmin to run operational commands', async () => {
    const h = await createHarness();
    // Make the sender a botAdmin
    const access = h.controls.profileConfig.access;
    access.botAdmins = ['ou-bot'];
    await saveRootConfig(
      createRootConfig('claude', h.controls.profileConfig),
      h.controls.configPath,
    );

    const botRun = (content: string, overrides?: RunOverrides) =>
      h.run(content, { senderId: 'ou-bot', ...overrides });

    // Allowed: operational commands
    await expect(botRun('/cd /tmp')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).not.toContain('仅管理员可用');

    await expect(botRun('/invite group', { chatId: 'oc-g', scope: 'oc-g', chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已把当前群');

    await expect(botRun('/status')).resolves.toBe(true);
    await expect(botRun('/help')).resolves.toBe(true);
  });

  it('rejects botAdmin from role-elevation commands', async () => {
    const h = await createHarness();
    const access = h.controls.profileConfig.access;
    access.botAdmins = ['ou-bot'];
    await saveRootConfig(
      createRootConfig('claude', h.controls.profileConfig),
      h.controls.configPath,
    );

    const botRun = (content: string, overrides?: RunOverrides) =>
      h.run(content, { senderId: 'ou-bot', ...overrides });

    // Denied: /invite admin (role elevation — handler-level gate)
    await expect(
      botRun('/invite admin @User', { mentions: [mention('ou-user', 'User')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('Bot 管理员只能使用');

    // Denied: /botAdmin add (managing botAdmins)
    await expect(
      botRun('/botAdmin add Bot2'),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');

    // Denied: /config (sensitive)
    await expect(botRun('/config')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');

    // Denied: /account (credential)
    await expect(botRun('/account')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('allows regular allowed users to run public self-service commands', async () => {
    const h = await createHarness();
    const userRun = (content: string, overrides?: RunOverrides) =>
      h.run(content, { senderId: 'ou-user', ...overrides });

    await expect(userRun('/help')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('仅管理员可用');

    await expect(userRun('/status')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('仅管理员可用');

    await expect(userRun('/new')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已开始新会话');

    h.activeRuns.register('chat-1', h.agent.run({ runId: 'run-1', prompt: 'running' }));
    await expect(userRun('/stop')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('仅管理员可用');

    await expect(userRun('/config')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  // ── Anti-lockout tests ──

  it('prevents removing the last human admin', async () => {
    const h = await createHarness();
    // Only one admin exists: 'ou-admin' (set by appConfig)
    await expect(
      h.run('/remove admin @Admin', { mentions: [mention('ou-admin', 'Admin')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不能移除最后一位管理员');

    // Verify admin was NOT removed
    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.admins).toContain('ou-admin');
  });

  it('allows removing an admin when another admin remains', async () => {
    const h = await createHarness();
    // Add a second admin first
    await expect(
      h.run('/invite admin @Bob', { mentions: [mention('ou-bob', 'Bob')] }),
    ).resolves.toBe(true);

    // Now remove the original admin
    await expect(
      h.run('/remove admin @Admin', { mentions: [mention('ou-admin', 'Admin')] }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('移出管理员');

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.admins).not.toContain('ou-admin');
    expect(root?.profiles.claude?.access.admins).toContain('ou-bob');
  });

  // ── Text-forgery rejection test ──

  it('does not accept text @ as structured mention for access gating', async () => {
    const h = await createHarness();
    // Send /invite user with text "@user" but NO structured mention
    // The handler should reject because mentionTargets() uses msg.mentions only
    await expect(
      h.run('/invite user @Someone'),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没检测到 @ 的用户');
  });

  // ── /project bootstrap tests ──

  it('removes legacy /project start', async () => {
    const h = await createHarness();
    await expect(h.run('/project start /tmp/old')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('/project bootstrap <workspace>');
  });

  it('dispatches /project bootstrap bridge commands as invite-before-cd slash commands', async () => {
    const h = await createHarness();
    const workspacePath = join(h.tmp.root, 'repo-one');
    await mkdir(workspacePath, { recursive: true });
    configureSingleBridgeBotBootstrap(h, 'ImplementerBot', 'ou_implementer');

    await expect(
      h.run(`/project bootstrap ${workspacePath} --implementer @ImplementerBot --plan-writer @PlannerBot`, {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(textMessages).toHaveLength(4);
    expect(textMessages.join('\n')).not.toContain('Project Bootstrap Task');
    expect(textMessages.join('\n')).not.toContain('task_id: project-bootstrap');
    expect(textMessages.join('\n')).not.toContain('Expected receipt format');
    expect(textMessages).toContain(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`);
    expect(textMessages).toContain('<at user_id="ou_planner">PlannerBot</at> /invite group');
    expect(textMessages).toContain(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`);
    expect(textMessages).toContain('<at user_id="ou_implementer">ImplementerBot</at> /invite group');
    expect(textMessages.indexOf('<at user_id="ou_planner">PlannerBot</at> /invite group'))
      .toBeLessThan(textMessages.indexOf(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`));
    expect(textMessages.indexOf('<at user_id="ou_implementer">ImplementerBot</at> /invite group'))
      .toBeLessThan(textMessages.indexOf(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`));
  });

  it('persists coordinator, implementer, and plan-writer role bindings from project bootstrap', async () => {
    const h = await createHarness();
    const workspacePath = join(h.tmp.root, 'repo-roles');
    await mkdir(workspacePath, { recursive: true });
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou-implementer' },
      { name: 'AlternateBot', openId: 'ou-plan-writer' },
    ]);

    await expect(
      h.run(`/project bootstrap ${workspacePath} --implementer ImplementerBot --plan-writer AlternateBot`, {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const store = new ProjectStore(resolveAppPaths({
      rootDir: h.tmp.root,
      profile: h.controls.profile,
    }).projectsFile);
    await store.load();
    expect(store.get('oc-project')).toEqual({
      workspace: workspacePath,
      decisionOwner: { openId: 'ou-admin', name: 'User' },
      coordinator: { botId: 'ou-self', name: 'CoordinatorBot' },
      planWriter: { botId: 'ou-plan-writer', name: 'AlternateBot' },
      implementer: { botId: 'ou-implementer', name: 'ImplementerBot' },
    });

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');
    expect(textMessages).toContain(`<at user_id="ou-plan-writer">AlternateBot</at> /cd ${workspacePath}`);
    expect(textMessages.join('\n')).not.toContain('PlannerBot');
  });

  it('explicitly rejects the legacy three-positional project bootstrap form', async () => {
    const h = await createHarness();

    await expect(
      h.run('/project bootstrap repo-legacy ImplementerBot PlannerBot', {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('旧语法已废弃，请使用具名参数');
    expect(lastMarkdown(h.channel)).toContain('--plan-writer');
    expect(lastMarkdown(h.channel)).toContain('未执行任何准备副作用');
  });

  it('serializes different bootstrap requests for the same chat', async () => {
    const h = await createHarness();
    const firstWorkspace = join(h.tmp.root, 'repo-first');
    const secondWorkspace = join(h.tmp.root, 'repo-second');
    await Promise.all([
      mkdir(firstWorkspace, { recursive: true }),
      mkdir(secondWorkspace, { recursive: true }),
    ]);
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou-implementer-a' },
      { name: 'AlternateBot', openId: 'ou-implementer-b' },
      { name: 'PlannerBot', openId: 'ou-plan-writer' },
    ]);

    await Promise.all([
      h.run(`/project bootstrap ${firstWorkspace} --implementer ImplementerBot --plan-writer PlannerBot`, {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
      h.run(`/project bootstrap ${secondWorkspace} --implementer AlternateBot --plan-writer PlannerBot`, {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ]);

    const store = new ProjectStore(resolveAppPaths({
      rootDir: h.tmp.root,
      profile: h.controls.profile,
    }).projectsFile);
    await store.load();
    expect(store.get('oc-project')?.workspace).toBe(secondWorkspace);

    const commands = h.channel.sent
      .map((message) => (message.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');
    const firstLast = commands.map((text) => text.includes(firstWorkspace)).lastIndexOf(true);
    const secondFirst = commands.findIndex((text) => text.includes(secondWorkspace));
    expect(firstLast).toBeGreaterThanOrEqual(0);
    expect(secondFirst).toBeGreaterThan(firstLast);
  });

  it('keeps the old binding usable when a rebind fails before any preparation side effect', async () => {
    const h = await createHarness();
    const stableWorkspace = join(h.tmp.root, 'repo-stable');
    const missingWorkspace = join(h.tmp.root, 'repo-missing');
    await mkdir(stableWorkspace, { recursive: true });
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou-implementer' },
      { name: 'AlternateBot', openId: 'ou-plan-writer' },
    ]);
    const runOptions = {
      chatId: 'oc-project',
      scope: 'oc-project',
      chatMode: 'group' as const,
    };

    await h.run(
      `/project bootstrap ${stableWorkspace} --implementer ImplementerBot --plan-writer AlternateBot`,
      runOptions,
    );
    await h.run(
      `/project bootstrap ${missingWorkspace} --implementer AlternateBot --plan-writer ImplementerBot`,
      runOptions,
    );

    const store = new ProjectStore(resolveAppPaths({
      rootDir: h.tmp.root,
      profile: h.controls.profile,
    }).projectsFile);
    await store.load();
    expect(store.get('oc-project')?.workspace).toBe(stableWorkspace);
    expect(store.getState('oc-project').usable).toBe(true);
    expect(lastMarkdown(h.channel)).toContain('旧绑定记录未改变且仍可安全使用');
    expect(lastMarkdown(h.channel)).toContain('Coordinator workspace 无法准备');
  });

  it('disables the old binding and reports partial side effects when target dispatch fails', async () => {
    const h = await createHarness();
    const stableWorkspace = join(h.tmp.root, 'repo-stable');
    const rebindWorkspace = join(h.tmp.root, 'repo-rebind');
    await Promise.all([
      mkdir(stableWorkspace, { recursive: true }),
      mkdir(rebindWorkspace, { recursive: true }),
    ]);
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou-implementer' },
      { name: 'AlternateBot', openId: 'ou-plan-writer' },
    ]);
    const runOptions = {
      chatId: 'oc-project',
      scope: 'oc-project',
      chatMode: 'group' as const,
    };
    await h.run(
      `/project bootstrap ${stableWorkspace} --implementer ImplementerBot --plan-writer AlternateBot`,
      runOptions,
    );

    const originalSend = h.channel.send.bind(h.channel);
    h.channel.send = async (chatId, content, options) => {
      const text = (content as { text?: string }).text ?? '';
      if (text.includes(`/cd ${rebindWorkspace}`)) {
        throw new Error('forced dispatch failure');
      }
      return originalSend(chatId, content, options);
    };
    await h.run(
      `/project bootstrap ${rebindWorkspace} --implementer AlternateBot --plan-writer ImplementerBot`,
      runOptions,
    );

    const store = new ProjectStore(resolveAppPaths({
      rootDir: h.tmp.root,
      profile: h.controls.profile,
    }).projectsFile);
    await store.load();
    expect(store.get('oc-project')).toBeUndefined();
    expect(store.getState('oc-project')).toMatchObject({
      assignment: { workspace: stableWorkspace },
      usable: false,
      disabledReason: 'bootstrap_incomplete',
    });
    expect(lastMarkdown(h.channel)).toContain('旧绑定记录未被新绑定覆盖，但已禁用');
    expect(lastMarkdown(h.channel)).toContain('当前不可用于 Agent 注入');
    expect(lastMarkdown(h.channel)).toContain('已发生部分准备副作用');
    expect(lastMarkdown(h.channel)).not.toContain('bootstrap 完成');
  });

  it('keeps the old record disabled when new-binding persistence fails after preparation', async () => {
    const h = await createHarness();
    const stableWorkspace = join(h.tmp.root, 'repo-stable');
    const rebindWorkspace = join(h.tmp.root, 'repo-persist-fail');
    await Promise.all([
      mkdir(stableWorkspace, { recursive: true }),
      mkdir(rebindWorkspace, { recursive: true }),
    ]);
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou-implementer' },
      { name: 'AlternateBot', openId: 'ou-plan-writer' },
    ]);
    const runOptions = {
      chatId: 'oc-project',
      scope: 'oc-project',
      chatMode: 'group' as const,
    };
    await h.run(
      `/project bootstrap ${stableWorkspace} --implementer ImplementerBot --plan-writer AlternateBot`,
      runOptions,
    );

    const projectProfileDir = join(h.tmp.root, 'profiles', h.controls.profile);
    const originalSend = h.channel.send.bind(h.channel);
    let persistenceBlocked = false;
    h.channel.send = async (chatId, content, options) => {
      const text = (content as { text?: string }).text ?? '';
      const result = await originalSend(chatId, content, options);
      if (!persistenceBlocked && text.includes(`/cd ${rebindWorkspace}`)) {
        persistenceBlocked = true;
        await chmod(projectProfileDir, 0o500);
      }
      return result;
    };
    try {
      await h.run(
        `/project bootstrap ${rebindWorkspace} --implementer AlternateBot --plan-writer ImplementerBot`,
        runOptions,
      );
    } finally {
      await chmod(projectProfileDir, 0o700);
    }
    expect(persistenceBlocked).toBe(true);

    const store = new ProjectStore(resolveAppPaths({
      rootDir: h.tmp.root,
      profile: h.controls.profile,
    }).projectsFile);
    await store.load();
    expect(store.get('oc-project')).toBeUndefined();
    expect(store.getState('oc-project')).toMatchObject({
      assignment: { workspace: stableWorkspace },
      usable: false,
      disabledReason: 'bootstrap_incomplete',
    });
    expect(lastMarkdown(h.channel)).toContain('旧绑定记录未被新绑定覆盖，但已禁用');
    expect(lastMarkdown(h.channel)).toContain('新角色绑定保存失败');
    expect(lastMarkdown(h.channel)).toContain('已发生部分准备副作用');
  });

  it('rejects role assignments that would self-review', async () => {
    const h = await createHarness();

    await expect(
      h.run('/project bootstrap repo-conflict --implementer ImplementerBot --plan-writer ImplementerBot', {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('必须是不同 Bot');
  });

  it('fails before side effects when a named role is missing from the shared Registry', async () => {
    const h = await createHarness();
    configureBootstrapCoordinatorIdentity(h);
    let discoveryCalls = 0;
    (h.channel.rawClient.im.v1 as unknown as {
      chatMembers: { bots(): Promise<unknown> };
    }).chatMembers = {
      async bots(): Promise<unknown> {
        discoveryCalls += 1;
        return { data: { items: [] } };
      },
    };

    await h.run(
      '/project bootstrap missing-workspace --implementer MissingBot --plan-writer PlannerBot',
      { chatId: 'oc-project', scope: 'oc-project', chatMode: 'group' },
    );

    expect(discoveryCalls).toBe(0);
    expect(lastMarkdown(h.channel)).toContain('MissingBot');
    expect(lastMarkdown(h.channel)).toContain('bot-registry add');
    expect(lastMarkdown(h.channel)).toContain('未执行任何准备副作用');
    expect(h.workspaces.cwdFor('oc-project')).toBeUndefined();
    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).not.toContain('oc-project');
  });

  it('fails closed before side effects when the shared Registry is invalid', async () => {
    const h = await createHarness();
    configureBootstrapCoordinatorIdentity(h);
    const raw = JSON.parse(await readFile(h.controls.configPath, 'utf8')) as {
      botRegistry: unknown;
    };
    raw.botRegistry = {
      entries: [{ name: 'BrokenBot', aliases: [], appId: '' }],
    };
    await writeFile(h.controls.configPath, `${JSON.stringify(raw)}\n`, 'utf8');
    let discoveryCalls = 0;
    (h.channel.rawClient.im.v1 as unknown as {
      chatMembers: { bots(): Promise<unknown> };
    }).chatMembers = {
      async bots(): Promise<unknown> {
        discoveryCalls += 1;
        return { data: { items: [] } };
      },
    };

    await h.run(
      '/project bootstrap missing-workspace --implementer ImplementerBot --plan-writer PlannerBot',
      { chatId: 'oc-project', scope: 'oc-project', chatMode: 'group' },
    );

    expect(discoveryCalls).toBe(0);
    expect(lastMarkdown(h.channel)).toContain('无法读取共享 Bot Registry');
    expect(lastMarkdown(h.channel)).toContain('appId');
    expect(lastMarkdown(h.channel)).toContain('未执行任何准备副作用');
  });

  it('fails closed before side effects when Root Config is missing', async () => {
    const h = await createHarness();
    configureBootstrapCoordinatorIdentity(h);
    await rm(h.controls.configPath);
    let discoveryCalls = 0;
    (h.channel.rawClient.im.v1 as unknown as {
      chatMembers: { bots(): Promise<unknown> };
    }).chatMembers = {
      async bots(): Promise<unknown> {
        discoveryCalls += 1;
        return { data: { items: [] } };
      },
    };

    await h.run(
      '/project bootstrap missing-workspace --implementer ImplementerBot --plan-writer PlannerBot',
      { chatId: 'oc-project', scope: 'oc-project', chatMode: 'group' },
    );

    expect(discoveryCalls).toBe(0);
    expect(lastMarkdown(h.channel)).toContain('Root Config 尚未初始化');
    expect(lastMarkdown(h.channel)).toContain('未执行任何准备副作用');
  });

  it('rejects a Registry role that resolves to the Coordinator entry before side effects', async () => {
    const h = await createHarness();
    configureBootstrapCoordinatorIdentity(h);

    await h.run(
      '/project bootstrap missing-workspace --implementer CoordinatorBot --plan-writer PlannerBot',
      { chatId: 'oc-project', scope: 'oc-project', chatMode: 'group' },
    );

    expect(lastMarkdown(h.channel)).toContain('三个不同 Bot');
    expect(lastMarkdown(h.channel)).toContain('未执行任何准备副作用');
    expect(h.workspaces.cwdFor('oc-project')).toBeUndefined();
  });

  it('keeps a usable old binding and all preparation state when two roles initially share one live open_id', async () => {
    const h = await createHarness();
    const stableWorkspace = join(h.tmp.root, 'same-live-id-stable');
    const rebindWorkspace = join(h.tmp.root, 'same-live-id-rebind');
    await Promise.all([
      mkdir(stableWorkspace, { recursive: true }),
      mkdir(rebindWorkspace, { recursive: true }),
    ]);
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou_implementer' },
      { name: 'AlternateBot', openId: 'ou_plan_writer' },
    ]);
    const runOptions = { chatId: 'oc-project', scope: 'oc-project', chatMode: 'group' as const };
    await h.run(
      `/project bootstrap ${stableWorkspace} --implementer ImplementerBot --plan-writer AlternateBot`,
      runOptions,
    );
    h.sessions.set('oc-project', 'stable-session', stableWorkspace);
    const cwdBefore = h.workspaces.cwdFor('oc-project');
    const accessBefore = structuredClone(h.controls.profileConfig.access);
    const sentBefore = h.channel.sent.length;
    const inviteLog = join(h.tmp.root, 'same-live-id-invite.log');
    await installFakeLarkCli(h, inviteLog);
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou_shared_role' },
      { name: 'PlannerBot', openId: 'ou_shared_role' },
    ]);

    await h.run(
      `/project bootstrap ${rebindWorkspace} --implementer ImplementerBot --plan-writer PlannerBot`,
      runOptions,
    );

    expect(lastMarkdown(h.channel)).toContain('解析到了同一个 Bot');
    expect(lastMarkdown(h.channel)).toContain('旧绑定记录未改变且仍可安全使用');
    expect(lastMarkdown(h.channel)).toContain('未记录到部分准备副作用');
    const store = new ProjectStore(resolveAppPaths({
      rootDir: h.tmp.root,
      profile: h.controls.profile,
    }).projectsFile);
    await store.load();
    expect(store.get('oc-project')?.workspace).toBe(stableWorkspace);
    expect(store.getState('oc-project').usable).toBe(true);
    expect(h.workspaces.cwdFor('oc-project')).toBe(cwdBefore);
    expect(h.sessions.resumeFor('oc-project', stableWorkspace)).toBe('stable-session');
    expect(h.controls.profileConfig.access).toEqual(accessBefore);
    expect(h.channel.sent).toHaveLength(sentBefore + 1);
    await expect(readFile(inviteLog, 'utf8').catch(() => '')).resolves.toBe('');
  });

  it('keeps a usable old binding and all preparation state on initial duplicate live matches', async () => {
    const h = await createHarness();
    const stableWorkspace = join(h.tmp.root, 'duplicate-live-stable');
    const rebindWorkspace = join(h.tmp.root, 'duplicate-live-rebind');
    await Promise.all([
      mkdir(stableWorkspace, { recursive: true }),
      mkdir(rebindWorkspace, { recursive: true }),
    ]);
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou_implementer' },
      { name: 'AlternateBot', openId: 'ou_plan_writer' },
    ]);
    const runOptions = { chatId: 'oc-project', scope: 'oc-project', chatMode: 'group' as const };
    await h.run(
      `/project bootstrap ${stableWorkspace} --implementer ImplementerBot --plan-writer AlternateBot`,
      runOptions,
    );
    h.sessions.set('oc-project', 'stable-session', stableWorkspace);
    const cwdBefore = h.workspaces.cwdFor('oc-project');
    const accessBefore = structuredClone(h.controls.profileConfig.access);
    const sentBefore = h.channel.sent.length;
    const inviteLog = join(h.tmp.root, 'duplicate-live-invite.log');
    await installFakeLarkCli(h, inviteLog);
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou_implementer_first' },
      { name: 'ImplementerBot', openId: 'ou_implementer_second' },
      { name: 'PlannerBot', openId: 'ou_planner' },
    ]);

    await h.run(
      `/project bootstrap ${rebindWorkspace} --implementer ImplementerBot --plan-writer PlannerBot`,
      runOptions,
    );

    expect(lastMarkdown(h.channel)).toContain('匹配到多个 Bot');
    expect(lastMarkdown(h.channel)).toContain('旧绑定记录未改变且仍可安全使用');
    expect(lastMarkdown(h.channel)).toContain('未记录到部分准备副作用');
    const store = new ProjectStore(resolveAppPaths({
      rootDir: h.tmp.root,
      profile: h.controls.profile,
    }).projectsFile);
    await store.load();
    expect(store.get('oc-project')?.workspace).toBe(stableWorkspace);
    expect(store.getState('oc-project').usable).toBe(true);
    expect(h.workspaces.cwdFor('oc-project')).toBe(cwdBefore);
    expect(h.sessions.resumeFor('oc-project', stableWorkspace)).toBe('stable-session');
    expect(h.controls.profileConfig.access).toEqual(accessBefore);
    expect(h.channel.sent).toHaveLength(sentBefore + 1);
    await expect(readFile(inviteLog, 'utf8').catch(() => '')).resolves.toBe('');
  });

  it('marks bootstrap incomplete when role identity conflict appears only after invite', async () => {
    const h = await createHarness();
    const stableWorkspace = join(h.tmp.root, 'post-invite-conflict-stable');
    const rebindWorkspace = join(h.tmp.root, 'post-invite-conflict-rebind');
    await Promise.all([
      mkdir(stableWorkspace, { recursive: true }),
      mkdir(rebindWorkspace, { recursive: true }),
    ]);
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou_implementer' },
      { name: 'AlternateBot', openId: 'ou_plan_writer' },
    ]);
    const runOptions = { chatId: 'oc-project', scope: 'oc-project', chatMode: 'group' as const };
    await h.run(
      `/project bootstrap ${stableWorkspace} --implementer ImplementerBot --plan-writer AlternateBot`,
      runOptions,
    );
    h.sessions.set('oc-project', 'stale-session', stableWorkspace);
    const sentBefore = h.channel.sent.length;
    const inviteLog = join(h.tmp.root, 'post-invite-conflict.log');
    await installFakeLarkCli(h, inviteLog);
    configureBootstrapCoordinatorIdentity(h);
    let discoveryCalls = 0;
    (h.channel.rawClient.im.v1 as unknown as {
      chatMembers: { bots(): Promise<unknown> };
    }).chatMembers = {
      async bots(): Promise<unknown> {
        discoveryCalls += 1;
        return {
          data: {
            items: discoveryCalls === 1
              ? []
              : [
                { member_id_type: 'bot', member_id: 'ou_shared_after_invite', name: 'ImplementerBot' },
                { member_id_type: 'bot', member_id: 'ou_shared_after_invite', name: 'PlannerBot' },
              ],
          },
        };
      },
    };

    await h.run(
      `/project bootstrap ${rebindWorkspace} --implementer ImplementerBot --plan-writer PlannerBot`,
      runOptions,
    );

    const store = new ProjectStore(resolveAppPaths({
      rootDir: h.tmp.root,
      profile: h.controls.profile,
    }).projectsFile);
    await store.load();
    expect(store.get('oc-project')).toBeUndefined();
    expect(store.getState('oc-project')).toMatchObject({
      assignment: { workspace: stableWorkspace },
      usable: false,
      disabledReason: 'bootstrap_incomplete',
    });
    expect(lastMarkdown(h.channel)).toContain('解析到了同一个 Bot');
    expect(lastMarkdown(h.channel)).toContain('已发生部分准备副作用');
    expect(lastMarkdown(h.channel)).toContain('Coordinator cwd 已切换');
    expect(lastMarkdown(h.channel)).toContain('至少一个目标 Bot 已被邀请进群');
    expect(lastMarkdown(h.channel)).not.toContain('当前群已加入 Coordinator 准入列表');
    expect(h.workspaces.cwdFor('oc-project')).toBe(await realpath(rebindWorkspace));
    expect(h.sessions.resumeFor('oc-project', stableWorkspace)).toBeUndefined();
    expect(h.channel.sent).toHaveLength(sentBefore + 1);
    expect(await readFile(inviteLog, 'utf8')).toContain('chat.members create');
  });

  it('sets the coordinator cwd during project bootstrap without rewriting dispatched workspace text', async () => {
    const h = await createHarness();
    const workspacePath = 'tests/integration/commands';
    configureSingleBridgeBotBootstrap(h, 'ImplementerBot', 'ou_implementer');
    h.sessions.set('oc-project', 'stale-session', h.tmp.workspace);

    await expect(
      h.run(`/project bootstrap ${workspacePath} --implementer ImplementerBot --plan-writer PlannerBot`, {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    await expect(realpath(workspacePath)).resolves.toBe(h.workspaces.cwdFor('oc-project'));
    expect(h.sessions.resumeFor('oc-project', await realpath(workspacePath))).toBeUndefined();

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(textMessages).toContain(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`);
    expect(textMessages).toContain(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`);
  });

  it('keeps the original bootstrap workspace instead of expanding tilde paths', async () => {
    const h = await createHarness();
    const homeWorkspace = await mkdtemp(join(homedir(), '.bridge-bootstrap-test-'));
    const workspaceText = `~/${basename(homeWorkspace)}`;
    cleanups.push(() => rm(homeWorkspace, { recursive: true, force: true }));
    configureSingleBridgeBotBootstrap(h, 'AlternateBot', 'ou_alternate');

    await expect(
      h.run(
        `/project bootstrap ${workspaceText} --implementer AlternateBot --plan-writer PlannerBot`,
        {
          chatId: 'oc-project',
          scope: 'oc-project',
          chatMode: 'group',
        },
      ),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(textMessages).toContain(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspaceText}`);
    expect(textMessages).toContain(`<at user_id="ou_alternate">AlternateBot</at> /cd ${workspaceText}`);
    expect(textMessages.join('\n')).not.toContain(homedir());
  });

  it('adds the project group to coordinator allowedChats before bootstrap dispatch', async () => {
    const h = await createHarness();
    const workspacePath = join(h.tmp.root, 'repo-allow');
    await mkdir(workspacePath, { recursive: true });
    configureSingleBridgeBotBootstrap(h, 'ImplementerBot', 'ou_implementer');

    await expect(
      h.run(`/project bootstrap ${workspacePath} --implementer ImplementerBot --plan-writer PlannerBot`, {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-project');
    expect(h.controls.profileConfig.access.allowedChats).toContain('oc-project');
  });

  it('rejects /project bootstrap in p2p because it initializes a project group', async () => {
    const h = await createHarness();

    await expect(
      h.run('/project bootstrap repo-p2p --implementer ImplementerBot --plan-writer PlannerBot'),
    ).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('只能在普通项目群里使用');
  });

  it('rejects Topic bootstrap without binding writes or preparation side effects', async () => {
    const h = await createHarness();
    const stableWorkspace = join(h.tmp.root, 'repo-stable');
    await mkdir(stableWorkspace, { recursive: true });
    configureRoleBotsBootstrap(h, [
      { name: 'ImplementerBot', openId: 'ou-implementer' },
      { name: 'AlternateBot', openId: 'ou-plan-writer' },
    ]);
    await h.run(`/project bootstrap ${stableWorkspace} --implementer ImplementerBot --plan-writer AlternateBot`, {
      chatId: 'oc-project',
      scope: 'oc-project',
      chatMode: 'group',
    });
    const sentBeforeTopic = h.channel.sent.length;

    await h.run('/project bootstrap repo-topic --implementer AlternateBot --plan-writer ImplementerBot', {
      chatId: 'oc-project',
      scope: 'oc-project:thread-a',
      chatMode: 'topic',
    });

    const store = new ProjectStore(resolveAppPaths({
      rootDir: h.tmp.root,
      profile: h.controls.profile,
    }).projectsFile);
    await store.load();
    expect(store.get('oc-project')?.workspace).toBe(stableWorkspace);
    expect(store.getState('oc-project').usable).toBe(true);
    expect(h.workspaces.cwdFor('oc-project:thread-a')).toBeUndefined();
    expect(h.channel.sent.slice(sentBeforeTopic)).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('Topic 群按话题隔离 workspace');
    expect(lastMarkdown(h.channel)).toContain('未执行任何准备副作用');
  });

  it('invites missing project bootstrap bots by app_id before dispatching', async () => {
    const h = await createHarness();
    const workspacePath = join(h.tmp.root, 'repo-invite');
    await mkdir(workspacePath, { recursive: true });
    const inviteLog = join(h.tmp.root, 'fake-lark-cli.log');
    await installFakeLarkCli(h, inviteLog);
    configureMissingThenPresentBridgeBotBootstrap(h, 'ImplementerBot', 'ou_implementer');

    await expect(
      h.run(`/project bootstrap ${workspacePath} --implementer ImplementerBot --plan-writer PlannerBot`, {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(textMessages).toHaveLength(4);
    expect(textMessages.indexOf('<at user_id="ou_planner">PlannerBot</at> /invite group'))
      .toBeLessThan(textMessages.indexOf(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`));
    expect(textMessages.indexOf('<at user_id="ou_implementer">ImplementerBot</at> /invite group'))
      .toBeLessThan(textMessages.indexOf(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`));
    expect(textMessages).toContain(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`);
    expect(textMessages).toContain(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`);

    const inviteCalls = await readFile(inviteLog, 'utf8');
    expect(inviteCalls).toContain('chat.members create');
    expect(inviteCalls).toContain('--chat-id oc-project');
    expect(inviteCalls).toContain('--member-id-type app_id');
    expect(inviteCalls).toContain('cli_test_implementer');
    expect(inviteCalls).toContain('cli_test_planner');
  });

  it('does not rediscover bootstrap bots before invite succeeds', async () => {
    const h = await createHarness();
    const workspacePath = join(h.tmp.root, 'repo-order');
    await mkdir(workspacePath, { recursive: true });
    const inviteLog = join(h.tmp.root, 'fake-lark-cli-order.log');
    await installFakeLarkCli(h, inviteLog);
    configureBootstrapBotsAppearOnlyAfterInvite(h, 'ImplementerBot', 'ou_implementer', inviteLog);

    await expect(
      h.run(`/project bootstrap ${workspacePath} --implementer ImplementerBot --plan-writer PlannerBot`, {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(await readFile(inviteLog, 'utf8')).toContain('chat.members create');
    expect(textMessages.indexOf('<at user_id="ou_implementer">ImplementerBot</at> /invite group'))
      .toBeLessThan(textMessages.indexOf(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`));
    expect(textMessages.indexOf('<at user_id="ou_planner">PlannerBot</at> /invite group'))
      .toBeLessThan(textMessages.indexOf(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`));
    expect(textMessages).toContain(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`);
    expect(textMessages).toContain(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`);
  });

  it('retries bootstrap discovery after invite before dispatching cd commands', async () => {
    const h = await createHarness();
    const workspacePath = join(h.tmp.root, 'repo-retry');
    await mkdir(workspacePath, { recursive: true });
    const inviteLog = join(h.tmp.root, 'fake-lark-cli-retry.log');
    await installFakeLarkCli(h, inviteLog);
    configureBootstrapBotsAppearAfterInviteRetry(h, 'ImplementerBot', 'ou_implementer', inviteLog);

    await expect(
      h.run(`/project bootstrap ${workspacePath} --implementer ImplementerBot --plan-writer PlannerBot`, {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(await readFile(inviteLog, 'utf8')).toContain('chat.members create');
    expect(textMessages.indexOf('<at user_id="ou_implementer">ImplementerBot</at> /invite group'))
      .toBeLessThan(textMessages.indexOf(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`));
    expect(textMessages.indexOf('<at user_id="ou_planner">PlannerBot</at> /invite group'))
      .toBeLessThan(textMessages.indexOf(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`));
    expect(textMessages).toContain(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`);
    expect(textMessages).toContain(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`);
  });

  it('falls back to lark-cli bot discovery when raw SDK discovery fails', async () => {
    const h = await createHarness();
    const workspacePath = join(h.tmp.root, 'repo-fallback');
    await mkdir(workspacePath, { recursive: true });
    const inviteLog = join(h.tmp.root, 'fake-lark-cli-fallback.log');
    await installFakeLarkCliDiscoveryFallback(h, inviteLog);
    configureThrowingRawSdkBootstrap(h);

    await expect(
      h.run(`/project bootstrap ${workspacePath} --implementer ImplementerBot --plan-writer PlannerBot`, {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(textMessages.indexOf('<at user_id="ou_implementer">ImplementerBot</at> /invite group'))
      .toBeLessThan(textMessages.indexOf(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`));
    expect(textMessages.indexOf('<at user_id="ou_planner">PlannerBot</at> /invite group'))
      .toBeLessThan(textMessages.indexOf(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`));
    expect(textMessages).toContain(`<at user_id="ou_implementer">ImplementerBot</at> /cd ${workspacePath}`);
    expect(textMessages).toContain(`<at user_id="ou_planner">PlannerBot</at> /cd ${workspacePath}`);

    const calls = await readFile(inviteLog, 'utf8');
    expect(calls).toContain('chat.members bots');
    expect(calls).toContain('chat.members create');
  });

  it('reports bootstrap discovery failure without dispatching or allowlisting the group', async () => {
    const h = await createHarness();
    await installFailingLarkCli(h);
    configureThrowingRawSdkBootstrap(h);

    await expect(
      h.run('/project bootstrap repo-fail --implementer ImplementerBot --plan-writer PlannerBot', {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');
    expect(textMessages).toHaveLength(0);
    expect(lastMarkdown(h.channel)).toContain('无法读取群内 bot 列表');

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).not.toContain('oc-project');
  });

  it('keeps /project bootstrap human-admin gated', async () => {
    const h = await createHarness();
    h.controls.profileConfig.access.botAdmins = ['ou-bot-admin'];

    await expect(
      h.run(
        '/project bootstrap repo-two --implementer ImplementerBot --plan-writer PlannerBot',
        { senderId: 'ou-bot-admin' },
      ),
    ).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('commands-v1-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const workspaceRealpath = await realpath(tmp.workspace);
  const profileConfig = appConfig(workspaceRealpath);
  const configPath = join(tmp.root, 'config.json');
  const rootConfig = createRootConfig('claude', profileConfig);
  rootConfig.botRegistry = {
    entries: [
      {
        name: 'CoordinatorBot',
        aliases: [],
        appId: 'cli_test_coordinator',
      },
      {
        name: 'ImplementerBot',
        aliases: ['ImplementationAlias'],
        appId: 'cli_test_implementer',
      },
      {
        name: 'PlannerBot',
        aliases: [],
        appId: 'cli_test_planner',
      },
      {
        name: 'AlternateBot',
        aliases: [],
        appId: 'cli_test_alternate',
      },
    ],
  };
  await saveRootConfig(rootConfig, configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  workspaces.setCwd('chat-1', workspaceRealpath);

  const run = (content: string, overrides: RunOverrides = {}): Promise<boolean> => {
    const chatId = overrides.chatId ?? 'chat-1';
    const scope = overrides.scope ?? chatId;
    return tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, {
        chatId,
        senderId: overrides.senderId ?? 'ou-admin',
        mentions: overrides.mentions ?? [],
        rawContent: overrides.rawContent,
      }),
      scope,
      chatMode: overrides.chatMode ?? 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });
  };

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, agent, controls, run };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    preferences: { maxConcurrentRuns: 2 },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(
  content: string,
  opts: {
    chatId: string;
    senderId: string;
    mentions?: NormalizedMessage['mentions'];
    rawContent?: string;
  },
): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: opts.chatId,
    chatType: 'p2p',
    senderId: opts.senderId,
    senderName: 'User',
    content,
    resources: [],
    mentions: opts.mentions ?? [],
    mentionedBot: false,
    ...(opts.rawContent ? { raw: { message: { content: opts.rawContent } } } : {}),
  } as unknown as NormalizedMessage;
}

function mention(openId: string, name: string): NonNullable<NormalizedMessage['mentions']>[number] {
  return {
    openId,
    name,
    isBot: false,
  } as NonNullable<NormalizedMessage['mentions']>[number];
}

function botMention(openId: string, name: string): NonNullable<NormalizedMessage['mentions']>[number] {
  return {
    openId,
    name,
    isBot: true,
  } as NonNullable<NormalizedMessage['mentions']>[number];
}

function configureSingleBridgeBotBootstrap(
  h: Harness,
  name: string,
  openId: string,
): void {
  configureBootstrapCoordinatorIdentity(h);
  (h.channel.rawClient.im.v1 as unknown as {
    chatMembers: {
      bots(params: unknown): Promise<unknown>;
    };
  }).chatMembers = {
    async bots(): Promise<unknown> {
      return {
        data: {
          items: [
            {
              member_id_type: 'bot',
              member_id: 'ou_planner',
              name: 'PlannerBot',
            },
            {
              member_id_type: 'bot',
              member_id: openId,
              name,
            },
          ],
        },
      };
    },
  };
}

function configureRoleBotsBootstrap(
  h: Harness,
  bots: Array<{ name: string; openId: string }>,
): void {
  configureBootstrapCoordinatorIdentity(h);
  (h.channel.rawClient.im.v1 as unknown as {
    chatMembers: {
      bots(params: unknown): Promise<unknown>;
    };
  }).chatMembers = {
    async bots(): Promise<unknown> {
      return {
        data: {
          items: bots.map((bot) => ({
            member_id_type: 'bot',
            member_id: bot.openId,
            name: bot.name,
          })),
        },
      };
    },
  };
}

function configureBootstrapCoordinatorIdentity(h: Harness): void {
  (h.channel as unknown as { botIdentity: { openId: string; name: string } }).botIdentity = {
    openId: 'ou-self',
    name: 'CoordinatorBot',
  };
}

async function installFakeLarkCli(h: Harness, logFile?: string): Promise<void> {
  const bin = join(h.tmp.root, 'bin');
  await mkdir(bin, { recursive: true });
  const script = join(bin, 'lark-cli');
  await writeFile(
    script,
    [
      '#!/bin/sh',
      'if [ -z "$LARK_CHANNEL_PROFILE" ] || [ -z "$LARK_CHANNEL_CONFIG" ] || [ -z "$LARKSUITE_CLI_CONFIG_DIR" ]; then',
      '  printf \'{"ok":false,"msg":"missing bridge lark-cli env"}\\n\'',
      '  exit 1',
      'fi',
      'if [ -n "$LARK_FAKE_CLI_LOG" ]; then',
      '  printf "%s\\n" "$*" >> "$LARK_FAKE_CLI_LOG"',
      'fi',
      'printf \'{"code":0,"data":{"invalid_id_list":[],"not_existed_id_list":[],"pending_approval_id_list":[]}}\\n\'',
    ].join('\n'),
    'utf8',
  );
  await chmod(script, 0o755);
  const oldPath = process.env.PATH ?? '';
  const oldLog = process.env.LARK_FAKE_CLI_LOG;
  process.env.PATH = `${bin}:${oldPath}`;
  if (logFile) {
    process.env.LARK_FAKE_CLI_LOG = logFile;
  } else {
    delete process.env.LARK_FAKE_CLI_LOG;
  }
  cleanups.push(async () => {
    process.env.PATH = oldPath;
    if (oldLog === undefined) {
      delete process.env.LARK_FAKE_CLI_LOG;
    } else {
      process.env.LARK_FAKE_CLI_LOG = oldLog;
    }
  });
}

async function installFakeLarkCliDiscoveryFallback(h: Harness, logFile?: string): Promise<void> {
  const bin = join(h.tmp.root, 'bin');
  await mkdir(bin, { recursive: true });
  const script = join(bin, 'lark-cli');
  await writeFile(
    script,
    [
      '#!/bin/sh',
      'if [ -z "$LARK_CHANNEL_PROFILE" ] || [ -z "$LARK_CHANNEL_CONFIG" ] || [ -z "$LARKSUITE_CLI_CONFIG_DIR" ]; then',
      '  printf \'{"ok":false,"msg":"missing bridge lark-cli env"}\\n\'',
      '  exit 1',
      'fi',
      'if [ -n "$LARK_FAKE_CLI_LOG" ]; then',
      '  printf "%s\\n" "$*" >> "$LARK_FAKE_CLI_LOG"',
      'fi',
      'case "$*" in',
      '  *"chat.members bots"*)',
      '    if [ -n "$LARK_FAKE_CLI_LOG" ] && grep -q "chat.members create" "$LARK_FAKE_CLI_LOG"; then',
      '      printf \'{"ok":true,"data":{"items":[{"bot_id":"ou-self","bot_name":"CoordinatorBot"},{"bot_id":"ou_planner","bot_name":"PlannerBot"},{"bot_id":"ou_implementer","bot_name":"ImplementerBot"}]}}\\n\'',
      '    else',
      '      printf \'{"ok":true,"data":{"items":[{"bot_id":"ou-self","bot_name":"CoordinatorBot"}]}}\\n\'',
      '    fi',
      '    ;;',
      '  *)',
      '    printf \'{"code":0,"data":{"invalid_id_list":[],"not_existed_id_list":[],"pending_approval_id_list":[]}}\\n\'',
      '    ;;',
      'esac',
    ].join('\n'),
    'utf8',
  );
  await chmod(script, 0o755);
  const oldPath = process.env.PATH ?? '';
  const oldLog = process.env.LARK_FAKE_CLI_LOG;
  process.env.PATH = `${bin}:${oldPath}`;
  if (logFile) {
    process.env.LARK_FAKE_CLI_LOG = logFile;
  } else {
    delete process.env.LARK_FAKE_CLI_LOG;
  }
  cleanups.push(async () => {
    process.env.PATH = oldPath;
    if (oldLog === undefined) {
      delete process.env.LARK_FAKE_CLI_LOG;
    } else {
      process.env.LARK_FAKE_CLI_LOG = oldLog;
    }
  });
}

async function installFakeLarkCliDiscoveryFailure(h: Harness): Promise<void> {
  const bin = join(h.tmp.root, 'bin');
  await mkdir(bin, { recursive: true });
  const script = join(bin, 'lark-cli');
  await writeFile(
    script,
    [
      '#!/bin/sh',
      'printf \'{"ok":false,"error":{"type":"authorization","message":"missing scope"}}\\n\' >&2',
      'exit 3',
    ].join('\n'),
    'utf8',
  );
  await chmod(script, 0o755);
  const oldPath = process.env.PATH ?? '';
  process.env.PATH = `${bin}:${oldPath}`;
  cleanups.push(async () => {
    process.env.PATH = oldPath;
  });
}

async function installFailingLarkCli(h: Harness): Promise<void> {
  const bin = join(h.tmp.root, 'bin');
  await mkdir(bin, { recursive: true });
  const script = join(bin, 'lark-cli');
  await writeFile(
    script,
    [
      '#!/bin/sh',
      'printf \'{"ok":false,"msg":"forced failure"}\\n\'',
      'exit 1',
    ].join('\n'),
    'utf8',
  );
  await chmod(script, 0o755);
  const oldPath = process.env.PATH ?? '';
  process.env.PATH = `${bin}:${oldPath}`;
  cleanups.push(async () => {
    process.env.PATH = oldPath;
  });
}

function configureMissingThenPresentBridgeBotBootstrap(
  h: Harness,
  name: string,
  openId: string,
): void {
  configureBootstrapCoordinatorIdentity(h);
  let calls = 0;
  (h.channel.rawClient.im.v1 as unknown as {
    chatMembers: {
      bots(params: unknown): Promise<unknown>;
    };
  }).chatMembers = {
    async bots(): Promise<unknown> {
      calls += 1;
      return {
        data: {
          items: calls === 1
            ? []
            : [
              {
                member_id_type: 'bot',
                member_id: 'ou_planner',
                name: 'PlannerBot',
              },
              {
                member_id_type: 'bot',
                member_id: openId,
                name,
              },
            ],
        },
      };
    },
  };
}

function configureThrowingRawSdkBootstrap(
  h: Harness,
): void {
  configureBootstrapCoordinatorIdentity(h);
  (h.channel.rawClient.im.v1 as unknown as {
    chatMembers: {
      bots(params: unknown): Promise<unknown>;
    };
  }).chatMembers = {
    async bots(): Promise<unknown> {
      throw new Error('raw SDK discovery unavailable');
    },
  };
}

function configureBootstrapBotsAppearOnlyAfterInvite(
  h: Harness,
  name: string,
  openId: string,
  inviteLog: string,
): void {
  configureBootstrapCoordinatorIdentity(h);
  (h.channel.rawClient.im.v1 as unknown as {
    chatMembers: {
      bots(params: unknown): Promise<unknown>;
    };
  }).chatMembers = {
    async bots(): Promise<unknown> {
      const invited = await readFile(inviteLog, 'utf8')
        .then((content) => content.includes('chat.members create'))
        .catch(() => false);
      return {
        data: {
          items: invited
            ? [
              {
                member_id_type: 'bot',
                member_id: 'ou_planner',
                name: 'PlannerBot',
              },
              {
                member_id_type: 'bot',
                member_id: openId,
                name,
              },
            ]
            : [],
        },
      };
    },
  };
}

function configureBootstrapBotsAppearAfterInviteRetry(
  h: Harness,
  name: string,
  openId: string,
  inviteLog: string,
): void {
  configureBootstrapCoordinatorIdentity(h);
  let postInviteDiscoveries = 0;
  (h.channel.rawClient.im.v1 as unknown as {
    chatMembers: {
      bots(params: unknown): Promise<unknown>;
    };
  }).chatMembers = {
    async bots(): Promise<unknown> {
      const invited = await readFile(inviteLog, 'utf8')
        .then((content) => content.includes('chat.members create'))
        .catch(() => false);
      if (invited) postInviteDiscoveries += 1;
      return {
        data: {
          items: invited && postInviteDiscoveries >= 2
            ? [
              {
                member_id_type: 'bot',
                member_id: 'ou_planner',
                name: 'PlannerBot',
              },
              {
                member_id_type: 'bot',
                member_id: openId,
                name,
              },
            ]
            : [],
        },
      };
    },
  };
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = lastContent(channel);
  expect(content.markdown).toBeTypeOf('string');
  return content.markdown as string;
}

function jsonStringFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
