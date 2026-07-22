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
  timeoutMs?: number;
  maxOutputBytes?: number;
}

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

    const clearAllTimers = () => {
      if (execTimer) { clearTimeout(execTimer); execTimer = null; }
      if (closeConfirmTimer) { clearTimeout(closeConfirmTimer); closeConfirmTimer = null; }
    };

    const settle = (finalCause: SettleCause) => {
      if (settled) return;
      settled = true;
      cause = finalCause;
      clearAllTimers();

      // On termination-unconfirmed: destroy local pipes and unref the
      // child so the CLI can return the stronger blocker. The caller
      // must not retry automatically because an external side effect
      // remains possible.
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
          // taskkill exit status: 0 = success, 128 = process not found
          // (already exited). Neither means we confirmed tree cleanup.
          // Status 128 means the PID was already gone — termination-unconfirmed.
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
        // POSIX: kill the process group.
        let killOk = false;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
            killOk = true;
          } catch {
            // Process group may already be gone; try direct child.
            try {
              child.kill('SIGKILL');
              killOk = true;
            } catch {
              /* neither worked */
            }
          }
        }
        if (!killOk) {
          // Neither group nor direct kill succeeded — cannot confirm
          // process-tree cleanup.
          settle('termination-unconfirmed');
          return;
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
    } catch {
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
      // On Windows the wrapper PID is no longer a reliable tree root
      // after exit. Invalidate hasPid so future killTree calls don't
      // attempt taskkill on an extinct PID.
      if (platform() === 'win32') {
        hasPid = false;
      }
      // Do NOT clear execTimer — timer stays armed until close.
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
