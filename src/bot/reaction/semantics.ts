import { DEFAULT_REACTION_POLICY, type ReactionBehavior, type ReactionPolicy } from './policy';

/** Emoji bindings and their meaning live in JSON; code only implements behaviors. */
export const SEMANTICS_SCHEMA_VERSION = 3;

export interface ReactionSemanticEntry {
  emojiType: string;
  emojiDisplay: string;
  emojiMeaning: string;
  semanticKey: string;
  behavior: ReactionBehavior;
  emojiMeaningSource: 'predefined';
}

export interface UnmappedReactionEntry {
  emojiType: string;
  emojiDisplay?: string;
  emojiMeaningSource: 'unmapped';
  semanticKey?: undefined;
  behavior?: undefined;
}

export type ReactionSemanticResult = ReactionSemanticEntry | UnmappedReactionEntry;

export function reactionBehavior(
  emojiType: string,
  policy: ReactionPolicy = DEFAULT_REACTION_POLICY,
): ReactionBehavior | undefined {
  return Object.hasOwn(policy.rules, emojiType) ? policy.rules[emojiType]?.behavior : undefined;
}

export function isPassiveReaction(emojiType: string, policy?: ReactionPolicy): boolean {
  return reactionBehavior(emojiType, policy) === 'passive';
}

export function isContinuationReaction(emojiType: string, policy?: ReactionPolicy): boolean {
  return reactionBehavior(emojiType, policy) === 'continue';
}

export function isRestartEmoji(emojiType: string, policy?: ReactionPolicy): boolean {
  return reactionBehavior(emojiType, policy) === 'restart';
}

export function isEditedMessageRestartReaction(input: {
  emojiType: string;
  action: 'added' | 'removed';
}, policy?: ReactionPolicy): boolean {
  return input.action === 'added' && isRestartEmoji(input.emojiType, policy);
}

/** Keep behavior attached to retained control signals in effective snapshots. */
export function lookupReactionSemantics(
  emojiType: string,
  policy: ReactionPolicy = DEFAULT_REACTION_POLICY,
): ReactionSemanticResult {
  const behavior = reactionBehavior(emojiType, policy);
  const rule = policy.rules[emojiType];
  if (rule && behavior && behavior !== 'passive') {
    return {
      emojiType,
      emojiDisplay: rule.emojiDisplay ?? emojiType,
      emojiMeaning: rule.emojiMeaning,
      semanticKey: rule.semanticKey,
      behavior,
      emojiMeaningSource: 'predefined',
    };
  }
  return { emojiType, emojiMeaningSource: 'unmapped' };
}

export function isPredefinedEmoji(emojiType: string, policy?: ReactionPolicy): boolean {
  return lookupReactionSemantics(emojiType, policy).emojiMeaningSource === 'predefined';
}

export function isStopEmoji(emojiType: string, policy?: ReactionPolicy): boolean {
  return reactionBehavior(emojiType, policy) === 'stop';
}

/** Default-policy exports for callers inspecting the shipped defaults, never runtime routing. */
export const SEMANTICS_TABLE: Readonly<Record<string, ReactionSemanticEntry>> = Object.freeze(
  Object.fromEntries(Object.keys(DEFAULT_REACTION_POLICY.rules)
    .map(emojiType => [emojiType, lookupReactionSemantics(emojiType)] as const)
    .filter((entry): entry is readonly [string, ReactionSemanticEntry] => entry[1].emojiMeaningSource === 'predefined')),
);
export const STOP_EMOJI_TYPES: readonly string[] = Object.freeze(
  Object.keys(DEFAULT_REACTION_POLICY.rules).filter(emoji => isStopEmoji(emoji)),
);
export const EDITED_MESSAGE_RESTART_EMOJI_TYPE = Object.keys(DEFAULT_REACTION_POLICY.rules)
  .find(emoji => isRestartEmoji(emoji))!;
