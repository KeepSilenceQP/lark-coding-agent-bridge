import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from './paths';
import type { AppConfig, AppPreferences, TenantBrand } from './schema';
import { secretKeyForApp } from './schema';

export async function loadConfig(path: string = paths.configFile): Promise<Partial<AppConfig>> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as Partial<AppConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Atomic write: write to a sibling temp file with 0600 perms, then rename
 * (atomic on POSIX) into place. Avoids the partial-write window where a
 * crash could leave the config truncated, and keeps secret-bearing bytes
 * from ever existing at the final path with looser perms.
 */
/**
 * Build an AppConfig that points the app's secret at the encrypted local
 * keystore via an exec-provider SecretRef. Used by /account change and the
 * first-run migration path. Preserves the existing `preferences` block so
 * users don't lose unrelated settings on credential update.
 *
 * The provider command is the bridge binary itself — when lark-cli (or
 * any other openclaw-protocol consumer) reads this config, it spawns
 * `lark-channel-bridge secrets get` and receives the decrypted secret
 * over stdout. Bridge itself short-circuits the spawn and reads the
 * keystore directly (see secret-resolver.ts).
 */
export function buildEncryptedAccountConfig(
  appId: string,
  tenant: TenantBrand,
  preferences?: AppPreferences,
): AppConfig {
  return {
    accounts: {
      app: {
        id: appId,
        secret: {
          source: 'exec',
          provider: 'bridge',
          id: secretKeyForApp(appId),
        },
        tenant,
      },
    },
    secrets: {
      providers: {
        bridge: {
          source: 'exec',
          command: process.execPath,
          args: [process.argv[1] ?? '', 'secrets', 'get'],
        },
      },
    },
    ...(preferences ? { preferences } : {}),
  };
}

export async function saveConfig(cfg: AppConfig, path: string = paths.configFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  // chmod the temp file before rename, so the destination path is never
  // visible with default permissions.
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
