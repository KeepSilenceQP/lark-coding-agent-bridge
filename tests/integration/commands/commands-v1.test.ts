import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import {
  tryHandleCommand,
  type CommandContext,
  type Controls,
} from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
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
      h.run('/botAdmin add 小P', { chatMode: 'group' }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已把 小P 加入 Bot 管理员');

    let root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toContain('ou-self');

    // Add same bot again (idempotent)
    await expect(
      h.run('/botAdmin add 小P', { chatMode: 'group' }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已经在 Bot 管理员里');

    // List
    await expect(h.run('/botAdmin list')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('<at user_id="ou-self">ou-self</at>');

    // Remove
    await expect(
      h.run('/botAdmin remove 小P', { chatMode: 'group' }),
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
      h.run('/botAdmin add 小P', { chatMode: 'group' }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).not.toContain('ou-self');
    expect(lastMarkdown(h.channel)).toContain('无法读取当前群内 Bot 列表');
    expect(lastMarkdown(h.channel)).toContain('小P');
  });

  it('rejects @-prefixed names as /botAdmin targets', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFallback(h);
    h.controls.profileConfig.access.botAdmins = ['ou-self'];
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);

    await expect(
      h.run('/botAdmin remove @小P', {
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
      h.run('/botAdmin remove 小P', {
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toEqual([]);
    expect(await readFile(logFile, 'utf8')).toContain(
      'chat.members bots --params {"chat_id":"chat-1"} --as bot',
    );
    expect(lastMarkdown(h.channel)).toContain('已把 小P 移出 Bot 管理员');
  });

  it('uses only names after /botAdmin add as bot admin targets', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFallback(h);

    await expect(
      h.run('/botAdmin add 小P', { chatMode: 'group' }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toEqual(['ou-self']);
    expect(lastMarkdown(h.channel)).toContain('已把 小P 加入 Bot 管理员');
    expect(lastMarkdown(h.channel)).not.toContain('小C');
  });

  it('uses only names after /botAdmin remove as bot admin targets', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFallback(h);
    h.controls.profileConfig.access.botAdmins = ['ou-live-c', 'ou-self'];
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);

    await expect(
      h.run('/botAdmin remove 小P', { chatMode: 'group' }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toEqual(['ou-live-c']);
    expect(lastMarkdown(h.channel)).toContain('已把 小P 移出 Bot 管理员');
    expect(lastMarkdown(h.channel)).not.toContain('小C');
  });

  it('strips only leading wake mentions when raw command text contains parameter mentions', async () => {
    const h = await createHarness();
    await installFakeLarkCliDiscoveryFallback(h);
    h.controls.profileConfig.access.botAdmins = ['ou-self'];
    await saveRootConfig(createRootConfig('claude', h.controls.profileConfig), h.controls.configPath);

    await expect(
      h.run('/botAdmin remove', {
        mentions: [
          { ...botMention('ou-xiaoc', '小C'), key: '@_user_1' },
        ],
        rawContent: JSON.stringify({ text: '@小C /botAdmin remove 小P' }),
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.botAdmins).toEqual([]);
    expect(lastMarkdown(h.channel)).toContain('已把 小P 移出 Bot 管理员');
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
    configureSingleBridgeBotBootstrap(h, '小C', 'ou-live-c', 'repo-one');

    await expect(
      h.run('/project bootstrap repo-one @小C', {
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
    expect(textMessages).toContain('<at user_id="ou-cloud-cz">云上C总</at> /cd repo-one');
    expect(textMessages).toContain('<at user_id="ou-cloud-cz">云上C总</at> /invite group');
    expect(textMessages).toContain('<at user_id="ou-live-c">小C</at> /cd repo-one');
    expect(textMessages).toContain('<at user_id="ou-live-c">小C</at> /invite group');
    expect(textMessages.indexOf('<at user_id="ou-cloud-cz">云上C总</at> /invite group'))
      .toBeLessThan(textMessages.indexOf('<at user_id="ou-cloud-cz">云上C总</at> /cd repo-one'));
    expect(textMessages.indexOf('<at user_id="ou-live-c">小C</at> /invite group'))
      .toBeLessThan(textMessages.indexOf('<at user_id="ou-live-c">小C</at> /cd repo-one'));
  });

  it('adds the project group to coordinator allowedChats before bootstrap dispatch', async () => {
    const h = await createHarness();
    configureSingleBridgeBotBootstrap(h, '小C', 'ou-live-c', 'repo-allow');

    await expect(
      h.run('/project bootstrap repo-allow 小C', {
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

    await expect(h.run('/project bootstrap repo-p2p 小C')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('只能在项目群里使用');
  });

  it('invites missing project bootstrap bots by app_id before dispatching', async () => {
    const h = await createHarness();
    const inviteLog = join(h.tmp.root, 'fake-lark-cli.log');
    await installFakeLarkCli(h, inviteLog);
    configureMissingThenPresentBridgeBotBootstrap(h, '小C', 'ou-live-c', 'cli_target_c', 'repo-invite');

    await expect(
      h.run('/project bootstrap repo-invite 小C', {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(textMessages).toHaveLength(4);
    expect(textMessages.indexOf('<at user_id="ou-cloud-cz">云上C总</at> /invite group'))
      .toBeLessThan(textMessages.indexOf('<at user_id="ou-cloud-cz">云上C总</at> /cd repo-invite'));
    expect(textMessages.indexOf('<at user_id="ou-live-c">小C</at> /invite group'))
      .toBeLessThan(textMessages.indexOf('<at user_id="ou-live-c">小C</at> /cd repo-invite'));
    expect(textMessages).toContain('<at user_id="ou-cloud-cz">云上C总</at> /cd repo-invite');
    expect(textMessages).toContain('<at user_id="ou-live-c">小C</at> /cd repo-invite');

    const inviteCalls = await readFile(inviteLog, 'utf8');
    expect(inviteCalls).toContain('chat.members create');
    expect(inviteCalls).toContain('--chat-id oc-project');
    expect(inviteCalls).toContain('--member-id-type app_id');
  });

  it('does not rediscover bootstrap bots before invite succeeds', async () => {
    const h = await createHarness();
    const inviteLog = join(h.tmp.root, 'fake-lark-cli-order.log');
    await installFakeLarkCli(h, inviteLog);
    configureBootstrapBotsAppearOnlyAfterInvite(h, '小C', 'ou-live-c', 'cli_target_c', 'repo-order', inviteLog);

    await expect(
      h.run('/project bootstrap repo-order 小C', {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(await readFile(inviteLog, 'utf8')).toContain('chat.members create');
    expect(textMessages.indexOf('<at user_id="ou-live-c">小C</at> /invite group'))
      .toBeLessThan(textMessages.indexOf('<at user_id="ou-live-c">小C</at> /cd repo-order'));
    expect(textMessages.indexOf('<at user_id="ou-cloud-cz">云上C总</at> /invite group'))
      .toBeLessThan(textMessages.indexOf('<at user_id="ou-cloud-cz">云上C总</at> /cd repo-order'));
    expect(textMessages).toContain('<at user_id="ou-live-c">小C</at> /cd repo-order');
    expect(textMessages).toContain('<at user_id="ou-cloud-cz">云上C总</at> /cd repo-order');
  });

  it('retries bootstrap discovery after invite before dispatching cd commands', async () => {
    const h = await createHarness();
    const inviteLog = join(h.tmp.root, 'fake-lark-cli-retry.log');
    await installFakeLarkCli(h, inviteLog);
    configureBootstrapBotsAppearAfterInviteRetry(h, '小C', 'ou-live-c', 'cli_target_c', 'repo-retry', inviteLog);

    await expect(
      h.run('/project bootstrap repo-retry 小C', {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(await readFile(inviteLog, 'utf8')).toContain('chat.members create');
    expect(textMessages.indexOf('<at user_id="ou-live-c">小C</at> /invite group'))
      .toBeLessThan(textMessages.indexOf('<at user_id="ou-live-c">小C</at> /cd repo-retry'));
    expect(textMessages.indexOf('<at user_id="ou-cloud-cz">云上C总</at> /invite group'))
      .toBeLessThan(textMessages.indexOf('<at user_id="ou-cloud-cz">云上C总</at> /cd repo-retry'));
    expect(textMessages).toContain('<at user_id="ou-live-c">小C</at> /cd repo-retry');
    expect(textMessages).toContain('<at user_id="ou-cloud-cz">云上C总</at> /cd repo-retry');
  });

  it('falls back to lark-cli bot discovery when raw SDK discovery fails', async () => {
    const h = await createHarness();
    const inviteLog = join(h.tmp.root, 'fake-lark-cli-fallback.log');
    await installFakeLarkCliDiscoveryFallback(h, inviteLog);
    configureThrowingRawSdkBootstrap(h, '小C', 'cli_target_c', 'repo-fallback');

    await expect(
      h.run('/project bootstrap repo-fallback 小C', {
        chatId: 'oc-project',
        scope: 'oc-project',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const textMessages = h.channel.sent
      .map((m) => (m.content as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');

    expect(textMessages.indexOf('<at user_id="ou-live-c">小C</at> /invite group'))
      .toBeLessThan(textMessages.indexOf('<at user_id="ou-live-c">小C</at> /cd repo-fallback'));
    expect(textMessages.indexOf('<at user_id="ou-cloud-cz">云上C总</at> /invite group'))
      .toBeLessThan(textMessages.indexOf('<at user_id="ou-cloud-cz">云上C总</at> /cd repo-fallback'));
    expect(textMessages).toContain('<at user_id="ou-live-c">小C</at> /cd repo-fallback');
    expect(textMessages).toContain('<at user_id="ou-cloud-cz">云上C总</at> /cd repo-fallback');

    const calls = await readFile(inviteLog, 'utf8');
    expect(calls).toContain('chat.members bots');
    expect(calls).toContain('chat.members create');
  });

  it('reports bootstrap discovery failure without dispatching or allowlisting the group', async () => {
    const h = await createHarness();
    await installFailingLarkCli(h);
    configureThrowingRawSdkBootstrap(h, '小C', 'cli_target_c', 'repo-fail');

    await expect(
      h.run('/project bootstrap repo-fail 小C', {
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
      h.run('/project bootstrap repo-two 小C', { senderId: 'ou-bot-admin' }),
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
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
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
  projectRoot: string,
): void {
  (h.channel as unknown as { botIdentity: { openId: string; name: string } }).botIdentity = {
    openId: 'ou-self',
    name: '小P',
  };
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
              member_id: 'ou-cloud-cz',
              name: '云上C总',
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
  (h.controls.profileConfig as unknown as {
    botRegistry: Array<{
      canonicalName: string;
      aliases: string[];
      role: 'bridge';
      machines: Array<{ kind: 'local'; root: string }>;
      projectRoot: string;
    }>;
  }).botRegistry = [
    {
      canonicalName: name,
      aliases: [],
      role: 'bridge',
      machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
      projectRoot,
    },
  ];
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
      '      printf \'{"ok":true,"data":{"items":[{"bot_id":"ou-self","bot_name":"小P"},{"bot_id":"ou-cloud-cz","bot_name":"云上C总"},{"bot_id":"ou-live-c","bot_name":"小C"}]}}\\n\'',
      '    else',
      '      printf \'{"ok":true,"data":{"items":[{"bot_id":"ou-self","bot_name":"小P"}]}}\\n\'',
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
  appId: string,
  projectRoot: string,
): void {
  (h.channel as unknown as { botIdentity: { openId: string; name: string } }).botIdentity = {
    openId: 'ou-self',
    name: '小P',
  };
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
                member_id: 'ou-cloud-cz',
                name: '云上C总',
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
  (h.controls.profileConfig as unknown as {
    botRegistry: Array<{
      canonicalName: string;
      aliases: string[];
      appId: string;
      role: 'bridge';
      machines: Array<{ kind: 'local'; root: string }>;
      projectRoot: string;
    }>;
  }).botRegistry = [
    {
      canonicalName: name,
      aliases: [],
      appId,
      role: 'bridge',
      machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
      projectRoot,
    },
  ];
}

function configureThrowingRawSdkBootstrap(
  h: Harness,
  name: string,
  appId: string,
  projectRoot: string,
): void {
  (h.channel as unknown as { botIdentity: { openId: string; name: string } }).botIdentity = {
    openId: 'ou-self',
    name: '小P',
  };
  (h.channel.rawClient.im.v1 as unknown as {
    chatMembers: {
      bots(params: unknown): Promise<unknown>;
    };
  }).chatMembers = {
    async bots(): Promise<unknown> {
      throw new Error('raw SDK discovery unavailable');
    },
  };
  (h.controls.profileConfig as unknown as {
    botRegistry: Array<{
      canonicalName: string;
      aliases: string[];
      appId: string;
      role: 'bridge';
      machines: Array<{ kind: 'local'; root: string }>;
      projectRoot: string;
    }>;
  }).botRegistry = [
    {
      canonicalName: name,
      aliases: [],
      appId,
      role: 'bridge',
      machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
      projectRoot,
    },
  ];
}

function configureBootstrapBotsAppearOnlyAfterInvite(
  h: Harness,
  name: string,
  openId: string,
  appId: string,
  projectRoot: string,
  inviteLog: string,
): void {
  (h.channel as unknown as { botIdentity: { openId: string; name: string } }).botIdentity = {
    openId: 'ou-self',
    name: '小P',
  };
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
                member_id: 'ou-cloud-cz',
                name: '云上C总',
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
  (h.controls.profileConfig as unknown as {
    botRegistry: Array<{
      canonicalName: string;
      aliases: string[];
      appId: string;
      role: 'bridge';
      machines: Array<{ kind: 'local'; root: string }>;
      projectRoot: string;
    }>;
  }).botRegistry = [
    {
      canonicalName: name,
      aliases: [],
      appId,
      role: 'bridge',
      machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
      projectRoot,
    },
  ];
}

function configureBootstrapBotsAppearAfterInviteRetry(
  h: Harness,
  name: string,
  openId: string,
  appId: string,
  projectRoot: string,
  inviteLog: string,
): void {
  (h.channel as unknown as { botIdentity: { openId: string; name: string } }).botIdentity = {
    openId: 'ou-self',
    name: '小P',
  };
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
                member_id: 'ou-cloud-cz',
                name: '云上C总',
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
  (h.controls.profileConfig as unknown as {
    botRegistry: Array<{
      canonicalName: string;
      aliases: string[];
      appId: string;
      role: 'bridge';
      machines: Array<{ kind: 'local'; root: string }>;
      projectRoot: string;
    }>;
  }).botRegistry = [
    {
      canonicalName: name,
      aliases: [],
      appId,
      role: 'bridge',
      machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
      projectRoot,
    },
  ];
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
