import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { upsertSelfRegistration } from '../../../src/config/bot-registry';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  materializeEnvSecretForService,
  resolveProfileRuntime,
} from '../../../src/runtime/profile-runtime';

const roots: string[] = [];

afterEach(async () => {
  delete process.env.BRIDGE_RACE_APP_SECRET;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile RootConfig concurrent writes', () => {
  it('preserves a concurrent bot registration during existing-profile runtime upgrades', async () => {
    const rootDir = await createRoot();
    const configPath = join(rootDir, 'config.json');
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: { id: 'cli_runtime_upgrade', secret: '${APP_SECRET}', tenant: 'feishu' },
      },
    });
    profile.workspaces = {};
    await saveRootConfig(createRootConfig('claude', profile), configPath);
    const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });

    let runtimePromise!: ReturnType<typeof resolveProfileRuntime>;
    await withConfigFileLock(configPath, async () => {
      runtimePromise = resolveProfileRuntime({
        config: configPath,
        profile: 'claude',
        allowBootstrap: false,
      });
      await waitForPath(appPaths.defaultWorkspaceDir);
      await addSelfRegistrationWhileLockHeld(configPath, {
        name: 'Registry Race Bot',
        appId: 'cli_registry_race',
      });
    });
    const runtime = await withTimeout(runtimePromise);

    const saved = await loadRootConfig(configPath);
    expect(saved?.botRegistry?.entries).toContainEqual({
      name: 'Registry Race Bot',
      aliases: [],
      appId: 'cli_registry_race',
    });
    expect(saved?.profiles.claude?.workspaces.default).toBe(await realpath(appPaths.defaultWorkspaceDir));
    expect(runtime.profileConfig.workspaces.default).toBe(await realpath(appPaths.defaultWorkspaceDir));
    expect(saved?.migrations?.permissionDefaultsV1).toContain('claude');
    await expect(loadRootConfig(configPath)).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it('preserves a concurrent bot registration during root plaintext-secret migration', async () => {
    const rootDir = await createRoot();
    const configPath = join(rootDir, 'config.json');
    const workspace = join(rootDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: { id: 'cli_plaintext_migration', secret: 'test-plaintext-secret', tenant: 'feishu' },
      },
    });
    profile.workspaces.default = workspace;
    const root = createRootConfig('claude', profile);
    root.migrations = { permissionDefaultsV1: ['claude'] };
    await saveRootConfig(root, configPath);
    const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });

    let runtimePromise!: ReturnType<typeof resolveProfileRuntime>;
    await withConfigFileLock(configPath, async () => {
      runtimePromise = resolveProfileRuntime({
        config: configPath,
        profile: 'claude',
        allowBootstrap: false,
      });
      await waitForPath(appPaths.secretsFile);
      await addSelfRegistrationWhileLockHeld(configPath, {
        name: 'Migration Registry Bot',
        appId: 'cli_migration_registry',
      });
    });
    await withTimeout(runtimePromise);

    const saved = await loadRootConfig(configPath);
    expect(saved?.botRegistry?.entries).toContainEqual({
      name: 'Migration Registry Bot',
      aliases: [],
      appId: 'cli_migration_registry',
    });
    expect(saved?.profiles.claude?.accounts.app.secret).toMatchObject({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_plaintext_migration',
    });
    await expect(loadRootConfig(configPath)).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it('preserves a concurrent bot registration during service secret materialization', async () => {
    const rootDir = await createRoot();
    const configPath = join(rootDir, 'config.json');
    process.env.BRIDGE_RACE_APP_SECRET = 'test-service-secret';
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_service_materialize',
          secret: { source: 'env', id: 'BRIDGE_RACE_APP_SECRET' },
          tenant: 'feishu',
        },
      },
      codex: { binaryPath: 'codex' },
    });
    await saveRootConfig(createRootConfig('codex', profile), configPath);
    const appPaths = resolveAppPaths({ rootDir, profile: 'codex' });

    let materializePromise!: ReturnType<typeof materializeEnvSecretForService>;
    await withConfigFileLock(configPath, async () => {
      materializePromise = materializeEnvSecretForService({
        config: configPath,
        profile: 'codex',
      });
      await waitForPath(appPaths.secretsFile);
      await addSelfRegistrationWhileLockHeld(configPath, {
        name: 'Service Registry Bot',
        appId: 'cli_service_registry',
      });
    });
    await expect(withTimeout(materializePromise)).resolves.toBe(true);

    const saved = await loadRootConfig(configPath);
    expect(saved?.botRegistry?.entries).toContainEqual({
      name: 'Service Registry Bot',
      aliases: [],
      appId: 'cli_service_registry',
    });
    expect(saved?.profiles.codex?.accounts.app.secret).toMatchObject({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_service_materialize',
    });
    await expect(loadRootConfig(configPath)).resolves.toMatchObject({ schemaVersion: 2 });
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'profile-root-config-race-'));
  roots.push(root);
  return root;
}

async function addSelfRegistrationWhileLockHeld(
  configPath: string,
  input: { name: string; appId: string },
): Promise<void> {
  const latest = await loadRootConfig(configPath);
  if (!latest) throw new Error('test root config missing');
  const result = upsertSelfRegistration(latest.botRegistry ?? { entries: [] }, input);
  if (result.kind === 'conflict') throw new Error(result.message);
  await saveRootConfig({ ...latest, botRegistry: result.registry }, configPath);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await stat(path).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for path: ${path}`);
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation deadlocked')), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
