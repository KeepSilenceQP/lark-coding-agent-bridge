import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import defaultPolicy from './default-policy.json';

export type ReactionBehavior = 'agent' | 'passive' | 'stop' | 'continue' | 'restart';

export interface ReactionRule {
  behavior: ReactionBehavior;
  semanticKey: string;
  emojiMeaning: string;
  emojiDisplay?: string;
}

export interface ReactionPolicy {
  readonly version: string;
  readonly rules: Readonly<Record<string, Readonly<ReactionRule>>>;
}

const MAX_FILE_BYTES = 128 * 1024;
const MAX_RULES = 256;
const BEHAVIORS = new Set<ReactionBehavior>(['agent', 'passive', 'stop', 'continue', 'restart']);
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const RULE_FIELDS = new Set(['behavior', 'semanticKey', 'emojiMeaning', 'emojiDisplay']);
const DEFAULT_FILE_CONTENT = `${JSON.stringify(defaultPolicy, null, 2)}\n`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function fail(reason: string): never {
  // Do not include any user-provided values or JSON parser excerpts in errors.
  throw new Error(`Invalid reaction policy: ${reason}`);
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Parse a complete config; omitted emoji types deliberately remain unmapped. */
export function parseReactionPolicy(content: string): ReactionPolicy {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) fail('file exceeds 128 KiB');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    fail('malformed JSON');
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 2
    || parsed.schemaVersion !== 1 || !Object.hasOwn(parsed, 'rules')) {
    fail('expected schemaVersion 1 and rules only');
  }
  if (!isRecord(parsed.rules)) fail('rules must be an object');
  const entries = Object.entries(parsed.rules);
  if (entries.length > MAX_RULES) fail('too many rules (maximum 256)');
  const rules: Record<string, Readonly<ReactionRule>> = Object.create(null);
  for (const [emojiType, raw] of entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(emojiType) || RESERVED_KEYS.has(emojiType)) {
      fail('invalid or reserved emoji type');
    }
    if (emojiType === 'Typing') fail('Typing is reserved for bridge activity');
    if (!isRecord(raw) || Object.keys(raw).some((key) => !RULE_FIELDS.has(key))) {
      fail('rule must be an object with supported fields only');
    }
    if (typeof raw.behavior !== 'string' || !BEHAVIORS.has(raw.behavior as ReactionBehavior)) {
      fail('unsupported behavior');
    }
    if (typeof raw.semanticKey !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/u.test(raw.semanticKey)
      || RESERVED_KEYS.has(raw.semanticKey)) {
      fail('semanticKey must be a nonempty snake_case identifier (maximum 128 characters)');
    }
    if (!validText(raw.emojiMeaning, 4096)) fail('invalid emojiMeaning (maximum 4096 characters)');
    if (Object.hasOwn(raw, 'emojiDisplay') && !validText(raw.emojiDisplay, 128)) {
      fail('invalid emojiDisplay (maximum 128 characters)');
    }
    rules[emojiType] = Object.freeze({
      behavior: raw.behavior as ReactionBehavior,
      semanticKey: raw.semanticKey,
      emojiMeaning: raw.emojiMeaning,
      ...(typeof raw.emojiDisplay === 'string' ? { emojiDisplay: raw.emojiDisplay } : {}),
    });
  }
  // Canonical key and field order makes the version stable across formatting edits.
  return Object.freeze({ version: digest(JSON.stringify({ schemaVersion: 1, rules })), rules: Object.freeze(rules) });
}

export const DEFAULT_REACTION_POLICY: ReactionPolicy = parseReactionPolicy(DEFAULT_FILE_CONTENT);

/** Bounded reads also catch atomic file replacement and coarse filesystem mtimes. */
function readPolicyFile(filePath: string): string {
  // Nonblocking open lets us reject a FIFO instead of hanging the event loop.
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail('config path must be a regular file');
    if (stat.size > MAX_FILE_BYTES) fail('file exceeds 128 KiB');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_FILE_BYTES) fail('file exceeds 128 KiB');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      fail('file must be UTF-8');
    }
  } finally {
    closeSync(fd);
  }
}

function errorDescription(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('Invalid reaction policy: ')) return error.message;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  // Only known filesystem error codes are safe to include, never raw error messages.
  if (code === 'ENOENT') return 'Reaction policy file is missing';
  if (code === 'EACCES' || code === 'EPERM') return 'Reaction policy file is not readable';
  return 'Reaction policy file could not be read';
}

/** Profile-local policy with synchronous event-boundary reload and last-good fallback. */
export class ReactionPolicyStore {
  readonly filePath: string;
  private current: ReactionPolicy | undefined;
  private observedContentDigest: string | undefined;
  private observedContentValid = false;
  private readonly warnedErrors = new Set<string>();

  constructor(
    private readonly profileDir: string,
    private readonly onWarning?: (message: string) => void,
  ) {
    this.filePath = join(profileDir, 'reaction-semantics.json');
  }

  async initialize(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true });
    try {
      await writeFile(this.filePath, DEFAULT_FILE_CONTENT, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    // Never silently replace an invalid initial configuration with defaults.
    try {
      const content = readPolicyFile(this.filePath);
      this.current = parseReactionPolicy(content);
      this.observedContentDigest = digest(content);
      this.observedContentValid = true;
      this.warnedErrors.clear();
    } catch (error) {
      throw new Error(`Cannot initialize reaction policy: ${errorDescription(error)}`);
    }
  }

  snapshot(): ReactionPolicy {
    if (!this.current) throw new Error('ReactionPolicyStore must be initialized before snapshot');
    try {
      const content = readPolicyFile(this.filePath);
      const contentDigest = digest(content);
      if (contentDigest !== this.observedContentDigest) {
        // Cache failed content too: unchanged invalid files do not repeat JSON parsing.
        this.observedContentDigest = contentDigest;
        this.observedContentValid = false;
        this.current = parseReactionPolicy(content);
        this.observedContentValid = true;
      }
      if (this.observedContentValid) this.warnedErrors.clear();
    } catch (error) {
      const description = errorDescription(error);
      if (!this.warnedErrors.has(description)) {
        this.warnedErrors.add(description);
        this.onWarning?.(`${description}; keeping the last valid reaction policy`);
      }
    }
    return this.current;
  }
}
