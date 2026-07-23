import type { ReactionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { log } from '../../core/logger';
import { isStopEmoji, lookupReactionSemantics } from './semantics';
import type { ReactionContext, ReactionKey } from './types';
import { makeReactionKey } from './types';

// ── Guard types ──

export interface ReactionGuardDeps {
  botOpenId?: string;
  appId?: string;
}

export type ReactionGuardDenyReason =
  | 'self-operator'
  | 'not-own-message'
  | 'access-dm'
  | 'access-group'
  | 'group-response';

export interface ReactionGuardResult {
  ok: boolean;
  reason?: ReactionGuardDenyReason;
}

export const GUARD_DENY_SELF_OPERATOR: ReactionGuardDenyReason = 'self-operator';
export const GUARD_DENY_NOT_OWN_MESSAGE: ReactionGuardDenyReason = 'not-own-message';
export const GUARD_DENY_ACCESS_DM: ReactionGuardDenyReason = 'access-dm';
export const GUARD_DENY_ACCESS_GROUP: ReactionGuardDenyReason = 'access-group';
export const GUARD_DENY_GROUP_RESPONSE: ReactionGuardDenyReason = 'group-response';

// ── Pipeline action types ──

export type ReactionPipelineAction =
  | { kind: 'drop'; reason: string }
  | {
      kind: 'enqueue-reaction';
      scope: string;
      chatId: string;
      chatType: 'p2p' | 'group';
      threadId?: string;
      operatorOpenId: string;
      targetMessageId: string;
      normalizedMsg: NormalizedMessage;
      reactionContext: ReactionContext;
      workChainId: string;
    }
  | { kind: 'stop-added-reply'; scope: string; chatId: string; message: string; targetMessageId: string }
  | { kind: 'stop-removed-reply'; scope: string; chatId: string; message: string; targetMessageId: string };

// ── Pipeline deps ──

export interface ReactionPipelineDeps {
  channel: LarkChannel;
  botOpenId?: string;
  appId?: string;
}

export interface ReactionPipelineCallbacks {
  /** Check operator access via canUseDm / canUseGroup. */
  checkAccess: (chatType: 'p2p' | 'group', chatId: string, senderId: string) => { ok: boolean; reason: string };
  /** Apply decideGroupResponse for reaction (mentionedBot=false, mentionCount=0, mentionAll=false). */
  checkGroupResponse: (chatType: string, chatId: string, senderId: string) => { accept: boolean; reason: string };
  /** Check if scope has current work (for stop control). */
  hasCurrentWork: (scope: string) => boolean;
  /** Validate stop target against current workChainId. */
  validateStopTarget: (targetMessageId: string, scope: string) => boolean;
  /** Execute stop: interrupt active run + cancel pending queue. Returns true if a run was interrupted. */
  executeStop: (scope: string) => Promise<boolean>;
  /** Allocate or inherit a workChainId for this reaction turn. */
  resolveWorkChain: (scope: string, replyToMessageId?: string) => string;
}

// ── Self-operator guard ──

export function isSelfOperator(evt: ReactionEvent, deps: ReactionGuardDeps): boolean {
  if (deps.botOpenId && evt.operator.openId === deps.botOpenId) return true;
  if (deps.appId && evt.operator.openId === deps.appId) return true;
  const raw = evt.raw as Record<string, unknown> | undefined;
  if (raw?.operator_type === 'app') return true;
  return false;
}

// ── Own-message check ──

export function isOwnMessage(messageSenderId: string | undefined, deps: ReactionGuardDeps): boolean {
  if (!messageSenderId) return false;
  if (deps.botOpenId && messageSenderId === deps.botOpenId) return true;
  if (deps.appId && messageSenderId === deps.appId) return true;
  return false;
}

// ── Route resolution ──

async function resolveRoute(channel: LarkChannel, messageId: string) {
  const r = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
  return r?.data?.items?.[0];
}

// ── Pipeline entry point (F1: production wiring) ──

/**
 * Process a reaction event through the full pipeline.
 *
 * Order (Spec §Permission Contract, §Stop Reaction Control Contract):
 * 1. Self-operator guard → drop if self
 * 2. Resolve target message routing (chatId, threadId, sender)
 * 3. Own-message filter → only reactions on THIS bot's messages
 * 4. Permission gates (F2): canUseDm/canUseGroup → decideGroupResponse
 *    (mentionedBot=false, mentionCount=0, mentionAll=false)
 * 5. For stop emojis → control plane (stop added/removed)
 * 6. For non-stop → build NormalizedMessage + ReactionContext → enqueue
 *
 * Errors are caught and logged — never crash the bridge queue (DD19).
 */
export async function handleReactionEvent(
  evt: ReactionEvent,
  deps: ReactionPipelineDeps,
  callbacks: ReactionPipelineCallbacks,
): Promise<ReactionPipelineAction> {
  try {
    // 1. Self-operator guard
    if (isSelfOperator(evt, { botOpenId: deps.botOpenId, appId: deps.appId })) {
      log.info('reaction', 'drop-self-operator', { operatorOpenId: evt.operator.openId, emojiType: evt.emojiType });
      return { kind: 'drop', reason: 'self-operator' };
    }

    // 2. Resolve target message routing
    const item = await resolveRoute(deps.channel, evt.messageId);
    const chatId = item?.chat_id as string | undefined;
    if (!chatId) {
      log.warn('reaction', 'no-chatId', { messageId: evt.messageId });
      return { kind: 'drop', reason: 'no-chatId' };
    }

    // 3. Own-message filter
    const messageSenderId = item?.sender?.id as string | undefined;
    if (!isOwnMessage(messageSenderId, { botOpenId: deps.botOpenId, appId: deps.appId })) {
      log.info('reaction', 'skip-other-sender', { messageId: evt.messageId, messageSenderId });
      return { kind: 'drop', reason: 'not-own-message' };
    }

    // Resolve scope
    const threadId = item?.thread_id as string | undefined;
    const scope = threadId ? `${chatId}:${threadId}` : chatId;

    // The caller (channel.ts) resolves chatMode and chatType.
    // We pass the raw chatId and let the caller finalize scope/chatType.
    // For now, assume chatType based on chat_id prefix (will be overridden by caller).
    // The pipeline returns scope/chatId and the caller applies final scope logic.

    // 4. Permission gates (F2): access control + group response for Reaction
    // Reaction has no structured @ → mentionedBot:false, mentionCount:0, mentionAll:false.
    // This makes Reaction equivalent to a non-@ message from the same operator.
    const accessResult = callbacks.checkAccess(
      chatId.startsWith('ou_') ? 'p2p' : 'group',
      chatId,
      evt.operator.openId,
    );
    if (!accessResult.ok) {
      log.info('reaction', 'deny-access', { scope, operator: evt.operator.openId.slice(-6), reason: accessResult.reason });
      return { kind: 'drop', reason: `access-${accessResult.reason}` };
    }

    // chatType determination — the caller provides final scope via chatMode lookup.
    // Here we use a heuristic; the caller overrides in the enqueue-reaction action.
    const chatType: 'p2p' | 'group' = chatId.startsWith('ou_') ? 'p2p' : 'group';

    const groupRespResult = callbacks.checkGroupResponse(chatType, chatId, evt.operator.openId);
    if (!groupRespResult.accept) {
      log.info('reaction', 'deny-group-response', { scope, operator: evt.operator.openId.slice(-6), reason: groupRespResult.reason });
      return { kind: 'drop', reason: 'group-response' };
    }

    // 5. Stop emoji → control plane fast path
    if (isStopEmoji(evt.emojiType)) {
      return handleStopReaction(evt, scope, chatId, callbacks);
    }

    // 6. Non-stop: build ReactionContext and NormalizedMessage for enqueue
    const sem = lookupReactionSemantics(evt.emojiType);
    const reactionContext: ReactionContext = {
      operatorOpenId: evt.operator.openId,
      reactionRevision: 1, // Updated by reconciler before agent sees it
      triggerReactions: [{
        action: evt.action,
        emojiType: evt.emojiType,
        emojiDisplay: sem.emojiDisplay,
        emojiMeaning: 'emojiMeaning' in sem ? sem.emojiMeaning : undefined,
        semanticKey: 'semanticKey' in sem ? sem.semanticKey : undefined,
        emojiMeaningSource: sem.emojiMeaningSource,
        actionTime: evt.actionTime ?? Date.now(),
      }],
      effectiveReactionSet: [{
        emojiType: evt.emojiType,
        emojiDisplay: sem.emojiDisplay,
        emojiMeaning: 'emojiMeaning' in sem ? sem.emojiMeaning : undefined,
        semanticKey: 'semanticKey' in sem ? sem.semanticKey : undefined,
        emojiMeaningSource: sem.emojiMeaningSource,
      }],
      targetMessage: {
        available: true,
        messageId: evt.messageId,
        senderId: messageSenderId,
        createdAt: item?.create_time ? new Date(Number(item.create_time)).toISOString() : undefined,
        rawContentType: item?.msg_type ?? 'text',
      },
    };

    // Resolve workChainId for this reaction (F10: inherit from target message's chain)
    const workChainId = callbacks.resolveWorkChain(scope, evt.messageId);

    // Build NormalizedMessage for PendingQueue compatibility
    const normalizedMsg: NormalizedMessage = {
      messageId: evt.messageId,
      chatId,
      chatType,
      threadId,
      senderId: evt.operator.openId,
      content: `[reaction-${evt.action}] ${evt.emojiType} (on msg ${evt.messageId.slice(-8)})`,
      rawContentType: 'reaction' as never,
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: evt.actionTime ?? Date.now(),
    };

    return {
      kind: 'enqueue-reaction',
      scope,
      chatId,
      chatType,
      threadId,
      operatorOpenId: evt.operator.openId,
      targetMessageId: evt.messageId,
      normalizedMsg,
      reactionContext,
      workChainId,
    };
  } catch (err) {
    log.fail('reaction', err);
    return { kind: 'drop', reason: 'pipeline-error' };
  }
}

// ── Stop reaction control plane handler ──

async function handleStopReaction(
  evt: ReactionEvent,
  scope: string,
  chatId: string,
  callbacks: ReactionPipelineCallbacks,
): Promise<ReactionPipelineAction> {
  if (evt.action === 'added') {
    // ①: scope has NO current work → idempotent reply
    if (!callbacks.hasCurrentWork(scope)) {
      return {
        kind: 'stop-added-reply',
        scope,
        chatId,
        message: '当前没有需要停止的任务。',
        targetMessageId: evt.messageId,
      };
    }

    // ②: scope has current work → validate target against workChainId
    if (!callbacks.validateStopTarget(evt.messageId, scope)) {
      return {
        kind: 'stop-added-reply',
        scope,
        chatId,
        message: '该 Reaction 未停止当前任务，如需停止请使用 /stop 命令。',
        targetMessageId: evt.messageId,
      };
    }

    // ③: association passed → interrupt + cancel pending (F11)
    const stopped = await callbacks.executeStop(scope);
    return {
      kind: 'stop-added-reply',
      scope,
      chatId,
      message: stopped ? '已停止当前任务。' : '当前没有需要停止的任务。',
      targetMessageId: evt.messageId,
    };
  }

  // action === 'removed': only reply if matching stop-added was consumed (F6/F7)
  return {
    kind: 'stop-removed-reply',
    scope,
    chatId,
    message: '撤回停止 Reaction 不会自动恢复工作。如需继续，请发送新的消息。',
    targetMessageId: evt.messageId,
  };
}
