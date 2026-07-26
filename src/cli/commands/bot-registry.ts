import { Command } from 'commander';
import { resolveAppPaths } from '../../config/app-paths';
import {
  normalizeRegistryName,
  validateBotRegistry,
  type BotRegistryEntry,
} from '../../config/bot-registry';
import {
  loadRootConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../../config/profile-store';
import { paths } from '../../config/paths';

interface BotRegistryRootOptions {
  rootDir?: string;
}

export interface BotRegistryAddOptions extends BotRegistryRootOptions {
  name: string;
  appId: string;
  aliases?: string[];
}

export interface BotRegistryRemoveOptions extends BotRegistryRootOptions {
  name: string;
}

export interface BotRegistryCommandHandlers {
  add(opts: BotRegistryAddOptions): Promise<void>;
  list(opts?: BotRegistryRootOptions): Promise<void>;
  remove(opts: BotRegistryRemoveOptions): Promise<void>;
}

const defaultHandlers: BotRegistryCommandHandlers = {
  add: runBotRegistryAdd,
  list: runBotRegistryList,
  remove: runBotRegistryRemove,
};

export function createBotRegistryCommand(
  handlers: BotRegistryCommandHandlers = defaultHandlers,
): Command {
  const command = new Command('bot-registry')
    .description('Manage the installation-level shared Bot Registry');

  command
    .command('add')
    .description('Add a Bot Registry entry')
    .requiredOption('--name <name>', 'canonical Bot display name')
    .requiredOption('--app-id <cli_xxx>', 'Bot App ID used for group invitation')
    .option('--alias <alias>', 'additional exact Bot name (repeatable)', collectOption, [])
    .action(async (opts: { name: string; appId: string; alias: string[] }) => {
      await handlers.add({
        name: opts.name,
        appId: opts.appId,
        aliases: opts.alias,
      });
    });

  command
    .command('list')
    .description('List canonical names, aliases, and App IDs')
    .action(async () => {
      await handlers.list();
    });

  command
    .command('remove')
    .description('Remove an entry by canonical Bot name')
    .requiredOption('--name <name>', 'canonical Bot display name')
    .action(async (opts: { name: string }) => {
      await handlers.remove({ name: opts.name });
    });

  return command;
}

export async function runBotRegistryAdd(opts: BotRegistryAddOptions): Promise<void> {
  const configPath = registryConfigPath(opts.rootDir);

  const outcome = await withConfigFileLock(configPath, async (): Promise<'created' | 'noop'> => {
    const root = await loadInitializedRoot(configPath);
    const registry = validateBotRegistry(root.botRegistry ?? { entries: [] });
    const candidate = validateBotRegistry({
      entries: [{
        name: opts.name,
        aliases: opts.aliases ?? [],
        appId: opts.appId,
      }],
    }).entries[0]!;
    const identical = registry.entries.find((entry) => entriesEqual(entry, candidate));
    if (identical) {
      return 'noop';
    }

    let nextRegistry;
    try {
      nextRegistry = validateBotRegistry({
        entries: [...registry.entries, candidate],
      });
    } catch (error) {
      throw new Error(`bot registry conflict: ${errorMessage(error)}`);
    }

    await saveRootConfig({ ...root, botRegistry: nextRegistry }, configPath);
    return 'created';
  });

  if (outcome === 'noop') {
    console.log(`Bot Registry entry already exists; no changes made: ${normalizeRegistryName(opts.name)}`);
    return;
  }
  console.log(`Added Bot Registry entry: ${normalizeRegistryName(opts.name)}`);
}

export async function runBotRegistryList(
  opts: BotRegistryRootOptions = {},
): Promise<void> {
  const root = await loadInitializedRoot(registryConfigPath(opts.rootDir));
  const registry = validateBotRegistry(root.botRegistry ?? { entries: [] });
  console.log(JSON.stringify(registry.entries, null, 2));
}

export async function runBotRegistryRemove(opts: BotRegistryRemoveOptions): Promise<void> {
  const configPath = registryConfigPath(opts.rootDir);
  const requestedName = normalizeRegistryName(opts.name);
  if (!requestedName) {
    throw new Error('bot registry remove requires a non-empty canonical name');
  }

  await withConfigFileLock(configPath, async () => {
    const root = await loadInitializedRoot(configPath);
    const registry = validateBotRegistry(root.botRegistry ?? { entries: [] });
    const matches = registry.entries.filter(
      (entry) => normalizeRegistryName(entry.name) === requestedName,
    );
    if (matches.length === 0) {
      throw new Error(
        `canonical Bot Registry entry not found: ${requestedName}; aliases are not accepted by remove`,
      );
    }
    if (matches.length > 1) {
      throw new Error(`multiple canonical Bot Registry entries match: ${requestedName}`);
    }

    const entry = matches[0]!;
    const occupyingProfiles = Object.entries(root.profiles)
      .filter(([, profile]) => profile.accounts.app.id.trim() === entry.appId)
      .map(([profile]) => profile)
      .sort();
    if (occupyingProfiles.length > 0) {
      throw new Error(
        `cannot remove "${entry.name}": appId "${entry.appId}" is used by local profile(s): ` +
          occupyingProfiles.join(', '),
      );
    }

    const nextRegistry = validateBotRegistry({
      entries: registry.entries.filter((candidate) => candidate !== entry),
    });
    await saveRootConfig({ ...root, botRegistry: nextRegistry }, configPath);
  });

  console.log(`Removed Bot Registry entry: ${requestedName}`);
}

function registryConfigPath(rootDir = paths.rootDir): string {
  return resolveAppPaths({ rootDir }).configFile;
}

async function loadInitializedRoot(configPath: string) {
  const root = await loadRootConfig(configPath);
  if (!root) {
    throw new Error(
      'Bot Registry is unavailable because the Bridge root config is not initialized. ' +
        'Initialize the Bridge first with `lark-channel-bridge profile create <name>` ' +
        'or `lark-channel-bridge run`.',
    );
  }
  return root;
}

function entriesEqual(left: BotRegistryEntry, right: BotRegistryEntry): boolean {
  return left.name === right.name &&
    left.appId === right.appId &&
    left.aliases.length === right.aliases.length &&
    left.aliases.every((alias, index) => alias === right.aliases[index]);
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
