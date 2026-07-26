import { describe, expect, it } from 'vitest';
import {
  parseBootstrapCommand,
  PROJECT_BOOTSTRAP_USAGE,
  tokenizeBootstrapArgs,
} from '../../../src/project/bootstrap-args';

describe('tokenizeBootstrapArgs', () => {
  it('groups single- and double-quoted tokens containing spaces', () => {
    expect(tokenizeBootstrapArgs(
      `"/repo/with spaces" --plan-writer 'Planner Bot' --implementer "Coder Bot"`,
    )).toEqual({
      ok: true,
      tokens: [
        '/repo/with spaces',
        '--plan-writer',
        'Planner Bot',
        '--implementer',
        'Coder Bot',
      ],
    });
  });

  it('preserves empty quoted tokens for parser-level validation', () => {
    expect(tokenizeBootstrapArgs(`workspace --plan-writer "" --implementer ''`))
      .toEqual({
        ok: true,
        tokens: ['workspace', '--plan-writer', '', '--implementer', ''],
      });
  });

  it('keeps shell-like syntax and backslash sequences literal', () => {
    expect(tokenizeBootstrapArgs(
      String.raw`'$HOME/my repo' --plan-writer "\`whoami\` Bot" --implementer 'Coder\nBot'`,
    )).toEqual({
      ok: true,
      tokens: [
        '$HOME/my repo',
        '--plan-writer',
        String.raw`\`whoami\` Bot`,
        '--implementer',
        String.raw`Coder\nBot`,
      ],
    });
  });

  it.each([
    ['"', `workspace --plan-writer "Planner Bot --implementer Coder`],
    ["'", `workspace --plan-writer 'Planner Bot --implementer Coder`],
  ])('rejects an unclosed %s quote', (quote, input) => {
    const result = tokenizeBootstrapArgs(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(`${quote} 引号未闭合`);
    }
  });
});

describe('parseBootstrapCommand', () => {
  it('treats both role-flag orders as equivalent', () => {
    const first = parseInput(
      `repo --plan-writer "Planner Bot" --implementer "Coder Bot"`,
    );
    const second = parseInput(
      `--implementer "Coder Bot" repo --plan-writer "Planner Bot"`,
    );

    expect(first).toEqual({
      ok: true,
      value: {
        workspacePath: 'repo',
        planWriter: 'Planner Bot',
        implementer: 'Coder Bot',
      },
    });
    expect(second).toEqual(first);
  });

  it('accepts quoted workspace and Bot names from both quote styles', () => {
    expect(parseInput(
      `'/repo/project one' --implementer 'Coder One' --plan-writer "Planner One"`,
    )).toEqual({
      ok: true,
      value: {
        workspacePath: '/repo/project one',
        planWriter: 'Planner One',
        implementer: 'Coder One',
      },
    });
  });

  it('normalizes Bot names by trimming, removing leading @, and applying NFC', () => {
    const result = parseInput(
      `repo --plan-writer "  @@@Cafe\u0301 Planner  " --implementer " @Coder "`,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        workspacePath: 'repo',
        planWriter: 'Café Planner',
        implementer: 'Coder',
      },
    });
  });

  it.each([
    ['missing workspace', `--plan-writer Planner --implementer Coder`, /workspace/],
    ['missing plan writer', `repo --implementer Coder`, /--plan-writer/],
    ['missing implementer', `repo --plan-writer Planner`, /--implementer/],
    [
      'duplicate plan writer',
      `repo --plan-writer Planner --plan-writer Other --implementer Coder`,
      /不能重复/,
    ],
    [
      'duplicate implementer',
      `repo --implementer Coder --implementer Other --plan-writer Planner`,
      /不能重复/,
    ],
    [
      'unknown flag',
      `repo --plan-writer Planner --unknown value --implementer Coder`,
      /未知参数/,
    ],
    [
      'extra positional argument',
      `repo extra --plan-writer Planner --implementer Coder`,
      /只能提供一个 workspace/,
    ],
    [
      'empty workspace',
      `"" --plan-writer Planner --implementer Coder`,
      /非空 workspace/,
    ],
    [
      'empty plan writer',
      `repo --plan-writer "" --implementer Coder`,
      /--plan-writer.*非空/,
    ],
    [
      'empty implementer after @ removal',
      `repo --plan-writer Planner --implementer "@@@"`,
      /--implementer.*非空/,
    ],
    [
      'flag used as preceding flag value',
      `repo --plan-writer --implementer Coder`,
      /--plan-writer.*非空/,
    ],
  ])('rejects %s and returns canonical usage', (_label, input, reason) => {
    const result = parseInput(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(reason);
      expect(result.reason).toContain(PROJECT_BOOTSTRAP_USAGE);
    }
  });

  it('explicitly rejects the legacy three-positional syntax without mapping roles', () => {
    const result = parseInput(`repo OldImplementer OldPlanWriter`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('旧语法已废弃，请使用具名参数');
      expect(result.reason).toContain(PROJECT_BOOTSTRAP_USAGE);
    }
  });

  it('returns $HOME and backticks as literal values without expansion', () => {
    expect(parseInput(
      `'$HOME/project one' --plan-writer '\`whoami\` Planner' --implementer '$USER Coder'`,
    )).toEqual({
      ok: true,
      value: {
        workspacePath: '$HOME/project one',
        planWriter: '`whoami` Planner',
        implementer: '$USER Coder',
      },
    });
  });
});

function parseInput(input: string) {
  const tokenized = tokenizeBootstrapArgs(input);
  if (!tokenized.ok) return tokenized;
  return parseBootstrapCommand(tokenized.tokens);
}
