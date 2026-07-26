import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  removeProfile,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';

const roots: string[] = [];

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-store-'));
  roots.push(root);
  return root;
}

describe('profile store canonical serialization', () => {
  it('saves stored root and profile config without unknown root fields or runtime-only profile fields', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const rootSecrets = {
      providers: {
        rootEnv: {
          source: 'env' as const,
          allowlist: ['APP_SECRET'],
        },
      },
      defaults: { env: 'rootEnv' },
    };
    const profile = {
      ...createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: { app },
        secrets: { defaults: { env: 'profileEnv' } },
        preferences: {
          messageReply: 'markdown',
          showToolCalls: false,
        },
        access: {
          allowedUsers: ['ou_user'],
          allowedChats: ['oc_chat'],
          admins: ['ou_admin'],
          groupResponseMode: 'owner-default',
          requireMentionInGroup: false,
        },
        codex: {
          binaryPath: '/usr/local/bin/codex',
          codexHome: '/tmp/codex-home',
          inheritCodexHome: false,
        },
        permissions: {
          defaultAccess: 'workspace',
          maxAccess: 'full',
        },
      }),
      workspaces: { default: '/repo' },
      attachments: {
        maxCount: 2,
        maxBytes: 1024,
        maxFileBytes: 512,
        imageMaxBytes: 256,
        cacheTtlMs: 60_000,
        cacheMaxBytes: 2048,
      },
      comments: {},
      larkCli: {
        identityPreset: 'user-default' as const,
        localUserImport: {
          status: 'imported' as const,
          attemptedAt: '2026-06-04T01:02:03.000Z',
          importedAt: '2026-06-04T01:03:03.000Z',
          reason: 'same-app-local-user',
        },
      },
      runtimeOnlyFutureField: true,
    };

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'codex',
      preferences: { messageReply: 'text' },
      secrets: rootSecrets,
      migrations: {
        permissionDefaultsV1: [
          'codex',
          'codex',
          '  claude  ',
          'claude',
          'claude ',
          '',
          42 as unknown as string,
        ],
      },
      profiles: { codex: profile },
      extra: true,
    } as unknown as RootConfig & { extra?: true; preferences: any }, configPath);

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.schemaVersion).toBe(2);
    expect(saved.activeProfile).toBe('codex');
    expect(saved.secrets).toEqual(rootSecrets);
    expect(saved.preferences).toEqual({});
    expect(saved.migrations).toEqual({ permissionDefaultsV1: ['claude', 'codex'] });
    expect(saved).not.toHaveProperty('extra');

    const savedProfile = saved.profiles.codex;
    expect(savedProfile.accounts).toEqual(profile.accounts);
    expect(savedProfile.secrets).toEqual(profile.secrets);
    expect(savedProfile.preferences).toEqual(profile.preferences);
    expect(savedProfile.access).toEqual(profile.access);
    expect(savedProfile.workspaces).toEqual(profile.workspaces);
    expect(savedProfile.codex).toEqual(profile.codex);
    expect(savedProfile.attachments).toEqual(profile.attachments);
    expect(savedProfile.comments).toEqual(profile.comments);
    expect(savedProfile.larkCli).toEqual(profile.larkCli);
    expect(savedProfile.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'full',
    });
    expect(savedProfile).not.toHaveProperty('runtimeOnlyFutureField');
    expect(savedProfile).not.toHaveProperty('permissionSource');
    expect(savedProfile).not.toHaveProperty('sandbox');

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.codex?.access).toMatchObject({
      groupResponseMode: 'owner-default',
      requireMentionInGroup: true,
    });
  });

  it('loads canonical-only saved config and re-derives runtime sandbox', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: { binaryPath: '/usr/local/bin/codex' },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'codex',
      preferences: {},
      profiles: { codex: profile },
    }, configPath);

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.codex?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(loaded?.profiles.codex?.sandbox).toMatchObject({
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    });
  });

  it('marks newly created roots as already evaluated for permission default migration', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    const root = createRootConfig('claude', profile);

    expect(root.migrations?.permissionDefaultsV1).toEqual(['claude']);
  });

  it('roundtrips ownerNoMentionChats through save and reload', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      access: {
        ownerNoMentionChats: ['oc_a', 'oc_b'],
        groupResponseMode: 'owner-allowlist',
      },
    });

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'claude',
      preferences: {},
      profiles: { claude: profile },
    }, configPath);

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.claude?.access.ownerNoMentionChats).toEqual(['oc_a', 'oc_b']);
    expect(loaded?.profiles.claude?.access.groupResponseMode).toBe('owner-allowlist');
  });
});

describe('botRegistry round-trip', () => {
  const registry = {
    entries: [
      { name: 'Planner Bot', aliases: ['Planner'], appId: 'cli_plan' },
      { name: 'Implementer Bot', aliases: ['Coder'], appId: 'cli_code' },
    ],
  };

  function rootConfig(botRegistry: unknown = registry): RootConfig {
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });
    return {
      schemaVersion: 2,
      activeProfile: 'claude',
      preferences: {},
      botRegistry: botRegistry as RootConfig['botRegistry'],
      profiles: { claude: profile },
    };
  }

  async function writeRawRegistry(configPath: string, botRegistry: unknown): Promise<string> {
    const raw = rootConfig() as unknown as Record<string, unknown>;
    raw.botRegistry = botRegistry;
    const bytes = `${JSON.stringify(raw, null, 2)}\n`;
    await writeFile(configPath, bytes, { mode: 0o600 });
    return bytes;
  }

  it('missing botRegistry normalizes to {entries: []} on load', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const legacy = rootConfig() as RootConfig & { botRegistry?: unknown };
    delete legacy.botRegistry;
    await writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.botRegistry).toEqual({ entries: [] });
  });

  it('missing botRegistry is serialized as empty', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const legacy = rootConfig() as RootConfig & { botRegistry?: unknown };
    delete legacy.botRegistry;
    await saveRootConfig(legacy, configPath);

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as RootConfig;
    expect(saved.botRegistry).toEqual({ entries: [] });
  });

  it('valid botRegistry is normalized and preserved through save and load', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const unnormalized = {
      entries: [
        { name: ' Planner Bot ', aliases: [' @Planner '], appId: ' cli_plan ' },
        { name: 'Implementer Bot', aliases: ['Coder'], appId: 'cli_code' },
      ],
    };

    await saveRootConfig(rootConfig(unnormalized), configPath);

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.botRegistry).toEqual(registry);
  });

  it('createRootConfig initializes botRegistry as empty', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(createRootConfig('claude', profile).botRegistry).toEqual({ entries: [] });
  });

  it('preserves botRegistry across active-profile updates and profile removal', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const codex = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: { binaryPath: '/usr/local/bin/codex' },
    });
    const claude = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { ...app, id: 'cli_second' } },
    });
    const config: RootConfig = {
      ...rootConfig(),
      activeProfile: 'codex',
      profiles: { codex, claude },
    };
    await saveRootConfig(config, configPath);

    const loaded = await loadRootConfig(configPath);
    expect(loaded).toBeDefined();
    await saveRootConfig({ ...loaded!, activeProfile: 'claude' }, configPath);

    const codexDir = resolveAppPaths({ rootDir: root, profile: 'codex' }).profileDir;
    await mkdir(codexDir, { recursive: true });
    const result = await removeProfile((await loadRootConfig(configPath))!, 'codex', root, {
      purge: true,
    });
    await saveRootConfig(result.root, configPath);

    const afterRemove = await loadRootConfig(configPath);
    expect(afterRemove?.botRegistry).toEqual(registry);
    expect(afterRemove?.profiles.codex).toBeUndefined();
    expect(afterRemove?.profiles.claude).toBeDefined();
  });

  const invalidRegistries: Array<[string, unknown]> = [
    ['invalid structure', 'not-an-object'],
    ['invalid entry', { entries: [{ name: 'Bot', aliases: 'not-an-array', appId: 'cli_a' }] }],
    [
      'canonical name conflict',
      {
        entries: [
          { name: 'Same Name', aliases: [], appId: 'cli_a' },
          { name: 'Same Name', aliases: [], appId: 'cli_b' },
        ],
      },
    ],
    [
      'alias conflict',
      {
        entries: [
          { name: 'Bot A', aliases: ['Shared'], appId: 'cli_a' },
          { name: 'Bot B', aliases: ['Shared'], appId: 'cli_b' },
        ],
      },
    ],
    [
      'appId conflict',
      {
        entries: [
          { name: 'Bot A', aliases: [], appId: 'cli_same' },
          { name: 'Bot B', aliases: [], appId: 'cli_same' },
        ],
      },
    ],
  ];

  it.each(invalidRegistries)('load fails closed for %s without changing file bytes', async (_label, invalid) => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const original = await writeRawRegistry(configPath, invalid);
    await expect(loadRootConfig(configPath)).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it.each(invalidRegistries)('save rejects %s before writing', async (_label, invalid) => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    await saveRootConfig(rootConfig(), configPath);
    const original = await readFile(configPath, 'utf8');
    await expect(saveRootConfig(rootConfig(invalid), configPath)).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });
});
