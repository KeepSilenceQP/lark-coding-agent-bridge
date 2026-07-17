import { randomUUID } from 'node:crypto';
import { spawnProcess } from '../../platform/spawn';

export const DEFAULT_CODEX_PROMPT_INPUT_TIMEOUT_MS = 15_000;

export interface VerifyCodexPromptInputOptions {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

export class CodexDeveloperInstructionsUnsupported extends Error {
  readonly code = 'codex-developer-instructions-unsupported';

  constructor(reason: string) {
    super(`Codex developer instructions are unavailable: ${reason}`);
    this.name = 'CodexDeveloperInstructionsUnsupported';
  }
}

export async function verifyCodexDeveloperInstructions(
  options: VerifyCodexPromptInputOptions,
): Promise<void> {
  const developerSentinel = [
    `lark-bridge-developer-${randomUUID()}`,
    '"quoted" `code` <bridge_context> 中文',
  ].join('\n');
  const userSentinel = `lark-bridge-user-${randomUUID()} <user_input> 用户`;
  const output = await runPromptInputProbe(
    options,
    developerSentinel,
    userSentinel,
  );
  if (!hasExactRoleSeparation(output, developerSentinel, userSentinel)) {
    throw new CodexDeveloperInstructionsUnsupported('capability probe returned unexpected roles');
  }
}

function runPromptInputProbe(
  options: VerifyCodexPromptInputOptions,
  developerSentinel: string,
  userSentinel: string,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODEX_PROMPT_INPUT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  const killGraceMs = options.killGraceMs ?? 250;
  let child: ReturnType<typeof spawnProcess>;
  try {
    child = spawnProcess(
      options.binary,
      [
        'debug',
        'prompt-input',
        '-c',
        `developer_instructions=${JSON.stringify(developerSentinel)}`,
        userSentinel,
      ],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    throw new CodexDeveloperInstructionsUnsupported(
      'capability probe could not be started',
    );
  }

  return new Promise<string>((resolve, reject) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingError: CodexDeveloperInstructionsUnsupported | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      terminate(
        new CodexDeveloperInstructionsUnsupported(
          `capability probe timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    const terminate = (error: CodexDeveloperInstructionsUnsupported): void => {
      if (pendingError) return;
      pendingError = error;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, killGraceMs);
    };
    const trackOutput = (kind: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (kind === 'stdout') {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= maxOutputBytes) stdout.push(chunk);
      } else {
        stderrBytes += chunk.length;
      }
      if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
        terminate(
          new CodexDeveloperInstructionsUnsupported('capability probe output exceeded limit'),
        );
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout?.on('data', (chunk: Buffer) => trackOutput('stdout', Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => trackOutput('stderr', Buffer.from(chunk)));
    child.once('error', () => {
      cleanup();
      reject(
        new CodexDeveloperInstructionsUnsupported('capability probe could not be started'),
      );
    });
    child.once('close', (code, signal) => {
      cleanup();
      if (pendingError) {
        reject(pendingError);
        return;
      }
      if (code !== 0 || signal) {
        reject(
          new CodexDeveloperInstructionsUnsupported(
            `capability probe exited ${code ?? signal ?? 'unexpectedly'}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

function hasExactRoleSeparation(
  stdout: string,
  developerSentinel: string,
  userSentinel: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  let developerMatches = 0;
  let userMatches = 0;
  for (const value of parsed) {
    if (!isRecord(value) || typeof value.role !== 'string' || !Array.isArray(value.content)) {
      continue;
    }
    for (const content of value.content) {
      if (!isRecord(content) || content.type !== 'input_text' || typeof content.text !== 'string') {
        continue;
      }
      if (content.text === developerSentinel) {
        if (value.role !== 'developer') return false;
        developerMatches += 1;
      }
      if (content.text === userSentinel) {
        if (value.role !== 'user') return false;
        userMatches += 1;
      }
    }
  }
  return developerMatches === 1 && userMatches === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
