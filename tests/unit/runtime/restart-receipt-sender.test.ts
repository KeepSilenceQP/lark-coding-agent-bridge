import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildReceiptRequestBody,
  sendLarkMessage,
  sendReceiptWithRetry,
  getTenantAccessToken,
  type ReceiptSendParams,
} from '../../../src/runtime/restart-receipt-sender';
import type { ReturnRoute } from '../../../src/runtime/restart-receipt';

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

// ── Helpers ────────────────────────────────────────────────────────────

function makeParams(overrides?: Partial<ReceiptSendParams>): ReceiptSendParams {
  return {
    profile: 'codex',
    returnRoute: {
      chatId: 'oc_test123',
      threadId: 'omt_thread456',
      replyTo: 'om_replyMsg789',
    },
    receiptId: 'restart-test-001',
    kind: 'success',
    uuid: 'restart-test-001-success-v1',
    newPid: 12345,
    ...overrides,
  };
}

function makeRoute(overrides?: Partial<ReturnRoute>): ReturnRoute {
  return {
    chatId: 'oc_test123',
    threadId: 'omt_thread456',
    replyTo: 'om_replyMsg789',
    ...overrides,
  };
}

function fakeJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

// ── UUID in request body ───────────────────────────────────────────────

describe('buildReceiptRequestBody', () => {
  it('includes the stable uuid in the request body', () => {
    const body = buildReceiptRequestBody(makeParams({ uuid: 'my-stable-uuid-123' }));
    const parsed = JSON.parse(body);
    expect(parsed.uuid).toBe('my-stable-uuid-123');
  });

  it('includes msg_type=text and content', () => {
    const body = buildReceiptRequestBody(makeParams());
    const parsed = JSON.parse(body);
    expect(parsed.msg_type).toBe('text');
    expect(parsed.content).toBeDefined();
    const content = JSON.parse(parsed.content);
    expect(content.text).toBeDefined();
    expect(typeof content.text).toBe('string');
  });

  it('produces the same uuid on successive calls with the same params', () => {
    const params = makeParams({ uuid: 'stable-uuid' });
    const body1 = JSON.parse(buildReceiptRequestBody(params));
    const body2 = JSON.parse(buildReceiptRequestBody(params));
    expect(body1.uuid).toBe(body2.uuid);
    expect(body1.uuid).toBe('stable-uuid');
  });

  it('includes success info in text content', () => {
    const body = buildReceiptRequestBody(
      makeParams({ kind: 'success', newPid: 99999 }),
    );
    const parsed = JSON.parse(body);
    const text = JSON.parse(parsed.content).text as string;
    expect(text).toContain('重启成功');
    expect(text).toContain('newPid: 99999');
    expect(text).toContain('restart-test-001');
  });

  it('includes failure reason in text content', () => {
    const body = buildReceiptRequestBody(
      makeParams({ kind: 'failure', reason: 'startup-timeout' }),
    );
    const parsed = JSON.parse(body);
    const text = JSON.parse(parsed.content).text as string;
    expect(text).toContain('重启失败');
    expect(text).toContain('启动超时');
  });

  it('includes reply_in_thread:true when route has threadId', () => {
    const body = buildReceiptRequestBody(
      makeParams({
        returnRoute: { chatId: 'oc_test', threadId: 'omt_topic1', replyTo: 'om_last' },
      }),
    );
    const parsed = JSON.parse(body);
    expect(parsed.reply_in_thread).toBe(true);
  });

  it('omits reply_in_thread when route has no threadId', () => {
    const body = buildReceiptRequestBody(
      makeParams({
        returnRoute: { chatId: 'oc_test', replyTo: 'om_last' },
      }),
    );
    const parsed = JSON.parse(body);
    expect(parsed.reply_in_thread).toBeUndefined();
    expect('reply_in_thread' in parsed).toBe(false);
  });
});

// ── Outbound API call captures uuid ────────────────────────────────────

describe('sendLarkMessage — uuid end-to-end', () => {
  it('posts to the reply endpoint with the correct message_id', async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      bodies.push(init?.body as string);
      return fakeJsonResponse({ code: 0, data: { message_id: 'om_newMsg001' } });
    }) as typeof fetch;

    const route = makeRoute({ replyTo: 'om_replyMsg789' });
    const body = buildReceiptRequestBody(makeParams({ uuid: 'uuid-test-abc' }));

    const messageId = await sendLarkMessage(
      'https://open.feishu.cn',
      't-token',
      route,
      body,
    );

    expect(messageId).toBe('om_newMsg001');
    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0]!);
    expect(parsed.uuid).toBe('uuid-test-abc');
  });

  it('sends to /reply endpoint (not /messages create)', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      urls.push(typeof input === 'string' ? input : input.toString());
      return fakeJsonResponse({ code: 0, data: { message_id: 'om_x' } });
    }) as typeof fetch;

    const route = makeRoute({ replyTo: 'om_target' });
    const body = buildReceiptRequestBody(makeParams({ uuid: 'u' }));

    await sendLarkMessage('https://open.feishu.cn', 't', route, body);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/reply');
    expect(urls[0]).toContain('om_target');
    expect(urls[0]).not.toContain('receive_id_type');
  });

  it('throws on non-zero API code', async () => {
    globalThis.fetch = vi.fn(async () =>
      fakeJsonResponse({ code: 190001, msg: 'message not found' }),
    ) as typeof fetch;

    await expect(
      sendLarkMessage(
        'https://open.feishu.cn',
        't',
        makeRoute(),
        buildReceiptRequestBody(makeParams()),
      ),
    ).rejects.toThrow(/code=190001/);
  });

  it('throws on HTTP error status', async () => {
    globalThis.fetch = vi.fn(async () =>
      fakeJsonResponse({}, 500),
    ) as typeof fetch;

    await expect(
      sendLarkMessage(
        'https://open.feishu.cn',
        't',
        makeRoute(),
        buildReceiptRequestBody(makeParams()),
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws on code=0 but missing data.message_id', async () => {
    globalThis.fetch = vi.fn(async () =>
      // API returns success code but no message_id — protocol error
      fakeJsonResponse({ code: 0, msg: 'success', data: {} }),
    ) as typeof fetch;

    await expect(
      sendLarkMessage(
        'https://open.feishu.cn',
        't',
        makeRoute(),
        buildReceiptRequestBody(makeParams()),
      ),
    ).rejects.toThrow(/data\.message_id is missing/);
  });

  it('returns message_id when present in response', async () => {
    globalThis.fetch = vi.fn(async () =>
      fakeJsonResponse({ code: 0, data: { message_id: 'om_actual_123' } }),
    ) as typeof fetch;

    const messageId = await sendLarkMessage(
      'https://open.feishu.cn',
      't',
      makeRoute(),
      buildReceiptRequestBody(makeParams()),
    );

    expect(messageId).toBe('om_actual_123');
  });

  it('sends reply_in_thread:true in body for topic route (threadId present)', async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      bodies.push(init?.body as string);
      return fakeJsonResponse({ code: 0, data: { message_id: 'om_x' } });
    }) as typeof fetch;

    const topicRoute = makeRoute({ threadId: 'omt_topic123', replyTo: 'om_parent' });
    const params = makeParams({
      uuid: 'u-topic',
      returnRoute: topicRoute,
    });
    const body = buildReceiptRequestBody(params);

    await sendLarkMessage('https://open.feishu.cn', 't', topicRoute, body);

    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0]!);
    expect(parsed.reply_in_thread).toBe(true);
    expect(parsed.uuid).toBe('u-topic');
  });

  it('omits reply_in_thread in body for non-topic route (no threadId)', async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      bodies.push(init?.body as string);
      return fakeJsonResponse({ code: 0, data: { message_id: 'om_x' } });
    }) as typeof fetch;

    const plainRoute = makeRoute({ threadId: undefined, replyTo: 'om_parent' });
    const params = makeParams({
      uuid: 'u-notopic',
      returnRoute: plainRoute,
    });
    const body = buildReceiptRequestBody(params);

    await sendLarkMessage('https://open.feishu.cn', 't', plainRoute, body);

    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0]!);
    expect(parsed.reply_in_thread).toBeUndefined();
    expect('reply_in_thread' in parsed).toBe(false);
  });
});

// ── Tenant access token ────────────────────────────────────────────────

describe('getTenantAccessToken', () => {
  it('posts app_id and app_secret to the internal token endpoint', async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      bodies.push(init?.body as string);
      return fakeJsonResponse({
        code: 0,
        tenant_access_token: 't-g123456',
        expire: 7200,
      });
    }) as typeof fetch;

    const token = await getTenantAccessToken(
      'https://open.feishu.cn',
      'cli_test',
      'secret123',
    );

    expect(token).toBe('t-g123456');
    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0]!);
    expect(parsed.app_id).toBe('cli_test');
    expect(parsed.app_secret).toBe('secret123');
  });

  it('throws on non-zero code', async () => {
    globalThis.fetch = vi.fn(async () =>
      fakeJsonResponse({ code: 999, msg: 'invalid app' }),
    ) as typeof fetch;

    await expect(
      getTenantAccessToken('https://open.feishu.cn', 'bad', 'bad'),
    ).rejects.toThrow(/code=999/);
  });
});

// ── Retry uses identical uuid ──────────────────────────────────────────

describe('retry uuid stability', () => {
  it('reports one actual attempt for a deterministic HTTP 400', async () => {
    const send = vi.fn(async () => {
      throw new Error('message reply failed: HTTP 400');
    });

    const result = await sendReceiptWithRetry(send, {
      sleep: async () => {},
    });

    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('produces identical body (including uuid) across retries', () => {
    const params = makeParams({ uuid: 'uuid-retry-test' });
    const body1 = buildReceiptRequestBody(params);
    const body2 = buildReceiptRequestBody(params);

    const parsed1 = JSON.parse(body1);
    const parsed2 = JSON.parse(body2);
    expect(parsed1).toEqual(parsed2);
    expect(parsed1.uuid).toBe('uuid-retry-test');
  });

  it('retry calls use same uuid across multiple sendLarkMessage calls', async () => {
    const uuids: string[] = [];
    let callCount = 0;
    globalThis.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse((init?.body as string) ?? '{}');
      uuids.push(body.uuid as string);
      if (callCount < 3) {
        return fakeJsonResponse({ code: 500, msg: 'transient' }, 500);
      }
      return fakeJsonResponse({ code: 0, data: { message_id: 'om_final' } });
    }) as typeof fetch;

    const route = makeRoute();
    // Simulate retry loop (simplified from sendRestartReceipt logic)
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const body = buildReceiptRequestBody(makeParams({ uuid: 'uuid-retry-xyz' }));
        await sendLarkMessage('https://open.feishu.cn', 't', route, body);
        break;
      } catch (err) {
        lastError = err;
        if (!/500/.test((err as Error).message)) break;
      }
    }

    // All 3 attempts used the same uuid
    expect(uuids).toHaveLength(3);
    expect(new Set(uuids).size).toBe(1);
    expect(uuids[0]).toBe('uuid-retry-xyz');
  });
});
