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
      kind: 'buffer-reaction';
      key: ReactionKey;
      scope: string;
      chatId: string;
      chatType: 'p2p' | 'group';
      threadId?: string;
      operatorOpenId: string;
      targetMessageId: string;
      normalizedMsg: NormalizedMessage;
      workChainId: string;
    }
  | { kind: 'stop-added-reply'; scope: string; chatId: string; message: string; targetClass: 'bot' | 'user'; targetMessageId: string; operatorOpenId: string; emojiType: string; actionTime?: number; stableId?: string }
  | { kind: 'stop-removed-reply'; scope: string; chatId: string; message: string; targetClass: 'bot' | 'user'; targetMessageId: string; operatorOpenId: string; emojiType: string; actionTime?: number; stableId?: string };

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
  /** Resolve chatMode/chatType for a chatId (F2: no oc_/ou_ guessing). */
  resolveChatMode: (chatId: string) => Promise<'p2p' | 'group' | 'topic'>;
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

// ── Pipeline entry point ──

/**
 * Guards pipeline for a reaction event:
 * self-operator → route/sender classification → stop/non-stop split.
 * Non-stop requires own-message before Reaction permission; stop applies
 * Reaction permission before its target eligibility is resolved by the caller.
 *
 * This does NOT do reconciliation — that's handled by the buffer's flush
 * handler which calls messageReaction.list → reconciler → ledger.
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

    // 3. Target sender classification + stop/non-stop split.
    const messageSenderId = item?.sender?.id as string | undefined;
    const ownMessage = isOwnMessage(
      messageSenderId,
      { botOpenId: deps.botOpenId, appId: deps.appId },
    );
    const stopEmoji = isStopEmoji(evt.emojiType);
    const senderType = item?.sender?.sender_type as string | undefined;

    // Ordinary Reaction semantics remain Bot-message only and are rejected
    // before permission/snapshot work.
    if (!stopEmoji && !ownMessage) {
      log.info('reaction', 'skip-other-sender', { messageId: evt.messageId, messageSenderId });
      return { kind: 'drop', reason: 'not-own-message' };
    }

    // Stop may additionally target a real inbound user message. Other bots,
    // unknown sender classes, and synthetic messages are not stop targets.
    const targetClass: 'bot' | 'user' | undefined = ownMessage
      ? 'bot'
      : senderType === 'user'
        ? 'user'
        : undefined;
    if (stopEmoji && !targetClass) {
      log.info('reaction', 'skip-unsupported-stop-target', {
        messageId: evt.messageId,
        messageSenderId,
        senderType,
      });
      return { kind: 'drop', reason: 'unsupported-stop-target' };
    }

    // 4. Resolve chatMode (F2: use channel's chatModeCache, not oc_/ou_ prefix guessing)
    const chatMode = await callbacks.resolveChatMode(chatId);
    const threadId = item?.thread_id as string | undefined;
    // A converted topic group may still resolve as `group` from chat info
    // while the message itself already carries thread_id. Match ordinary
    // intake: thread_id is authoritative for topic scope isolation.
    const effectiveChatMode = threadId ? 'topic' : chatMode;
    const scope = (effectiveChatMode === 'topic' && threadId) ? `${chatId}:${threadId}` : chatId;
    const chatType: 'p2p' | 'group' = chatMode === 'p2p' ? 'p2p' : 'group';

    // 5. Permission gates (F2): access control + group response
    const accessResult = callbacks.checkAccess(chatType, chatId, evt.operator.openId);
    if (!accessResult.ok) {
      log.info('reaction', 'deny-access', { scope, operator: evt.operator.openId.slice(-6), reason: accessResult.reason });
      return { kind: 'drop', reason: `access-${accessResult.reason}` };
    }

    if (chatType === 'group' || effectiveChatMode === 'topic') {
      const groupRespResult = callbacks.checkGroupResponse(chatType, chatId, evt.operator.openId);
      if (!groupRespResult.accept) {
        log.info('reaction', 'deny-group-response', { scope, operator: evt.operator.openId.slice(-6), reason: groupRespResult.reason });
        return { kind: 'drop', reason: 'group-response' };
      }
    }

    // 6. Stop emoji → control plane fast path (return event info so caller can persist)
    if (stopEmoji) {
      const rawHeader = (evt.raw as Record<string, unknown> | undefined)?.['header'] as Record<string, unknown> | undefined;
      if (evt.action === 'added') {
        return {
          kind: 'stop-added-reply',
          scope, chatId, targetMessageId: evt.messageId,
          targetClass: targetClass!,
          message: '', // caller fills based on hasCurrentWork/validateStopTarget
          operatorOpenId: evt.operator.openId, emojiType: evt.emojiType,
          actionTime: evt.actionTime, stableId: rawHeader?.['event_id'] as string | undefined,
        };
      }
      return {
        kind: 'stop-removed-reply',
        scope, chatId, targetMessageId: evt.messageId,
        targetClass: targetClass!,
        message: '', // caller fills
        operatorOpenId: evt.operator.openId, emojiType: evt.emojiType,
        actionTime: evt.actionTime, stableId: rawHeader?.['event_id'] as string | undefined,
      };
    }

    // 7. Non-stop: build NormalizedMessage and buffer key → enqueue via buffer
    const key = makeReactionKey(scope, evt.operator.openId, evt.messageId);
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
      kind: 'buffer-reaction',
      key, scope, chatId, chatType, threadId,
      operatorOpenId: evt.operator.openId,
      targetMessageId: evt.messageId,
      normalizedMsg,
      workChainId,
    };
  } catch (err) {
    log.fail('reaction', err);
    return { kind: 'drop', reason: 'pipeline-error' };
  }
}
