/**
 * Bounded process-tree runner for the at-bot command.
 *
 * Each lark-cli invocation spawns through a Node wrapper that in turn
 * spawns a native child. This module therefore:
 *
 * - spawns with detached:true (POSIX) so wrapper + native child share a
 *   process group;
 * - drains stdout/stderr only after original close (not exit);
 * - kills the whole group on timeout or output overflow;
 * - on Windows, uses taskkill /T /F only while the wrapper PID is live;
 *   returns termination-unconfirmed otherwise.
 * - on POSIX, kill failure (process group or direct child) upgrades to
 *   termination-unconfirmed.
 * - `child.kill()` return-false is treated as kill failure.
 */

import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import {
  spawnProcess,
  spawnProcessSync,
} from '../../platform/spawn';

export interface BoundedProcessResult {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
  settled: 'exit' | 'timeout' | 'overflow' | 'unavailable' | 'termination-unconfirmed';
}

export interface BoundedProcessOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Injectable platform/spawn deps so tests can control OS and child processes. */
export interface BoundedProcessDeps {
  platform: () => string;
  spawn: typeof spawnProcess;
  spawnSync: typeof spawnProcessSync;
}

const DEFAULT_DEPS: BoundedProcessDeps = {
  platform: () => osPlatform(),
  spawn: spawnProcess,
  spawnSync: spawnProcessSync,
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB
const CLOSE_CONFIRM_MS = 5_000;
const TASKKILL_TIMEOUT_MS = 5_000;
const TASKKILL_OUTPUT_BYTES = 16_384;

type SettleCause = BoundedProcessResult['settled'];

export function runBoundedProcess(
  command: string,
  args: readonly string[],
  opts: BoundedProcessOptions = {},
  deps: BoundedProcessDeps = DEFAULT_DEPS,
): Promise<BoundedProcessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<BoundedProcessResult>((resolve) => {
    let settled = false;
    let cause: SettleCause | null = null;
    let child: ChildProcess | null = null;
    let hasPid = false;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let exitCode: number | null = null;
    let signalCode: string | null = null;

    let execTimer: ReturnType<typeof setTimeout> | null = null;
    let closeConfirmTimer: ReturnType<typeof setTimeout> | null = null;

    const isWindows = deps.platform() === 'win32';

    const clearAllTimers = () => {
      if (execTimer) { clearTimeout(execTimer); execTimer = null; }
      if (closeConfirmTimer) { clearTimeout(closeConfirmTimer); closeConfirmTimer = null; }
    };

    const settle = (finalCause: SettleCause) => {
      if (settled) return;
      settled = true;
      cause = finalCause;
      clearAllTimers();

      if (finalCause === 'termination-unconfirmed' && child) {
        try {
          if (child.stdout) { child.stdout.destroy(); }
          if (child.stderr) { child.stderr.destroy(); }
          child.unref();
          child.removeAllListeners();
        } catch { /* best-effort */ }
      }

      resolve({
        exitCode,
        signalCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        settled: cause!,
      });
    };

    const killTree = () => {
      if (!child) return;
      if (isWindows) {
        if (!hasPid) {
          settle('termination-unconfirmed');
          return;
        }
        try {
          const result = deps.spawnSync(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            {
              timeout: TASKKILL_TIMEOUT_MS,
              maxBuffer: TASKKILL_OUTPUT_BYTES,
              encoding: 'utf8',
            },
          );
          if (result.status === 128) {
            settle('termination-unconfirmed');
            return;
          }
          if (result.status !== 0) {
            settle('termination-unconfirmed');
            return;
          }
        } catch {
          settle('termination-unconfirmed');
          return;
        }
      } else {
        // POSIX: kill the process group first, then direct child.
        let killOk = false;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
            killOk = true;
          } catch {
            // Process group already gone; try direct child.
            try {
              const ok = child.kill('SIGKILL');
              if (ok) killOk = true;
            } catch {
              // child.kill itself threw — both methods failed.
            }
          }
        }
        if (!killOk) {
          settle('termination-unconfirmed');
          return;
        }
      }
      closeConfirmTimer = setTimeout(() => {
        settle('termination-unconfirmed');
      }, CLOSE_CONFIRM_MS);
    };

    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    };

    if (!isWindows) {
      spawnOpts.detached = true;
    }

    let childProcess: ChildProcess;
    try {
      childProcess = deps.spawn(command, [...args], spawnOpts);
    } catch {
      settle('unavailable');
      return;
    }

    child = childProcess;
    hasPid = child.pid !== undefined;

    execTimer = setTimeout(() => {
      if (!cause) {
        cause = 'timeout';
        killTree();
      }
    }, timeoutMs);

    child.on('error', () => {
      if (!cause) {
        cause = 'unavailable';
        if (hasPid) {
          killTree();
        } else {
          closeConfirmTimer = setTimeout(() => settle('unavailable'), CLOSE_CONFIRM_MS);
        }
      }
    });

    child.on('exit', (code, sig) => {
      exitCode = code;
      signalCode = sig;
      if (isWindows) {
        hasPid = false;
      }
      // Do NOT clear execTimer — timer stays armed until close.
    });

    child.on('close', () => {
      if (!cause) {
        // On Windows, when the wrapper exited before close (hasPid false),
        // the PID is extinct and taskkill cannot tree-discover orphans.
        // Must fail-closed rather than reporting a clean exit.
        if (isWindows && !hasPid) {
          settle('termination-unconfirmed');
        } else {
          settle('exit');
        }
      } else {
        settle(cause);
      }
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutLen += chunk.length;
        if (stdoutLen > maxBytes) {
          if (!cause) { cause = 'overflow'; killTree(); }
          return;
        }
        stdoutChunks.push(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrLen += chunk.length;
        if (stderrLen > maxBytes) {
          if (!cause) { cause = 'overflow'; killTree(); }
          return;
        }
        stderrChunks.push(chunk);
      });
    }
  });
}
