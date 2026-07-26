import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runBotRegistryAdd,
  runBotRegistryList,
  runBotRegistryRemove,
} from '../../../src/cli/commands/bot-registry';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bot-registry CLI persistence', () => {
  it('distinguishes an uninitialized installation from a zero-profile root', async () => {
    const uninitialized = await makeRoot();
    const expectedGuidance = /not initialized.*profile create|not initialized.*run/is;

    await expect(runBotRegistryList({ rootDir: uninitialized })).rejects.toThrow(
      expectedGuidance,
    );
    await expect(runBotRegistryAdd({
      rootDir: uninitialized,
      name: 'Planner',
      appId: 'cli_planner',
    })).rejects.toThrow(expectedGuidance);
    await expect(runBotRegistryRemove({
      rootDir: uninitialized,
      name: 'Planner',
    })).rejects.toThrow(expectedGuidance);

    const zeroProfile = await makeRoot();
    await saveRootConfig(zeroProfileRoot(), configPath(zeroProfile));
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));

    await runBotRegistryAdd({
      rootDir: zeroProfile,
      name: 'Planner',
      appId: 'cli_planner',
      aliases: ['Plan Writer'],
    });
    await runBotRegistryList({ rootDir: zeroProfile });
    await runBotRegistryRemove({ rootDir: zeroProfile, name: 'Planner' });

    const saved = await loadRootConfig(configPath(zeroProfile));
    expect(saved?.profiles).toEqual({});
    expect(saved?.activeProfile).toBe('');
    expect(saved?.botRegistry?.entries).toEqual([]);
    expect(lines.some((line) => line.includes('cli_planner'))).toBe(true);
  });

  it('treats an identical add as a successful no-op with byte-for-byte preservation', async () => {
    const rootDir = await makeRoot();
    await saveRootConfig({
      ...zeroProfileRoot(),
      botRegistry: {
        entries: [{
          name: 'Planner',
          aliases: ['Plan Writer'],
          appId: 'cli_planner',
        }],
      },
    }, configPath(rootDir));
    const before = await readFile(configPath(rootDir), 'utf8');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));

    await runBotRegistryAdd({
      rootDir,
      name: ' Planner ',
      appId: ' cli_planner ',
      aliases: [' Plan Writer '],
    });

    expect(await readFile(configPath(rootDir), 'utf8')).toBe(before);
    expect(lines.join('\n')).toMatch(/no changes/i);
  });

  it.each([
    {
      label: 'same appId with a different canonical name',
      input: { name: 'Other', appId: 'cli_planner', aliases: [] },
    },
    {
      label: 'canonical name occupied by another appId',
      input: { name: 'Planner', appId: 'cli_other', aliases: [] },
    },
    {
      label: 'same name and appId with different aliases',
      input: { name: 'Planner', appId: 'cli_planner', aliases: ['Different Alias'] },
    },
    {
      label: 'new canonical name occupied by an existing alias',
      input: { name: 'Plan Writer', appId: 'cli_other', aliases: [] },
    },
    {
      label: 'new alias occupied by an existing canonical name',
      input: { name: 'Other', appId: 'cli_other', aliases: ['Planner'] },
    },
  ])('fails closed for $label', async ({ input }) => {
    const rootDir = await rootWithEntries([{
      name: 'Planner',
      aliases: ['Plan Writer'],
      appId: 'cli_planner',
    }]);
    const before = await readFile(configPath(rootDir), 'utf8');

    await expect(runBotRegistryAdd({ rootDir, ...input })).rejects.toThrow();

    expect(await readFile(configPath(rootDir), 'utf8')).toBe(before);
    expect((await loadRootConfig(configPath(rootDir)))?.botRegistry?.entries).toHaveLength(1);
  });

  it('serializes concurrent distinct adds under the shared config lock', async () => {
    const rootDir = await makeRoot();
    await saveRootConfig(zeroProfileRoot(), configPath(rootDir));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await Promise.all([
      runBotRegistryAdd({
        rootDir,
        name: 'Planner',
        appId: 'cli_planner',
        aliases: ['Plan Writer'],
      }),
      runBotRegistryAdd({
        rootDir,
        name: 'Implementer',
        appId: 'cli_implementer',
        aliases: ['Coder'],
      }),
    ]);

    expect((await loadRootConfig(configPath(rootDir)))?.botRegistry?.entries).toEqual(
      expect.arrayContaining([
        { name: 'Planner', aliases: ['Plan Writer'], appId: 'cli_planner' },
        { name: 'Implementer', aliases: ['Coder'], appId: 'cli_implementer' },
      ]),
    );
  });

  it('refuses to remove an entry used by any local profile and preserves bytes', async () => {
    const rootDir = await makeRoot();
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: {
          id: 'cli_local',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
    });
    await saveRootConfig({
      ...createRootConfig('local', profile),
      botRegistry: {
        entries: [{ name: 'Local Bot', aliases: [], appId: 'cli_local' }],
      },
    }, configPath(rootDir));
    const before = await readFile(configPath(rootDir), 'utf8');

    await expect(runBotRegistryRemove({
      rootDir,
      name: 'Local Bot',
    })).rejects.toThrow(/used by local profile.*local/i);

    expect(await readFile(configPath(rootDir), 'utf8')).toBe(before);
  });

  it('removes by NFC-exact canonical name only and rejects aliases without writing', async () => {
    const rootDir = await rootWithEntries([{
      name: 'Cafe\u0301 Bot',
      aliases: ['Helper'],
      appId: 'cli_remote',
    }]);
    const before = await readFile(configPath(rootDir), 'utf8');

    await expect(runBotRegistryRemove({
      rootDir,
      name: 'Helper',
    })).rejects.toThrow(/canonical.*not found|aliases are not accepted/i);
    expect(await readFile(configPath(rootDir), 'utf8')).toBe(before);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runBotRegistryRemove({ rootDir, name: 'Café Bot' });
    expect((await loadRootConfig(configPath(rootDir)))?.botRegistry?.entries).toEqual([]);
  });

  it('does not rewrite malformed Registry bytes when validation fails', async () => {
    const rootDir = await makeRoot();
    const malformed = JSON.stringify({
      ...zeroProfileRoot(),
      botRegistry: {
        entries: [
          { name: 'Duplicate', aliases: [], appId: 'cli_one' },
          { name: 'Duplicate', aliases: [], appId: 'cli_two' },
        ],
      },
    });
    await writeFile(configPath(rootDir), malformed);

    await expect(runBotRegistryAdd({
      rootDir,
      name: 'Other',
      appId: 'cli_other',
    })).rejects.toThrow(/already used/);

    expect(await readFile(configPath(rootDir), 'utf8')).toBe(malformed);
  });
});

async function rootWithEntries(
  entries: NonNullable<RootConfig['botRegistry']>['entries'],
): Promise<string> {
  const rootDir = await makeRoot();
  await saveRootConfig({
    ...zeroProfileRoot(),
    botRegistry: { entries },
  }, configPath(rootDir));
  return rootDir;
}

function zeroProfileRoot(): RootConfig {
  return {
    schemaVersion: 2,
    activeProfile: '',
    preferences: {},
    botRegistry: { entries: [] },
    profiles: {},
  };
}

function configPath(rootDir: string): string {
  return join(rootDir, 'config.json');
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bot-registry-integration-'));
  roots.push(root);
  return root;
}
