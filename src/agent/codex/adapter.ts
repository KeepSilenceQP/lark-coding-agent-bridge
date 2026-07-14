import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildCodexArgs } from './argv';
import { CodexJsonlTranslator, type CodexFinishReason } from './jsonl';
import {
  createCodexTurnStateProbe,
  type CodexTurnState,
  type CodexTurnStateProbe,
} from './turn-state-probe';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  stdoutIdleProbeMs?: number;
  turnStateProbe?: CodexTurnStateProbe;
  larkChannel?: LarkChannelEnvContext;
}

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;
const DEFAULT_STDOUT_IDLE_PROBE_MS = 60_000;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly ignoreRules: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly stdoutIdleProbeMs: number;
  private readonly turnStateProbe: CodexTurnStateProbe;
  private readonly turnProbeBaselines = new Map<
    string,
    { enabled: boolean; turnId?: string }
  >();
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CodexAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.ignoreRules = opts.ignoreRules !== false;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.stdoutIdleProbeMs = opts.stdoutIdleProbeMs ?? DEFAULT_STDOUT_IDLE_PROBE_MS;
    this.turnStateProbe =
      opts.turnStateProbe ??
      createCodexTurnStateProbe({
        binary: opts.binary,
        profileStateDir: opts.profileStateDir,
        codexHome: opts.codexHome,
        inheritCodexHome: opts.inheritCodexHome,
      });
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(opts?: AgentRunOptions): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    if (!opts) return;
    if (this.stdoutIdleProbeMs <= 0 || !opts.threadId) {
      this.turnProbeBaselines.set(opts.runId, { enabled: true });
      return;
    }
    try {
      const latest = await this.turnStateProbe(opts.threadId);
      this.turnProbeBaselines.set(opts.runId, {
        enabled: true,
        ...(latest ? { turnId: latest.id } : {}),
      });
    } catch (error) {
      this.turnProbeBaselines.set(opts.runId, { enabled: false });
      log.warn('agent', 'terminal-probe-baseline-failed', {
        threadId: opts.threadId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CodexAdapter.run');
    }
    const preparedProbe = this.turnProbeBaselines.get(opts.runId);
    this.turnProbeBaselines.delete(opts.runId);
    const terminalProbe = opts.threadId
      ? preparedProbe?.enabled
        ? this.turnStateProbe
        : undefined
      : this.turnStateProbe;

    const args = buildCodexArgs({
      cwd: opts.cwd,
      sandbox: opts.sandbox ?? this.sandbox,
      threadId: opts.threadId,
      images: opts.images,
      ignoreUserConfig: this.ignoreUserConfig,
      ignoreRules: this.ignoreRules,
      model: opts.model,
    });
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CodexChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasThread: Boolean(opts.threadId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn codex: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: CodexFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(
        child,
        stderrChunks,
        () => runtimeError,
        () => stopReason,
        this.stdoutIdleProbeMs,
        opts.threadId,
        preparedProbe?.turnId,
        terminalProbe,
      ),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
      async canRetryAfterNoOutput(): Promise<boolean> {
        if (!opts.threadId || !terminalProbe) return false;
        try {
          const latest = await terminalProbe(opts.threadId);
          const safe = Boolean(
            latest &&
            latest.id !== preparedProbe?.turnId &&
            (latest.status === 'interrupted' || latest.status === 'failed') &&
            latest.itemCount === 0,
          );
          log.warn('agent', 'no-output-retry-check', {
            threadId: opts.threadId,
            baselineTurnId: preparedProbe?.turnId,
            turnId: latest?.id,
            turnStatus: latest?.status,
            itemCount: latest?.itemCount,
            safe,
          });
          return safe;
        } catch (error) {
          log.warn('agent', 'no-output-retry-check-failed', {
            threadId: opts.threadId,
            message: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      },
    };
  }
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => CodexFinishReason | undefined,
  stdoutIdleProbeMs: number,
  initialThreadId: string | undefined,
  baselineTurnId: string | undefined,
  turnStateProbe: CodexTurnStateProbe | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new CodexJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let lastStdoutAt = Date.now();
  let currentThreadId = initialThreadId;
  let sawSubstantiveEvent = false;
  const emittedText = new Set<string>();
  let terminalProbeInFlight = false;
  let recoveredReason: CodexFinishReason | undefined;
  let recoveredText: string | undefined;
  let streamClosed = false;
  const probePersistedTerminal = async (idleMs: number): Promise<void> => {
    if (
      !turnStateProbe ||
      !currentThreadId ||
      !sawSubstantiveEvent ||
      terminalProbeInFlight ||
      streamClosed ||
      recoveredReason
    ) {
      return;
    }
    terminalProbeInFlight = true;
    try {
      const latest = await turnStateProbe(currentThreadId);
      if (
        streamClosed ||
        !latest ||
        latest.id === baselineTurnId ||
        latest.status === 'inProgress'
      ) {
        return;
      }
      recoveredReason = finishReasonForTurn(latest);
      if (
        latest.status === 'completed' &&
        latest.finalText &&
        !emittedText.has(latest.finalText)
      ) {
        recoveredText = latest.finalText;
      }
      log.warn('agent', 'terminal-recovered', {
        pid: child.pid ?? null,
        threadId: currentThreadId,
        turnId: latest.id,
        turnStatus: latest.status,
        idleMs,
      });
      rl.close();
      child.stdout.destroy();
    } catch (error) {
      if (!streamClosed) {
        log.warn('agent', 'terminal-probe-failed', {
          pid: child.pid ?? null,
          threadId: currentThreadId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      terminalProbeInFlight = false;
    }
  };
  const stdoutIdleTimer =
    stdoutIdleProbeMs > 0
      ? setInterval(() => {
          const idleMs = Date.now() - lastStdoutAt;
          if (idleMs < stdoutIdleProbeMs) return;
          log.warn('agent', 'stdout-idle', {
            pid: child.pid ?? null,
            idleMs,
            childExitCode: child.exitCode,
            childSignalCode: child.signalCode,
          });
          lastStdoutAt = Date.now();
          void probePersistedTerminal(idleMs);
        }, stdoutIdleProbeMs)
      : undefined;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      lastStdoutAt = Date.now();
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const raw = parsed as { type?: unknown; thread_id?: unknown; threadId?: unknown };
      if (raw.type === 'thread.started') {
        const threadId =
          typeof raw.thread_id === 'string'
            ? raw.thread_id
            : typeof raw.threadId === 'string'
              ? raw.threadId
              : undefined;
        if (threadId) currentThreadId = threadId;
      }
      const translated = translator.translate(parsed);
      for (const event of translated) {
        if (event.type === 'text') emittedText.add(event.delta);
      }
      if (translated.some((event) => event.type !== 'system' && event.type !== 'usage')) {
        sawSubstantiveEvent = true;
      }
      yield* translated;
    }
  } finally {
    streamClosed = true;
    if (stdoutIdleTimer) clearInterval(stdoutIdleTimer);
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  if (recoveredReason) {
    if (recoveredText) yield { type: 'text', delta: recoveredText };
    yield* translator.finish(recoveredReason);
    return;
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield terminalError(`codex runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield terminalError(`codex exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield terminalError(`codex runtime error: ${runtimeError.message}`);
    return;
  }

  yield* translator.finish();
}

function finishReasonForTurn(turn: CodexTurnState): CodexFinishReason {
  if (turn.status === 'completed') return 'normal';
  if (turn.status === 'interrupted') return 'interrupted';
  return 'failed';
}

function terminalError(message: string): AgentEvent {
  return {
    type: 'error',
    message,
    terminationReason: 'failed',
  };
}

async function waitForExitCode(child: CodexChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
