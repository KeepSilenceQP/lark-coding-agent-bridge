import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readLegacyForegroundMetadata } from './legacy-foreground';
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
  itemCount: number;
  finalText?: string;
  parentThreadId?: string;
  foregroundChildThreadIds?: string[];
  progressToken?: string;
  hasRunningTool?: boolean;
  foregroundLinkSource?: 'legacy-rollout';
  foregroundProbeReason?: string;
  foregroundCandidateCount?: number;
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
      void parseLatestTurn(response.result, threadId).then((state) => {
        if (settled) return;
        resolve(state);
        cleanup();
      }, fail);
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

async function parseLatestTurn(input: unknown, threadId: string): Promise<CodexTurnState | undefined> {
  const result = recordValue(input);
  const thread = recordValue(result?.thread);
  if (!Array.isArray(thread?.turns)) {
    throw new Error('codex app-server returned malformed thread/read response');
  }
  if (thread.id !== undefined && thread.id !== threadId) {
    throw new Error('codex app-server returned a different thread');
  }
  const latest = recordValue(thread.turns.at(-1));
  if (!latest) return undefined;
  const id = stringValue(latest.id);
  const status = stringValue(latest.status);
  if (!id || !isTurnStatus(status)) {
    throw new Error('codex app-server returned malformed latest turn state');
  }
  if (!Array.isArray(latest.items)) {
    throw new Error('codex app-server returned latest turn without items');
  }
  const finalText = parseFinalAgentText(latest.items);
  const children = new Set<string>();
  const candidates = new Set<string>();
  let hasRunningTool = false;
  const progress = latest.items.map((value) => {
    const item = recordValue(value);
    if (item?.type === 'subAgentActivity' && item.kind === 'started') {
      const childId = stringValue(item.agentThreadId);
      if (childId && childId !== threadId) candidates.add(childId);
    }
    if (item?.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' &&
        item.senderThreadId === threadId && item.runInBackground === false &&
        item.status !== 'failed' && Array.isArray(item.receiverThreadIds)) {
      for (const child of item.receiverThreadIds) {
        if (typeof child === 'string' && child && child !== threadId) children.add(child);
      }
    }
    if (['commandExecution', 'mcpToolCall', 'collabAgentToolCall'].includes(String(item?.type)) &&
        item?.status === 'inProgress') hasRunningTool = true;
    // Only lifecycle metadata and output length enter the in-memory fingerprint.
    // Prompts, tool inputs/results and reasoning are never retained or logged.
    return [item?.id, item?.type, item?.status,
      typeof item?.aggregatedOutput === 'string' ? item.aggregatedOutput.length : undefined];
  });
  const source = recordValue(thread.source);
  const subAgent = recordValue(source?.subAgent ?? source?.subagent);
  const spawnSource = recordValue(subAgent?.thread_spawn);
  const parentThreadId = stringValue(thread.parentThreadId) ?? stringValue(spawnSource?.parent_thread_id);
  const legacy = !children.size && candidates.size
    ? await readLegacyForegroundMetadata(thread.path, threadId, id, [...candidates]) : undefined;
  for (const childId of legacy?.childThreadIds ?? []) children.add(childId);
  if (legacy) progress.push(['legacy-foreground-results', ...legacy.completedCallIds]);
  return {
    id, status, itemCount: latest.items.length,
    progressToken: createHash('sha256').update(JSON.stringify(progress)).digest('hex'),
    ...(finalText ? { finalText } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(children.size ? { foregroundChildThreadIds: [...children] } : {}),
    ...(hasRunningTool ? { hasRunningTool: true } : {}),
    ...(legacy?.reason === 'verified' ? { foregroundLinkSource: 'legacy-rollout' as const } : {}),
    ...(legacy ? { foregroundProbeReason: legacy.reason, foregroundCandidateCount: candidates.size } : {}),
  };
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
