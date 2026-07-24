import type { NormalizedMessage } from '@larksuite/channel';

/**
 * Internal identity for one reconciled Reaction revision.
 *
 * `NormalizedMessage.messageId` remains the real Lark `om_...` identifier so
 * every existing outbound API consumer can safely use it. The opaque turn id
 * is carried separately for queue cancellation and Reaction lifecycle maps.
 */
const REACTION_TURN_ID = Symbol('lark-channel.reaction-turn-id');

type ReactionTurnMessage = NormalizedMessage & {
  [REACTION_TURN_ID]?: string;
};

export function withReactionTurnId(
  message: NormalizedMessage,
  turnId: string,
): NormalizedMessage {
  Object.defineProperty(message, REACTION_TURN_ID, {
    value: turnId,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return message;
}

export function reactionTurnIdOf(
  message: NormalizedMessage,
): string | undefined {
  return (message as ReactionTurnMessage)[REACTION_TURN_ID];
}
