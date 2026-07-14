import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../../platform/spawn';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export type CodexTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface CodexTurnState {
  id: string;
  status: CodexTurnStatus;
  finalText?: string;
}

export type CodexTurnStateProbe = (threadId: string) => Promise<CodexTurnState | undefined>;

export interface CreateCodexTurnStateProbeOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Read the latest persisted turn through Codex's supported app-server API.
 * This intentionally does not parse rollout JSONL files: app-server owns the
 * on-disk format and exposes the stable thread/read protocol boundary.
 */
export function createCodexTurnStateProbe(
  options: CreateCodexTurnStateProbeOptions,
): CodexTurnStateProbe {
  return async (threadId) => readLatestTurn(options, threadId);
}

async function readLatestTurn(
  options: CreateCodexTurnStateProbeOptions,
  threadId: string,
): Promise<CodexTurnState | undefined> {
  const envOverrides: NodeJS.ProcessEnv = {};
  if (options.codexHome) {
    envOverrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false) {
    envOverrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }
  const child = spawnProcess(options.binary, ['app-server', '--listen', 'stdio://'], {
    env: mergeProcessEnv(process.env, envOverrides),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CodexAppServerChild;

  return new Promise<CodexTurnState | undefined>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderr: Buffer[] = [];
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      child.stdin.removeAllListeners('error');
      child.stderr.removeAllListeners('data');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(
        new Error(
          `${error instanceof Error ? error.message : String(error)}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
        ),
      );
      cleanup();
    };
    const timer = setTimeout(() => {
      fail(new Error(`codex thread state probe timed out after ${options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS}ms`));
    }, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);

    child.once('error', fail);
    child.stdin.once('error', fail);
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('exit', (code, signal) => {
      if (!settled) fail(new Error(`codex app-server exited before thread/read response: ${code ?? signal ?? 'unknown'}`));
    });
    rl.on('line', (line) => {
      if (settled || !line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const response = recordValue(message);
      if (!response || response.id !== 2) return;
      if (response.error) {
        const error = recordValue(response.error);
        fail(new Error(stringValue(error?.message) ?? 'codex app-server rejected thread/read'));
        return;
      }
      const state = parseLatestTurn(response.result);
      resolve(state);
      cleanup();
    });

    try {
      child.stdin.write(
        `${JSON.stringify(initializeRequest())}\n${JSON.stringify(threadReadRequest(threadId))}\n`,
        'utf8',
        (error?: Error | null) => {
          if (error) fail(error);
        },
      );
    } catch (error) {
      fail(error);
    }
  });
}

function initializeRequest() {
  return {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge',
        version: '0.5.6',
      },
      capabilities: null,
    },
  };
}

function threadReadRequest(threadId: string) {
  return {
    method: 'thread/read',
    id: 2,
    params: { threadId, includeTurns: true },
  };
}

function parseLatestTurn(input: unknown): CodexTurnState | undefined {
  const result = recordValue(input);
  const thread = recordValue(result?.thread);
  if (!Array.isArray(thread?.turns)) {
    throw new Error('codex app-server returned malformed thread/read response');
  }
  const latest = recordValue(thread.turns.at(-1));
  if (!latest) return undefined;
  const id = stringValue(latest.id);
  const status = stringValue(latest.status);
  if (!id || !isTurnStatus(status)) {
    throw new Error('codex app-server returned malformed latest turn state');
  }
  const finalText = parseFinalAgentText(latest.items);
  return { id, status, ...(finalText ? { finalText } : {}) };
}

function parseFinalAgentText(input: unknown): string | undefined {
  if (!Array.isArray(input)) return undefined;
  let finalAnswer: string | undefined;
  let phaseUnknown: string | undefined;
  for (const value of input) {
    const item = recordValue(value);
    if (item?.type !== 'agentMessage') continue;
    const text = stringValue(item.text);
    if (!text) continue;
    if (item.phase === 'final_answer') finalAnswer = text;
    if (item.phase === null || item.phase === undefined) phaseUnknown = text;
  }
  return finalAnswer ?? phaseUnknown;
}

function isTurnStatus(value: string | undefined): value is CodexTurnStatus {
  return value === 'completed' || value === 'interrupted' || value === 'failed' || value === 'inProgress';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
