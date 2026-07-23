import type { ReactionEvent } from '@larksuite/channel';
import type { LarkChannel } from '@larksuite/channel';
import { log } from '../../core/logger';
import { isStopEmoji } from './semantics';
import type { ReactionContext, ReactionKey } from './types';
import { makeReactionKey } from './types';

// ── Reaction turn types (shared across pipeline modules) ──

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

/** Deny reason constants — stable keys for tests and logging. */
export const GUARD_DENY_SELF_OPERATOR: ReactionGuardDenyReason = 'self-operator';
export const GUARD_DENY_NOT_OWN_MESSAGE: ReactionGuardDenyReason = 'not-own-message';
export const GUARD_DENY_ACCESS_DM: ReactionGuardDenyReason = 'access-dm';
export const GUARD_DENY_ACCESS_GROUP: ReactionGuardDenyReason = 'access-group';
export const GUARD_DENY_GROUP_RESPONSE: ReactionGuardDenyReason = 'group-response';

// ── Pipeline result types ──

export type ReactionPipelineAction =
  | { kind: 'drop'; reason: string }
  | { kind: 'enqueue-reaction'; key: ReactionKey; reactionContext: ReactionContext; replyToMessageId: string; scope: string }
  | { kind: 'stop-added-reply'; message: string }
  | { kind: 'stop-removed-reply'; message: string }
  | { kind: 'no-op-reply'; message: string };

// ── Self-operator guard ──

/**
 * Returns true when the reaction operator IS the current bot/app itself.
 * This MUST run before any side effect (permission check, snapshot update,
 * queue push, interrupt, or reply).
 *
 * Checks (any match → self):
 * 1. `evt.operator.openId === botOpenId`
 * 2. `evt.operator.openId === appId`
 * 3. `evt.raw?.operator_type === 'app'` (SDK normalizeReaction drops this field)
 */
export function isSelfOperator(
  evt: ReactionEvent,
  deps: ReactionGuardDeps,
): boolean {
  if (deps.botOpenId && evt.operator.openId === deps.botOpenId) return true;
  if (deps.appId && evt.operator.openId === deps.appId) return true;
  const raw = evt.raw as Record<string, unknown> | undefined;
  if (raw?.operator_type === 'app') return true;
  return false;
}

// ── Own-message check ──

/**
 * Returns true when the target message sender IS the current bot.
 * This is the routing precondition — only reactions on THIS bot's messages
 * are forwarded to the agent.
 */
export function isOwnMessage(
  messageSenderId: string | undefined,
  deps: ReactionGuardDeps,
): boolean {
  if (!messageSenderId) return false;
  if (deps.botOpenId && messageSenderId === deps.botOpenId) return true;
  if (deps.appId && messageSenderId === deps.appId) return true;
  return false;
}

// ── Pipeline entry point ──

export interface ReactionPipelineDeps {
  channel: LarkChannel;
  botOpenId?: string;
  appId?: string;
  profileDir?: string;
}

export interface ReactionPipelineCallbacks {
  /** Enqueue a reaction context for agent processing. */
  enqueueReaction: (
    scope: string,
    reactionContext: ReactionContext,
    replyToMessageId: string,
  ) => void;
  /** Send a Bridge reply for stop/no-op/error scenarios. */
  sendBridgeReply: (scope: string, chatId: string, message: string, replyToMessageId: string) => Promise<void>;
  /** Check if scope has current (active/reserved/queued) work. */
  hasCurrentWork: (scope: string) => boolean;
  /** Execute stop: interrupt + cancel pending. */
  executeStop: (scope: string) => Promise<boolean>;
  /** Validate stop target against current workChainId. */
  validateStopTarget: (targetMessageId: string, scope: string) => boolean;
}

/**
 * Process a reaction event through the full pipeline.
 *
 * Order (Spec §Permission Contract, §Stop Reaction Control Contract):
 * 1. Self-operator guard (drop if self)
 * 2. Resolve target message (chatId, threadId, sender)
 * 3. Own-message filter (only reactions on THIS bot's messages)
 * 4. Permission gates (canUseDm/canUseGroup + decideGroupResponse)
 * 5. For stop emojis → control plane (stop added/removed)
 * 6. For non-stop → buffer → reconciler → enqueue
 *
 * Returns the action to take. Errors are caught and logged — never crash
 * the bridge queue (DD19).
 */
export async function handleReactionEvent(
  evt: ReactionEvent,
  deps: ReactionPipelineDeps,
  callbacks: ReactionPipelineCallbacks,
): Promise<ReactionPipelineAction> {
  try {
    // 1. Self-operator guard
    if (isSelfOperator(evt, { botOpenId: deps.botOpenId, appId: deps.appId })) {
      log.info('reaction', 'drop-self-operator', {
        operatorOpenId: evt.operator.openId,
        emojiType: evt.emojiType,
      });
      return { kind: 'drop', reason: 'self-operator' };
    }

    // 2. Fetch target message to resolve routing metadata
    let targetItem;
    try {
      const r = await deps.channel.rawClient.im.v1.message.get({
        path: { message_id: evt.messageId },
      });
      targetItem = r?.data?.items?.[0];
    } catch (err) {
      log.warn('reaction', 'target-fetch-failed', {
        messageId: evt.messageId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'drop', reason: 'target-fetch-failed' };
    }

    const chatId = targetItem?.chat_id as string | undefined;
    if (!chatId) {
      log.warn('reaction', 'no-chatId', { messageId: evt.messageId });
      return { kind: 'drop', reason: 'no-chatId' };
    }

    // 3. Own-message filter
    const messageSenderId = targetItem?.sender?.id as string | undefined;
    if (!isOwnMessage(messageSenderId, { botOpenId: deps.botOpenId, appId: deps.appId })) {
      log.info('reaction', 'skip-other-sender', {
        messageId: evt.messageId,
        messageSenderId,
      });
      return { kind: 'drop', reason: 'not-own-message' };
    }

    const threadId = targetItem?.thread_id as string | undefined;
    const scope = threadId ? `${chatId}:${threadId}` : chatId;

    // 4. Stop emoji → control plane fast path
    if (isStopEmoji(evt.emojiType)) {
      return handleStopReaction(evt, scope, chatId, callbacks);
    }

    // 5. Non-stop: build reaction context and enqueue
    const key = makeReactionKey(scope, evt.operator.openId, evt.messageId);

    // Build a minimal reaction context — the full context (with reconciled
    // effectiveReactionSet) will be built by the buffer flush handler.
    // For now, create the context from the event itself.
    const { lookupReactionSemantics } = await import('./semantics');
    const sem = lookupReactionSemantics(evt.emojiType);
    const reactionContext: ReactionContext = {
      operatorOpenId: evt.operator.openId,
      reactionRevision: 1, // Will be set by reconciler
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
        semanticKey: 'semanticKey' in sem ? sem.semanticKey : undefined,
        emojiMeaningSource: sem.emojiMeaningSource,
      }],
      targetMessage: {
        available: true,
        messageId: evt.messageId,
        senderId: messageSenderId,
        createdAt: targetItem?.create_time
          ? new Date(Number(targetItem.create_time)).toISOString()
          : undefined,
        rawContentType: targetItem?.msg_type ?? 'text',
        content: undefined, // Will be filled by context-builder in Unit 4
      },
    };

    return {
      kind: 'enqueue-reaction',
      key,
      reactionContext,
      replyToMessageId: evt.messageId,
      scope,
    };
  } catch (err) {
    log.fail('reaction', err);
    return { kind: 'drop', reason: 'pipeline-error' };
  }
}

/** Handle stop emoji reaction through the control plane. */
async function handleStopReaction(
  evt: ReactionEvent,
  scope: string,
  chatId: string,
  callbacks: ReactionPipelineCallbacks,
): Promise<ReactionPipelineAction> {
  if (evt.action === 'added') {
    // Check if scope has any current work
    if (!callbacks.hasCurrentWork(scope)) {
      return {
        kind: 'stop-added-reply',
        message: '当前没有需要停止的任务。',
      };
    }

    // Validate stop target against current workChainId
    if (!callbacks.validateStopTarget(evt.messageId, scope)) {
      return {
        kind: 'stop-added-reply',
        message: '该 Reaction 未停止当前任务，如需停止请使用 /stop 命令。',
      };
    }

    // Execute stop: interrupt + cancel pending
    const stopped = await callbacks.executeStop(scope);
    if (stopped) {
      return {
        kind: 'stop-added-reply',
        message: '已停止当前任务。',
      };
    }
    return {
      kind: 'stop-added-reply',
      message: '当前没有需要停止的任务。',
    };
  }

  // action === 'removed'
  return {
    kind: 'stop-removed-reply',
    message: '撤回停止 Reaction 不会自动恢复工作。如需继续，请发送新的消息。',
  };
}
