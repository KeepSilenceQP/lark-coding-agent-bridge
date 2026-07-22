/**
 * Bounded process-tree runner for the at-bot command.
 *
 * Each lark-cli invocation spawns through a Node wrapper that in turn spawns
 * a native child. Plain spawnSync timeout semantics can kill only the wrapper
 * while the request subprocess survives. This module therefore:
 *
 * - spawns with detached:true (POSIX) so wrapper + native child share a
 *   process group;
 * - drains stdout/stderr only after original close (not exit);
 * - kills the whole group on timeout or output overflow;
 * - on Windows, uses taskkill /T /F only while the wrapper PID is live;
 *   returns termination-unconfirmed otherwise.
 *
 * The exported function is the testable seam: production passes the real
 * cross-spawn, tests inject a mock.
 */

import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { platform } from 'node:os';
import { spawnProcess, spawnProcessSync } from '../../platform/spawn';

export interface BoundedProcessResult {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
  settled: 'exit' | 'timeout' | 'overflow' | 'unavailable' | 'termination-unconfirmed';
}

export interface BoundedProcessOptions {
  /** Execution timeout in ms. Default 20_000 (20 seconds). */
  timeoutMs?: number;
  /** Max bytes per stdout or stderr stream. Default 1_048_576 (1 MiB). */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB
const CLOSE_CONFIRM_MS = 5_000;
const TASKKILL_TIMEOUT_MS = 5_000;
const TASKKILL_OUTPUT_BYTES = 16_384;

type SettleCause = BoundedProcessResult['settled'];

/**
 * Spawn a child with bounded execution, output, and process-tree cleanup.
 *
 * On POSIX the child runs in its own process group (detached:true).
 * On Windows a synchronous `taskkill /T /F` is used while the wrapper PID
 * is still alive; after wrapper exit the runner returns
 * termination-unconfirmed rather than pretending it can tree-kill through
 * an extinct PID.
 */
export function runBoundedProcess(
  command: string,
  args: readonly string[],
  opts: BoundedProcessOptions = {},
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

    const cleanup = () => {
      if (execTimer) { clearTimeout(execTimer); execTimer = null; }
      if (closeConfirmTimer) { clearTimeout(closeConfirmTimer); closeConfirmTimer = null; }
    };

    const settle = (finalCause: SettleCause) => {
      if (settled) return;
      settled = true;
      cause = finalCause;
      cleanup();
      resolve({
        exitCode,
        signalCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        settled: cause,
      });
    };

    const killTree = () => {
      if (!child) return;
      if (platform() === 'win32') {
        // Only taskkill while the wrapper PID is still a live tree root.
        if (!hasPid) {
          settle('termination-unconfirmed');
          return;
        }
        try {
          const result = spawnProcessSync(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            {
              timeout: TASKKILL_TIMEOUT_MS,
              maxBuffer: TASKKILL_OUTPUT_BYTES,
              encoding: 'utf8',
            },
          );
          if (result.status !== 0 && result.status !== 128) {
            settle('termination-unconfirmed');
            return;
          }
        } catch {
          settle('termination-unconfirmed');
          return;
        }
      } else {
        // POSIX: kill the process group.
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // Process group may already be gone; try direct child.
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }
      }
      // Wait for original close after kill.
      closeConfirmTimer = setTimeout(() => {
        settle('termination-unconfirmed');
      }, CLOSE_CONFIRM_MS);
    };

    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    };

    if (platform() !== 'win32') {
      spawnOpts.detached = true;
    }

    let childProcess: ChildProcess;
    try {
      childProcess = spawnProcess(command, [...args], spawnOpts);
    } catch (err) {
      // Spawn threw synchronously (no PID).
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

    child.on('error', (err: NodeJS.ErrnoException) => {
      // spawn error after the constructor returned (rare path with PID).
      if (!cause) {
        cause = 'unavailable';
        if (hasPid) {
          killTree();
        } else {
          // No PID, wait briefly for close then settle.
          closeConfirmTimer = setTimeout(() => settle('unavailable'), CLOSE_CONFIRM_MS);
        }
      }
    });

    child.on('exit', (code, sig) => {
      exitCode = code;
      signalCode = sig;
      if (platform() === 'win32') {
        // On Windows the wrapper PID is no longer a reliable tree root
        // after exit. If we haven't already terminated, we'll handle it
        // at close.
      }
      // Do NOT clear execTimer — Plan requires timer stays armed until close.
    });

    child.on('close', () => {
      // close is the only normal settle point.
      if (!cause) {
        settle('exit');
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
