import type { AgentEvent } from '../agent/types';
import type { CotMessagesMode, TenantBrand } from '../config/schema';
import { log } from '../core/logger';
import { toolHeaderText } from '../card/tool-render';
import type { RunState } from '../card/run-state';

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

const COT_UPDATE_THROTTLE_MS = 600;
const COT_TOOL_OUTPUT_MAX = 1200;
const COT_TEXT_MAX = 1200;
// Bound each background HTTP attempt instead of retaining progress requests
// until undici's much longer default. Safe connect failures get one retry.
const COT_REQUEST_TIMEOUT_MS = 15_000;
const COT_CONNECT_RETRY_DELAY_MS = 250;
const COT_SAFE_CONNECT_ERRORS = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
]);

export class CotClient {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private token: string | undefined;
  private tokenExpiresAt = 0;

  constructor(opts: { tenant: TenantBrand; appId: string; appSecret: string }) {
    this.baseUrl = ENDPOINTS[opts.tenant];
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
  }

  async tenantToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.tokenExpiresAt - now > 60_000) return this.token;
    const data = await this.withRequestDiagnostics('tenant-auth', async () => {
      const resp = await this.fetchWithConnectRetry('tenant-auth', `${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      });
      if (!resp.ok) throw new Error(`tenant token HTTP ${resp.status}`);
      const body = await resp.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
      if (body.code !== 0 || !body.tenant_access_token) {
        throw new Error(`tenant token failed: code=${body.code ?? '?'} msg=${body.msg ?? '<no msg>'}`);
      }
      return { token: body.tenant_access_token, expire: body.expire };
    });
    this.token = data.token;
    const expireSeconds = typeof data.expire === 'number' ? data.expire : 7200;
    this.tokenExpiresAt = now + Math.max(60, expireSeconds - 60) * 1000;
    return this.token;
  }

  async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const token = await this.tenantToken();
    const operation = path.includes('/complete/') ? 'cot-complete'
      : init.method === 'PUT' ? 'cot-update' : 'cot-create';
    return this.withRequestDiagnostics(operation, async () => {
      const resp = await this.fetchWithConnectRetry(operation, `${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      });
      if (!resp.ok) throw new Error(`COT HTTP ${resp.status}`);
      const text = await resp.text();
      if (!text) return {};
      const data = JSON.parse(text) as { code?: number; msg?: string; data?: Record<string, unknown> } & Record<string, unknown>;
      if (data.code !== undefined && data.code !== 0) {
        throw new Error(`COT API failed: code=${data.code} msg=${data.msg ?? '<no msg>'}`);
      }
      return data.data ?? data;
    });
  }

  private async fetchWithConnectRetry(operation: string, url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const signal = init.signal ?? AbortSignal.timeout(COT_REQUEST_TIMEOUT_MS);
      try {
        return await fetch(url, {
          ...init,
          // A redirect can fail to connect after the original POST succeeded.
          // Refuse redirects so connect failures always precede delivery.
          redirect: 'error',
          signal,
        });
      } catch (err) {
        const causeCode = transportCauseCode(err);
        if (attempt !== 1 || signal.aborted || !(err instanceof TypeError)
          || !causeCode || !COT_SAFE_CONNECT_ERRORS.has(causeCode)) throw err;
        log.warn('cot', 'request-retry', {
          operation,
          causeCode,
          attempt,
          retryDelayMs: COT_CONNECT_RETRY_DELAY_MS,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, COT_CONNECT_RETRY_DELAY_MS));
      }
    }
  }

  private async withRequestDiagnostics<T>(operation: string, request: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await request();
    } catch (err) {
      // Do not log request/response bodies, headers or transport error objects:
      // they can contain credentials. Fetch's useful socket code is in cause.
      const error = err instanceof Error ? err : undefined;
      log.warn('cot', 'request-failed', {
        operation,
        durationMs: Date.now() - startedAt,
        timeoutMs: COT_REQUEST_TIMEOUT_MS,
        errorName: error?.name,
        causeCode: transportCauseCode(err),
      });
      throw err;
    }
  }

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    // message_cot only accepts receive_id_type=chat_id. thread_id is NOT a
    // valid receive type for this endpoint (it exists only on the forward
    // APIs) — addressing the create to an omt_* thread id is rejected with
    // code=10002 "Bot/User can NOT be out of the chat" (the backend tries to
    // resolve the omt_* id as a chat the bot belongs to and finds none).
    //
    // Placement inside a topic is instead governed by origin_message_id: the
    // bubble inherits the topic of the message it originates from. Passing an
    // in-topic message id keeps the bubble in the topic; the topic's root
    // (首楼) message has no thread of its own, so a bubble originated from it
    // lands at the group top level. Callers pick origin_message_id
    // accordingly.
    return this.request('/open-apis/im/v1/message_cot?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        ...(originMessageId ? { origin_message_id: originMessageId } : {}),
      }),
    });
  }

  async update(ref: CotRef, events: readonly CotEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.request('/open-apis/im/v1/message_cot', {
      method: 'PUT',
      body: JSON.stringify({
        cot_id: ref.cotId,
        message_id: ref.messageId,
        events,
      }),
    });
  }

  async complete(ref: CotRef, reason: string): Promise<void> {
    const cotId = encodeURIComponent(ref.cotId);
    const messageId = encodeURIComponent(ref.messageId);
    await this.request(`/open-apis/im/v1/message_cot/complete/${cotId}?message_id=${messageId}&reason=${reason}`, {
      method: 'POST',
      body: '',
    });
  }
}

function transportCauseCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

interface CotRef {
  cotId: string;
  messageId: string;
}

interface CotEvent {
  event_type: string;
  content: string;
  timestamp: number;
}

export class CotPublisher {
  private readonly client: Pick<CotClient, 'create' | 'update' | 'complete'>;
  readonly chatId: string;
  readonly originMessageId: string;
  readonly runId: string;
  readonly scope: string;
  readonly inputPreview: string;
  ref: CotRef | undefined;
  disabled = false;
  degradedReason: string | undefined;
  private buffer: CotEvent[] = [];
  private flushing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private completing: Promise<void> | undefined;
  private completed = false;
  private readonly onDegraded?: (reason: string) => void | Promise<void>;

  constructor(opts: {
    client: Pick<CotClient, 'create' | 'update' | 'complete'>;
    chatId: string;
    originMessageId: string;
    runId: string;
    scope: string;
    inputPreview: string;
    onDegraded?: (reason: string) => void | Promise<void>;
  }) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.originMessageId = opts.originMessageId;
    this.runId = opts.runId;
    this.scope = opts.scope;
    this.inputPreview = opts.inputPreview;
    this.onDegraded = opts.onDegraded;
  }

  async start(): Promise<void> {
    // Single chat_id-addressed create. In topics the bubble follows
    // originMessageId's thread (see CotClient.create); the caller passes an
    // in-topic origin so it lands in the topic. On any failure we disable CoT
    // and let the caller fall back to a plain reply. Only CotClient's proven
    // pre-delivery connect failures may retry; replaying an ambiguous create
    // could leave a duplicate bubble spinning forever.
    let created: Record<string, unknown>;
    try {
      created = await this.client.create(this.chatId, this.originMessageId);
    } catch (err) {
      this.disabled = true;
      log.warn('cot', 'create-failed', { err: err instanceof Error ? err.message : String(err) });
      return;
    }
    const cotId = stringValue(created.cot_id ?? created.cotId);
    const messageId = stringValue(created.message_id ?? created.messageId);
    if (!cotId || !messageId) {
      this.disabled = true;
      log.warn('cot', 'create-failed', {
        err: `CreateCOT missing ids: ${JSON.stringify(created).slice(0, 200)}`,
      });
      return;
    }
    this.ref = { cotId, messageId };
    log.info('cot', 'created', { cotId, messageId });
    this.enqueue('RUN_STARTED', {
      threadId: this.scope,
      runId: this.runId,
      input: { query: this.inputPreview },
    });
    this.enqueue('STEP_STARTED', {
      stepId: `step-understand-${this.runId}`,
      stepName: '理解用户问题',
    });
  }

  enqueue(eventType: string, content: unknown): void {
    if (this.disabled || !this.ref) return;
    this.buffer.push({
      event_type: eventType,
      content: JSON.stringify(content),
      timestamp: Date.now(),
    });
    this.scheduleFlush();
  }

  async finish(reason: string): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    if (this.disabled) {
      // Retry a failed best-effort close at terminal, but never hold the final
      // reply behind a broken progress endpoint. In-flight/successful closes
      // are shared, so we cannot close the bubble twice concurrently.
      void this.complete('error');
      return;
    }
    await this.complete(reason);
  }

  private complete(reason: string): Promise<void> {
    if (this.completing) return this.completing;
    const ref = this.ref;
    if (this.completed || !ref) return Promise.resolve();
    this.completing = Promise.resolve()
      .then(() => this.client.complete(ref, reason))
      .then(() => {
        this.completed = true;
        log.info('cot', 'completed', { cotId: ref.cotId, reason });
      })
      .catch((err) => {
        log.warn('cot', 'complete-failed', { err: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { this.completing = undefined; });
    return this.completing;
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, COT_UPDATE_THROTTLE_MS);
  }

  private async flush(): Promise<void> {
    if (this.disabled || !this.ref) return;
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.length > 0 && !this.disabled) await this.flush();
      return;
    }
    const events = this.buffer.splice(0);
    if (events.length === 0) return;
    this.flushing = this.client.update(this.ref, events)
      .catch((err) => {
        this.disabled = true;
        const reason = err instanceof Error ? err.message : String(err);
        this.degradedReason = reason;
        this.buffer = [];
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
        log.warn('cot', 'update-failed', { err: this.degradedReason });
        // Update delivery is ambiguous, so do not replay events. Close only
        // the progress bubble and notify immediately; the agent keeps running
        // independently of both outbound requests.
        void this.complete('error');
        void Promise.resolve().then(() => this.onDegraded?.(reason)).catch((noticeErr) => {
          log.warn('cot', 'degraded-callback-failed', {
            err: noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
          });
        });
      })
      .finally(() => {
        this.flushing = undefined;
        if (this.buffer.length > 0 && !this.disabled) this.scheduleFlush();
      });
    await this.flushing;
  }
}

export function finalAnswerOnlyState(state: RunState): RunState {
  return {
    ...state,
    blocks: state.blocks.filter((b) => b.kind === 'text'),
    reasoning: { content: '', active: false },
    footer: null,
  };
}

export async function consumeCotEvents(
  events: AsyncIterable<AgentEvent>,
  publisher: CotPublisher,
  opts: { detail: CotMessagesMode; signal?: AbortSignal },
): Promise<void> {
  let reasoningOpen = false;
  let textStepOpen = false;
  let textMessageOpen = false;
  let textMessageIndex = 0;
  let textMessageId: string | undefined;
  const toolBrief = new Map<string, { name: string; input: unknown }>();
  const reasoningMessageId = `reasoning-${publisher.runId}`;
  const finalStepId = `step-process-${publisher.runId}`;

  try {
    for await (const evt of interruptibleCotEvents(events, opts.signal)) {
      if (evt.type === 'system' || evt.type === 'usage') continue;
      if (evt.type === 'thinking') {
        closeTextIfNeeded();
        if (!reasoningOpen) {
          reasoningOpen = true;
          publisher.enqueue('REASONING_START', { messageId: reasoningMessageId });
          publisher.enqueue('REASONING_MESSAGE_START', {
            messageId: reasoningMessageId,
            role: 'reasoning',
          });
        }
        publisher.enqueue('REASONING_MESSAGE_CONTENT', {
          messageId: reasoningMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX),
        });
        continue;
      }
      if (evt.type === 'tool_use') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        const toolCallId = evt.id;
        const detailed = opts.detail === 'detailed';
        const showSummary = opts.detail === 'brief' || detailed;
        const title = showSummary ? cotBriefToolTitle(evt.name, evt.input, 'running') : '正在调用工具';
        toolBrief.set(toolCallId, { name: evt.name, input: evt.input });
        publisher.enqueue('TOOL_CALL_START', {
          toolCallId,
          icon: showSummary ? cotToolIcon(evt.name) : 'default',
          title,
          toolCallName: showSummary ? evt.name : 'tool',
        });
        if (detailed && evt.input !== undefined) {
          publisher.enqueue('TOOL_CALL_ARGS', {
            toolCallId,
            delta: JSON.stringify(evt.input),
          });
        }
        publisher.enqueue('TOOL_CALL_END', { toolCallId });
        continue;
      }
      if (evt.type === 'tool_result') {
        const detailed = opts.detail === 'detailed';
        const brief = toolBrief.get(evt.id);
        publisher.enqueue('TOOL_CALL_RESULT', {
          messageId: `tool-result-${evt.id}`,
          toolCallId: evt.id,
          role: 'tool',
          content: detailed
            ? truncateCot(evt.output ?? '', COT_TOOL_OUTPUT_MAX)
            : brief
              ? cotBriefToolTitle(brief.name, brief.input, evt.isError ? 'error' : 'done')
              : '工具调用已完成',
        });
        toolBrief.delete(evt.id);
        continue;
      }
      if (evt.type === 'text') {
        closeReasoningIfNeeded();
        if (!textStepOpen) {
          textStepOpen = true;
          publisher.enqueue('STEP_STARTED', {
            stepId: finalStepId,
            stepName: '输出过程',
          });
        }
        if (!textMessageOpen) {
          textMessageOpen = true;
          textMessageId = `text-${publisher.runId}-${++textMessageIndex}`;
          publisher.enqueue('TEXT_MESSAGE_START', { messageId: textMessageId, role: 'assistant' });
        }
        publisher.enqueue('TEXT_MESSAGE_CONTENT', {
          messageId: textMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX),
        });
        continue;
      }
      if (evt.type === 'done' || evt.type === 'error') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        if (textStepOpen) {
          publisher.enqueue('STEP_FINISHED', {
            stepId: finalStepId,
            stepName: '输出过程',
          });
        }
        if (evt.type === 'error') {
          publisher.enqueue('RUN_ERROR', { message: evt.message, code: evt.terminationReason ?? 'error' });
          await publisher.finish('error');
        } else {
          const status = evt.terminationReason === 'normal' ? 'done' : evt.terminationReason ?? 'done';
          publisher.enqueue('RUN_FINISHED', {
            threadId: publisher.scope,
            runId: publisher.runId,
            status,
          });
          await publisher.finish(status === 'done' ? 'done' : 'error');
        }
        return;
      }
    }
    closeReasoningIfNeeded();
    closeTextIfNeeded();
    await publisher.finish(opts.signal?.aborted && opts.signal.reason === 'error' ? 'error' : 'done');
  } catch (err) {
    log.warn('cot', 'consume-failed', { err: err instanceof Error ? err.message : String(err) });
    await publisher.finish('error');
  }

  function closeReasoningIfNeeded(): void {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    publisher.enqueue('REASONING_MESSAGE_END', { messageId: reasoningMessageId });
    publisher.enqueue('REASONING_END', { messageId: reasoningMessageId });
  }

  function closeTextIfNeeded(): void {
    if (!textMessageOpen || !textMessageId) return;
    publisher.enqueue('TEXT_MESSAGE_END', { messageId: textMessageId });
    textMessageOpen = false;
    textMessageId = undefined;
  }
}

async function* interruptibleCotEvents(
  events: AsyncIterable<AgentEvent>,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  if (!signal) {
    yield* events;
    return;
  }
  const iterator = events[Symbol.asyncIterator]();
  let sourceDone = false;
  try {
    while (!signal.aborted) {
      let onAbort!: () => void;
      const aborted = new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        // Promise.race observes a late next() rejection even after abort wins.
        const result = await Promise.race([Promise.resolve().then(() => iterator.next()), aborted]);
        if (!result || signal.aborted) return;
        if (result.done) {
          sourceDone = true;
          return;
        }
        yield result.value;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
  } finally {
    if (!sourceDone) {
      // Release this subscription only. Its pending next/return must not hold
      // final delivery or stop the independently owned agent event source.
      void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
    }
  }
}

export function cotBriefToolTitle(
  name: string,
  input: unknown,
  status: 'running' | 'done' | 'error' = 'running',
): string {
  return toolHeaderText({ id: 'cot-tool', name, input, status }).replace(/\*\*/g, '');
}

function cotToolIcon(name: string): string {
  const lower = String(name ?? '').toLowerCase();
  if (lower.includes('search') || lower.includes('grep') || lower.includes('rg')) return 'search';
  if (lower.includes('read')) return 'read';
  if (lower.includes('write') || lower.includes('edit')) return 'write';
  if (lower.includes('doc')) return 'doc';
  if (lower.includes('calendar')) return 'calendar';
  if (lower.includes('task')) return 'task';
  if (lower.includes('command') || lower.includes('bash')) return 'bash';
  return 'default';
}

function truncateCot(value: unknown, max: number): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
