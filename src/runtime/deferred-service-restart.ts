import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import { receiptDir, createPending as createPendingReceipt, readPending } from './restart-receipt';

const MARKER_FILE = '.deferred-service-restart.json';

// ── Old marker (backward compat) ───────────────────────────────────────

export interface DeferredServiceRestartMarker {
  profile: string;
  bridgePid?: number;
  requestedAt: string;
}

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
 * Check for pending restart in both the new receipt pending.json and the
 * old marker. Returns the pending state:
 * - {format: 'new', receiptId, returnRoute}: new receipt system, send receipt
 * - {format: 'old'}: old marker, just restart without receipt
 * - undefined: nothing pending
 */
export interface PendingRestartNew {
  format: 'new';
  receiptId: string;
  profile: string;
  oldPid: number;
  returnRoute: { chatId: string; threadId?: string; replyTo: string };
  deployRevision?: string;
}

export interface PendingRestartOld {
  format: 'old';
  profile: string;
}

export type PendingRestart = PendingRestartNew | PendingRestartOld;

export async function consumeDeferredServiceRestart(
  profileDir: string,
  bridgePid: number,
): Promise<PendingRestart | undefined> {
  // Check new receipt pending.json first (takes precedence)
  const newPending = await readPending(profileDir);
  if (newPending) {
    // Verify oldPid matches — only the requesting bridge can consume
    if (newPending.oldPid !== bridgePid) return undefined;
    return {
      format: 'new',
      receiptId: newPending.receiptId,
      profile: newPending.profile,
      oldPid: newPending.oldPid,
      returnRoute: newPending.returnRoute,
      deployRevision: newPending.deployRevision,
    };
  }

  // Fall back to old marker
  const target = join(profileDir, MARKER_FILE);
  let marker: DeferredServiceRestartMarker;
  try {
    marker = JSON.parse(await readFile(target, 'utf8')) as DeferredServiceRestartMarker;
  } catch (err) {
    if (isMissingFile(err)) return undefined;
    await rm(target, { force: true });
    return undefined;
  }
  await rm(target, { force: true });
  if (marker.bridgePid !== undefined && marker.bridgePid !== bridgePid) return undefined;
  return { format: 'old', profile: marker.profile };
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

// ── Helpers ────────────────────────────────────────────────────────────

interface SpawnedRestartHelper {
  unref(): void;
}

type SpawnRestartHelper = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedRestartHelper;

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
