import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { claudeCapability, codexCapability } from '../agent/capability';
import { modelLabel, normalizeModelSelection, resolveModelArg } from '../agent/models';
import {
  buildAgentPrompt,
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
} from '../agent/prompt';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { handleCardAction } from '../card/dispatcher';
import { CallbackAuth } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { tryHandleCommand, type Controls } from '../commands';
import type { AppConfig } from '../config/schema';
import {
  getAgentStopGraceMs,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getShowToolCalls,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, reportMetric, withTrace } from '../core/logger';
import { MediaCache, type LocalAttachment } from '../media/cache';
import {
  toPolicyAttachment,
  toPromptAttachment,
} from '../media/attachment';
import { canRunBotAdminCommand, canUseDm, canUseGroup } from '../policy/access';
import type { ScopeContext } from '../policy/run-policy';
import { createOwnerRefreshController } from '../policy/owner';
import { RunExecutor } from '../runtime/run-executor';
import {
  consumeDeferredServiceRestart,
  launchDeferredServiceRestart,
  requestDeferredServiceRestart,
} from '../runtime/deferred-service-restart';
import {
  createRouteLease,
  deleteRouteLease,
  cleanupExpiredLeases,
  routeLeaseDir,
} from '../runtime/route-lease';
import {
  createPending,
  readPending,
  deletePending,
  createClaim,
  readClaim,
  createAttempt,
  readAttempt,
  deleteAttempt,
  createTerminal,
  readTerminal,
  cleanupReceiptArtifacts,
  cleanupOrphanTemps,
  scanReceipts,
  quarantineStalePending,
  makeReceiptId,
  makeClaimUuid,
  receiptDir,
  type PendingRequest,
  type ClaimDescriptor,
  type ReceiptKind,
} from '../runtime/restart-receipt';
import { sendRestartReceiptViaChannel } from '../runtime/restart-receipt-sender';
import { isAlive } from '../runtime/registry';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type {
  PromptSessionDecision,
  PromptSessionService,
} from '../session/prompt-session-service';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns, type RunHandle } from './active-runs';
import { resolveRunIdleTimeoutMs, resolveRunStartupTimeoutMs } from './run-idle-timeout';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { decideGroupResponse } from './group-response-policy';
import {
  recordRunSessionEvent,
  recordRunSessionEventAwaited,
  startRunFlow,
} from './run-flow';
import { commandSessionCatalogIdentity } from './session-catalog-identity';
import { startKeepalive } from './keepalive';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, fetchTopicContext, type QuotedContext } from './quote';
import { lookupMessageThreadId } from './thread-id';
import { addWorkingReaction, removeReaction } from './reaction';
import { handleReactionEvent } from './reaction/pipeline';
import { isStopEmoji, lookupReactionSemantics } from './reaction/semantics';
import { WorkChainStore } from './reaction/work-chain';
import { ReactionContextStore } from './reaction/context-store';
import { ReactionBuffer } from './reaction/buffer';
import { reconcile } from './reaction/reconciler';
import { loadReactionLedger } from './reaction/ledger';
import type { ReactionLedger } from './reaction/ledger';
import { loadStopControlLedger, stopEventFingerprint } from './reaction/control-ledger';
import type { StopControlLedger } from './reaction/control-ledger';
import { ReactionRunTracker } from './reaction/run-tracker';
import { fetchKnownChats } from './lark-info';
import type { AppPaths } from '../config/app-paths';
import {
  consumeCotEvents,
  CotClient,
  CotPublisher,
  finalAnswerOnlyState,
} from './cot';

// ── Reaction context store (module-level, set by startChannel) ──
let _reactionContextStore: ReactionContextStore | null = null;
function getReactionContexts(messageIds: string[]): unknown[] {
  return _reactionContextStore ? _reactionContextStore.consume(messageIds) : [];
}

const DEBOUNCE_MS = 600;
const STREAM_TERMINAL_GRACE_MS = 3000;
const FINAL_READBACK_RETRY_MS = 250;
const FINAL_READBACK_TIMEOUT_MS = 2000;
const TAIL_COMPARE_CHARS = 500;
// Mirrors @larksuite/channel's DEFAULT_MAX_ELEMENT_CHARS for markdown streaming
// cards. When final markdown exceeds this, the SDK rolls over internally but
// currently returns only the head messageId from MarkdownStreamController.run().
const MARKDOWN_STREAM_MAX_ELEMENT_CHARS = 30_000;
const REACTION_CLEANUP_GRACE_MS = 1000;
const STREAM_HASH_HEX_CHARS = 12;

const BRIDGE_AGENT_INSTRUCTIONS = [
  '你在 bridge 进程中运行，普通 lark-cli 会继承 LARK_CHANNEL=1 并进入 bridge-bound 模式。',
  '不要 unset LARK_CHANNEL / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR，也不要用 env -u LARK_CHANNEL 绕回本机普通配置。',
  'Codex bridge 默认使用 danger-full-access 对齐 Claude bridge 的 bypassPermissions 行为，因此 lark-cli 应能像用户本机终端一样访问 keychain。',
  '如果提示 lark-channel context detected but not bound，停止当前操作并请用户重启 bridge 或运行 bridge doctor/preflight；不要改用普通 profile，不要自行 bind，也不要直接读取 config.json 里的账号或密钥。',
];

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

type RawClientCall = (request: unknown) => Promise<unknown>;
type RawMethodOwner = Record<string, RawClientCall | undefined>;

interface RawClientShape {
  cardkit?: {
    v1?: {
      card?: RawMethodOwner;
      cardElement?: RawMethodOwner;
    };
  };
  im?: {
    v1?: {
      message?: RawMethodOwner;
    };
  };
}

const STREAM_DIAG_WRAPPED = Symbol('streamDiagWrapped');
const STREAM_RECOVERY_WRAPPED = Symbol('streamRecoveryWrapped');
const CARDKIT_STREAM_TRACKER = Symbol('cardkitStreamTracker');
const CARDKIT_STREAM_EXPIRED_CODES = new Set([200850, 300309]);
const CARDKIT_STREAM_TRACKER_LIMIT = 256;

interface CardkitStreamTracker {
  cardByMessageId: Map<string, string>;
  sequenceByCardId: Map<string, number>;
}

interface StreamRecoveryState {
  expiredCardIds: Set<string>;
  failures: Map<string, Error>;
}

const streamRecoveryState = new AsyncLocalStorage<StreamRecoveryState>();

export function installCardkitStreamDiagnostics(channel: LarkChannel): void {
  const tracker = getOrCreateCardkitStreamTracker(channel);
  wrapMarkdownStreamWithRecoveryFailures(channel);
  const raw = channel.rawClient as RawClientShape;
  wrapRawClientCall(
    raw.cardkit?.v1?.card,
    'create',
    'cardkit-card-create',
    summarizeCardCreateRequest,
  );
  wrapCardElementContentWithExpiryRecovery(raw, tracker);
  wrapRawClientCall(
    raw.cardkit?.v1?.card,
    'settings',
    'cardkit-card-settings',
    summarizeCardSettingsRequest,
    (request) => trackCardSequence(tracker, request),
  );
  wrapRawClientCall(
    raw.im?.v1?.message,
    'create',
    'im-message-create',
    summarizeImCreateRequest,
    (request, result) => trackCardMessage(tracker, request, result),
  );
  wrapRawClientCall(
    raw.im?.v1?.message,
    'reply',
    'im-message-reply',
    summarizeImReplyRequest,
    (request, result) => trackCardMessage(tracker, request, result),
  );
}

function getOrCreateCardkitStreamTracker(channel: LarkChannel): CardkitStreamTracker {
  const trackedChannel = channel as LarkChannel & { [CARDKIT_STREAM_TRACKER]?: CardkitStreamTracker };
  const existing = trackedChannel[CARDKIT_STREAM_TRACKER];
  if (existing) return existing;
  const tracker: CardkitStreamTracker = {
    cardByMessageId: new Map(),
    sequenceByCardId: new Map(),
  };
  trackedChannel[CARDKIT_STREAM_TRACKER] = tracker;
  return tracker;
}

function wrapMarkdownStreamWithRecoveryFailures(channel: LarkChannel): void {
  const original = channel.stream as LarkChannel['stream'] & {
    [STREAM_RECOVERY_WRAPPED]?: boolean;
  } | undefined;
  if (!original || original[STREAM_RECOVERY_WRAPPED]) return;

  const wrapped = async function wrappedMarkdownStream(
    this: LarkChannel,
    ...args: Parameters<LarkChannel['stream']>
  ): ReturnType<LarkChannel['stream']> {
    const state: StreamRecoveryState = {
      expiredCardIds: new Set<string>(),
      failures: new Map<string, Error>(),
    };
    return streamRecoveryState.run(state, async () => {
      const result = await original.apply(this, args);
      const failure = state.failures.values().next().value;
      if (failure) throw failure;
      return result;
    });
  } as LarkChannel['stream'] & { [STREAM_RECOVERY_WRAPPED]?: boolean };
  wrapped[STREAM_RECOVERY_WRAPPED] = true;
  channel.stream = wrapped;
}

function wrapCardElementContentWithExpiryRecovery(
  raw: RawClientShape,
  tracker: CardkitStreamTracker,
): void {
  const owner = raw.cardkit?.v1?.cardElement;
  const cardOwner = raw.cardkit?.v1?.card;
  const original = owner?.content as
    | (RawClientCall & { [STREAM_DIAG_WRAPPED]?: boolean })
    | undefined;
  const updateCard = cardOwner?.update;
  if (!owner || !original || original[STREAM_DIAG_WRAPPED]) return;

  const wrapped = async function wrappedCardElementContent(
    this: unknown,
    request: unknown,
  ): Promise<unknown> {
    const fields = summarizeCardElementContentRequest(request);
    const path = recordAt(request, 'path');
    const cardId = stringAt(path, 'card_id');
    trackCardSequence(tracker, request);
    const start = Date.now();
    log.info('stream-diag', 'cardkit-card-element-content-request', fields);
    try {
      if (cardId && updateCard && isExpiredCardInCurrentStream(cardId)) {
        log.info('stream-diag', 'cardkit-card-element-content-bypassed', fields);
        return await recoverExpiredStreamingCard(cardOwner, updateCard, request, fields, undefined);
      }
      const result = await original.call(this, request);
      const resultFields = summarizeApiResult(result);
      const resultCode = numberAt(resultFields, 'code');
      log.info('stream-diag', 'cardkit-card-element-content-result', {
        ...fields,
        durationMs: Date.now() - start,
        ...resultFields,
      });
      if (!CARDKIT_STREAM_EXPIRED_CODES.has(resultCode ?? -1) || !updateCard) return result;
      if (cardId) markExpiredCardInCurrentStream(cardId);

      return await recoverExpiredStreamingCard(cardOwner, updateCard, request, fields, result);
    } catch (err) {
      log.fail('stream-diag', err, {
        step: 'cardkit-card-element-content',
        durationMs: Date.now() - start,
        ...fields,
      });
      throw err;
    }
  } as RawClientCall & { [STREAM_DIAG_WRAPPED]?: boolean };
  wrapped[STREAM_DIAG_WRAPPED] = true;
  owner.content = wrapped;
}

async function recoverExpiredStreamingCard(
  cardOwner: RawMethodOwner,
  updateCard: RawClientCall,
  elementRequest: unknown,
  fields: Record<string, unknown>,
  expiredResult: unknown,
): Promise<unknown> {
  const path = recordAt(elementRequest, 'path');
  const data = recordAt(elementRequest, 'data');
  const cardId = stringAt(path, 'card_id');
  const elementId = stringAt(path, 'element_id');
  const content = stringAt(data, 'content');
  const sequence = numberAt(data, 'sequence');
  if (!cardId || !elementId || content === undefined || sequence === undefined) {
    log.warn('stream-diag', 'cardkit-stream-expired-recovery-skipped', {
      reason: 'invalid-element-request',
      ...fields,
    });
    recordStreamRecoveryFailure(
      cardId ?? 'unknown-card',
      new Error('CardKit stream recovery failed: invalid element update request'),
    );
    return expiredResult;
  }

  const request = {
    path: { card_id: cardId },
    data: {
      card: {
        type: 'card_json',
        data: JSON.stringify(buildClosedMarkdownCard(elementId, content)),
      },
      sequence,
      uuid: `u_${cardId}_${sequence}`,
    },
  };
  const start = Date.now();
  log.warn('stream-diag', 'cardkit-stream-expired-recovery-request', fields);
  try {
    const result = await updateCard.call(cardOwner, request);
    const resultFields = summarizeApiResult(result);
    const resultCode = numberAt(resultFields, 'code');
    log.info('stream-diag', 'cardkit-stream-expired-recovery-result', {
      ...fields,
      durationMs: Date.now() - start,
      ...resultFields,
    });
    if (resultCode === 0) {
      clearStreamRecoveryFailure(cardId);
      return result;
    }
    recordStreamRecoveryFailure(
      cardId,
      new Error(
        `CardKit stream recovery failed card=${cardId} sequence=${sequence} code=${resultCode ?? 'missing'} msg=${resultFields.msg ?? 'unknown'}`,
      ),
    );
    return expiredResult;
  } catch (err) {
    log.fail('stream-diag', err, {
      step: 'cardkit-stream-expired-recovery',
      durationMs: Date.now() - start,
      ...fields,
    });
    recordStreamRecoveryFailure(
      cardId,
      new Error(
        `CardKit stream recovery failed card=${cardId} sequence=${sequence}: ${errorMessage(err)}`,
        { cause: err },
      ),
    );
    return expiredResult;
  }
}

function recordStreamRecoveryFailure(cardId: string, error: Error): void {
  streamRecoveryState.getStore()?.failures.set(cardId, error);
}

function clearStreamRecoveryFailure(cardId: string): void {
  streamRecoveryState.getStore()?.failures.delete(cardId);
}

function markExpiredCardInCurrentStream(cardId: string): void {
  streamRecoveryState.getStore()?.expiredCardIds.add(cardId);
}

function isExpiredCardInCurrentStream(cardId: string): boolean {
  return streamRecoveryState.getStore()?.expiredCardIds.has(cardId) ?? false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildClosedMarkdownCard(elementId: string, content: string): Record<string, unknown> {
  const summary = content.replace(/\s+/g, ' ').trim();
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: summary.length <= 50 ? summary : `${summary.slice(0, 49)}…` },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: elementId,
          content,
        },
      ],
    },
  };
}

function wrapRawClientCall(
  owner: RawMethodOwner | undefined,
  method: string,
  event: string,
  summarize: (request: unknown) => Record<string, unknown>,
  observe?: (request: unknown, result: unknown) => void,
): void {
  const original = owner?.[method] as (RawClientCall & { [STREAM_DIAG_WRAPPED]?: boolean }) | undefined;
  if (!owner || !original || original[STREAM_DIAG_WRAPPED]) return;

  const wrapped = async function wrappedRawClientCall(this: unknown, request: unknown): Promise<unknown> {
    const fields = summarize(request);
    const start = Date.now();
    log.info('stream-diag', `${event}-request`, fields);
    try {
      const result = await original.call(this, request);
      observe?.(request, result);
      log.info('stream-diag', `${event}-result`, {
        ...fields,
        durationMs: Date.now() - start,
        ...summarizeApiResult(result),
      });
      return result;
    } catch (err) {
      log.fail('stream-diag', err, {
        step: event,
        durationMs: Date.now() - start,
        ...fields,
      });
      throw err;
    }
  } as RawClientCall & { [STREAM_DIAG_WRAPPED]?: boolean };
  wrapped[STREAM_DIAG_WRAPPED] = true;
  owner[method] = wrapped;
}

function trackCardSequence(tracker: CardkitStreamTracker, request: unknown): void {
  const path = recordAt(request, 'path');
  const data = recordAt(request, 'data');
  const cardId = stringAt(path, 'card_id');
  const sequence = numberAt(data, 'sequence');
  if (!cardId || sequence === undefined) return;
  const current = tracker.sequenceByCardId.get(cardId) ?? 0;
  if (sequence > current) rememberBounded(tracker.sequenceByCardId, cardId, sequence);
}

function trackCardMessage(
  tracker: CardkitStreamTracker,
  request: unknown,
  result: unknown,
): void {
  const data = recordAt(request, 'data');
  const content = stringAt(data, 'content');
  const messageId = stringAt(recordAt(result, 'data'), 'message_id');
  const cardId = cardIdFromReferenceContent(content);
  if (!messageId || !cardId) return;
  rememberBounded(tracker.cardByMessageId, messageId, cardId);
}

function cardIdFromReferenceContent(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const parsed = parseJson(content);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const root = parsed as Record<string, unknown>;
  return stringAt(root, 'card_id') ?? stringAt(recordAt(root, 'data'), 'card_id');
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CARDKIT_STREAM_TRACKER_LIMIT) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function summarizeCardCreateRequest(request: unknown): Record<string, unknown> {
  const data = recordAt(request, 'data');
  const rawCard = stringAt(data, 'data');
  return {
    cardType: stringAt(data, 'type'),
    ...textLogFields('cardJson', rawCard),
  };
}

function summarizeCardElementContentRequest(request: unknown): Record<string, unknown> {
  const path = recordAt(request, 'path');
  const data = recordAt(request, 'data');
  const content = stringAt(data, 'content');
  return {
    cardId: stringAt(path, 'card_id'),
    elementId: stringAt(path, 'element_id'),
    sequence: numberAt(data, 'sequence'),
    uuid: stringAt(data, 'uuid'),
    ...textLogFields('content', content),
  };
}

function summarizeCardSettingsRequest(request: unknown): Record<string, unknown> {
  const path = recordAt(request, 'path');
  const data = recordAt(request, 'data');
  const settings = stringAt(data, 'settings');
  return {
    cardId: stringAt(path, 'card_id'),
    sequence: numberAt(data, 'sequence'),
    uuid: stringAt(data, 'uuid'),
    streamingMode: parseStreamingMode(settings),
    ...textLogFields('settings', settings),
  };
}

function summarizeImCreateRequest(request: unknown): Record<string, unknown> {
  const params = recordAt(request, 'params');
  const data = recordAt(request, 'data');
  const content = stringAt(data, 'content');
  return {
    receiveIdType: stringAt(params, 'receive_id_type'),
    receiveId: stringAt(data, 'receive_id'),
    msgType: stringAt(data, 'msg_type'),
    ...textLogFields('content', content),
  };
}

function summarizeImReplyRequest(request: unknown): Record<string, unknown> {
  const path = recordAt(request, 'path');
  const data = recordAt(request, 'data');
  const content = stringAt(data, 'content');
  return {
    replyToMessageId: stringAt(path, 'message_id'),
    msgType: stringAt(data, 'msg_type'),
    ...textLogFields('content', content),
  };
}

function summarizeApiResult(result: unknown): Record<string, unknown> {
  const data = recordAt(result, 'data');
  return {
    code: numberAt(result, 'code') ?? numberAt(data, 'code'),
    msg: stringAt(result, 'msg') ?? stringAt(result, 'message') ?? stringAt(data, 'msg'),
    cardId: stringAt(data, 'card_id'),
    messageId: stringAt(data, 'message_id'),
    requestId: stringAt(result, 'request_id') ?? stringAt(data, 'request_id'),
  };
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === 'object' ? (child as Record<string, unknown>) : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function numberAt(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' ? field : undefined;
}

function parseStreamingMode(settings: string | undefined): boolean | undefined {
  if (!settings) return undefined;
  const parsed = parseJson(settings);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const config = (parsed as { config?: { streaming_mode?: unknown } }).config;
  return typeof config?.streaming_mode === 'boolean' ? config.streaming_mode : undefined;
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  promptSessionService?: PromptSessionService;
  workspaces: WorkspaceStore;
  controls: Controls;
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir'> &
    Partial<Pick<AppPaths, 'profileDir'>>;
  launchDeferredRestart?: (profile: string) => void;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, sessionCatalog, workspaces, controls } = deps;
  const activeRuns = new ActiveRuns();
  // WorkChainStore: maps message→workChainId for stop reaction validation (DD15).
  // In-memory store — restart fail-closed (all historical associations lost).
  const workChainStore = new WorkChainStore();
  // ReactionContextStore: keyed store carrying reconciled reaction contexts
  // from pipeline to buildPrompt (F1).
  const reactionContextStore = new ReactionContextStore();
  _reactionContextStore = reactionContextStore;
  // ReactionRunTracker: tracks active reaction runs by reaction key (F23).
  const reactionRunTracker = new ReactionRunTracker();
  // Ledgers: lazily loaded when profileDir is available (F3/F12).
  let reactionLedger: ReactionLedger | null = null;
  let stopControlLedger: StopControlLedger | null = null;
  // ReactionBuffer: buffers non-stop events before reconciliation (F4/F5).
  const reactionBuffer = new ReactionBuffer(async (key, events) => {
    if (!reactionLedger) return;
    const result = await reconcile(key, events, {
      channel,
      ledger: reactionLedger,
      botOpenId: channel.botIdentity?.openId,
      appId: cfg.accounts.app.id,
    });

    if (result.reconciliationFailed) {
      // Reply to retry
      try {
        await channel.send(result.components.scope.split(':')[0] ?? result.components.scope,
          { markdown: '本次 Reaction 暂时无法确认，请重试。' },
          { replyTo: result.components.targetMessageId });
      } catch { /* best-effort */ }
      return;
    }
    if (result.noOp) return; // No state change, no reply

    // Build ReactionContext from reconciliation result
    const sem = lookupReactionSemantics(events[0]?.emojiType ?? '');
    const reactionContext = {
      operatorOpenId: result.components.operatorOpenId,
      reactionRevision: result.revision,
      triggerReactions: result.triggerReactions,
      effectiveReactionSet: result.effectiveReactionSet,
      targetMessage: {
        available: true as const,
        messageId: result.components.targetMessageId,
      },
    };

    // Store in contextStore and enqueue via pushBarrier
    reactionContextStore.set(result.components.targetMessageId, [reactionContext]);
    const normalizedMsg = {
      messageId: result.components.targetMessageId,
      chatId: result.components.scope.split(':')[0] ?? result.components.scope,
      chatType: 'group' as const,
      senderId: result.components.operatorOpenId,
      content: `[reaction] ${events.map(e => e.emojiType).join(', ')}`,
      rawContentType: 'reaction' as never,
      resources: [] as never[],
      mentions: [] as never[],
      mentionAll: false,
      mentionedBot: false,
      createTime: Date.now(),
    } satisfies import('@larksuite/channel').NormalizedMessage;
    pending.pushBarrier(result.components.scope, normalizedMsg);
    log.info('reaction', 'reconciled-and-enqueued', {
      key: result.key,
      revision: result.revision,
      netZero: result.netZeroConsumed,
    });
  });
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const executor = new RunExecutor({ agent, pool, activeRuns });
  let activeBatchCount = 0;
  let deferredRestartLaunching = false;

  const maybeLaunchDeferredRestart = async (): Promise<void> => {
    const profileDir = deps.appPaths?.profileDir;
    if (!profileDir || activeBatchCount !== 0 || deferredRestartLaunching) return;
    const requested = await consumeDeferredServiceRestart(profileDir, process.pid);
    if (!requested) return;
    // Another scope may have started while the marker read yielded to the
    // event loop. Put the request back and let the final active batch consume
    // it, so a restart can never cut across a newly-started reply.
    if (activeBatchCount !== 0) {
      // For new format: pending.json already exists, no need to re-write.
      // For old format: re-write the marker since consume deleted it.
      if (requested.format === 'old') {
        await requestDeferredServiceRestart(profileDir, {
          profile: controls.profile,
          bridgePid: process.pid,
          requestedAt: new Date().toISOString(),
        });
      }
      return;
    }
    deferredRestartLaunching = true;
    log.info('service', 'deferred-restart-launch', {
      profile: controls.profile,
      format: requested.format,
      ...(requested.format === 'new' ? { receiptId: requested.receiptId } : {}),
    });
    (deps.launchDeferredRestart ?? launchDeferredServiceRestart)(controls.profile);
  };

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg, deps.appPaths);
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: [{ version: 1, secret: appSecret }],
        nonceStore: callbackNonceStore,
      })
    : undefined;
  // F3/F12: Load reaction and stop-control ledgers when profileDir is available.
  if (deps.appPaths?.profileDir) {
    reactionLedger = await loadReactionLedger(deps.appPaths.profileDir);
    stopControlLedger = await loadStopControlLedger(deps.appPaths.profileDir);
  }

  const activePolicyFingerprints = new Map<string, string>();
  // Per-scope record of the model used on the last run, so a `/config` model
  // switch can inject a one-time "model changed" note into the next (resumed)
  // prompt. In-memory only: on restart the first run re-seeds silently.
  const lastRunModelByScope = new Map<string, string>();
  const cotClient = new CotClient({
    tenant: cfg.accounts.app.tenant,
    appId: cfg.accounts.app.id,
    appSecret,
  });
  const threadModeOverrideWarnedChats = new Set<string>();
  const logThreadModeOverride: LogThreadModeOverride = ({ chatId, resolvedMode, threadId }) => {
    const fields = { chatId, cachedMode: resolvedMode, threadId };
    if (threadModeOverrideWarnedChats.has(chatId)) {
      log.info('chat', 'mode-overridden-by-thread', fields);
      return;
    }
    threadModeOverrideWarnedChats.add(chatId);
    log.warn('chat', 'mode-overridden-by-thread', fields);
  };

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain:
      cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'lark-channel-bridge',
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true,
  };

  const channel = createLarkChannel(opts);
  installCardkitStreamDiagnostics(channel);
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    activeBatchCount += 1;
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', {
        scope,
        batchSize: batch.length,
        chatId: firstMsg.chatId,
        threadId: firstMsg.threadId,
        msgId: firstMsg.messageId,
      });
      try {
        const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);
        // Feishu/Lark converted topic groups may still resolve as `group` from
        // the chat info API/cache, while message events already carry threadId.
        // Treat threadId as authoritative for IM messages so scope and replies
        // stay isolated per topic.
        const mode = firstMsg.threadId ? 'topic' : resolvedMode;
        if (firstMsg.threadId && resolvedMode !== 'topic') {
          chatModeCache.invalidate(firstMsg.chatId);
          logThreadModeOverride({
            chatId: firstMsg.chatId,
            resolvedMode,
            threadId: firstMsg.threadId,
          });
        }
        await runAgentBatch({
          channel,
          executor,
          sessions,
          sessionCatalog,
          promptSessionService: deps.promptSessionService,
          workspaces,
          media,
          batch,
          controls,
          cotClient,
          callbackAuth,
          activePolicyFingerprints,
          lastRunModelByScope,
          scope,
          mode,
          profileDir: deps.appPaths?.profileDir,
        });
      } catch (err) {
        log.fail('flush', err);
      } finally {
        pending.unblock(scope);
        activeBatchCount = Math.max(0, activeBatchCount - 1);
        await maybeLaunchDeferredRestart().catch((err) =>
          log.fail('service', err, { step: 'deferred-restart' }),
        );
        log.info('flush', 'end');
      }
    });
  });

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
          channel,
          agent,
          sessions,
          sessionCatalog,
          promptSessionService: deps.promptSessionService,
          workspaces,
          activeRuns,
          pending,
          msg,
          controls,
          chatModeCache,
          logThreadModeOverride,
          executor,
          pool,
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await handleCardAction({
          channel,
          evt,
          sessions,
          sessionCatalog,
          promptSessionService: deps.promptSessionService,
          workspaces,
          activeRuns,
          agent,
          processPool: pool,
          runExecutor: executor,
          controls,
          pending,
          chatModeCache,
          callbackAuth,
          callbackPolicyFingerprintForScope: (scope) => activePolicyFingerprints.get(scope),
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        await handleCommentMention({
          channel,
          evt,
          agent,
          sessions,
          sessionCatalog,
          promptSessionService: deps.promptSessionService,
          workspaces,
          activeRuns,
          executor,
          controls,
        }).catch((err) => log.fail('comment', err));
      }).catch((err) => log.fail('comment', err));
    },
    reaction: async (evt) => {
      await withTrace({ chatId: evt.messageId }, async () => {
        try {
          // F1/F2: Guards pipeline: self-operator → route → own-message →
          // permission (using chatModeCache for chatType, not oc_/ou_ guessing).
          const pipelineResult = await handleReactionEvent(evt, {
            channel,
            botOpenId: channel.botIdentity?.openId,
            appId: cfg.accounts.app.id,
          }, {
            checkAccess: (chatType, chatId, senderId) => {
              if (chatType === 'p2p') {
                return canUseDm(controls.profileConfig, controls, senderId);
              }
              return canUseGroup(controls.profileConfig, controls, chatId, senderId);
            },
            checkGroupResponse: (_chatType, chatId, senderId) => {
              const decision = decideGroupResponse({
                chatType: 'group',
                mode: controls.profileConfig.access.groupResponseMode,
                senderId,
                botOwnerId: controls.botOwnerId,
                ownerRefreshState: controls.ownerRefreshState,
                mentionedBot: false,
                mentionCount: 0,
                mentionAll: false,
                chatId,
                ownerNoMentionChats: controls.profileConfig.access.ownerNoMentionChats,
              });
              return decision;
            },
            resolveChatMode: async (chatId) => {
              return chatModeCache.resolve(channel, chatId);
            },
            resolveWorkChain: (scope, replyToMessageId) => {
              return workChainStore.resolveOrAllocate(scope, replyToMessageId);
            },
          });

          if (pipelineResult.kind === 'drop') return;

          // F1/F4/F5: Non-stop → push into buffer for reconciliation
          if (pipelineResult.kind === 'buffer-reaction') {
            reactionBuffer.push(pipelineResult.key, evt);
            log.info('reaction', 'buffered', {
              key: pipelineResult.key,
              emojiType: evt.emojiType,
              action: evt.action,
            });
            return;
          }

          // F3/F6/F7/F11/F12: Stop control plane with persistent ledger
          if (pipelineResult.kind === 'stop-added-reply') {
            const fp = stopEventFingerprint(
              pipelineResult.operatorOpenId, pipelineResult.targetMessageId,
              pipelineResult.emojiType, 'added',
              pipelineResult.actionTime, pipelineResult.stableId,
            );

            // F3/F12: isConsumed check before any action
            if (stopControlLedger?.isConsumed(fp)) return;

            // F11: Determine result based on current state
            let message: string;
            let replyKind: 'no-work' | 'stopped' | 'fail-closed';

            if (activeRuns.get(pipelineResult.scope) === undefined) {
              message = '当前没有需要停止的任务。';
              replyKind = 'no-work';
            } else if (workChainStore.resolveCurrentChain(pipelineResult.targetMessageId) === undefined) {
              message = '该 Reaction 未停止当前任务，如需停止请使用 /stop 命令。';
              replyKind = 'fail-closed';
            } else {
              // F11: Real interrupt + cancel pending
              activeRuns.interrupt(pipelineResult.scope);
              pending.cancel(pipelineResult.scope);
              message = '已停止当前任务。';
              replyKind = 'stopped';
            }

            // F12: Persist consumed state
            if (stopControlLedger) {
              await stopControlLedger.record(fp, 'added',
                pipelineResult.operatorOpenId, pipelineResult.targetMessageId,
                pipelineResult.emojiType, replyKind);
            }

            try {
              await channel.send(pipelineResult.chatId, { markdown: message }, {
                replyTo: pipelineResult.targetMessageId,
              });
            } catch (err) {
              log.warn('reaction', 'stop-reply-failed', { err: String(err) });
            }
            return;
          }

          if (pipelineResult.kind === 'stop-removed-reply') {
            const fp = stopEventFingerprint(
              pipelineResult.operatorOpenId, pipelineResult.targetMessageId,
              pipelineResult.emojiType, 'removed',
              pipelineResult.actionTime, pipelineResult.stableId,
            );

            // F6/F7: Only reply if matching stop-added was consumed
            if (stopControlLedger && !stopControlLedger.isConsumed(fp)) {
              const match = stopControlLedger.findMatchingAdded(
                pipelineResult.operatorOpenId, pipelineResult.targetMessageId, pipelineResult.emojiType);
              if (match) {
                await stopControlLedger.record(fp, 'removed',
                  pipelineResult.operatorOpenId, pipelineResult.targetMessageId, pipelineResult.emojiType);
                try {
                  await channel.send(pipelineResult.chatId, {
                    markdown: '撤回停止 Reaction 不会自动恢复工作。如需继续，请发送新的消息。',
                  }, { replyTo: pipelineResult.targetMessageId });
                } catch (err) {
                  log.warn('reaction', 'stop-removed-reply-failed', { err: String(err) });
                }
              }
              // F7: No matching added → silent no-op
            }
            return;
          }
        } catch (err) {
          log.fail('reaction', err);
        }
      }).catch((err) => log.fail('reaction', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      reportMetric('ws_reconnect', 1, { kind: 'ws' });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  await channel.connect();
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id,
  });
  await ownerRefresh.start();
  const knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);

  const identity = channel.botIdentity;
  // Late-bind the bot's own IM identity into the agent adapter so the system
  // prompt can state "this open_id is you" with the real value. Covers both
  // initial start and credential-swap reconnects (both go through here).
  if (identity?.openId) {
    agent.setBotIdentity?.({
      openId: identity.openId,
      ...(identity.name ? { name: identity.name } : {}),
    });
  }
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // ── New bridge: lifecycle cleanup + receipt handling ──────────────
  const profileDir = deps.appPaths?.profileDir;
  if (profileDir) {
    // Clean up orphan .tmp files from interrupted primitives.
    await cleanupOrphanTemps(profileDir).catch((err) =>
      log.fail('receipt', err, { step: 'cleanup-temps' }),
    );
    // Remove expired route leases.
    await cleanupExpiredLeases(profileDir).catch((err) =>
      log.fail('route-lease', err, { step: 'cleanup-leases' }),
    );
    // Quarantine stale pending (oldPid dead + request too old).
    await handleStalePendingQuarantine(controls.profile, profileDir).catch((err) =>
      log.fail('receipt', err, { step: 'stale-pending-quarantine' }),
    );
    // Send success receipt for a pending restart.
    await handleNewBridgePendingReceipt(channel, controls.profile, profileDir).catch((err) =>
      log.fail('receipt', err, { step: 'new-bridge-success-receipt' }),
    );
    // Recovery: scan for claim.* files without terminal and attempt takeover.
    await handleReceiptRecovery(channel, controls.profile, profileDir).catch((err) =>
      log.fail('receipt', err, { step: 'receipt-recovery' }),
    );
  }

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  return {
    channel,
    disconnect: async () => {
      activeRuns.pauseNewRuns('bridge-disconnect');
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      pending.cancelAll();
      const [disconnectResult, stopAllResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.stopAll(),
        sessions.flush(),
        sessionCatalog?.flush(),
        callbackNonceStore?.flush(),
        workspaces.flush(),
      ]);
      if (stopAllResult.status === 'rejected') {
        log.fail('disconnect', stopAllResult.reason, { step: 'stopAll' });
      }
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${idx}` });
        }
      }
      if (disconnectResult.status === 'rejected') {
        throw disconnectResult.reason;
      }
    },
  };
}

function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: Controls,
): { stop(): void } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendNonAllowedGroupHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    'Bot owner/管理员可在本群发 /invite group 加入白名单。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  promptSessionService?: PromptSessionService;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
  logThreadModeOverride: LogThreadModeOverride;
  executor: RunExecutor;
  pool: ProcessPool;
}

type LogThreadModeOverride = (input: {
  chatId: string;
  resolvedMode: ChatMode;
  threadId: string;
}) => void;

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    sessionCatalog,
    promptSessionService,
    workspaces,
    activeRuns,
    pending,
    msg,
    controls,
    chatModeCache,
    logThreadModeOverride,
    executor,
    pool,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const resolvedMode = await chatModeCache.resolve(channel, msg.chatId);
  // Feishu delivers a sizable fraction of topic-group message events without a
  // `thread_id` (notably the message that opens a new topic). We route topic
  // replies (`replyInThread`) and isolate per-topic session scope off it, so a
  // missing one makes the reply escape into a brand-new topic AND collapses the
  // scope to the chat level. When getChatMode says this is a topic group but
  // the event dropped `thread_id`, backfill it from the raw message — the same
  // recovery the card-click path uses.
  let threadId = msg.threadId;
  if (!threadId && resolvedMode === 'topic') {
    threadId = await lookupMessageThreadId(channel, msg.messageId);
    if (threadId) {
      log.info('intake', 'thread-id-backfilled', {
        chatId: msg.chatId,
        msgId: msg.messageId,
        threadId,
      });
    }
  }
  // Carry the (possibly backfilled) threadId on the message so the batched
  // flush — which reads `firstMsg.threadId` for reply routing and topic scope —
  // sees it.
  const emsg: NormalizedMessage = threadId === msg.threadId ? msg : { ...msg, threadId };
  // Some groups are converted into topic groups after creation. In that state
  // getChatMode can lag behind the message event shape, so threadId is the
  // stronger signal for topic-scoped sessions and reply routing.
  const chatMode = threadId ? 'topic' : resolvedMode;
  if (threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(msg.chatId);
    logThreadModeOverride({
      chatId: msg.chatId,
      resolvedMode,
      threadId,
    });
  }
  const scope = chatMode === 'topic' && threadId
    ? `${msg.chatId}:${threadId}`
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId,
    msgId: msg.messageId,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  let accessDecision =
    msg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, msg.senderId)
      : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId);
  if (!accessDecision.ok) {
    if (shouldBypassDeniedChatForInviteGroup(msg, controls)) {
      accessDecision = { ok: true, reason: 'allowed-admin' };
      log.info('intake', 'allow-denied-chat-invite-group', {
        scope,
        sender: msg.senderId.slice(-6),
      });
    } else {
      log.info('intake', 'skip-not-allowed-user', {
        scope,
        sender: msg.senderId.slice(-6),
        reason: accessDecision.reason,
      });
      if (msg.chatType !== 'p2p' && accessDecision.reason === 'denied-chat' && msg.mentionedBot) {
        void sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch((err) =>
          log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
        );
      }
      return;
    }
  }

  // This gate is intentionally after access control and before commands,
  // pending queues, runs, and cards. Explicit @bot messages retain their
  // original path; owner-default is a narrow opt-in for owner messages with
  // no structured mention of any account.
  const groupResponseDecision = decideGroupResponse({
    chatType: msg.chatType,
    mode: controls.profileConfig.access.groupResponseMode,
    senderId: msg.senderId,
    botOwnerId: controls.botOwnerId,
    ownerRefreshState: controls.ownerRefreshState,
    mentionedBot: msg.mentionedBot,
    mentionCount: msg.mentions?.length ?? 0,
    mentionAll: msg.mentionAll,
    chatId: msg.chatId,
    ownerNoMentionChats: controls.profileConfig.access.ownerNoMentionChats,
  });
  if (!groupResponseDecision.accept) {
    log.info('intake', 'skip-group-response-policy', {
      scope,
      chatType: msg.chatType,
      reason: groupResponseDecision.reason,
    });
    return;
  }

  const handled = await tryHandleCommand({
    channel,
    msg: emsg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    sessionCatalog,
    promptSessionService,
    sessionCatalogIdentity: await commandSessionCatalogIdentity({
      msg: emsg,
      scope,
      mode: chatMode,
      workspaces,
      controls,
      access: accessDecision,
    }),
    runExecutor: executor,
    processPool: pool,
    controls,
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    return;
  }

  const size = pending.push(scope, emsg);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}

export function shouldBypassDeniedChatForInviteGroup(
  msg: NormalizedMessage,
  controls: Controls,
): boolean {
  if (msg.chatType === 'p2p') return false;
  if (!msg.mentionedBot) return false;
  const content = msg.content.trim();
  if (
    !/^(?:@\S+[ \t]+)?\/(?:invite[ \t]+group|invite[ \t]+owner-default[ \t]+group|remove[ \t]+owner-default[ \t]+group)$/.test(
      content,
    )
  )
    return false;
  return canRunBotAdminCommand(controls.profileConfig, controls, msg.senderId).ok;
}

interface RunBatchDeps {
  channel: LarkChannel;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  promptSessionService?: PromptSessionService;
  workspaces: WorkspaceStore;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  cotClient: CotClient;
  callbackAuth?: CallbackAuth;
  activePolicyFingerprints: Map<string, string>;
  lastRunModelByScope: Map<string, string>;
  scope: string;
  mode: ChatMode;
  profileDir?: string;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    executor,
    sessions,
    sessionCatalog,
    promptSessionService,
    workspaces,
    media,
    batch,
    controls,
    cotClient,
    callbackAuth,
    activePolicyFingerprints,
    lastRunModelByScope,
    scope,
    mode,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await media.resolve(resourceItems, controls.profileConfig.attachments);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => replyQuoteTargetForMessage(m, mode))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  // Topic upstream context. When the bot is pulled into a topic for the FIRST
  // time (no session yet for this scope), the topic's earlier messages — the
  // root question that may never have @-mentioned the bot, plus prior replies —
  // live nowhere the agent can see them. Fetch them so it isn't blind to what
  // the user is pointing at. An already-engaged topic keeps that history in its
  // resumed session, so we skip the fetch there.
  let topicContext: QuotedContext[] = [];
  if (mode === 'topic' && threadId && !sessions.getRaw(scope)) {
    const exclude = new Set([...batchIds, ...quoteTargets]);
    topicContext = await fetchTopicContext(channel, threadId, {
      maxMessages: 40,
      excludeIds: exclude,
    });
    if (topicContext.length > 0) {
      log.info('topic', 'context-fetched', {
        scope,
        threadId,
        count: topicContext.length,
      });
    }
  }

  // Detect a model switch since this scope's last run. When resuming an
  // existing conversation the transcript still claims the old model, so tell
  // the (now-switched) agent its model changed — otherwise it keeps echoing
  // the previously-announced model. Only fires when a prior model was seen
  // for this scope (never on the first run) and the selection actually
  // changed. `requestedModel` (the `--model` value, or undefined for default)
  // is reused below to log requested-vs-actual against the init event.
  const agentKind = controls.profileConfig.agentKind;
  const modelPref = controls.profileConfig.preferences.model;
  const modelSelection = normalizeModelSelection(agentKind, modelPref);
  const requestedModel = resolveModelArg(agentKind, modelPref);
  const prevModel = lastRunModelByScope.get(scope);
  const modelSwitched = prevModel !== undefined && prevModel !== modelSelection;
  lastRunModelByScope.set(scope, modelSelection);
  const extraInstructions = modelSwitched
    ? [
        `用户刚把本会话使用的模型切换为「${modelLabel(agentKind, modelPref)}」。` +
          '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
      ]
    : undefined;

  // F1: Detect reaction batches and collect reactionContexts via internal store
  const isReactionBatch = lastMsg.rawContentType === ('reaction' as never);
  const reactionContexts: unknown[] | undefined = isReactionBatch
    ? getReactionContexts(batch.map(m => m.messageId))
    : undefined;

  const prompt = buildPrompt(
    batch,
    attachments,
    quotes,
    topicContext,
    channel.botIdentity,
    extraInstructions,
    (reactionContexts && reactionContexts.length > 0) ? reactionContexts : undefined,
  );
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    quotes: quotes.length,
    topicContext: topicContext.length,
    ...(modelSwitched ? { modelSwitchedTo: modelSelection } : {}),
  });

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  // F1: For reaction batches, replyTo targets the reaction's target message,
  // not the last batch message (which is the synthetic reaction placeholder).
  const replyToId = isReactionBatch ? (batch[0]?.messageId ?? lastMsg.messageId) : lastMsg.messageId;
  const sendOpts = {
    replyTo: replyToId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
  };
  log.info('flush', 'reply-target', {
    scope,
    mode,
    chatId,
    threadId,
    replyTo: sendOpts.replyTo,
    replyInThread: sendOpts.replyInThread === true,
  });

  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatId,
    actorId: firstMsg.senderId,
    ...(threadId ? { threadId } : {}),
  };
  const capability =
    controls.profileConfig.agentKind === 'codex'
      ? codexCapability(controls.profileConfig)
      : claudeCapability(controls.profileConfig);
  const promptOrigin = {
    source: 'im' as const,
    scopeId: scope,
    chatId,
    chatType: firstMsg.chatType,
    ...(threadId ? { threadId } : {}),
  };
  // Create a per-run route lease for deferred self-restart. Only routeId is
  // exposed to the agent environment — never chatId. The restart CLI validates
  // the lease by bridgePid and consumes it to create a pending receipt.
  let routeLeaseId: string | undefined;
  if (deps.profileDir) {
    const lease = await createRouteLease(deps.profileDir, {
      chatId,
      threadId,
      replyTo: lastMsg.messageId,
      bridgePid: process.pid,
      runId: `${scope}:${Date.now()}`,
    });
    if (lease) {
      routeLeaseId = lease.routeId;
      log.info('route-lease', 'created', { routeId: routeLeaseId, chatId });
    }
  }

  const startFlow = (
    stage: 'submit' | 'startup-retry',
    reuseDecision?: PromptSessionDecision,
  ) =>
    startRunFlow({
      scopeId: scope,
      scope: scopeContext,
      prompt,
      attachments: attachments.map(toPolicyAttachment),
      access: accessDecision,
      capability,
      profileConfig: controls.profileConfig,
      sessions,
      sessionCatalog,
      ...(promptSessionService
        ? {
            promptSession: {
              service: promptSessionService,
              origin: promptOrigin,
              ...(reuseDecision ? { reuseDecision } : {}),
            },
          }
        : {}),
      workspaces,
      executor,
      now: Date.now(),
      stopGraceMs: getAgentStopGraceMs(controls.cfg),
      routeId: routeLeaseId,
      observability: {
        profile: controls.profile,
        agent: capability.agentId,
        source: 'im',
        stage,
      },
    });
  const flow = await startFlow('submit');
  if (!flow.ok) {
    // Clean up route lease if flow is rejected — no agent run will happen.
    if (routeLeaseId && deps.profileDir) {
      await deleteRouteLease(deps.profileDir, routeLeaseId).catch(() => {});
    }
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    if (flow.rejectReason.code === 'run-interrupted') return;
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    return;
  }

  const { execution, cwdRealpath: cwd } = flow;
  let activeFlow = flow;
  const promptAdmissions = flow.promptSession ? [flow.promptSession.admission] : [];
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  const eventStream = execution.subscribe();
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }
  const recordSession = async (evt: AgentEvent): Promise<void> => {
    const promptSession = activeFlow.promptSession;
    const agentSessionId =
      evt.type === 'system'
        ? capability.agentId === 'claude'
          ? evt.sessionId
          : evt.threadId
        : undefined;
    if (promptSession?.decision.kind === 'fresh' && agentSessionId) {
      await promptSessionService!.recordIdentifier({
        identity: promptSession.identity,
        origin: promptSession.origin,
        binding: promptSession.decision.binding,
        generation: promptSession.decision.generation,
        agentSessionId,
        admission: promptSession.admission,
      });
    } else if (promptSession?.decision.kind === 'dormant') {
      const durability = recordRunSessionEventAwaited({
        scopeId: scope,
        sessions,
        sessionCatalog,
        capability,
        policy: activeFlow.policy,
        event: evt,
      });
      if (agentSessionId) {
        promptSession.admission.trackIdentifierDurability(durability);
        void durability.catch((err) => {
          log.fail('session', err, { step: 'dormant-identifier-persist', scope });
        });
      }
    }
    if (evt.type === 'system' && evt.sessionId) {
      log.info('session', 'set', { sessionId: evt.sessionId });
    }
    // Ground truth for "which model is actually running": claude reports the
    // model it loaded in its init event. Logging requested-vs-actual reveals
    // whether the --model pin took effect or claude silently fell back (e.g.
    // an id this claude build/account doesn't recognize).
    if (evt.type === 'system' && evt.model) {
      log.info('session', 'model', {
        requested: requestedModel ?? 'default',
        actual: evt.model,
      });
    }
    if (evt.type === 'system' && evt.threadId) {
      log.info('session', 'set-thread', { threadId: evt.threadId });
    }
  };
  let startupRetryUsed = false;
  const recoverStartupTimeout = async (): Promise<
    { handle: RunHandle; events: AsyncIterable<AgentEvent> } | undefined
  > => {
    if (capability.agentId !== 'codex' || startupRetryUsed) return undefined;
    startupRetryUsed = true;
    await execution.stop();
    const safe = await execution.run.canRetryAfterNoOutput?.() ?? false;
    if (!safe) {
      log.warn('agent', 'startup-timeout-retry-skipped', {
        scope,
        reason: execution.run.canRetryAfterNoOutput
          ? 'turn-not-empty-terminal'
          : 'agent-does-not-support-verification',
      });
      return undefined;
    }
    const replacement = await startFlow(
      'startup-retry',
      activeFlow.promptSession?.decision,
    );
    if (!replacement.ok) {
      log.warn('agent', 'startup-timeout-retry-rejected', {
        scope,
        code: replacement.rejectReason.code,
      });
      return undefined;
    }
    log.warn('agent', 'startup-timeout-retry-started', {
      scope,
      previousRunId: execution.runId,
      retryRunId: replacement.execution.runId,
      threadId: replacement.resumeFrom,
    });
    activeFlow = replacement;
    if (replacement.promptSession) promptAdmissions.push(replacement.promptSession.admission);
    return {
      handle: replacement.execution.handle,
      events: replacement.execution.subscribe(),
    };
  };

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs = resolveRunIdleTimeoutMs(
    controls.cfg,
    scopeOverride,
    capability.agentId,
  );
  const startupTimeoutMs = resolveRunStartupTimeoutMs(capability.agentId);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }
  if (startupTimeoutMs) {
    log.info('flush', 'startup-watchdog', { startupTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });
  const cotMessages = getCotMessages(controls.cfg);
  const cotEnabled = cotMessages !== 'off';

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(controls.cfg)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };
  const cardRenderOptions = callbackAuth
    ? {
        signCallback: (action: string) =>
          callbackAuth.sign({
            runId: execution.runId,
            scope,
            chatId,
            operatorOpenId: firstMsg.senderId,
            action,
            policyFingerprint: flow.policy.policyFingerprint,
            ttlMs: 24 * 60 * 60 * 1000,
          }),
      }
    : {};

  // For non-card modes Claude's output doesn't surface visually until either
  // a first streamed token (markdown mode) or the whole run ends (text mode).
  // Add a "Typing" reaction to the triggering message as an instant ack, but
  // never let that outbound API call block agent event draining.
  const reactionPromise =
    cotEnabled || replyMode === 'card' ? undefined : addWorkingReaction(channel, lastMsg.messageId);

  try {
    if (cotEnabled) {
      const cotPublisher = new CotPublisher({
        client: cotClient,
        chatId,
        // The CoT bubble follows this origin message's thread. In a topic the
        // triggering message is itself in-topic, so the bubble lands in the
        // topic; message_cot has no thread_id receive type, so origin is the
        // only lever we have (see CotClient.create).
        originMessageId: lastMsg.messageId,
        runId: execution.runId,
        scope,
        inputPreview: lastMsg.content,
      });
      await cotPublisher.start();
      if (!cotPublisher.disabled) {
        const cotDone = consumeCotEvents(execution.subscribe(), cotPublisher, {
          detail: cotMessages,
        });
        const finalState = await processAgentStream(
          handle,
          eventStream,
          scope,
          idleTimeoutMs,
          startupTimeoutMs,
          recordSession,
          async () => {},
          recoverStartupTimeout,
        );
        await cotDone;
        if (cotPublisher.degradedReason) {
          await sendCotDegradedNotice({
            channel,
            chatId,
            scope,
            sendOpts,
            reason: cotPublisher.degradedReason,
          });
        }
        await sendFinalReply({
          channel,
          chatId,
          scope,
          state: finalAnswerOnlyState(finalState),
          replyMode,
          sendOpts,
          cardRenderOptions,
        });
        return;
      }
      log.warn('cot', 'fallback-existing-reply', { reason: 'create-disabled' });
    }

    if (replyMode === 'card') {
      let latestState: RunState = initialState;
      let producerStarted = false;
      let cardCtrl:
        | { update(next: object | ((current: object) => object)): Promise<void> }
        | undefined;
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        startupTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (cardCtrl) {
            await cardCtrl.update(renderCard(filterForPrefs(state), cardRenderOptions));
          }
        },
        recoverStartupTimeout,
      );
      const streamDone = channel.stream(
        chatId,
        {
          card: {
            initial: renderCard(initialState, cardRenderOptions),
            producer: async (ctrl) => {
              producerStarted = true;
              cardCtrl = ctrl;
              await ctrl.update(renderCard(filterForPrefs(latestState), cardRenderOptions));
              await renderDone;
            },
          },
        },
        sendOpts,
      );
      await awaitRenderAwareStream({
        mode: replyMode,
        streamDone,
        renderDone,
        producerStarted: () => producerStarted,
        fallback: async (state) => {
          await channel.send(
            chatId,
            { card: renderCard(filterForPrefs(state), cardRenderOptions) },
            sendOpts,
          );
        },
      });
    } else if (replyMode === 'markdown') {
      let latestState: RunState = initialState;
      let latestMarkdown = renderMarkdownStreamText(latestState);
      let markdownFlushes = 0;
      let producerStarted = false;
      let lastSetContent:
        | ({ flush: number; phase: string; durationMs: number } & ReturnType<typeof textLogFields>)
        | undefined;
      let markdownCtrl: { setContent(markdown: string): Promise<void> } | undefined;
      const setMarkdownContent = async (
        phase: 'initial' | 'update' | 'terminal',
        markdown: string,
      ): Promise<void> => {
        if (!markdownCtrl) return;
        latestMarkdown = markdown;
        markdownFlushes++;
        const flush = markdownFlushes;
        const start = Date.now();
        try {
          await markdownCtrl.setContent(markdown);
          lastSetContent = {
            flush,
            phase,
            durationMs: Date.now() - start,
            ...textLogFields('markdown', markdown),
          };
          if (phase !== 'update') {
            log.info('stream', 'markdown-set-content', lastSetContent);
          }
        } catch (err) {
          log.fail('stream', err, {
            step: 'markdown-set-content',
            flush,
            phase,
            ...textLogFields('markdown', markdown),
          });
          throw err;
        }
      };
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        startupTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (markdownCtrl) {
            const markdown = renderMarkdownStreamText(filterForPrefs(state));
            await setMarkdownContent(state.terminal === 'running' ? 'update' : 'terminal', markdown);
          }
        },
        recoverStartupTimeout,
      );
      const streamDone = channel
        .stream(
          chatId,
          {
            markdown: async (ctrl) => {
              producerStarted = true;
              markdownCtrl = ctrl;
              const initialMarkdown = renderMarkdownStreamText(filterForPrefs(latestState));
              await setMarkdownContent('initial', initialMarkdown);
              const finalState = await renderDone;
              const finalMarkdown = renderMarkdownStreamText(filterForPrefs(finalState));
              log.info('stream', 'markdown-producer-final', {
                terminal: finalState.terminal,
                chars: latestMarkdown.length,
                flushes: markdownFlushes,
                hasRunningFooter: hasRunningFooter(latestMarkdown),
                finalMatchesLatest: finalMarkdown === latestMarkdown,
                ...textLogFields('finalMarkdown', finalMarkdown),
                lastSetContent,
              });
            },
          },
          sendOpts,
        )
        .then((result) => {
          log.info('stream', 'markdown-terminal-resolved', {
            chars: latestMarkdown.length,
            flushes: markdownFlushes,
            hasRunningFooter: hasRunningFooter(latestMarkdown),
            ...textLogFields('latestMarkdown', latestMarkdown),
            lastSetContent,
            ...streamResultLogFields(result),
          });
          return result;
        });
      await awaitRenderAwareStream({
        mode: replyMode,
        streamDone,
        renderDone,
        producerStarted: () => producerStarted,
        verifyFinal: async (streamValue, state) =>
          verifyMarkdownFinalReadback(
            channel,
            streamValue,
            renderMarkdownStreamText(filterForPrefs(state)),
          ),
        fallback: async (state) => {
          const body = renderText(filterForPrefs(state));
          if (body.trim()) {
            await channel.send(chatId, { markdown: body }, sendOpts);
          }
        },
      });
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        startupTimeoutMs,
        recordSession,
        async () => {},
        recoverStartupTimeout,
      );
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state: filterForPrefs(finalState),
        replyMode,
        sendOpts,
        cardRenderOptions,
      });
    }
  } catch (err) {
    log.fail('stream', err);
  } finally {
    for (const admission of promptAdmissions) admission.finishWithoutIdentifier();
    activePolicyFingerprints.delete(scope);
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);
  }
}

async function sendFinalReply(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  state: RunState;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  cardRenderOptions: { signCallback?: (action: string) => string };
}): Promise<void> {
  const body = renderText(input.state);

  if (input.replyMode === 'card') {
    const result = await input.channel.send(
      input.chatId,
      { card: renderCard(input.state, input.cardRenderOptions) },
      input.sendOpts,
    );
    log.info('outbound', 'sent', outboundLogFields(input, 'card', body, result));
  } else if (input.replyMode === 'markdown') {
    if (body.trim()) {
      try {
        await input.channel.stream(
          input.chatId,
          {
            markdown: async (ctrl) => {
              await ctrl.setContent(body);
            },
          },
          input.sendOpts,
        );
        log.info('outbound', 'sent', outboundLogFields(input, 'markdown-stream', body));
      } catch (err) {
        log.warn('outbound', 'markdown-stream-fallback', {
          err: err instanceof Error ? err.message : String(err),
        });
        const result = await input.channel.send(
          input.chatId,
          { markdown: body },
          input.sendOpts,
        );
        log.info('outbound', 'sent', outboundLogFields(input, 'markdown', body, result));
      }
    }
  } else if (body.trim()) {
    const result = await input.channel.send(
      input.chatId,
      { markdown: body },
      input.sendOpts,
    );
    log.info('outbound', 'sent', outboundLogFields(input, 'text', body, result));
  }
}

async function sendCotDegradedNotice(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  reason: string;
}): Promise<void> {
  log.warn('cot', 'degraded', {
    scope: input.scope,
    reason: input.reason,
    replyInThread: input.sendOpts.replyInThread === true,
  });
  try {
    await input.channel.send(
      input.chatId,
      { markdown: 'COT 过程消息更新失败，已停止展示过程；最终答案仍会继续发送。' },
      input.sendOpts,
    );
  } catch (err) {
    log.warn('cot', 'degraded-notice-failed', {
      scope: input.scope,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function outboundLogFields(
  input: {
    scope?: string;
    replyMode: ReturnType<typeof getMessageReplyMode>;
    sendOpts?: { replyTo?: string; replyInThread?: boolean };
  },
  type: string,
  body: string,
  result?: { messageId?: string },
): Record<string, unknown> {
  return {
    type,
    scope: input.scope,
    mode: input.replyMode,
    chars: body.length,
    messageId: result?.messageId,
    replyTo: input.sendOpts?.replyTo,
    replyInThread: input.sendOpts?.replyInThread === true,
  };
}

function renderMarkdownStreamText(state: RunState): string {
  return renderText(state);
}

function hasRunningFooter(markdown: string): boolean {
  return (
    markdown.includes('正在思考') ||
    markdown.includes('正在调用工具') ||
    markdown.includes('正在输出')
  );
}

function streamResultLogFields(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {};
  const messageId = (result as { messageId?: unknown }).messageId;
  const chunkIds = (result as { chunkIds?: unknown }).chunkIds;
  return {
    ...(typeof messageId === 'string' ? { messageId } : {}),
    ...(Array.isArray(chunkIds) ? { chunkIds } : {}),
  };
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
export async function processAgentStream(
  handle: RunHandle,
  events: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  startupTimeoutMs: number | undefined,
  recordSession: (event: AgentEvent) => void | Promise<void>,
  flush: (state: RunState) => Promise<void>,
  recoverStartupTimeout?: () => Promise<
    { handle: RunHandle; events: AsyncIterable<AgentEvent> } | undefined
  >,
): Promise<RunState> {
  const runStart = Date.now();
  let state: RunState = initialState;

  // Idle watchdog: claude going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — claude can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize). In that
  // case there's no event stream activity from claude itself, only the
  // tool subprocess running. We track which tool_use ids haven't matched
  // a tool_result yet, and pause the watchdog whenever the set is
  // non-empty.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  let startupFired = false;
  let startupTimer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const stopForTimeout = (kind: 'idle' | 'startup', timeoutMs: number): void => {
    if (idleFired || startupFired) return;
    if (kind === 'idle') idleFired = true;
    else startupFired = true;
    handle.interrupted = true;
    log.warn('agent', `${kind}-timeout`, { scope, timeoutMs });
    void handle.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
  };
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0) return;
    timer = setTimeout(() => {
      stopForTimeout('idle', idleTimeoutMs);
    }, idleTimeoutMs);
  };
  armOrPauseIdle();
  if (startupTimeoutMs) {
    startupTimer = setTimeout(() => {
      stopForTimeout('startup', startupTimeoutMs);
    }, startupTimeoutMs);
  }

  try {
    for await (const evt of events) {
      if (handle.interrupted) break;

      // Codex can emit thread/task metadata and then permanently stop making
      // progress when a broken resume transcript is loaded. Metadata alone
      // does not prove startup completed; any substantive event does.
      if (evt.type !== 'system' && evt.type !== 'usage' && startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }

      // Track tool flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use opens a window; tool_result
      // closes it. Other event types are bookkept after the if/else.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      }
      armOrPauseIdle();

      if (evt.type === 'system') {
        try {
          await recordSession(evt);
        } catch (err) {
          log.fail('session', err, { step: 'identifier-commit', scope });
          handle.interrupted = true;
          await handle.run.stop().catch(() => {});
          await handle.run.waitForExit(2_000).catch(() => false);
          state = reduce(state, {
            type: 'error',
            message: '会话状态保存失败，请稍后重试。',
            terminationReason: 'failed',
          });
          await flush(state);
          return state;
        }
        continue;
      }
      if (evt.type === 'usage') {
        const { costUsd, inputTokens, outputTokens } = evt;
        if (costUsd !== undefined || inputTokens !== undefined || outputTokens !== undefined) {
          log.info('agent', 'usage', {
            ...(costUsd !== undefined ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
          if (costUsd !== undefined) reportMetric('cost_usd', costUsd);
          if (inputTokens !== undefined) reportMetric('tokens_in', inputTokens);
          if (outputTokens !== undefined) reportMetric('tokens_out', outputTokens);
        }
        continue;
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state. Some claude
      // versions don't close stdout immediately after the result event, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (startupTimer) clearTimeout(startupTimer);
  }

  if (state.terminal === 'running' && startupFired && recoverStartupTimeout) {
    await handle.run.stop().catch(() => {});
    try {
      const replacement = await recoverStartupTimeout();
      if (replacement) {
        log.warn('agent', 'startup-timeout-retrying', { scope });
        return processAgentStream(
          replacement.handle,
          replacement.events,
          scope,
          idleTimeoutMs,
          startupTimeoutMs,
          recordSession,
          flush,
        );
      }
    } catch (err) {
      log.fail('agent', err, { step: 'startup-timeout-recovery', scope });
    }
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "claude finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired || startupFired) {
      const timeoutMs = startupFired ? startupTimeoutMs! : idleTimeoutMs!;
      state = markIdleTimeout(state, Math.round(timeoutMs / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { scope, terminal: state.terminal, interrupted: handle.interrupted });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  await flush(state);
  if (handle.interrupted) {
    await handle.run.stop();
  }
  return state;
}

async function awaitRenderAwareStream(input: {
  mode: 'card' | 'markdown';
  streamDone: Promise<unknown>;
  renderDone: Promise<RunState>;
  producerStarted: () => boolean;
  verifyFinal?: (streamValue: unknown, state: RunState) => Promise<boolean | undefined>;
  fallback: (state: RunState) => Promise<void>;
}): Promise<void> {
  const streamResult = input.streamDone.then(
    (value) => ({ kind: 'stream' as const, ok: true as const, value }),
    (err) => ({ kind: 'stream' as const, ok: false as const, err }),
  );
  const renderResult = input.renderDone.then(
    (state) => ({ kind: 'render' as const, ok: true as const, state }),
    (err) => ({ kind: 'render' as const, ok: false as const, err }),
  );
  const first = await Promise.race([streamResult, renderResult]);
  if (!first.ok) {
    if (first.kind === 'stream') {
      log.fail('stream', first.err, { mode: input.mode, step: 'stream' });
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      await runFallbackReply(input.mode, rendered.state, input.fallback);
      return;
    }
    throw first.err;
  }

  if (first.kind === 'stream') {
    const rendered = await renderResult;
    if (!rendered.ok) throw rendered.err;
    await runFallbackOnFinalMismatch(input, first.value, rendered.state);
    return;
  }

  if (!input.producerStarted()) {
    log.warn('stream', 'producer-not-started-before-agent-terminal', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }

  const terminal = await Promise.race([
    streamResult,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
  ]);
  if (!terminal) {
    log.warn('stream', 'terminal-grace-expired', {
      mode: input.mode,
      graceMs: STREAM_TERMINAL_GRACE_MS,
    });
    void streamResult.then((result) => {
      if (!result.ok) {
        log.fail('stream', result.err, { mode: input.mode, step: 'stream-terminal-late' });
      }
    });
    return;
  }
  if (!terminal.ok) {
    log.fail('stream', terminal.err, { mode: input.mode, step: 'stream-terminal' });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }
  await runFallbackOnFinalMismatch(input, terminal.value, first.state);
}

async function runFallbackOnFinalMismatch(
  input: {
    mode: 'card' | 'markdown';
    verifyFinal?: (streamValue: unknown, state: RunState) => Promise<boolean | undefined>;
    fallback: (state: RunState) => Promise<void>;
  },
  streamValue: unknown,
  state: RunState,
): Promise<void> {
  if (!input.verifyFinal) return;
  const visible = await input.verifyFinal(streamValue, state);
  if (visible === false) {
    log.warn('stream', 'final-readback-mismatch-no-fallback', { mode: input.mode });
  }
}

async function verifyMarkdownFinalReadback(
  channel: LarkChannel,
  streamValue: unknown,
  expected: string,
): Promise<boolean | undefined> {
  const messageId = streamMessageId(streamValue);
  const chunkIds = streamChunkIds(streamValue);
  const readbackMessageId = streamReadbackMessageId(messageId, chunkIds);
  if (!readbackMessageId) {
    log.warn('stream', 'markdown-readback-skipped', {
      reason: 'missing-message-id',
      didRollover: chunkIds.length > 0,
      chunkIds,
    });
    return undefined;
  }
  if (isLikelyUntrackedMarkdownRollover(expected, chunkIds)) {
    log.warn('stream', 'markdown-readback-skipped', {
      reason: 'likely-rollover-without-chunk-ids',
      messageId,
      readbackMessageId,
      chars: expected.length,
      maxElementChars: MARKDOWN_STREAM_MAX_ELEMENT_CHARS,
    });
    return undefined;
  }

  const first = await readMarkdownMessageSnapshot(channel, readbackMessageId, messageId, chunkIds);
  if (first === undefined) return undefined;
  if (markdownReadbackMatches(first.text, expected)) {
    log.info('stream', 'markdown-readback-match', {
      messageId,
      readbackMessageId,
      didRollover: chunkIds.length > 0,
      chunkIds,
      ...readbackLogFields(first, expected),
    });
    return true;
  }

  await delay(FINAL_READBACK_RETRY_MS);
  const second = await readMarkdownMessageSnapshot(channel, readbackMessageId, messageId, chunkIds);
  if (second === undefined) return undefined;
  const matches = markdownReadbackMatches(second.text, expected);
  if (!matches) {
    const finalAnchorPresent = markdownFinalAnchorPresent(second.text, expected);
    log.warn('stream', 'markdown-readback-mismatch', {
      messageId,
      readbackMessageId,
      didRollover: chunkIds.length > 0,
      chunkIds,
      ...readbackLogFields(second, expected),
      liveTail: tailForLog(second.text),
      expectedTail: tailForLog(expected),
      finalAnchorPresent,
    });
    if (finalAnchorPresent && !hasRunningFooter(second.text)) return false;
    const repaired = await repairStaleMarkdownCard(channel, readbackMessageId, expected);
    if (repaired) {
      await delay(FINAL_READBACK_RETRY_MS);
      const repairedSnapshot = await readMarkdownMessageSnapshot(
        channel,
        readbackMessageId,
        messageId,
        chunkIds,
      );
      const repairVisible = repairedSnapshot !== undefined
        && markdownReadbackMatches(repairedSnapshot.text, expected);
      log.info('stream', 'markdown-readback-repair-verified', {
        messageId,
        readbackMessageId,
        visible: repairVisible,
        ...(repairedSnapshot ? readbackLogFields(repairedSnapshot, expected) : {}),
      });
      return repairVisible;
    }
  }
  return matches;
}

async function repairStaleMarkdownCard(
  channel: LarkChannel,
  messageId: string,
  expected: string,
): Promise<boolean> {
  const tracker = getOrCreateCardkitStreamTracker(channel);
  const cardId = tracker.cardByMessageId.get(messageId);
  const updateCard = (channel.rawClient as RawClientShape).cardkit?.v1?.card?.update;
  if (!cardId || !updateCard) {
    log.warn('stream', 'markdown-readback-repair-skipped', {
      messageId,
      reason: cardId ? 'missing-card-update-api' : 'missing-card-correlation',
    });
    return false;
  }

  const sequence = (tracker.sequenceByCardId.get(cardId) ?? 0) + 1;
  const request = {
    path: { card_id: cardId },
    data: {
      card: {
        type: 'card_json',
        data: JSON.stringify(buildClosedMarkdownCard('stream_md', expected)),
      },
      sequence,
      uuid: `u_repair_${cardId}_${sequence}_${Date.now()}`,
    },
  };
  const start = Date.now();
  log.warn('stream', 'markdown-readback-repair-request', {
    messageId,
    cardId,
    sequence,
    ...textLogFields('expected', expected),
  });
  try {
    const result = await updateCard.call(
      (channel.rawClient as RawClientShape).cardkit?.v1?.card,
      request,
    );
    const resultFields = summarizeApiResult(result);
    if (numberAt(resultFields, 'code') !== 0) {
      log.warn('stream', 'markdown-readback-repair-rejected', {
        messageId,
        cardId,
        sequence,
        durationMs: Date.now() - start,
        ...resultFields,
      });
      return false;
    }
    rememberBounded(tracker.sequenceByCardId, cardId, sequence);
    log.info('stream', 'markdown-readback-repair-result', {
      messageId,
      cardId,
      sequence,
      durationMs: Date.now() - start,
      ...resultFields,
    });
    return true;
  } catch (err) {
    log.fail('stream', err, {
      step: 'markdown-readback-repair',
      messageId,
      cardId,
      sequence,
      durationMs: Date.now() - start,
    });
    return false;
  }
}

interface MarkdownReadbackSnapshot {
  text: string;
  messageType?: string;
  createTime?: string;
  updateTime?: string;
  rawContent?: string;
}

async function readMarkdownMessageSnapshot(
  channel: LarkChannel,
  readbackMessageId: string,
  messageId: string | undefined,
  chunkIds: string[],
): Promise<MarkdownReadbackSnapshot | undefined> {
  try {
    const result = await Promise.race([
      channel.rawClient.im.v1.message.get({
        path: { message_id: readbackMessageId },
        params: { card_msg_content_type: 'user_card_content' },
      }),
      delay(FINAL_READBACK_TIMEOUT_MS).then(() => READBACK_TIMEOUT),
    ]);
    if (result === READBACK_TIMEOUT) {
      log.warn('stream', 'markdown-readback-timeout', {
        messageId,
        readbackMessageId,
        timeoutMs: FINAL_READBACK_TIMEOUT_MS,
        didRollover: chunkIds.length > 0,
        chunkIds,
      });
      return undefined;
    }
    const item = firstMessageItem(result);
    const text = extractMessageText(result);
    if (text === undefined) {
      log.warn('stream', 'markdown-readback-unsupported-content', {
        messageId,
        readbackMessageId,
        didRollover: chunkIds.length > 0,
        chunkIds,
        ...messageItemMetadata(item),
      });
      return undefined;
    }
    return {
      text,
      ...messageItemMetadata(item),
    };
  } catch (err) {
    log.fail('stream', err, {
      step: 'markdown-readback',
      messageId,
      readbackMessageId,
      didRollover: chunkIds.length > 0,
      chunkIds,
    });
    return undefined;
  }
}

const READBACK_TIMEOUT = Symbol('readback-timeout');

function streamMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const messageId = (value as { messageId?: unknown }).messageId;
  return typeof messageId === 'string' ? messageId : undefined;
}

function streamChunkIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const chunkIds = (value as { chunkIds?: unknown }).chunkIds;
  return Array.isArray(chunkIds)
    ? chunkIds.filter((chunkId): chunkId is string => typeof chunkId === 'string')
    : [];
}

function streamReadbackMessageId(
  messageId: string | undefined,
  chunkIds: string[],
): string | undefined {
  return chunkIds.at(-1) ?? messageId;
}

function isLikelyUntrackedMarkdownRollover(expected: string, chunkIds: string[]): boolean {
  return chunkIds.length === 0 && expected.length > MARKDOWN_STREAM_MAX_ELEMENT_CHARS;
}

function readbackLogFields(
  snapshot: MarkdownReadbackSnapshot,
  expected: string,
): Record<string, unknown> {
  const expectedTail = tailForLog(normalizeReadbackText(expected));
  const normalizedLive = normalizeReadbackText(snapshot.text);
  return {
    messageType: snapshot.messageType,
    createTime: snapshot.createTime,
    updateTime: snapshot.updateTime,
    expectedTailPresent: expectedTail ? normalizedLive.includes(expectedTail) : true,
    liveHasRunningFooter: hasRunningFooter(snapshot.text),
    ...textLogFields('live', snapshot.text),
    ...textLogFields('expected', expected),
    ...textLogFields('rawContent', snapshot.rawContent),
  };
}

function firstMessageItem(value: unknown): Record<string, unknown> | undefined {
  const item = (
    value as
      | { data?: { items?: Array<Record<string, unknown>> } }
      | undefined
  )?.data?.items?.[0];
  return item && typeof item === 'object' ? item : undefined;
}

function messageItemMetadata(item: Record<string, unknown> | undefined): Omit<MarkdownReadbackSnapshot, 'text'> {
  if (!item) return {};
  const content = messageItemRawContent(item);
  return {
    messageType: typeof item.message_type === 'string' ? item.message_type : undefined,
    createTime: typeof item.create_time === 'string' ? item.create_time : undefined,
    updateTime: typeof item.update_time === 'string' ? item.update_time : undefined,
    rawContent: typeof content === 'string' ? content : undefined,
  };
}

function extractMessageText(value: unknown): string | undefined {
  const item = firstMessageItem(value);
  const content = item ? messageItemRawContent(item) : undefined;
  if (typeof content !== 'string') return undefined;
  const parsed = parseJson(content);
  if (isUnsupportedInteractiveCardContent(parsed)) return undefined;
  const extracted = parsed === undefined ? '' : collectText(parsed).join('\n');
  const text = `${content}\n${extracted}`.trim();
  return text || undefined;
}

function messageItemRawContent(item: Record<string, unknown>): unknown {
  const body = item.body;
  return item.content ?? (body && typeof body === 'object'
    ? (body as { content?: unknown }).content
    : undefined);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function collectText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectText);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectText);
}

function isUnsupportedInteractiveCardContent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'card') return true;
  if (typeof record.card_id === 'string') return true;
  const data = record.data;
  if (data && typeof data === 'object' && typeof (data as { card_id?: unknown }).card_id === 'string') {
    return true;
  }
  return isDowngradedInteractiveCard(value);
}

function isDowngradedInteractiveCard(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.schema === '2.0' || record.body !== undefined) return false;
  if (!('elements' in record)) return false;
  return collectText(value).some((text) => text.includes('请升级至最新版本客户端，以查看内容'));
}

function markdownReadbackMatches(live: string, expected: string): boolean {
  const expectedTail = tailForLog(normalizeReadbackText(expected));
  if (!expectedTail) return true;
  return normalizeReadbackText(live).includes(expectedTail);
}

function markdownFinalAnchorPresent(live: string, expected: string): boolean {
  const paragraphs = expected
    .trim()
    .split(/\n\s*\n/)
    .map(normalizeReadbackText)
    .filter(Boolean);
  const finalParagraph = paragraphs.at(-1);
  if (!finalParagraph) return true;
  const anchor = finalParagraph.slice(-TAIL_COMPARE_CHARS);
  return normalizeReadbackText(live).includes(anchor);
}

function textLogFields(prefix: string, value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  return {
    [`${prefix}Chars`]: value.length,
    [`${prefix}Hash`]: textHash(value),
    [`${prefix}HasRunningFooter`]: hasRunningFooter(value),
    [`${prefix}Tail`]: tailForLog(value),
  };
}

function textHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, STREAM_HASH_HEX_CHARS);
}

function tailForLog(value: string): string {
  return value.slice(-TAIL_COMPARE_CHARS);
}

function normalizeReadbackText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

async function runFallbackReply(
  mode: 'card' | 'markdown',
  state: RunState,
  fallback: (state: RunState) => Promise<void>,
): Promise<void> {
  try {
    await fallback(state);
  } catch (err) {
    log.fail('stream', err, { mode, step: 'fallback' });
  }
}

function scheduleWorkingReactionCleanup(
  channel: LarkChannel,
  messageId: string,
  reactionPromise: Promise<string | undefined> | undefined,
): void {
  if (!reactionPromise) return;

  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true as const, reactionId }),
      (err) => ({ ok: false as const, err }),
    );
    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => undefined),
    ]);

    if (!settled) {
      log.warn('reaction', 'cleanup-deferred', {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS,
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;
        void removeReaction(channel, messageId, result.reactionId);
      });
      return;
    }

    if (!settled.ok || !settled.reactionId) return;
    await removeReaction(channel, messageId, settled.reactionId);
  })();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  topicContext: QuotedContext[] = [],
  botIdentity?: { openId: string; name?: string },
  extraInstructions?: string[],
  reactionContexts?: unknown[],
): string {
  const first = batch[0];
  if (!first) return '';

  // Detect reaction batch: rawContentType === 'reaction' on first message
  const isReactionBatch = first.rawContentType === ('reaction' as never);

  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  // When the debounce window merged messages (possibly from several senders —
  // common in bot-at-bot group chats), annotate each segment with its sender
  // so the agent can tell who said what. Single-message batches stay verbatim.
  const annotate = batch.length > 1;
  const texts = batch
    .map((m) => {
      const text = stripAttachmentRefs(m.content, fileKeys).trim();
      if (!text) return '';
      return annotate ? `${senderAnnotation(m)} ${text}` : text;
    })
    .filter(Boolean);
  const userPart =
    texts.length > 0
      ? texts.join('\n\n')
      : attachments.length > 0
        ? '请看下面的附件。'
        : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  const senderType = senderTypeOf(first);
  const mentions = mergeMentions(batch);

  return buildAgentPrompt({
    context: {
      chatId: first.chatId,
      chatType: first.chatType,
      senderId: first.senderId,
      ...(first.senderName ? { senderName: first.senderName } : {}),
      ...(senderType ? { senderType } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(first.threadId ? { threadId: first.threadId } : {}),
      messageIds: batch.map((m) => m.messageId),
      source: isReactionBatch ? 'reaction' : 'im',
    },
    instructions:
      extraInstructions && extraInstructions.length > 0
        ? [...BRIDGE_AGENT_INSTRUCTIONS, ...extraInstructions]
        : BRIDGE_AGENT_INSTRUCTIONS,
    userInput: userPart,
    ...(topicContext.length > 0 ? { topicContext: topicContext.map(toPromptTopicMessage) } : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
    ...(reactionContexts && reactionContexts.length > 0 ? { reactionContexts } : {}),
  });
}

/**
 * Classify the sender as human or bot from the raw Feishu event
 * (`sender.sender_type`: 'user' = human, 'app' = bot). The normalizer drops
 * this field, so read it off `msg.raw` (`includeRawEvent: true` above).
 * Unknown / missing values return undefined — omit rather than guess.
 */
function senderTypeOf(msg: NormalizedMessage): 'user' | 'bot' | undefined {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  if (senderType === 'user') return 'user';
  if (senderType === 'app' || senderType === 'bot') return 'bot';
  return undefined;
}

function senderAnnotation(msg: NormalizedMessage): string {
  const name = msg.senderName ?? msg.senderId;
  const type = senderTypeOf(msg);
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: NormalizedMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];
  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }
  return out;
}

function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptTopicMessage(q: QuotedContext): BridgePromptTopicMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.senderType ? { senderType: q.senderType } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptInteractiveCard(m: NormalizedMessage): BridgePromptInteractiveCard | undefined {
  if (m.rawContentType !== 'interactive') return undefined;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return undefined;
  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent),
  };
}

function parseJsonOrRaw(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

// ── Stale pending quarantine ──────────────────────────────────────────

const STALE_PENDING_MAX_AGE_MS = 30 * 60 * 1000; // 30 min — quarantine after

export async function handleStalePendingQuarantine(
  profile: string,
  profileDir: string,
): Promise<void> {
  const pending = await readPending(profileDir);
  if (!pending) return;

  const age = Date.now() - new Date(pending.requestedAt).getTime();
  if (age < STALE_PENDING_MAX_AGE_MS) return;

  // Only quarantine if the requesting bridge is confirmed dead.
  if (isAlive(pending.oldPid)) return;

  await quarantineStalePending(profileDir, pending.receiptId);
  log.info('receipt', 'stale-pending-quarantined', {
    receiptId: pending.receiptId,
    ageMs: age,
    oldPid: pending.oldPid,
  });
}

// ── New bridge: pending receipt handler ──────────────────────────────

const ATTEMPT_LEASE_TTL_MS = 120_000; // 2 min — attempt lease validity

export async function handleNewBridgePendingReceipt(
  channel: LarkChannel,
  profile: string,
  profileDir: string,
): Promise<void> {
  const pending = await readPending(profileDir);
  if (!pending) return;

  // Verify this is a legit pending request: oldPid must be a prior bridge.
  if (pending.oldPid === process.pid) {
    log.info('receipt', 'skip-self-pending', { receiptId: pending.receiptId });
    return;
  }

  // oldPid should be dead (this is a new bridge after restart).
  if (isAlive(pending.oldPid)) {
    log.info('receipt', 'skip-oldpid-alive', {
      receiptId: pending.receiptId,
      oldPid: pending.oldPid,
    });
    return;
  }

  // Check if already claimed
  const existingClaim = await readClaim(profileDir, pending.receiptId);
  if (existingClaim) {
    // Claim exists → recovery is responsible. Clean pending to unblock
    // future restarts; recovery will handle terminal + residue.
    await deletePending(profileDir, pending.receiptId).catch(() => {});
    log.info('receipt', 'skip-already-claimed', { receiptId: pending.receiptId });
    return;
  }

  // Check terminal
  const existingTerminal = await readTerminal(profileDir, pending.receiptId);
  if (existingTerminal) {
    // Terminal already set — clean up pending
    await deletePending(profileDir, pending.receiptId).catch(() => {});
    await cleanupReceiptArtifacts(profileDir, pending.receiptId).catch(() => {});
    return;
  }

  const kind: ReceiptKind = 'success';
  const uuid = makeClaimUuid(pending.receiptId, kind);

  // Primitive A: claim (immutable)
  const claimed = await createClaim(profileDir, {
    receiptId: pending.receiptId,
    kind,
    payload: pending.returnRoute,
    uuid,
    claimedAt: new Date().toISOString(),
  });
  if (!claimed) {
    log.info('receipt', 'claim-eeexist', { receiptId: pending.receiptId });
    return;
  }

  // Primitive A: attempt lease
  const attempted = await createAttempt(profileDir, {
    receiptId: pending.receiptId,
    ownerPid: process.pid,
    attemptedAt: new Date().toISOString(),
  });
  if (!attempted) {
    log.info('receipt', 'attempt-eeexist', { receiptId: pending.receiptId });
    return;
  }

  // Primitive C: delete pending (verified)
  await deletePending(profileDir, pending.receiptId);

  // Read terminal one more time before sending (defense-in-depth)
  if (await readTerminal(profileDir, pending.receiptId)) {
    await cleanupReceiptArtifacts(profileDir, pending.receiptId).catch(() => {});
    return;
  }

  // Send success receipt
  const result = await sendRestartReceiptViaChannel(channel, {
    profile,
    returnRoute: pending.returnRoute,
    receiptId: pending.receiptId,
    kind,
    uuid,
    newPid: process.pid,
    deployRevision: pending.deployRevision,
  });

  if (result.ok && result.messageId) {
    // Primitive A: terminal(completed)
    await createTerminal(profileDir, {
      receiptId: pending.receiptId,
      kind,
      outcome: 'completed',
      messageId: result.messageId,
    });
    log.info('receipt', 'sent-success', {
      receiptId: pending.receiptId,
      messageId: result.messageId,
    });
  } else {
    // Deterministic failure
    await createTerminal(profileDir, {
      receiptId: pending.receiptId,
      kind,
      outcome: 'delivery-failed',
      reason: 'receipt-delivery-failure',
    });
    log.warn('receipt', 'delivery-failed', { receiptId: pending.receiptId });
  }

  // Clean up claim + attempt
  await cleanupReceiptArtifacts(profileDir, pending.receiptId).catch(() => {});
}

// ── Recovery: scan claim.* without terminal, attempt takeover ─────────

export async function handleReceiptRecovery(
  channel: LarkChannel,
  profile: string,
  profileDir: string,
  deps?: {
    sendReceipt?: (params: import('../runtime/restart-receipt-sender').ReceiptSendParams) =>
      Promise<import('../runtime/restart-receipt-sender').ReceiptSendResult>;
  },
): Promise<void> {
  const sendReceipt = deps?.sendReceipt ??
    ((params) => sendRestartReceiptViaChannel(channel, params));

  const scans = await scanReceipts(profileDir);
  for (const scan of scans) {
    if (scan.hasTerminal) {
      // Terminal exists — clean all residue including pending (which
      // may have been left behind if claimer crashed after claim/attempt
      // but before deletePending).
      await deletePending(profileDir, scan.receiptId).catch(() => {});
      await cleanupReceiptArtifacts(profileDir, scan.receiptId).catch(() => {});
      continue;
    }
    if (!scan.hasClaim) continue;

    // claim exists, no terminal — recovery needed
    const claim = await readClaim(profileDir, scan.receiptId);
    if (!claim) continue;

    // Check attempt lease
    const attempt = await readAttempt(profileDir, scan.receiptId);
    if (attempt) {
      // Attempt exists — check strict-AND takeover conditions
      const ttlExpired =
        Date.now() - new Date(attempt.attemptedAt).getTime() > ATTEMPT_LEASE_TTL_MS;
      const ownerDead = !isAlive(attempt.ownerPid);

      if (!ttlExpired || !ownerDead) {
        // Cannot take over — both conditions must be satisfied
        log.info('receipt', 'recovery-attempt-not-takeover', {
          receiptId: scan.receiptId,
          ttlExpired,
          ownerDead,
        });
        continue;
      }

      // Delete stale attempt (primitive C)
      await deleteAttempt(profileDir, scan.receiptId).catch(() => {});
    }

    // Try to take over attempt
    const taken = await createAttempt(profileDir, {
      receiptId: scan.receiptId,
      ownerPid: process.pid,
      attemptedAt: new Date().toISOString(),
    });
    if (!taken) {
      log.info('receipt', 'recovery-attempt-eeexist', { receiptId: scan.receiptId });
      continue;
    }

    // Read terminal again (defense-in-depth)
    if (await readTerminal(profileDir, scan.receiptId)) {
      await cleanupReceiptArtifacts(profileDir, scan.receiptId).catch(() => {});
      continue;
    }

    // Re-send with same kind+uuid (immutable claim → no flip)
    const result = await sendReceipt({
      profile,
      returnRoute: claim.payload,
      receiptId: claim.receiptId,
      kind: claim.kind,
      uuid: claim.uuid,
    });

    if (result.ok && result.messageId) {
      await createTerminal(profileDir, {
        receiptId: claim.receiptId,
        kind: claim.kind,
        outcome: 'completed',
        messageId: result.messageId,
      });
      log.info('receipt', 'recovery-sent', {
        receiptId: claim.receiptId,
        kind: claim.kind,
        messageId: result.messageId,
      });
    } else {
      await createTerminal(profileDir, {
        receiptId: claim.receiptId,
        kind: claim.kind,
        outcome: 'delivery-failed',
        reason: 'receipt-delivery-failure',
      });
    }

    // Clean pending, claim, and attempt after terminal resolution.
    // Pending may still exist if the original claimer crashed after
    // claim/attempt but before deletePending.
    await deletePending(profileDir, scan.receiptId).catch(() => {});
    await cleanupReceiptArtifacts(profileDir, scan.receiptId).catch(() => {});
  }
}
