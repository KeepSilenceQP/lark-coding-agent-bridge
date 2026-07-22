/**
 * at-bot — send a native Feishu structured mention to a target Bot.
 *
 * Three-argument CLI primitive. Validates the target against the live
 * group Bot list, constructs one canonical post with exactly one at
 * element + one text element, sends with the current bridge-bound
 * profile's Bot identity, and returns machine-readable JSON only on
 * confirmed send with a real message_id.
 */

import {
  runBoundedProcess,
  type BoundedProcessResult,
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
  bot_id?: string;
  bot_name?: string;
}

interface LarkCliEnvelope {
  ok?: boolean;
  code?: number | string;
  msg?: string;
  identity?: string;
  data?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
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

class RunError extends Error {
  code: string;
  apiCode?: number;
  constructor(code: string, message: string, apiCode?: number) {
    super(message);
    this.name = 'RunError';
    this.code = code;
    this.apiCode = apiCode;
  }
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
  // If the source contains the known unbound marker, return the fixed instruction.
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

// ── validation ──

function validateArgs(opts: AtBotOptions): void {
  const env = opts.env ?? process.env;
  if (env.LARK_CHANNEL !== '1') {
    throw makeError('at-bot/context-missing', formatError('at-bot/context-missing'));
  }
  if (!opts.chatId || !opts.chatId.startsWith('oc_')) {
    throw makeError(
      'at-bot/invalid-argument',
      formatError('at-bot/invalid-argument'),
    );
  }
  if (!opts.botId || !opts.botId.startsWith('ou_')) {
    throw makeError(
      'at-bot/invalid-argument',
      formatError('at-bot/invalid-argument'),
    );
  }
  if (!opts.message || !opts.message.trim()) {
    throw makeError(
      'at-bot/invalid-argument',
      formatError('at-bot/invalid-argument'),
    );
  }
}

// ── discovery ──

async function discoverBots(
  chatId: string,
  env: NodeJS.ProcessEnv,
): Promise<BotListItem[]> {
  const result = await runBoundedProcess(
    process.execPath,
    ['lark-cli', 'im', 'chat.members', 'bots',
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

  // Classify settle cause.
  if (result.settled === 'unavailable') {
    throw makeError('at-bot/discovery-unavailable',
      formatError('at-bot/discovery-unavailable'));
  }
  if (result.settled === 'timeout') {
    throw makeError('at-bot/discovery-timeout',
      formatError('at-bot/discovery-timeout'));
  }
  if (result.settled === 'overflow') {
    throw makeError('at-bot/discovery-invalid',
      formatError('at-bot/discovery-invalid'));
  }
  if (result.settled === 'termination-unconfirmed') {
    throw makeError('at-bot/termination-unconfirmed',
      formatError('at-bot/termination-unconfirmed'));
  }

  // Parse JSON output.
  let parsed: LarkCliEnvelope;
  try {
    parsed = JSON.parse(result.stdout) as LarkCliEnvelope;
  } catch {
    throw makeError('at-bot/discovery-invalid',
      formatError('at-bot/discovery-invalid'));
  }

  // Strict envelope validation.
  if (parsed.ok !== true) {
    const code = typeof parsed.code === 'number' ? parsed.code : undefined;
    throw makeError('at-bot/discovery-invalid',
      formatError('at-bot/discovery-invalid', code));
  }
  if (parsed.identity !== 'bot') {
    throw makeError('at-bot/discovery-invalid',
      formatError('at-bot/discovery-invalid'));
  }
  if (parsed.code !== undefined) {
    const code = Number(parsed.code);
    if (!Number.isFinite(code) || code !== 0) {
      throw makeError('at-bot/discovery-invalid',
        formatError('at-bot/discovery-invalid', Number.isFinite(code) ? code : undefined));
    }
  }

  const data = parsed.data as { items?: BotListItem[] } | undefined;
  if (!data || !Array.isArray(data.items)) {
    throw makeError('at-bot/discovery-invalid',
      formatError('at-bot/discovery-invalid'));
  }

  return data.items;
}

// ── target validation ──

function validateTarget(
  items: BotListItem[],
  botId: string,
): { bot_id: string; bot_name: string } {
  const match = items.find(
    (item) => item.bot_id === botId,
  );
  if (!match) {
    throw makeError('at-bot/target-not-in-group',
      formatError('at-bot/target-not-in-group'));
  }
  if (!match.bot_name || !match.bot_name.trim()) {
    throw makeError('at-bot/target-not-in-group',
      formatError('at-bot/target-not-in-group'));
  }
  return { bot_id: match.bot_id!, bot_name: match.bot_name!.trim() };
}

// ── canonical post ──

function buildCanonicalPost(target: { bot_id: string; bot_name: string }, message: string): object {
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
    process.execPath,
    ['lark-cli', 'im', '+messages-send',
      '--chat-id', chatId,
      '--msg-type', 'post',
      '--content', contentStr,
      '--format', 'json',
      '--as', 'bot'],
    { timeoutMs: 20_000, maxOutputBytes: 1_048_576 },
  );

  // Check for unbound marker first.
  const unbound = scanForUnbound(result.stdout, result.stderr);
  if (unbound) {
    throw makeError('at-bot/context-unbound', unbound);
  }

  // Classify settle cause.
  if (result.settled === 'unavailable') {
    throw makeError('at-bot/send-unavailable',
      formatError('at-bot/send-unavailable'));
  }
  if (result.settled === 'timeout') {
    throw makeError('at-bot/send-timeout',
      formatError('at-bot/send-timeout'));
  }
  if (result.settled === 'overflow') {
    throw makeError('at-bot/send-invalid',
      formatError('at-bot/send-invalid'));
  }
  if (result.settled === 'termination-unconfirmed') {
    throw makeError('at-bot/termination-unconfirmed',
      formatError('at-bot/termination-unconfirmed'));
  }

  // Parse JSON output.
  let parsed: LarkCliEnvelope;
  try {
    parsed = JSON.parse(result.stdout) as LarkCliEnvelope;
  } catch {
    throw makeError('at-bot/send-invalid',
      formatError('at-bot/send-invalid'));
  }

  // Strict envelope validation.
  if (parsed.ok !== true) {
    const code = typeof parsed.code === 'number' ? parsed.code : undefined;
    throw makeError('at-bot/send-rejected',
      formatError('at-bot/send-rejected', code));
  }
  if (parsed.identity !== 'bot') {
    throw makeError('at-bot/send-invalid',
      formatError('at-bot/send-invalid'));
  }
  if (parsed.code !== undefined) {
    const code = Number(parsed.code);
    if (!Number.isFinite(code) || code !== 0) {
      throw makeError('at-bot/send-invalid',
        formatError('at-bot/send-invalid', Number.isFinite(code) ? code : undefined));
    }
  }

  const data = parsed.data as { message_id?: string } | undefined;
  if (!data?.message_id || !data.message_id.startsWith('om_')) {
    throw makeError('at-bot/send-invalid',
      formatError('at-bot/send-invalid'));
  }

  return data.message_id;
}

// ── main entry ──

export async function runAtBot(opts: AtBotOptions): Promise<AtBotSuccess> {
  const env = opts.env ?? process.env;

  // 1. Validate arguments (includes bridge context check).
  validateArgs(opts);

  // 2. Discover group bots.
  let items: BotListItem[];
  try {
    items = await discoverBots(opts.chatId, env);
  } catch (err) {
    if ((err as AtBotError).code) throw err;
    // Spawn errors: classify and throw.
    const msg = String((err as Error).message ?? '');
    // Scan for unbound marker in spawn error too.
    if (msg.includes(UNBOUND_MARKER)) {
      throw makeError('at-bot/context-unbound',
        formatError('at-bot/context-unbound'));
    }
    throw makeError('at-bot/discovery-unavailable',
      formatError('at-bot/discovery-unavailable'));
  }

  // 3. Validate target.
  const target = validateTarget(items, opts.botId);

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
      throw makeError('at-bot/context-unbound',
        formatError('at-bot/context-unbound'));
    }
    throw makeError('at-bot/send-unavailable',
      formatError('at-bot/send-unavailable'));
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
