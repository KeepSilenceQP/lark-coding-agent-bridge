import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureBotRegistrySelfRegistration,
  type BotRegistryServiceDependencies,
} from '../../../src/config/bot-registry-service';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('ensureBotRegistrySelfRegistration', () => {
  let rootDir: string;
  let configPath: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'bot-registry-service-'));
    configPath = join(rootDir, 'config.json');
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('creates and persists a new entry', async () => {
    await saveRootConfig(emptyRoot(), configPath);

    const result = await ensureBotRegistrySelfRegistration({
      configPath,
      name: 'Bridge',
      appId: 'cli_bridge',
    });

    expect(result).toEqual({
      kind: 'created',
      entry: { name: 'Bridge', aliases: [], appId: 'cli_bridge' },
    });
    expect((await loadRootConfig(configPath))?.botRegistry).toEqual({
      entries: [{ name: 'Bridge', aliases: [], appId: 'cli_bridge' }],
    });
  });

  it('returns noop without saving or changing file bytes', async () => {
    await saveRootConfig({
      ...emptyRoot(),
      botRegistry: {
        entries: [{ name: 'Bridge', aliases: ['Coordinator Bot'], appId: 'cli_bridge' }],
      },
    }, configPath);
    const before = await readFile(configPath, 'utf8');
    const save = vi.fn<typeof saveRootConfig>();

    const result = await ensureBotRegistrySelfRegistration(
      { configPath, name: 'Bridge', appId: 'cli_bridge' },
      dependencies({ saveRootConfig: save }),
    );

    expect(result).toEqual({
      kind: 'noop',
      entry: { name: 'Bridge', aliases: ['Coordinator Bot'], appId: 'cli_bridge' },
    });
    expect(save).not.toHaveBeenCalled();
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('returns conflict without saving, overwriting bytes, or invalidating RootConfig', async () => {
    await saveRootConfig({
      ...emptyRoot(),
      botRegistry: {
        entries: [{ name: 'Existing', aliases: [], appId: 'cli_bridge' }],
      },
    }, configPath);
    const before = await readFile(configPath, 'utf8');
    const save = vi.fn<typeof saveRootConfig>();

    const result = await ensureBotRegistrySelfRegistration(
      { configPath, name: 'Bridge', appId: 'cli_bridge' },
      dependencies({ saveRootConfig: save }),
    );

    expect(result.kind).toBe('conflict');
    expect(save).not.toHaveBeenCalled();
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect((await loadRootConfig(configPath))?.botRegistry).toEqual({
      entries: [{ name: 'Existing', aliases: [], appId: 'cli_bridge' }],
    });
  });

  it('contains lock failure instead of throwing', async () => {
    const result = await ensureBotRegistrySelfRegistration(
      { configPath, name: 'Bridge', appId: 'cli_bridge' },
      dependencies({
        withConfigFileLock: async () => {
          throw new Error('lock timeout');
        },
      }),
    );

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error.message).toBe('lock timeout');
    }
  });

  it('contains disk save failure and preserves the previous file bytes', async () => {
    await saveRootConfig(emptyRoot(), configPath);
    const before = await readFile(configPath, 'utf8');

    const result = await ensureBotRegistrySelfRegistration(
      { configPath, name: 'Bridge', appId: 'cli_bridge' },
      dependencies({
        saveRootConfig: async () => {
          throw new Error('disk full');
        },
      }),
    );

    expect(result.kind).toBe('failed');
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('contains invalid RootConfig failure without overwriting its bytes', async () => {
    const invalid = '{"schemaVersion":2,"profiles":';
    await writeFile(configPath, invalid);

    const result = await ensureBotRegistrySelfRegistration({
      configPath,
      name: 'Bridge',
      appId: 'cli_bridge',
    });

    expect(result.kind).toBe('failed');
    expect(await readFile(configPath, 'utf8')).toBe(invalid);
  });
});

function emptyRoot() {
  return createRootConfig(
    'test',
    createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: {
          id: 'cli_bridge',
          secret: 'secret',
          tenant: 'feishu',
        },
      },
    }),
  );
}

function dependencies(
  overrides: Partial<BotRegistryServiceDependencies>,
): BotRegistryServiceDependencies {
  return {
    withConfigFileLock,
    loadRootConfig,
    saveRootConfig,
    ...overrides,
  };
}
