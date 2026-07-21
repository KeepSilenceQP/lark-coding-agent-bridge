import type { GroupResponseMode } from '../config/profile-schema';
import type { OwnerRefreshState } from '../policy/access';

export interface GroupResponsePolicyInput {
  chatType: string;
  mode: GroupResponseMode;
  senderId: string;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  mentionedBot: boolean;
  mentionCount: number;
  mentionAll: boolean;
  chatId: string;
  ownerNoMentionChats: string[];
}

export type GroupResponsePolicyDecision =
  | { accept: true; reason: 'p2p' | 'mentioned-bot' | 'all-messages' | 'owner-default' | 'owner-allowlist' }
  | { accept: false; reason: 'mention-required' | 'owner-default-not-eligible' | 'owner-allowlist-not-eligible' | 'owner-allowlist-chat-not-listed' };

/**
 * Decide whether a normalized IM message may enter command/pending/run intake.
 * Explicit @bot routing is intentionally evaluated before default-response
 * modes so multi-mention behavior remains exactly as it was.
 */
export function decideGroupResponse(
  input: GroupResponsePolicyInput,
): GroupResponsePolicyDecision {
  if (input.chatType === 'p2p') return { accept: true, reason: 'p2p' };
  if (input.mentionedBot) return { accept: true, reason: 'mentioned-bot' };
  if (input.mode === 'all-messages') return { accept: true, reason: 'all-messages' };
  if (input.mode === 'mention-only') return { accept: false, reason: 'mention-required' };

  const ownerEligible =
    input.ownerRefreshState === 'ok' &&
    Boolean(input.botOwnerId) &&
    input.botOwnerId === input.senderId &&
    input.mentionCount === 0 &&
    input.mentionAll === false;

  if (input.mode === 'owner-allowlist') {
    if (!ownerEligible) {
      return { accept: false, reason: 'owner-allowlist-not-eligible' };
    }
    if (!input.ownerNoMentionChats.includes(input.chatId)) {
      return { accept: false, reason: 'owner-allowlist-chat-not-listed' };
    }
    return { accept: true, reason: 'owner-allowlist' };
  }

  // owner-default
  return ownerEligible
    ? { accept: true, reason: 'owner-default' }
    : { accept: false, reason: 'owner-default-not-eligible' };
}
