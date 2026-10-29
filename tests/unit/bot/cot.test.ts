import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { consumeCotEvents, CotClient, CotPublisher, cotBriefToolTitle, finalAnswerOnlyState } from '../../../src/bot/cot.js';
import { log } from '../../../src/core/logger.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { RunState } from '../../../src/card/run-state.js';

describe('COT request diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('identifies a tenant authentication timeout without logging credentials', async () => {
    const error = new DOMException('request secret must not be logged', 'TimeoutError');
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const client = new CotClient({ tenant: 'feishu', appId: 'private-app', appSecret: 'private-secret' });

    await expect(client.create('oc_chat', 'om_origin')).rejects.toBe(error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('cot', 'request-failed', expect.objectContaining({
      operation: 'tenant-auth', errorName: 'TimeoutError', timeoutMs: 15_000,
      durationMs: expect.any(Number),
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-app|private-secret|request secret/);
  });

  it('identifies a create response-body failure and preserves its transport cause code', async () => {
    const cause = Object.assign(new Error('private socket details'), { code: 'ECONNRESET' });
    const error = new TypeError('fetch failed', { cause });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, tenant_access_token: 'private-token', expire: 7200 }) })
      .mockResolvedValueOnce({ ok: true, text: async () => { throw error; } });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const client = new CotClient({ tenant: 'feishu', appId: 'private-app', appSecret: 'private-secret' });

    await expect(client.create('oc_chat', 'om_origin')).rejects.toBe(error);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('cot', 'request-failed', expect.objectContaining({
      operation: 'cot-create', errorName: 'TypeError', causeCode: 'ECONNRESET',
      durationMs: expect.any(Number), timeoutMs: 15_000,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-token|private-secret|private socket/);
  });
});

describe('COT connection retries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('recovers a connection failure without dropping or reordering progress events', async () => {
    vi.useFakeTimers();
    const updateBodies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/auth/')) return cotAuthResponse();
      if (init?.method === 'PUT') {
        updateBodies.push(String(init.body));
        if (updateBodies.length === 1) throw cotConnectError('UND_ERR_CONNECT_TIMEOUT');
        return Response.json({ code: 0 });
      }
      return Response.json({ code: 0, data: { cot_id: 'cot_x', message_id: 'om_x' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const onDegraded = vi.fn();
    const client = new CotClient({ tenant: 'feishu', appId: 'private-app', appSecret: 'private-secret' });
    const publisher = degradedPublisher(client, onDegraded);
    await publisher.start();
    publisher.enqueue('TOOL_CALL_START', { toolCallId: 'tool-1' });

    await vi.advanceTimersByTimeAsync(600);
    expect(publisher.disabled).toBe(false);
    publisher.enqueue('TOOL_CALL_RESULT', { toolCallId: 'tool-1' });
    await vi.advanceTimersByTimeAsync(249);
    expect(updateBodies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(updateBodies).toHaveLength(2);
    expect(updateBodies[1]).toBe(updateBodies[0]);
    await vi.advanceTimersByTimeAsync(600);
    await publisher.finish('done');

    expect(updateBodies).toHaveLength(3);
    expect(JSON.parse(updateBodies[1]!).events.map((event: { event_type: string }) => event.event_type))
      .toEqual(['RUN_STARTED', 'STEP_STARTED', 'TOOL_CALL_START']);
    expect(JSON.parse(updateBodies[2]!).events.map((event: { event_type: string }) => event.event_type))
      .toEqual(['TOOL_CALL_RESULT']);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('receive_id_type'))).toHaveLength(1);
    expect(onDegraded).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('cot', 'request-retry', expect.objectContaining({
      operation: 'cot-update', causeCode: 'UND_ERR_CONNECT_TIMEOUT', retryDelayMs: 250,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-app|private-secret|private-token|private socket/);
  });

  it.each(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])(
    'retries a create only when %s proves the request was not delivered', async (code) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(cotAuthResponse())
        .mockRejectedValueOnce(cotConnectError(code))
        .mockResolvedValueOnce(Response.json({ code: 0, data: { cot_id: 'cot_x', message_id: 'om_x' } }));
      vi.stubGlobal('fetch', fetchMock);
      vi.spyOn(log, 'warn').mockImplementation(() => {});
      const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });

      const created = expect(client.create('oc_chat', 'om_origin'))
        .resolves.toEqual({ cot_id: 'cot_x', message_id: 'om_x' });
      await vi.advanceTimersByTimeAsync(249);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await created;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [, original] = fetchMock.mock.calls[1]!;
      const [, retried] = fetchMock.mock.calls[2]!;
      expect(retried?.body).toBe(original?.body);
      expect(retried?.signal).not.toBe(original?.signal);
      expect(retried?.redirect).toBe('error');
    },
  );

  it('retries tenant authentication before creating the bubble', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(cotConnectError('ENOTFOUND'))
      .mockResolvedValueOnce(cotAuthResponse())
      .mockResolvedValueOnce(Response.json({ code: 0, data: { cot_id: 'cot_x', message_id: 'om_x' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });

    const created = expect(client.create('oc_chat', 'om_origin')).resolves.toHaveProperty('cot_id', 'cot_x');
    await vi.advanceTimersByTimeAsync(250);
    await created;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/'))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('receive_id_type'))).toHaveLength(1);
  });

  it('degrades once when the single safe update retry is exhausted', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/auth/')) return cotAuthResponse();
      if (init?.method === 'PUT') throw cotConnectError('ECONNREFUSED');
      return Response.json({ code: 0, data: { cot_id: 'cot_x', message_id: 'om_x' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const onDegraded = vi.fn();
    const publisher = degradedPublisher(
      new CotClient({ tenant: 'feishu', appId: 'private-app', appSecret: 'private-secret' }),
      onDegraded,
    );
    await publisher.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(onDegraded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(publisher.disabled).toBe(true);
    expect(onDegraded).toHaveBeenCalledTimes(1);

    await consumeCotEvents(iterate([
      { type: 'text', delta: 'final answer still arrives' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });
    await vi.advanceTimersByTimeAsync(600);

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('receive_id_type'))).toHaveLength(1);
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('cot', 'request-failed', expect.objectContaining({
      operation: 'cot-update', causeCode: 'ECONNREFUSED',
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-app|private-secret|private-token|private socket/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry authentication after receiving a response with an unreadable body', async () => {
    vi.useFakeTimers();
    const error = cotConnectError('ENOTFOUND');
    const response = cotAuthResponse();
    vi.spyOn(response, 'json').mockRejectedValue(error);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });

    const rejected = expect(client.tenantToken()).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not replay when an aborted request uses a connection error as its abort reason', async () => {
    vi.useFakeTimers();
    const error = cotConnectError('ECONNREFUSED');
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(cotAuthResponse()).mockImplementation(async () => {
      controller.abort(error);
      throw error;
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });

    const rejected = expect(client.request('/open-apis/im/v1/message_cot', {
      method: 'PUT', body: '{}', signal: controller.signal,
    })).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe.each(['create', 'update'] as const)('%s with uncertain delivery', (operation) => {
    it.each([
      ['connection reset', () => Promise.reject(cotConnectError('ECONNRESET'))],
      ['socket failure', () => Promise.reject(cotConnectError('UND_ERR_SOCKET'))],
      ['headers timeout', () => Promise.reject(cotConnectError('UND_ERR_HEADERS_TIMEOUT'))],
      ['body timeout', () => Promise.reject(cotConnectError('UND_ERR_BODY_TIMEOUT'))],
      ['request timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
      ['request abort', () => Promise.reject(new DOMException('cancelled', 'AbortError'))],
      ['request abort with transport cause', () => Promise.reject(Object.assign(
        new DOMException('cancelled', 'AbortError'), { cause: { code: 'ECONNREFUSED' } },
      ))],
      ['request timeout with transport cause', () => Promise.reject(Object.assign(
        new DOMException('timed out', 'TimeoutError'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } },
      ))],
      ['HTTP error', () => Promise.resolve(Response.json({}, { status: 503 }))],
      ['API rejection', () => Promise.resolve(Response.json({ code: 10002, msg: 'rejected' }))],
      ['invalid response body', () => Promise.resolve(new Response('invalid json'))],
    ] as const)('does not replay after %s', async (_name, fail) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(cotAuthResponse()).mockImplementation(fail);
      vi.stubGlobal('fetch', fetchMock);
      vi.spyOn(log, 'warn').mockImplementation(() => {});
      const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });

      const request = operation === 'create'
        ? client.create('oc_chat', 'om_origin')
        : client.update({ cotId: 'cot_x', messageId: 'om_x' }, [
            { event_type: 'RUN_STARTED', content: '{}', timestamp: 123 },
          ]);
      const rejected = expect(request).rejects.toBeInstanceOf(Error);
      await vi.runAllTimersAsync();
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not replay response-body failures even with an allowed connection code', async () => {
      vi.useFakeTimers();
      const error = cotConnectError('UND_ERR_CONNECT_TIMEOUT');
      const response = Response.json({ code: 0 });
      vi.spyOn(response, 'text').mockRejectedValue(error);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(cotAuthResponse()).mockResolvedValue(response);
      vi.stubGlobal('fetch', fetchMock);
      vi.spyOn(log, 'warn').mockImplementation(() => {});
      const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });

      const request = operation === 'create'
        ? client.create('oc_chat', 'om_origin')
        : client.update({ cotId: 'cot_x', messageId: 'om_x' }, [
            { event_type: 'RUN_STARTED', content: '{}', timestamp: 123 },
          ]);
      const rejected = expect(request).rejects.toBe(error);
      await vi.runAllTimersAsync();
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe('COT event mapping', () => {
  it('publishes assistant progress text and brief tool summaries', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-1',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'draw a bear',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: '我会先生成图片。' },
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'echo bear' } },
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      { type: 'text', delta: '图片已经生成。' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    const eventTypes = client.events.map((event) => event.event_type);
    expect(eventTypes).toContain('TEXT_MESSAGE_START');
    expect(eventTypes).toContain('TEXT_MESSAGE_CONTENT');
    expect(eventTypes).toContain('TEXT_MESSAGE_END');
    expect(eventTypes).toContain('TOOL_CALL_START');
    expect(eventTypes).toContain('TOOL_CALL_RESULT');
    expect(eventTypes).not.toContain('TOOL_CALL_ARGS');

    const textDeltas = client.events
      .filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => JSON.parse(event.content).delta);
    expect(textDeltas).toEqual(['我会先生成图片。', '图片已经生成。']);

    const toolResult = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(toolResult?.content ?? '{}').content).toContain('command_execution');
    expect(client.completed).toEqual(['done']);
  });

  it('includes tool args and output only in detailed mode', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-2',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: 'workspace', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    expect(client.events.map((event) => event.event_type)).toContain('TOOL_CALL_ARGS');
    const result = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(result?.content ?? '{}').content).toBe('workspace');
  });

  it('derives final answer state from text blocks only', () => {
    const state: RunState = {
      blocks: [
        { kind: 'tool', tool: { id: 'tool', name: 'command_execution', input: {}, status: 'done' } },
        { kind: 'text', content: 'final', streaming: false },
      ],
      reasoning: { content: 'hidden', active: true },
      footer: 'streaming',
      terminal: 'done',
    };

    expect(finalAnswerOnlyState(state)).toMatchObject({
      blocks: [{ kind: 'text', content: 'final' }],
      reasoning: { content: '', active: false },
      footer: null,
    });
  });

  it('uses the legacy tool header format for brief COT titles', () => {
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('✅ command_execution');
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('echo hello');
  });

  it('creates the CoT bubble once, addressed to the origin message in a topic', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      // In a topic the trigger message is itself in-topic, so the bubble
      // inherits its thread. No thread_id is passed — message_cot rejects it.
      originMessageId: 'om_in_topic',
      runId: 'run-topic',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    // Exactly one create — never a second (that would render a duplicate).
    expect(client.createCalls).toEqual([
      { chatId: 'oc_chat', originMessageId: 'om_in_topic' },
    ]);
    expect(publisher.disabled).toBe(false);
  });

  it('disables the publisher when the create is rejected and never retries', async () => {
    const client = new FakeCotClient();
    client.failCreate = new Error('COT API failed: code=10002 msg=Bot/User can NOT be out of the chat.');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-rejected',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('disables the publisher when the create returns unusable ids and never retries', async () => {
    const client = new FakeCotClient();
    // code=0 response missing cot_id/message_id: the bubble may exist
    // server-side, so a second create would render a duplicate.
    client.createResult = { unexpected: 'shape' };
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-missing-ids',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('addresses CoT create to the chat with the origin message id', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    // Intercept the HTTP layer so we assert only how create() shapes the request.
    (client as unknown as { request: CotClient['request'] }).request = async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      return { cot_id: 'cot_x', message_id: 'om_x' };
    };

    await client.create('oc_chat', 'om_origin');
    expect(calls[0]?.path).toContain('receive_id_type=chat_id');
    // thread_id is never a valid receive type for message_cot.
    expect(calls[0]?.path).not.toContain('thread_id');
    expect(calls[0]?.body).toMatchObject({ receive_id: 'oc_chat', origin_message_id: 'om_origin' });
  });

  it('marks the publisher degraded when COT updates fail', async () => {
    const client = new FakeCotClient();
    client.failUpdate = new Error('field validation failed');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-degraded',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: 'working' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    expect(publisher.disabled).toBe(true);
    expect(publisher.degradedReason).toBe('field validation failed');
    expect(client.completed).toEqual(['error']);
  });
});

describe('COT mid-run degradation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('notifies and closes the stale bubble before the agent finishes, without replaying updates', async () => {
    vi.useFakeTimers();
    const client = new FakeCotClient();
    const update = vi.spyOn(client, 'update').mockRejectedValue(new Error('fetch failed'));
    const onDegraded = vi.fn();
    const publisher = degradedPublisher(client, onDegraded);
    await publisher.start();
    publisher.enqueue('TOOL_CALL_START', { toolCallId: 'running-tool' });

    await vi.advanceTimersByTimeAsync(600);

    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onDegraded).toHaveBeenCalledWith('fetch failed');
    expect(client.completed).toEqual(['error']);
    publisher.enqueue('TOOL_CALL_RESULT', { toolCallId: 'running-tool' });
    await publisher.finish('done');
    expect(update).toHaveBeenCalledTimes(1);
    expect(client.completed).toEqual(['error']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['throw', 'reject', 'hang'] as const)('does not block terminal consumption when the notification %s and completion hangs', async (failure) => {
    vi.useFakeTimers();
    const client = new FakeCotClient();
    vi.spyOn(client, 'update').mockRejectedValue(new Error('fetch failed'));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const complete = vi.spyOn(client, 'complete').mockReturnValue(pending);
    const onDegraded = vi.fn(() => {
      if (failure === 'throw') throw new Error('notice failed');
      return failure === 'hang' ? pending : Promise.reject(new Error('notice failed'));
    });
    const publisher = degradedPublisher(client, onDegraded);
    await publisher.start();
    await vi.advanceTimersByTimeAsync(600);

    await consumeCotEvents(iterate([
      { type: 'text', delta: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onDegraded).toHaveBeenCalledTimes(1);
    release();
  });

  it('retries a failed bubble close at terminal without sending another degradation notice', async () => {
    vi.useFakeTimers();
    const client = new FakeCotClient();
    vi.spyOn(client, 'update').mockRejectedValue(new Error('fetch failed'));
    const complete = vi.spyOn(client, 'complete')
      .mockRejectedValueOnce(new Error('network still down'))
      .mockResolvedValueOnce();
    const onDegraded = vi.fn();
    const publisher = degradedPublisher(client, onDegraded);
    await publisher.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(complete).toHaveBeenCalledTimes(1);

    await publisher.finish('done');
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenLastCalledWith(publisher.ref, 'error');
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });
});

describe('COT subscription cancellation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['done', 'error'] as const)('ends a pending subscription as %s and ignores late progress', async (reason) => {
    vi.useFakeTimers();
    const client = new FakeCotClient();
    const publisher = degradedPublisher(client, vi.fn());
    await publisher.start();
    let resolveNext!: (result: IteratorResult<AgentEvent>) => void;
    const next = vi.fn(() => new Promise<IteratorResult<AgentEvent>>((resolve) => { resolveNext = resolve; }));
    const close = vi.fn(() => new Promise<IteratorResult<AgentEvent>>(() => {}));
    const events: AsyncIterable<AgentEvent> = { [Symbol.asyncIterator]: () => ({ next, return: close }) };
    const controller = new AbortController();
    let consumed = false;
    const consuming = consumeCotEvents(events, publisher, { detail: 'brief', signal: controller.signal })
      .then(() => { consumed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(consumed).toBe(true);
    await consuming;
    expect(client.completed).toEqual([reason]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

    resolveNext({ done: false, value: { type: 'text', delta: 'late progress' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(next).toHaveBeenCalledTimes(1);
    expect(client.events.map((event) => event.event_type)).not.toContain('TEXT_MESSAGE_CONTENT');
    expect(client.completed).toEqual([reason]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes late next rejection and a failed close after cancellation', async () => {
    vi.useFakeTimers();
    const client = new FakeCotClient();
    const publisher = degradedPublisher(client, vi.fn());
    await publisher.start();
    let rejectNext!: (error: Error) => void;
    const next = vi.fn(() => new Promise<IteratorResult<AgentEvent>>((_resolve, reject) => { rejectNext = reject; }));
    const close = vi.fn().mockRejectedValue(new Error('close failed'));
    const controller = new AbortController();
    const consuming = consumeCotEvents({ [Symbol.asyncIterator]: () => ({ next, return: close }) }, publisher, {
      detail: 'brief', signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);

    controller.abort('error');
    await consuming;
    rejectNext(new Error('late subscription failure'));
    await vi.advanceTimersByTimeAsync(0);

    expect(next).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.completed).toEqual(['error']);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not start event consumption after cancellation', async () => {
    const client = new FakeCotClient();
    const publisher = degradedPublisher(client, vi.fn());
    await publisher.start();
    const next = vi.fn();
    const close = vi.fn();
    const controller = new AbortController();
    controller.abort('done');

    await consumeCotEvents({ [Symbol.asyncIterator]: () => ({ next, return: close }) }, publisher, {
      detail: 'brief', signal: controller.signal,
    });

    expect(next).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.completed).toEqual(['done']);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

function degradedPublisher(client: Pick<CotClient, 'create' | 'update' | 'complete'>, onDegraded: (reason: string) => void | Promise<void>): CotPublisher {
  return new CotPublisher({
    client,
    chatId: 'oc_chat',
    originMessageId: 'om_origin',
    runId: 'run-degraded',
    scope: 'oc_chat',
    inputPreview: 'run',
    onDegraded,
  });
}

function cotAuthResponse(): Response {
  return Response.json({ code: 0, tenant_access_token: 'private-token', expire: 7200 });
}

function cotConnectError(code: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('private socket details'), { code }),
  });
}

class FakeCotClient {
  events: Array<{ event_type: string; content: string; timestamp: number }> = [];
  completed: string[] = [];
  createCalls: Array<{ chatId: string; originMessageId?: string }> = [];
  failUpdate: Error | undefined;
  failCreate: Error | undefined;
  createResult: Record<string, unknown> | undefined;

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    this.createCalls.push({ chatId, originMessageId });
    if (this.failCreate) throw this.failCreate;
    return this.createResult ?? { cot_id: 'cot_fake', message_id: 'om_cot_fake' };
  }

  async update(_ref: unknown, events: readonly { event_type: string; content: string; timestamp: number }[]): Promise<void> {
    if (this.failUpdate) throw this.failUpdate;
    this.events.push(...events);
  }

  async complete(_ref: unknown, reason: string): Promise<void> {
    this.completed.push(reason);
  }
}

async function* iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}
