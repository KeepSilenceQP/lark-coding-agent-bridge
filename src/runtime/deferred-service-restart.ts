import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';

const MARKER_FILE = '.deferred-service-restart.json';

export interface DeferredServiceRestartMarker {
  profile: string;
  bridgePid?: number;
  requestedAt: string;
}

interface SpawnedRestartHelper {
  unref(): void;
}

type SpawnRestartHelper = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedRestartHelper;

export async function requestDeferredServiceRestart(
  profileDir: string,
  marker: DeferredServiceRestartMarker,
): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  const target = join(profileDir, MARKER_FILE);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(marker)}\n`, 'utf8');
  await rename(temp, target);
}

/**
 * Atomically consumes a restart request. A marker from a previous bridge pid
 * is stale: that process has already exited, so the service manager has
 * already performed the restart the marker was asking for.
 */
export async function consumeDeferredServiceRestart(
  profileDir: string,
  bridgePid: number,
): Promise<boolean> {
  const target = join(profileDir, MARKER_FILE);
  let marker: DeferredServiceRestartMarker;
  try {
    marker = JSON.parse(await readFile(target, 'utf8')) as DeferredServiceRestartMarker;
  } catch (err) {
    if (isMissingFile(err)) return false;
    await rm(target, { force: true });
    return false;
  }
  await rm(target, { force: true });
  return marker.bridgePid === undefined || marker.bridgePid === bridgePid;
}

export function launchDeferredServiceRestart(
  profile: string,
  options: {
    spawn?: SpawnRestartHelper;
    execPath?: string;
    cliPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const execPath = options.execPath ?? process.execPath;
  const cliPath = options.cliPath ?? process.argv[1];
  if (!cliPath) throw new Error('cannot determine bridge CLI path for deferred restart');
  const env = mergeProcessEnv(options.env ?? process.env, {
    LARK_CHANNEL: undefined,
    LARK_CHANNEL_PROFILE: undefined,
    LARK_CHANNEL_BRIDGE_PID: undefined,
  });
  const child = (options.spawn ?? spawnProcess)(
    execPath,
    [cliPath, 'restart', '--profile', profile],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    },
  );
  child.unref();
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
