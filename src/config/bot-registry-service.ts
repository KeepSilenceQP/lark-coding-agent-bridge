import * as profileStore from './profile-store';
import {
  upsertSelfRegistration,
  type BotRegistryEntry,
} from './bot-registry';

export type BotRegistrySelfRegistrationOutcome =
  | { kind: 'created'; entry: BotRegistryEntry }
  | { kind: 'noop'; entry: BotRegistryEntry }
  | { kind: 'conflict'; message: string }
  | { kind: 'failed'; error: Error };

export interface BotRegistryServiceDependencies {
  withConfigFileLock<T>(configPath: string, fn: () => Promise<T>): Promise<T>;
  loadRootConfig: typeof profileStore.loadRootConfig;
  saveRootConfig: typeof profileStore.saveRootConfig;
}

/**
 * Register the connected bot's observed identity in the installation-level
 * registry. The complete load → upsert → save sequence runs under the config
 * file lock so it cannot overwrite a concurrent RootConfig update.
 *
 * Operational failures are returned as data: self-registration is
 * best-effort and must never tear down an already-established bot connection.
 */
export async function ensureBotRegistrySelfRegistration(
  input: { configPath: string; name: string; appId: string },
  dependencies?: BotRegistryServiceDependencies,
): Promise<BotRegistrySelfRegistrationOutcome> {
  const serviceDependencies = dependencies ?? defaultDependencies();
  try {
    return await serviceDependencies.withConfigFileLock(input.configPath, async () => {
      const root = await serviceDependencies.loadRootConfig(input.configPath);
      if (!root) {
        throw new Error(`RootConfig not found or invalid: ${input.configPath}`);
      }

      const result = upsertSelfRegistration(root.botRegistry ?? { entries: [] }, {
        name: input.name,
        appId: input.appId,
      });
      if (result.kind === 'conflict') {
        return result;
      }
      if (result.kind === 'noop') {
        return { kind: 'noop', entry: result.entry };
      }

      await serviceDependencies.saveRootConfig(
        { ...root, botRegistry: result.registry },
        input.configPath,
      );
      return { kind: 'created', entry: result.entry };
    });
  } catch (error) {
    return {
      kind: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function defaultDependencies(): BotRegistryServiceDependencies {
  return {
    withConfigFileLock: profileStore.withConfigFileLock,
    loadRootConfig: profileStore.loadRootConfig,
    saveRootConfig: profileStore.saveRootConfig,
  };
}
