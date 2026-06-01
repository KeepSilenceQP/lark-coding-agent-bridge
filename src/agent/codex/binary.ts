import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { AgentPreflightError, checkAgentVersion } from '../preflight';

export interface CodexBinaryPin {
  binaryPath: string;
  realpath: string;
  version: string;
  sha256: string;
  owner?: number;
  mode?: number;
}

export interface CodexBinaryPinOptions {
  readVersion?: (binaryRealpath: string) => Promise<string>;
  command?: string;
}

export type CodexBinaryPinDriftCode =
  | 'binary-realpath-mismatch'
  | 'binary-version-mismatch'
  | 'binary-hash-mismatch'
  | 'binary-owner-mismatch'
  | 'binary-mode-mismatch';

export class CodexBinaryPinDriftError extends Error {
  constructor(
    readonly code: CodexBinaryPinDriftCode,
    field: string,
    actual: string | number,
    expected: string | number,
  ) {
    super(`Codex binary ${field} drift`);
    this.name = 'CodexBinaryPinDriftError';
    this.cause = { field, actual, expected };
  }
}

export async function createCodexBinaryPin(
  binaryPath: string,
  options: CodexBinaryPinOptions = {},
): Promise<CodexBinaryPin> {
  return inspectCodexBinary(binaryPath, options);
}

export async function verifyCodexBinaryPin(
  pin: CodexBinaryPin,
  binaryPath = pin.binaryPath,
  options: CodexBinaryPinOptions = {},
): Promise<void> {
  const current = await inspectCodexBinary(binaryPath, options);
  assertEqual('realpath', current.realpath, pin.realpath);
  assertEqual('version', current.version, pin.version);
  assertEqual('sha256', current.sha256, pin.sha256);
  if (pin.owner !== undefined && current.owner !== undefined) {
    assertEqual('owner', current.owner, pin.owner);
  }
  if (pin.mode !== undefined && current.mode !== undefined) {
    assertEqual('mode', current.mode, pin.mode);
  }
}

async function inspectCodexBinary(
  binaryPath: string,
  options: CodexBinaryPinOptions,
): Promise<CodexBinaryPin> {
  const resolved = await resolveCodexRealpath(binaryPath, options.command ?? 'codex');
  const info = await statCodexBinary(resolved, binaryPath, options.command ?? 'codex');
  const bytes = await readCodexBinary(resolved, binaryPath, options.command ?? 'codex');
  const version = await (
    options.readVersion ?? ((path) => readCodexVersion(path, binaryPath, options.command ?? 'codex'))
  )(resolved);
  const owner = typeof info.uid === 'number' ? info.uid : undefined;
  const mode = typeof info.mode === 'number' ? info.mode & 0o7777 : undefined;
  return {
    binaryPath,
    realpath: resolved,
    version,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(owner !== undefined ? { owner } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

async function resolveCodexRealpath(binaryPath: string, command: string): Promise<string> {
  try {
    return await realpath(binaryPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: code === 'ENOENT' ? 'agent-binary-not-found' : 'agent-binary-resolve-failed',
      agentId: 'codex',
      agentName: 'Codex CLI',
      command,
      binaryPath,
      errno: code,
    });
  }
}

async function statCodexBinary(resolved: string, binaryPath: string, command: string) {
  try {
    return await stat(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: code === 'ENOENT' ? 'agent-binary-not-found' : 'agent-binary-resolve-failed',
      agentId: 'codex',
      agentName: 'Codex CLI',
      command,
      binaryPath,
      realpath: resolved,
      errno: code,
    });
  }
}

async function readCodexBinary(resolved: string, binaryPath: string, command: string): Promise<Buffer> {
  try {
    return await readFile(resolved);
  } catch (err) {
    throw new AgentPreflightError({
      code: 'agent-binary-not-readable',
      agentId: 'codex',
      agentName: 'Codex CLI',
      command,
      binaryPath,
      realpath: resolved,
      errno: (err as NodeJS.ErrnoException).code,
    });
  }
}

function assertEqual<T extends string | number>(field: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new CodexBinaryPinDriftError(pinCodeForField(field), field, actual, expected);
  }
}

function pinCodeForField(field: string): CodexBinaryPinDriftCode {
  if (field === 'realpath') return 'binary-realpath-mismatch';
  if (field === 'version') return 'binary-version-mismatch';
  if (field === 'sha256') return 'binary-hash-mismatch';
  if (field === 'owner') return 'binary-owner-mismatch';
  return 'binary-mode-mismatch';
}

async function readCodexVersion(
  binaryRealpath: string,
  binaryPath: string,
  command: string,
): Promise<string> {
  return checkAgentVersion({
    agentId: 'codex',
    agentName: 'Codex CLI',
    command,
    binaryPath,
    realpath: binaryRealpath,
  });
}
