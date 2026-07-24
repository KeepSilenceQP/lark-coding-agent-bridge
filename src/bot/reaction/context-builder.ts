import type { LarkChannel } from '@larksuite/channel';
import { fetchQuotedContext } from '../quote';
import { log } from '../../core/logger';
import type { ReactionTargetMessage } from './types';

// ── Two-level failure handling (Spec §Agent Input Contract 2) ──

/**
 * Build target message context for a reaction.
 *
 * Level 1 (routing): if we can't resolve chatId/threadId or target sender,
 *   returns undefined → caller drops the event entirely.
 *
 * Level 2 (content): if routing succeeds but content fetch/normalize fails,
 *   returns `{ available: false, messageId }` → agent sees unavailable marker.
 */
export async function buildReactionTargetMessage(
  channel: LarkChannel,
  targetMessageId: string,
): Promise<ReactionTargetMessage | undefined> {
  // Level 2: fetch and normalize content
  let quoted;
  try {
    quoted = await fetchQuotedContext(channel, targetMessageId);
  } catch (err) {
    log.warn('reaction', 'target-fetch-failed', {
      targetMessageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!quoted) {
    // Routing succeeded (we have the message ID) but content fetch failed.
    // Return available=false — agent must not act on target semantics.
    return {
      available: false,
      messageId: targetMessageId,
    };
  }

  return {
    available: true,
    messageId: quoted.messageId,
    senderId: quoted.senderId,
    senderName: quoted.senderName,
    createdAt: quoted.createdAt,
    rawContentType: quoted.rawContentType,
    content: quoted.content,
  };
}
