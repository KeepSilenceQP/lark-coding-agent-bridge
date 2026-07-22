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
  return { ...process.env, LARK_CHANNEL: '1', LARK_CHANNEL_HOME: '/t', LARK_CHANNEL_PROFILE: 'p' };
}

const LISTED_BOT_ID = 'ou_target_bot';
const LISTED_BOT_NAME = '目标Bot';

function discRes(overrides?: Record<string, unknown>) {
  return {
    exitCode: 0 as number | null, signalCode: null as string | null, settled: 'exit' as const,
    stdout: JSON.stringify({
      ok: true, identity: 'bot',
      data: { items: [{ bot_id: 'ou_other', bot_name: '其他Bot' }, { bot_id: LISTED_BOT_ID, bot_name: LISTED_BOT_NAME }] },
      ...overrides,
    }), stderr: '',
  };
}

function sendRes(messageId = 'om_test_123') {
  return {
    exitCode: 0 as number | null, signalCode: null as string | null, settled: 'exit' as const,
    stdout: JSON.stringify({ ok: true, identity: 'bot', data: { message_id: messageId } }), stderr: '',
  };
}

const B = { chatId: 'oc_test', botId: LISTED_BOT_ID, message: 'hello', env: withBridgeEnv() };

describe('at-bot command', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ═══ context ═══
  it('context-missing: LARK_CHANNEL != 1', async () => {
    await expect(runAtBot({ ...B, env: { ...process.env, LARK_CHANNEL: undefined } as NodeJS.ProcessEnv }))
      .rejects.toMatchObject({ code: 'at-bot/context-missing' });
  });

  // ═══ argument validation ═══
  it.each([
    ['', 'ou_test', 'hi'],
    ['od_test', 'ou_test', 'hi'],
    ['oc_', 'ou_test', 'hi'],
    ['oc_test', '', 'hi'],
    ['oc_test', 'cli_test', 'hi'],
    ['oc_test', 'ou_', 'hi'],
    ['oc_test', 'ou_test', ''],
    ['oc_test', 'ou_test', '   '],
  ])('invalid-argument: chatId=%s botId=%s msg=%s', async (chatId, botId, message) => {
    await expect(runAtBot({ chatId, botId, message, env: withBridgeEnv() }))
      .rejects.toMatchObject({ code: 'at-bot/invalid-argument' });
  });

  // ═══ discovery ═══
  it('discovery uses lark-cli --as bot --format json', async () => {
    mockRunBounded.mockResolvedValueOnce(discRes());
    mockRunBounded.mockResolvedValueOnce(sendRes());
    await runAtBot(B);
    const call = (mockRunBounded.mock.calls as Array<[string, string[]]>)[0]!;
    expect(call[0]).toBe('lark-cli');
    expect(call[1]).toContain('--as');
    expect(call[1]).toContain('bot');
    expect(call[1]).toContain('chat.members');
    expect(call[1]).toContain('bots');
  });

  // ═══ discovery failures ═══
  it.each([
    ['unavailable', { settled: 'unavailable' as const, stdout: '' }, 'at-bot/discovery-unavailable'],
    ['timeout', { settled: 'timeout' as const, stdout: '' }, 'at-bot/discovery-timeout'],
    ['malformed JSON', { stdout: 'not json' }, 'at-bot/discovery-invalid'],
    ['JSON root null', { stdout: 'null' }, 'at-bot/discovery-invalid'],
    ['ok false', { stdout: JSON.stringify({ ok: false, identity: 'bot' }) }, 'at-bot/discovery-invalid'],
    ['identity user', { stdout: JSON.stringify({ ok: true, identity: 'user', data: { items: [] } }) }, 'at-bot/discovery-invalid'],
    ['string code', { stdout: JSON.stringify({ ok: true, identity: 'bot', code: '0', data: { items: [] } }) }, 'at-bot/discovery-invalid'],
    ['nonzero exitCode', { exitCode: 1, stdout: JSON.stringify({ ok: true, identity: 'bot', data: { items: [] } }) }, 'at-bot/discovery-invalid'],
    ['exitCode null', { exitCode: null, stdout: JSON.stringify({ ok: true, identity: 'bot', data: { items: [] } }) }, 'at-bot/discovery-invalid'],
    ['items null element', { stdout: JSON.stringify({ ok: true, identity: 'bot', data: { items: [null] } }) }, 'at-bot/discovery-invalid'],
    ['bot_name missing', { stdout: JSON.stringify({ ok: true, identity: 'bot', data: { items: [{ bot_id: LISTED_BOT_ID }] } }) }, 'at-bot/discovery-invalid'],
  ])('discovery: %s → %s', async (_label, overrides, expectedCode) => {
    mockRunBounded.mockResolvedValueOnce({ ...discRes(), ...overrides });
    await expect(runAtBot(B)).rejects.toMatchObject({ code: expectedCode });
    expect(mockRunBounded).toHaveBeenCalledTimes(1); // no send attempted
  });

  // ═══ unbound ═══
  it('context-unbound: stdout marker → fixed instruction', async () => {
    mockRunBounded.mockResolvedValueOnce({ ...discRes(), exitCode: 1, stdout: 'lark-channel context detected but not bound' });
    await expect(runAtBot(B)).rejects.toMatchObject({ code: 'at-bot/context-unbound' });
  });

  // ═══ target ═══
  it('target-not-in-group: absent botId, no send', async () => {
    mockRunBounded.mockResolvedValueOnce({
      exitCode: 0 as number | null, signalCode: null as string | null, settled: 'exit' as const,
      stdout: JSON.stringify({ ok: true, identity: 'bot', data: { items: [{ bot_id: 'ou_other', bot_name: 'O' }] } }), stderr: '',
    });
    await expect(runAtBot(B)).rejects.toMatchObject({ code: 'at-bot/target-not-in-group' });
    expect(mockRunBounded).toHaveBeenCalledTimes(1);
  });

  // ═══ send ═══
  it('send: +messages-send, --msg-type post, canonical content', async () => {
    mockRunBounded.mockResolvedValueOnce(discRes());
    mockRunBounded.mockResolvedValueOnce(sendRes());
    await runAtBot(B);
    const sa = (mockRunBounded.mock.calls as Array<[string, string[]]>)[1]![1]!;
    expect(sa).toContain('+messages-send');
    expect(sa).toContain('post');
    const ci = sa.indexOf('--content');
    const c = JSON.parse(sa[ci + 1]!);
    const p = c.zh_cn.content[0];
    expect(p.length).toBe(2);
    expect(p[0]).toEqual({ tag: 'at', user_id: LISTED_BOT_ID, user_name: LISTED_BOT_NAME });
    expect(p[1]).toEqual({ tag: 'text', text: ' hello' });
  });

  // ═══ canonical post special chars (7 variants) ═══
  it.each([
    ['say "hi"'],
    ["don't"],
    ['a\nb'],
    ['a<b>c'],
    ['text</a>'],
    ['<at user_id="x">N</at>'],
    ['@Bot hi'],
  ])('canonical post: msg=%j stays in text element', async (msg) => {
    mockRunBounded.mockResolvedValueOnce(discRes());
    mockRunBounded.mockResolvedValueOnce(sendRes());
    await runAtBot({ ...B, message: msg });
    const sa = (mockRunBounded.mock.calls as Array<[string, string[]]>)[1]![1]!;
    const ci = sa.indexOf('--content');
    const c = JSON.parse(sa[ci + 1]!);
    const p = c.zh_cn.content[0];
    expect(p.length).toBe(2);
    expect(p[0].tag).toBe('at');
    expect(p[1].tag).toBe('text');
    expect(p[1].text).toBe(` ${msg}`);
  });

  // ═══ send failures — table-driven ═══
  it.each([
    ['send-unavailable', { settled: 'unavailable' as const, stdout: '' }, 'at-bot/send-unavailable'],
    ['send-timeout', { settled: 'timeout' as const, stdout: '' }, 'at-bot/send-timeout'],
    ['send-rejected ok=false', { stdout: JSON.stringify({ ok: false, identity: 'bot', code: 999 }) }, 'at-bot/send-rejected'],
    ['send-invalid identity', { stdout: JSON.stringify({ ok: true, identity: 'user', data: { message_id: 'om_x' } }) }, 'at-bot/send-invalid'],
    ['send-invalid string code', { stdout: JSON.stringify({ ok: true, identity: 'bot', code: '0', data: { message_id: 'om_x' } }) }, 'at-bot/send-invalid'],
    ['send-invalid missing message_id', { stdout: JSON.stringify({ ok: true, identity: 'bot', data: {} }) }, 'at-bot/send-invalid'],
    ['send-invalid number message_id', { stdout: JSON.stringify({ ok: true, identity: 'bot', data: { message_id: 123 } }) }, 'at-bot/send-invalid'],
    ['send-invalid nonzero exitCode', { exitCode: 1 }, 'at-bot/send-invalid'],
  ])('send failure: %s → %s', async (_label, overrides, expectedCode) => {
    mockRunBounded.mockResolvedValueOnce(discRes());
    mockRunBounded.mockResolvedValueOnce({ ...sendRes(), ...overrides });
    await expect(runAtBot(B)).rejects.toMatchObject({ code: expectedCode });
  });

  // ═══ nested error.code ═══
  it('send-rejected: nested error.code → apiCode preserved', async () => {
    mockRunBounded.mockResolvedValueOnce(discRes());
    mockRunBounded.mockResolvedValueOnce({
      exitCode: 0, signalCode: null, settled: 'exit' as const,
      stdout: JSON.stringify({ ok: false, identity: 'bot', error: { code: 230001, message: 'perm' } }), stderr: '',
    });
    let caught: any = null;
    try { await runAtBot(B); } catch (err) { caught = err; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('at-bot/send-rejected');
    expect(caught.apiCode).toBe(230001);
  });

  // ═══ success ═══
  it('success: {ok:true, chatId, botId, messageId}', async () => {
    mockRunBounded.mockResolvedValueOnce(discRes());
    mockRunBounded.mockResolvedValueOnce(sendRes('om_real_456'));
    const r = await runAtBot(B);
    expect(r).toEqual({ ok: true, chatId: 'oc_test', botId: LISTED_BOT_ID, messageId: 'om_real_456' });
  });

  // ═══ 12 failure categories — table-driven real trigger, verify prefix+code ═══
  const CATEGORY_FIXTURES: Array<[string, string, () => Promise<void>]> = [
    ['at-bot/context-missing', 'run only from a bridge-bound Agent', async () => {
      await runAtBot({ ...B, env: { ...process.env, LARK_CHANNEL: undefined } as NodeJS.ProcessEnv });
    }],
    ['at-bot/context-unbound', 'restart the Bridge or run doctor/preflight', async () => {
      mockRunBounded.mockResolvedValueOnce({ ...discRes(), exitCode: 1, stdout: 'lark-channel context detected but not bound' });
      await runAtBot(B);
    }],
    ['at-bot/invalid-argument', 'correct the named CLI option', async () => {
      await runAtBot({ ...B, chatId: '' });
    }],
    ['at-bot/target-not-in-group', 'verify the target Bot in the current group', async () => {
      mockRunBounded.mockResolvedValueOnce({ ...discRes(), stdout: JSON.stringify({ ok: true, identity: 'bot', data: { items: [{ bot_id: 'ou_x', bot_name: 'X' }] } }) });
      await runAtBot(B);
    }],
    ['at-bot/discovery-unavailable', 'restore current-profile Bot discovery; do not send', async () => {
      mockRunBounded.mockResolvedValueOnce({ ...discRes(), settled: 'unavailable' as const, stdout: '' });
      await runAtBot(B);
    }],
    ['at-bot/discovery-timeout', 'restore current-profile Bot discovery; do not send', async () => {
      mockRunBounded.mockResolvedValueOnce({ ...discRes(), settled: 'timeout' as const, stdout: '' });
      await runAtBot(B);
    }],
    ['at-bot/discovery-invalid', 'restore current-profile Bot discovery; do not send', async () => {
      mockRunBounded.mockResolvedValueOnce({ ...discRes(), stdout: 'not json' });
      await runAtBot(B);
    }],
    ['at-bot/send-unavailable', 'notification is not confirmed; do not claim success', async () => {
      mockRunBounded.mockResolvedValueOnce(discRes());
      mockRunBounded.mockResolvedValueOnce({ ...sendRes(), settled: 'unavailable' as const, stdout: '' });
      await runAtBot(B);
    }],
    ['at-bot/send-timeout', 'notification is not confirmed; do not claim success', async () => {
      mockRunBounded.mockResolvedValueOnce(discRes());
      mockRunBounded.mockResolvedValueOnce({ ...sendRes(), settled: 'timeout' as const, stdout: '' });
      await runAtBot(B);
    }],
    ['at-bot/send-rejected', 'notification is not confirmed; do not claim success', async () => {
      mockRunBounded.mockResolvedValueOnce(discRes());
      mockRunBounded.mockResolvedValueOnce({ ...sendRes(), stdout: JSON.stringify({ ok: false, identity: 'bot', code: 999 }) });
      await runAtBot(B);
    }],
    ['at-bot/send-invalid', 'notification is not confirmed; do not claim success', async () => {
      mockRunBounded.mockResolvedValueOnce(discRes());
      mockRunBounded.mockResolvedValueOnce({ ...sendRes(), stdout: JSON.stringify({ ok: true, identity: 'user', data: { message_id: 'om_x' } }) });
      await runAtBot(B);
    }],
    ['at-bot/termination-unconfirmed', 'a child tree may remain; do not retry automatically', async () => {
      // Exercise via discovery-settle: use discRes + settled = termination-unconfirmed
      mockRunBounded.mockResolvedValueOnce({ ...discRes(), settled: 'termination-unconfirmed' as const, stdout: '' });
      await runAtBot(B);
    }],
  ];

  it.each(CATEGORY_FIXTURES)('category %s triggers, code and action verified', async (code, action, fn) => {
    try {
      await fn();
      expect.unreachable(`expected ${code} to throw`);
    } catch (err) {
      const e = err as Error & { code?: string };
      expect(e.code).toBe(code);
      expect(e.message).toContain(code);
      expect(e.message).toContain(action);
    }
  });

  // ═══ redaction (guarded — each must throw) ═══
  it('redacts bare token in discovery msg', async () => {
    mockRunBounded.mockResolvedValueOnce({ ...discRes(), stdout: JSON.stringify({ ok: false, identity: 'bot', msg: 'secret abc123xyz' }) });
    let threw = false;
    try { await runAtBot(B); } catch (err) {
      threw = true;
      const m = (err as Error).message;
      expect(m).not.toContain('abc123xyz');
      expect(m).toContain('at-bot/discovery-invalid');
    }
    expect(threw).toBe(true);
  });

  it('redacts nested error.message secret from send', async () => {
    mockRunBounded.mockResolvedValueOnce(discRes());
    mockRunBounded.mockResolvedValueOnce({
      exitCode: 0, signalCode: null, settled: 'exit' as const,
      stdout: JSON.stringify({ ok: false, identity: 'bot', error: { code: 230001, message: 'token sk-123 leaked' } }), stderr: '',
    });
    let threw = false;
    try { await runAtBot(B); } catch (err) {
      threw = true;
      const m = (err as Error).message;
      expect(m).not.toContain('sk-123');
      expect(m).toContain('at-bot/send-rejected');
    }
    expect(threw).toBe(true);
  });

  it('redacts stderr credential via unbound marker (not incidental)', async () => {
    mockRunBounded.mockResolvedValueOnce({
      exitCode: 1, signalCode: null, settled: 'exit' as const,
      stdout: '', stderr: 'lark-channel context detected but not bound APP_SECRET=deadbeef',
    });
    let threw = false;
    try { await runAtBot(B); } catch (err) {
      threw = true;
      const m = (err as Error).message;
      expect(m).not.toContain('deadbeef');
      expect(m).not.toContain('APP_SECRET');
      expect(m).toContain('restart the Bridge or run doctor/preflight');
    }
    expect(threw).toBe(true);
  });
});
