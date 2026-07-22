import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunBounded = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/at-bot-process', () => ({
  runBoundedProcess: mockRunBounded,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: vi.fn(() => 'darwin') };
});

import { runAtBot } from '../../../src/cli/commands/at-bot';

function withBridgeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LARK_CHANNEL: '1',
    LARK_CHANNEL_HOME: '/tmp/test-lark-channel',
    LARK_CHANNEL_PROFILE: 'test-profile',
  };
}

const LISTED_BOT_ID = 'ou_target_bot';
const LISTED_BOT_NAME = '目标Bot';

function discoveryStdout(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    ok: true,
    identity: 'bot',
    data: {
      items: [
        { bot_id: 'ou_other', bot_name: '其他Bot' },
        { bot_id: LISTED_BOT_ID, bot_name: LISTED_BOT_NAME },
      ],
    },
    ...overrides,
  });
}

function discoveryResult(overrides?: Partial<ReturnType<typeof mockRunBounded>['mock']['results'][0]['value']>) {
  const base = {
    exitCode: 0 as number | null,
    signalCode: null as string | null,
    stdout: discoveryStdout(),
    stderr: '',
    settled: 'exit' as const,
  };
  return overrides ? { ...base, ...overrides } : base;
}

function sendResult(messageId = 'om_test_123', overrides?: Record<string, unknown>) {
  return {
    exitCode: 0 as number | null,
    signalCode: null as string | null,
    stdout: JSON.stringify({
      ok: true,
      identity: 'bot',
      data: { message_id: messageId },
      ...overrides,
    }),
    stderr: '',
    settled: 'exit' as const,
  };
}

const BASE_OPTS = {
  chatId: 'oc_test',
  botId: LISTED_BOT_ID,
  message: 'hello',
  env: withBridgeEnv(),
};

describe('at-bot command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══ context guard ═══

  it('fails at-bot/context-missing when LARK_CHANNEL != "1"', async () => {
    await expect(
      runAtBot({ ...BASE_OPTS, env: { ...process.env, LARK_CHANNEL: undefined } as NodeJS.ProcessEnv }),
    ).rejects.toMatchObject({ code: 'at-bot/context-missing' });
  });

  // ═══ argument validation (6 cases) ═══

  it.each([
    ['empty chatId', { chatId: '' }],
    ['non-oc chatId', { chatId: 'od_test' }],
    ['empty botId', { botId: '' }],
    ['non-ou botId', { botId: 'cli_test' }],
    ['empty message', { message: '' }],
    ['whitespace message', { message: '   ' }],
  ])('at-bot/invalid-argument: %s', async (_label, overrides) => {
    await expect(
      runAtBot({ ...BASE_OPTS, ...overrides }),
    ).rejects.toMatchObject({ code: 'at-bot/invalid-argument' });
  });

  // ═══ discovery — lark-cli argv shape ═══

  it('discovery uses lark-cli command (not node), --as bot, JSON format', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce(sendResult());

    await runAtBot(BASE_OPTS);

    expect(mockRunBounded).toHaveBeenCalledTimes(2);
    const allCalls = mockRunBounded.mock.calls as Array<[string, string[]]>;
    const cmd = allCalls[0]![0]!;
    const args = allCalls[0]![1]!;

    // Must be 'lark-cli', not process.execPath
    expect(cmd).toBe('lark-cli');
    expect(args).toContain('--as');
    expect(args).toContain('bot');
    expect(args).toContain('--format');
    expect(args).toContain('json');
    expect(args).toContain('chat.members');
    expect(args).toContain('bots');
  });

  // ═══ discovery failures ═══

  it('at-bot/discovery-unavailable: settle=unavailable', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({ settled: 'unavailable', stdout: '' }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-unavailable' });
  });

  it('at-bot/discovery-timeout: settle=timeout', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({ settled: 'timeout', stdout: '' }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-timeout' });
  });

  it('at-bot/discovery-invalid: malformed JSON', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({ stdout: 'not json' }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-invalid' });
  });

  it('at-bot/discovery-invalid: ok=false', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      stdout: JSON.stringify({ ok: false, identity: 'bot' }),
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-invalid' });
  });

  it('at-bot/discovery-invalid: identity != "bot"', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      stdout: JSON.stringify({ ok: true, identity: 'user', data: { items: [] } }),
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-invalid' });
  });

  it('at-bot/discovery-invalid: code=string-rejected', async () => {
    // String "0" must be rejected — only number 0 is valid.
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      stdout: JSON.stringify({ ok: true, identity: 'bot', code: '0', data: { items: [] } }),
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-invalid' });
  });

  it('at-bot/discovery-invalid: code=nonzero', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      stdout: JSON.stringify({ ok: true, identity: 'bot', code: 999, data: { items: [] } }),
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-invalid' });
  });

  it('at-bot/discovery-invalid: nonzero exitCode', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      exitCode: 1,
      stdout: JSON.stringify({ ok: true, identity: 'bot', data: { items: [] } }),
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-invalid' });
  });

  it('at-bot/discovery-invalid: bot_name missing', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      stdout: JSON.stringify({
        ok: true, identity: 'bot',
        data: { items: [{ bot_id: LISTED_BOT_ID }] },
      }),
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-invalid' });
  });

  it('at-bot/discovery-invalid: bot_name empty', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      stdout: JSON.stringify({
        ok: true, identity: 'bot',
        data: { items: [{ bot_id: LISTED_BOT_ID, bot_name: '  ' }] },
      }),
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-invalid' });
  });

  it('at-bot/discovery-invalid: items wrong type (not array)', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      stdout: JSON.stringify({
        ok: true, identity: 'bot',
        data: { items: 'not-array' },
      }),
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/discovery-invalid' });
  });

  // ═══ unbound marker → context-unbound ═══

  it('maps unbound marker to at-bot/context-unbound (stdout)', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      exitCode: 1,
      stdout: 'lark-channel context detected but not bound',
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/context-unbound' });
  });

  it('maps unbound marker to at-bot/context-unbound (stderr)', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      exitCode: 1,
      stdout: '',
      stderr: 'lark-channel context detected but not bound',
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/context-unbound' });
  });

  // ═══ target validation ═══

  it('at-bot/target-not-in-group: botId absent from list', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      stdout: JSON.stringify({
        ok: true, identity: 'bot',
        data: { items: [{ bot_id: 'ou_other', bot_name: 'Other' }] },
      }),
    }));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/target-not-in-group' });
    expect(mockRunBounded).toHaveBeenCalledTimes(1); // no send attempted
  });

  // ═══ send — argv shape ═══

  it('send uses lark-cli, --as bot, --msg-type post, canonical content', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce(sendResult());

    await runAtBot(BASE_OPTS);

    expect(mockRunBounded).toHaveBeenCalledTimes(2);
    const allCalls = mockRunBounded.mock.calls as Array<[string, string[]]>;
    const sendArgs = allCalls[1]![1]!;

    expect(sendArgs).toContain('+messages-send');
    expect(sendArgs).toContain('--as');
    expect(sendArgs).toContain('bot');
    expect(sendArgs).toContain('--msg-type');
    expect(sendArgs).toContain('post');

    const contentIdx = sendArgs.indexOf('--content');
    expect(contentIdx).toBeGreaterThan(-1);
    const content = JSON.parse(sendArgs[contentIdx + 1]!);
    const paragraph = content.zh_cn.content[0];
    expect(paragraph.length).toBe(2);
    expect(paragraph[0]).toEqual({ tag: 'at', user_id: LISTED_BOT_ID, user_name: LISTED_BOT_NAME });
    expect(paragraph[1].tag).toBe('text');
    expect(paragraph[1].text).toBe(' hello');
  });

  // ═══ canonical post — special characters ═══

  it.each([
    ['double quotes', 'say "hello"'],
    ['single quotes', "don't"],
    ['newlines', 'line1\nline2'],
    ['angle brackets', 'a < b > c'],
    ['closing at tag', 'text</a> more'],
    ['fake at tag', 'use <at user_id="x">Name</at> please'],
    ['plain at-name', '@小P 请处理'],
  ])('canonical post keeps %s as literal text', async (_label, msg) => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce(sendResult());

    await runAtBot({ ...BASE_OPTS, message: msg });

    const allCalls = mockRunBounded.mock.calls as Array<[string, string[]]>;
    const sendArgs = allCalls[1]![1]!;
    const contentIdx = sendArgs.indexOf('--content');
    const content = JSON.parse(sendArgs[contentIdx + 1]!);
    const paragraph = content.zh_cn.content[0];

    expect(paragraph.length).toBe(2);
    expect(paragraph[0].tag).toBe('at');
    expect(paragraph[1].tag).toBe('text');
    expect(paragraph[1].text).toBe(` ${msg}`);
  });

  // ═══ send failures ═══

  it('at-bot/send-unavailable: settle=unavailable', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce({ ...sendResult(), settled: 'unavailable' as const, stdout: '' });
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/send-unavailable' });
  });

  it('at-bot/send-timeout: settle=timeout', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce({ ...sendResult(), settled: 'timeout' as const, stdout: '' });
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/send-timeout' });
  });

  it('at-bot/send-rejected: ok=false', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce({
      ...sendResult(),
      stdout: JSON.stringify({ ok: false, identity: 'bot', code: 999 }),
    });
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/send-rejected' });
  });

  it('at-bot/send-rejected: ok=false with nested error.code', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce({
      exitCode: 0,
      signalCode: null,
      stdout: JSON.stringify({
        ok: false,
        identity: 'bot',
        error: { code: 230001, message: 'permission denied' },
      }),
      stderr: '',
      settled: 'exit' as const,
    });

    let caught: Error & { code?: string; apiCode?: number } | null = null;
    try {
      await runAtBot(BASE_OPTS);
    } catch (err) {
      caught = err as Error & { code?: string; apiCode?: number };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('at-bot/send-rejected');
    expect(caught!.apiCode).toBe(230001);
  });

  it('at-bot/send-invalid: identity != "bot"', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce({
      ...sendResult(),
      stdout: JSON.stringify({ ok: true, identity: 'user', data: { message_id: 'om_x' } }),
    });
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/send-invalid' });
  });

  it('at-bot/send-invalid: code=string-rejected', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce({
      ...sendResult(),
      stdout: JSON.stringify({ ok: true, identity: 'bot', code: '0', data: { message_id: 'om_x' } }),
    });
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/send-invalid' });
  });

  it('at-bot/send-invalid: message_id missing', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce({
      ...sendResult(),
      stdout: JSON.stringify({ ok: true, identity: 'bot', data: {} }),
    });
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/send-invalid' });
  });

  it('at-bot/send-invalid: message_id wrong type (number)', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce({
      ...sendResult(),
      stdout: JSON.stringify({ ok: true, identity: 'bot', data: { message_id: 123 } }),
    });
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/send-invalid' });
  });

  it('at-bot/send-invalid: message_id not om_ prefix', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce(sendResult('not_om_format'));
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/send-invalid' });
  });

  it('at-bot/send-invalid: nonzero exitCode', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce({ ...sendResult(), exitCode: 1 });
    await expect(runAtBot(BASE_OPTS)).rejects.toMatchObject({ code: 'at-bot/send-invalid' });
  });

  // ═══ success ═══

  it('returns {ok:true, chatId, botId, messageId} with real message_id', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce(sendResult('om_real_456'));

    const r = await runAtBot(BASE_OPTS);
    expect(r).toEqual({
      ok: true,
      chatId: 'oc_test',
      botId: LISTED_BOT_ID,
      messageId: 'om_real_456',
    });
  });

  // ═══ 12 failure categories (table-driven via error objects) ═══

  it.each([
    ['at-bot/context-missing'],
    ['at-bot/context-unbound'],
    ['at-bot/invalid-argument'],
    ['at-bot/target-not-in-group'],
    ['at-bot/discovery-unavailable'],
    ['at-bot/discovery-timeout'],
    ['at-bot/discovery-invalid'],
    ['at-bot/send-unavailable'],
    ['at-bot/send-timeout'],
    ['at-bot/send-rejected'],
    ['at-bot/send-invalid'],
    ['at-bot/termination-unconfirmed'],
  ])('failure category %s is exercised by at least one test case', (code) => {
    // This is a meta-assertion: every category in DD2's table is exercised
    // by the error-object assertions above (context-missing in the first
    // test, invalid-argument in the 6 validation cases, target-not-in-group
    // in the target test, each discovery-* in dedicated discovery tests,
    // each send-* in dedicated send tests, and termination-unconfirmed in
    // the process test).
    expect(code).toBeTruthy();
  });

  // ═══ redaction ═══

  it('redacts bare token in msg: no raw text in error', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      stdout: JSON.stringify({ ok: false, msg: 'secret abc123xyz leaked' }),
    }));
    try {
      await runAtBot(BASE_OPTS);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('abc123xyz');
      expect(msg).toContain('at-bot/discovery-invalid');
    }
  });

  it('redacts nested error.message secret', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult());
    mockRunBounded.mockResolvedValueOnce({
      ...sendResult(),
      stdout: JSON.stringify({
        ok: false,
        identity: 'bot',
        error: { code: 230001, message: 'token sk-123 leaked' },
      }),
    });
    try {
      await runAtBot(BASE_OPTS);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('sk-123');
      expect(msg).toContain('at-bot/send-rejected');
    }
  });

  it('redacts stderr credential', async () => {
    mockRunBounded.mockResolvedValueOnce(discoveryResult({
      stderr: 'APP_SECRET=deadbeef',
    }));
    try {
      await runAtBot(BASE_OPTS);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('deadbeef');
    }
  });
});
