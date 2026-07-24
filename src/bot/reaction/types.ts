import type { ReactionSemanticResult } from './semantics';

// ── Reaction context (Spec §Agent Input Contract 2) ──

export interface ReactionTriggerEntry {
  action: 'added' | 'removed';
  emojiType: string;
  emojiDisplay?: string;
  emojiMeaning?: string;
  semanticKey?: string;
  emojiMeaningSource: 'predefined' | 'unmapped';
  actionTime: number;
}

export interface EffectiveReactionEntry {
  emojiType: string;
  emojiDisplay?: string;
  emojiMeaning?: string;
  semanticKey?: string;
  emojiMeaningSource: 'predefined' | 'unmapped';
}

export interface ReactionTargetMessage {
  available: boolean;
  messageId: string;
  senderId?: string;
  senderName?: string;
  createdAt?: string;
  rawContentType?: string;
  content?: string;
}

export interface ReactionContext {
  operatorOpenId: string;
  reactionRevision: number;
  triggerReactions: ReactionTriggerEntry[];
  effectiveReactionSet: EffectiveReactionEntry[];
  targetMessage: ReactionTargetMessage;
}

// ── Internal pipeline types ──

export type ReactionKey = string; // `${scope}\x1f${operatorOpenId}\x1f${targetMessageId}`

export interface BufferedReactionEvent {
  action: 'added' | 'removed';
  emojiType: string;
  actionTime: number;
  arrivalOrder: number;
  semantics: ReactionSemanticResult;
}

export interface ReactionKeyComponents {
  scope: string;
  operatorOpenId: string;
  targetMessageId: string;
}

export const REACTION_KEY_SEPARATOR = '\x1f';

export function makeReactionKey(
  scope: string,
  operatorOpenId: string,
  targetMessageId: string,
): ReactionKey {
  return [scope, operatorOpenId, targetMessageId].join(REACTION_KEY_SEPARATOR);
}

export function parseReactionKey(key: ReactionKey): ReactionKeyComponents {
  const [scope, operatorOpenId, targetMessageId] = key.split(REACTION_KEY_SEPARATOR);
  if (!scope || !operatorOpenId || !targetMessageId) {
    throw new Error(`invalid reaction key: ${key}`);
  }
  return { scope, operatorOpenId, targetMessageId };
}

// ── Canonical fingerprint ──

/**
 * Fields used to compute a canonical fingerprint for the effective reaction set.
 * Fields: operator_type, operator_id, emoji_type.
 * Sorted by operator_id then emoji_type (case-sensitive).
 * `reaction_id` is only used for dedup, NOT as a sort key.
 */
export interface CanonicalReactionRecord {
  operator_type: string; // 'app' | 'user'
  operator_id: string;
  emoji_type: string;
  reaction_id?: string;
}

// ── Ledger record ──

export interface ReactionLedgerEntry {
  /** Canonical fingerprint of the last confirmed effectiveReactionSet. */
  fingerprint: string;
  /** Fingerprint that was last consumed (produced an Agent turn or Bridge reply). */
  consumedFingerprint: string;
  /** Latest action time among records in the confirmed set. */
  latestActionTime: number;
  /** Record IDs from messageReaction.list (for dedup, not sort). */
  recordIds: string[];
  /** Monotonically increasing revision (runtime, not durable across restarts). */
  lastRevision: number;
}

// ── Buffer result after flush + reconciliation ──

export interface ReconciliationResult {
  key: ReactionKey;
  components: ReactionKeyComponents;
  /** What changed in this round — ordered triggerReactions. */
  triggerReactions: ReactionTriggerEntry[];
  /** Current authoritative effective set after reconciliation. */
  effectiveReactionSet: EffectiveReactionEntry[];
  /** new revision (ledger.lastRevision + 1 if fingerprint changed, else same). */
  revision: number;
  /** Canonical fingerprint of the current effective set. */
  fingerprint: string;
  /** Net-zero added→removed exception: events consumed as withdrawal confirmation. */
  netZeroConsumed: boolean;
  /** Reconciliation failed and we replied with error. */
  reconciliationFailed: boolean;
  /** No state change at all (fingerprint unchanged, no net-zero pair). */
  noOp: boolean;
}
