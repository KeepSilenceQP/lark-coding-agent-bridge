/**
 * at-bot — send a native Feishu structured mention to a target Bot.
 *
 * Three-argument CLI primitive. Validates the target against the live
 * group Bot list, constructs one canonical post with exactly one at
 * element + one text element, sends with the current bridge-bound
 * profile's Bot identity, and returns machine-readable JSON only on
 * confirmed send with a real message_id.
 */

import { platform } from 'node:os';
import {
  runBoundedProcess,
} from './at-bot-process';

// ── public types ──

export interface AtBotOptions {
  chatId: string;
  botId: string;
  message: string;
  env?: NodeJS.ProcessEnv;
}

export interface AtBotSuccess {
  ok: true;
  chatId: string;
  botId: string;
  messageId: string;
}

interface BotListItem {
  bot_id?: unknown;
  bot_name?: unknown;
}

interface LarkCliEnvelope {
  ok?: unknown;
  code?: unknown;
  msg?: unknown;
  identity?: unknown;
  data?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

// ── lark-cli resolution ──

/**
 * The bridge-bound environment puts lark-cli on PATH. Use the bare
 * command name so the child process inherits the full bridge env
 * (LARK_CHANNEL_HOME, LARK_CHANNEL_PROFILE, …).
 *
 * On Windows the Node wrapper is a .cmd file resolved by shell:false
 * cross-spawn; the .cmd extension is implied.
 */
function larkCliCommand(): string {
  return platform() === 'win32' ? 'lark-cli.cmd' : 'lark-cli';
}

// ── error categories ──

interface AtBotError extends Error {
  code: string;
  apiCode?: number;
}

function makeError(code: string, message: string, apiCode?: number): AtBotError {
  const err = new Error(message) as AtBotError;
  err.code = code;
  if (apiCode !== undefined) err.apiCode = apiCode;
  return err;
}

const UNBOUND_MARKER = 'lark-channel context detected but not bound';

const FAILURE_CATEGORIES: Record<string, string> = {
  'at-bot/context-missing': 'run only from a bridge-bound Agent',
  'at-bot/context-unbound': 'restart the Bridge or run doctor/preflight',
  'at-bot/invalid-argument': 'correct the named CLI option',
  'at-bot/target-not-in-group': 'verify the target Bot in the current group',
  'at-bot/discovery-unavailable': 'restore current-profile Bot discovery; do not send',
  'at-bot/discovery-timeout': 'restore current-profile Bot discovery; do not send',
  'at-bot/discovery-invalid': 'restore current-profile Bot discovery; do not send',
  'at-bot/send-unavailable': 'notification is not confirmed; do not claim success',
  'at-bot/send-timeout': 'notification is not confirmed; do not claim success',
  'at-bot/send-rejected': 'notification is not confirmed; do not claim success',
  'at-bot/send-invalid': 'notification is not confirmed; do not claim success',
  'at-bot/termination-unconfirmed': 'a child tree may remain; do not retry automatically',
};

function formatError(code: string, apiCode?: number): string {
  const action = FAILURE_CATEGORIES[code] ?? code;
  const suffix = apiCode !== undefined ? ` [code=${apiCode}]` : '';
  return `${code}: ${action}${suffix}`;
}

// ── redaction ──

function redact(source: string): string {
  if (!source) return source;
  if (source.includes(UNBOUND_MARKER)) {
    return 'at-bot/context-unbound: restart the Bridge or run doctor/preflight';
  }
  return '';
}

function scanForUnbound(...sources: string[]): string | undefined {
  for (const s of sources) {
    if (s.includes(UNBOUND_MARKER)) return redact(s);
  }
  return undefined;
}

// ── strict envelope validation (shared by discovery + send) ──

function requireNonzeroExit(result: { exitCode: number | null }, category: string, invalidCategory: string): void {
  if (result.exitCode !== null && result.exitCode !== 0) {
    throw makeError(category, formatError(category));
  }
}

function validateEnvelopeOk(parsed: LarkCliEnvelope, invalidCategory: string): void {
  // ok must be strictly true (boolean).
  if (parsed.ok !== true) {
    const code = typeof parsed.code === 'number' ? parsed.code : undefined;
    throw makeError(invalidCategory, formatError(invalidCategory, code));
  }
}

function validateEnvelopeIdentity(parsed: LarkCliEnvelope, invalidCategory: string): void {
  // identity must be strictly 'bot' (string).
  if (parsed.identity !== 'bot') {
    throw makeError(invalidCategory, formatError(invalidCategory));
  }
}

function validateEnvelopeCode(parsed: LarkCliEnvelope, invalidCategory: string): void {
  if (parsed.code !== undefined) {
    // code must be absent or exactly number 0.  String "0" is rejected.
    if (typeof parsed.code !== 'number') {
      throw makeError(invalidCategory, formatError(invalidCategory));
    }
    if (!Number.isFinite(parsed.code) || parsed.code !== 0) {
      throw makeError(
        invalidCategory,
        formatError(invalidCategory, parsed.code),
      );
    }
  }
}

function parseNestedApiCode(parsed: LarkCliEnvelope): number | undefined {
  if (parsed.error && typeof parsed.error.code === 'number') {
    return parsed.error.code;
  }
  return undefined;
}

function parseEnvelopeJSON(stdout: string, invalidCategory: string): LarkCliEnvelope {
  let parsed: LarkCliEnvelope;
  try {
    parsed = JSON.parse(stdout) as LarkCliEnvelope;
  } catch {
    throw makeError(invalidCategory, formatError(invalidCategory));
  }
  return parsed;
}

// ── validation ──

function validateArgs(opts: AtBotOptions): void {
  const env = opts.env ?? process.env;
  if (env.LARK_CHANNEL !== '1') {
    throw makeError('at-bot/context-missing', formatError('at-bot/context-missing'));
  }
  if (!opts.chatId || !opts.chatId.startsWith('oc_')) {
    throw makeError('at-bot/invalid-argument', formatError('at-bot/invalid-argument'));
  }
  if (!opts.botId || !opts.botId.startsWith('ou_')) {
    throw makeError('at-bot/invalid-argument', formatError('at-bot/invalid-argument'));
  }
  if (!opts.message || !opts.message.trim()) {
    throw makeError('at-bot/invalid-argument', formatError('at-bot/invalid-argument'));
  }
}

// ── discovery ──

function validateBotItem(item: BotListItem): { bot_id: string; bot_name: string } {
  if (typeof item.bot_id !== 'string' || !item.bot_id) {
    throw makeError('at-bot/discovery-invalid', formatError('at-bot/discovery-invalid'));
  }
  if (typeof item.bot_name !== 'string' || !item.bot_name.trim()) {
    throw makeError('at-bot/discovery-invalid', formatError('at-bot/discovery-invalid'));
  }
  return { bot_id: item.bot_id, bot_name: item.bot_name.trim() };
}

async function discoverBots(
  chatId: string,
  env: NodeJS.ProcessEnv,
): Promise<Array<{ bot_id: string; bot_name: string }>> {
  const result = await runBoundedProcess(
    larkCliCommand(),
    ['im', 'chat.members', 'bots',
      '--params', JSON.stringify({ chat_id: chatId }),
      '--as', 'bot',
      '--format', 'json'],
    { timeoutMs: 20_000, maxOutputBytes: 1_048_576 },
  );

  // Check for unbound marker first.
  const unbound = scanForUnbound(result.stdout, result.stderr);
  if (unbound) {
    throw makeError('at-bot/context-unbound', unbound);
  }

  // Classify settle cause (before exitCode check because timeout/overflow
  // may have nonzero exit that is already covered by the settle category).
  if (result.settled === 'unavailable') {
    throw makeError('at-bot/discovery-unavailable', formatError('at-bot/discovery-unavailable'));
  }
  if (result.settled === 'timeout') {
    throw makeError('at-bot/discovery-timeout', formatError('at-bot/discovery-timeout'));
  }
  if (result.settled === 'overflow') {
    throw makeError('at-bot/discovery-invalid', formatError('at-bot/discovery-invalid'));
  }
  if (result.settled === 'termination-unconfirmed') {
    throw makeError('at-bot/termination-unconfirmed', formatError('at-bot/termination-unconfirmed'));
  }

  // On normal exit, check the subprocess exit code.
  requireNonzeroExit(result, 'at-bot/discovery-invalid', 'at-bot/discovery-invalid');

  const parsed = parseEnvelopeJSON(result.stdout, 'at-bot/discovery-invalid');
  validateEnvelopeOk(parsed, 'at-bot/discovery-invalid');
  validateEnvelopeIdentity(parsed, 'at-bot/discovery-invalid');
  validateEnvelopeCode(parsed, 'at-bot/discovery-invalid');

  const data = parsed.data as { items?: BotListItem[] } | undefined;
  if (!data || !Array.isArray(data.items)) {
    throw makeError('at-bot/discovery-invalid', formatError('at-bot/discovery-invalid'));
  }

  return data.items.map(validateBotItem);
}

// ── target validation ──

function validateTarget(
  items: Array<{ bot_id: string; bot_name: string }>,
  botId: string,
): { bot_id: string; bot_name: string } {
  const match = items.find((item) => item.bot_id === botId);
  if (!match) {
    throw makeError('at-bot/target-not-in-group', formatError('at-bot/target-not-in-group'));
  }
  return match;
}

// ── canonical post ──

function buildCanonicalPost(
  target: { bot_id: string; bot_name: string },
  message: string,
): object {
  return {
    zh_cn: {
      title: '',
      content: [
        [
          { tag: 'at', user_id: target.bot_id, user_name: target.bot_name },
          { tag: 'text', text: ` ${message}` },
        ],
      ],
    },
  };
}

// ── send ──

async function sendMessage(
  chatId: string,
  postContent: object,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const contentStr = JSON.stringify(postContent);
  const result = await runBoundedProcess(
    larkCliCommand(),
    ['im', '+messages-send',
      '--chat-id', chatId,
      '--msg-type', 'post',
      '--content', contentStr,
      '--format', 'json',
      '--as', 'bot'],
    { timeoutMs: 20_000, maxOutputBytes: 1_048_576 },
  );

  const unbound = scanForUnbound(result.stdout, result.stderr);
  if (unbound) {
    throw makeError('at-bot/context-unbound', unbound);
  }

  if (result.settled === 'unavailable') {
    throw makeError('at-bot/send-unavailable', formatError('at-bot/send-unavailable'));
  }
  if (result.settled === 'timeout') {
    throw makeError('at-bot/send-timeout', formatError('at-bot/send-timeout'));
  }
  if (result.settled === 'overflow') {
    throw makeError('at-bot/send-invalid', formatError('at-bot/send-invalid'));
  }
  if (result.settled === 'termination-unconfirmed') {
    throw makeError('at-bot/termination-unconfirmed', formatError('at-bot/termination-unconfirmed'));
  }

  requireNonzeroExit(result, 'at-bot/send-invalid', 'at-bot/send-invalid');

  const parsed = parseEnvelopeJSON(result.stdout, 'at-bot/send-invalid');

  // If ok is false with a nested error code, surface it.
  if (parsed.ok === false) {
    const apiCode = parseNestedApiCode(parsed) ??
      (typeof parsed.code === 'number' ? parsed.code : undefined);
    throw makeError('at-bot/send-rejected', formatError('at-bot/send-rejected', apiCode), apiCode);
  }

  validateEnvelopeOk(parsed, 'at-bot/send-invalid');
  validateEnvelopeIdentity(parsed, 'at-bot/send-invalid');
  validateEnvelopeCode(parsed, 'at-bot/send-invalid');

  const data = parsed.data as { message_id?: unknown } | undefined;
  if (!data || typeof data.message_id !== 'string' || !data.message_id.startsWith('om_')) {
    throw makeError('at-bot/send-invalid', formatError('at-bot/send-invalid'));
  }

  return data.message_id;
}

// ── main entry ──

export async function runAtBot(opts: AtBotOptions): Promise<AtBotSuccess> {
  const env = opts.env ?? process.env;

  // 1. Validate arguments (includes bridge context check).
  validateArgs(opts);

  // 2. Discover group bots.
  let validatedItems: Array<{ bot_id: string; bot_name: string }>;
  try {
    validatedItems = await discoverBots(opts.chatId, env);
  } catch (err) {
    if ((err as AtBotError).code) throw err;
    const msg = String((err as Error).message ?? '');
    if (msg.includes(UNBOUND_MARKER)) {
      throw makeError('at-bot/context-unbound', formatError('at-bot/context-unbound'));
    }
    throw makeError('at-bot/discovery-unavailable', formatError('at-bot/discovery-unavailable'));
  }

  // 3. Validate target.
  const target = validateTarget(validatedItems, opts.botId);

  // 4. Build canonical post.
  const post = buildCanonicalPost(target, opts.message);

  // 5. Send.
  let messageId: string;
  try {
    messageId = await sendMessage(opts.chatId, post, env);
  } catch (err) {
    if ((err as AtBotError).code) throw err;
    const msg = String((err as Error).message ?? '');
    if (msg.includes(UNBOUND_MARKER)) {
      throw makeError('at-bot/context-unbound', formatError('at-bot/context-unbound'));
    }
    throw makeError('at-bot/send-unavailable', formatError('at-bot/send-unavailable'));
  }

  return {
    ok: true,
    chatId: opts.chatId,
    botId: target.bot_id,
    messageId,
  };
}

/**
 * CLI action handler. Runs runAtBot, prints success JSON to stdout,
 * or prints a fixed-error line to stderr and exits non-zero.
 */
export async function runAtBotCli(opts: AtBotOptions): Promise<void> {
  try {
    const result = await runAtBot(opts);
    console.log(JSON.stringify(result));
  } catch (err) {
    const runErr = err as AtBotError;
    const code = runErr.code ?? 'at-bot/unknown';
    const apiCode = runErr.apiCode;
    console.error(formatError(code, apiCode));
    process.exit(1);
  }
}
