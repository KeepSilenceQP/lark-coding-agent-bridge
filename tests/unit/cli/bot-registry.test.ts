import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBotRegistryCommand,
  runBotRegistryList,
  type BotRegistryCommandHandlers,
} from '../../../src/cli/commands/bot-registry';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bot-registry CLI parameters', () => {
  it('registers only add/list/remove without a profile option', () => {
    const command = createBotRegistryCommand(mockHandlers());

    expect(command.commands.map((child) => child.name())).toEqual(['add', 'list', 'remove']);
    const allFlags = [
      ...command.options,
      ...command.commands.flatMap((child) => child.options),
    ].map((option) => option.flags);
    expect(allFlags).not.toContain('--profile <name>');
    expect(command.commands.find((child) => child.name() === 'add')?.options.map(
      (option) => option.flags,
    )).toEqual([
      '--name <name>',
      '--app-id <cli_xxx>',
      '--alias <alias>',
    ]);
  });

  it('is registered on the root CLI program', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toContain("import { createBotRegistryCommand } from './commands/bot-registry'");
    expect(source).toContain('program.addCommand(createBotRegistryCommand())');
  });

  it('parses repeated aliases and forwards canonical named options', async () => {
    const handlers = mockHandlers();
    const command = configuredCommand(handlers);

    await command.parseAsync([
      'node',
      'test',
      'add',
      '--name',
      'Planner Bot',
      '--app-id',
      'cli_planner',
      '--alias',
      'Planner',
      '--alias',
      'Cloud Planner',
    ]);

    expect(handlers.add).toHaveBeenCalledWith({
      name: 'Planner Bot',
      appId: 'cli_planner',
      aliases: ['Planner', 'Cloud Planner'],
    });
  });

  it('requires add name/app-id and remove name', async () => {
    const addCommand = configuredCommand(mockHandlers());
    await expect(addCommand.parseAsync([
      'node',
      'test',
      'add',
      '--name',
      'Planner',
    ])).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });

    const removeCommand = configuredCommand(mockHandlers());
    await expect(removeCommand.parseAsync([
      'node',
      'test',
      'remove',
    ])).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
  });
});

describe('bot-registry list output', () => {
  it('outputs only canonical name, aliases, and appId', async () => {
    const rootDir = await makeRoot();
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: {
          id: 'cli_local',
          secret: 'highly-sensitive-test-secret',
          tenant: 'feishu',
        },
      },
    });
    await saveRootConfig({
      ...createRootConfig('local', profile),
      botRegistry: {
        entries: [{
          name: 'Planner Bot',
          aliases: ['Planner'],
          appId: 'cli_planner',
        }],
      },
    }, join(rootDir, 'config.json'));
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));

    await runBotRegistryList({ rootDir });

    expect(JSON.parse(lines.join('\n'))).toEqual([{
      name: 'Planner Bot',
      aliases: ['Planner'],
      appId: 'cli_planner',
    }]);
    expect(lines.join('\n')).not.toContain('highly-sensitive-test-secret');
    expect(lines.join('\n')).not.toContain('profiles');
    expect(lines.join('\n')).not.toContain('accounts');
  });
});

function configuredCommand(handlers: BotRegistryCommandHandlers) {
  const command = createBotRegistryCommand(handlers);
  for (const current of [command, ...command.commands]) {
    current.exitOverride();
    current.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  }
  return command;
}

function mockHandlers(): BotRegistryCommandHandlers {
  return {
    add: vi.fn(async () => {}),
    list: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bot-registry-unit-'));
  roots.push(root);
  return root;
}
