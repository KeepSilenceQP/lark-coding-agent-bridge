export const PROJECT_BOOTSTRAP_USAGE =
  '用法：`/project bootstrap <workspace> --plan-writer <bot-name> --implementer <bot-name>`';

export type BootstrapTokenizeResult =
  | { ok: true; tokens: string[] }
  | { ok: false; reason: string };

export interface BootstrapCommandArgs {
  workspacePath: string;
  planWriter: string;
  implementer: string;
}

export type BootstrapCommandParseResult =
  | { ok: true; value: BootstrapCommandArgs }
  | { ok: false; reason: string };

/**
 * Split bootstrap arguments without invoking shell semantics.
 *
 * Single and double quotes group whitespace into one token. Quotes themselves
 * are discarded; every other character — including `$`, backticks and
 * backslashes — remains literal. Backslashes do not escape quotes.
 */
export function tokenizeBootstrapArgs(input: string): BootstrapTokenizeResult {
  const tokens: string[] = [];
  let current = '';
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;

  for (const character of input) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    current += character;
    tokenStarted = true;
  }

  if (quote) {
    return {
      ok: false,
      reason: `参数中的 ${quote} 引号未闭合。`,
    };
  }
  if (tokenStarted) {
    tokens.push(current);
  }
  return { ok: true, tokens };
}

export function parseBootstrapCommand(tokens: string[]): BootstrapCommandParseResult {
  if (isLegacyPositionalSyntax(tokens)) {
    return invalid('旧语法已废弃，请使用具名参数。');
  }

  let workspacePath: string | undefined;
  let planWriter: string | undefined;
  let implementer: string | undefined;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--plan-writer' || token === '--implementer') {
      const current = token === '--plan-writer' ? planWriter : implementer;
      if (current !== undefined) {
        return invalid(`参数 ${token} 不能重复。`);
      }
      const rawValue = tokens[index + 1];
      if (rawValue === undefined || rawValue.startsWith('--')) {
        return invalid(`参数 ${token} 必须提供非空 Bot 名称。`);
      }
      const value = normalizeBotName(rawValue);
      if (!value) {
        return invalid(`参数 ${token} 必须提供非空 Bot 名称。`);
      }
      if (token === '--plan-writer') {
        planWriter = value;
      } else {
        implementer = value;
      }
      index++;
      continue;
    }

    if (token.startsWith('-')) {
      return invalid(`未知参数：${token}`);
    }
    if (workspacePath !== undefined) {
      return invalid(`只能提供一个 workspace 位置参数，多余参数：${token}`);
    }
    workspacePath = token;
  }

  if (workspacePath === undefined || !workspacePath.trim()) {
    return invalid('必须提供一个非空 workspace 位置参数。');
  }
  if (planWriter === undefined) {
    return invalid('缺少必填参数 --plan-writer。');
  }
  if (implementer === undefined) {
    return invalid('缺少必填参数 --implementer。');
  }

  return {
    ok: true,
    value: {
      workspacePath,
      planWriter,
      implementer,
    },
  };
}

function normalizeBotName(input: string): string {
  return input.trim().replace(/^@+/, '').trim().normalize('NFC');
}

function isLegacyPositionalSyntax(tokens: string[]): boolean {
  return tokens.length === 3 && tokens.every((token) => !token.startsWith('-'));
}

function invalid(reason: string): BootstrapCommandParseResult {
  return {
    ok: false,
    reason: `${reason}\n${PROJECT_BOOTSTRAP_USAGE}`,
  };
}
