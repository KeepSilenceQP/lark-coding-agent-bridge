/**
 * Versioned, testable predefined reaction semantics table.
 *
 * v1 covers 11 emojiTypes across 4 semanticKeys as confirmed by the Spec
 * "Confirmed Predefined Semantics" table. The table is the single source of
 * truth — model runtimes MUST NOT generate predefined rules at runtime.
 *
 * emojiType values are case-sensitive and taken from the Feishu reaction emoji
 * list. Any emojiType NOT in this table is unmapped and MUST be passed through
 * to the agent with `emojiMeaningSource: 'unmapped'`.
 */

export const SEMANTICS_SCHEMA_VERSION = 1;

export interface ReactionSemanticEntry {
  emojiType: string;
  emojiDisplay: string;
  emojiMeaning: string;
  semanticKey: string;
  emojiMeaningSource: 'predefined';
}

export interface UnmappedReactionEntry {
  emojiType: string;
  emojiDisplay?: string;
  emojiMeaningSource: 'unmapped';
  semanticKey?: undefined;
}

export type ReactionSemanticResult = ReactionSemanticEntry | UnmappedReactionEntry;

/**
 * v1 predefined semantics table — strictly 11 entries.
 *
 * | semanticKey          | emojiType                             |
 * |----------------------|---------------------------------------|
 * | approve_continue     | OK, LGTM, Yes, CheckMark, JIAYI       |
 * | explain_more         | WHAT, THINKING                         |
 * | user_step_completed  | DONE                                   |
 * | stop_current_work    | No, CrossMark, MinusOne                |
 */
export const SEMANTICS_TABLE: Record<string, ReactionSemanticEntry> = {
  // ── approve_continue ──
  OK: {
    emojiType: 'OK',
    emojiDisplay: 'OK',
    emojiMeaning: '同意模型提出的意见或下一步，继续执行',
    semanticKey: 'approve_continue',
    emojiMeaningSource: 'predefined',
  },
  LGTM: {
    emojiType: 'LGTM',
    emojiDisplay: 'LGTM',
    emojiMeaning: '同意模型提出的意见或下一步，继续执行',
    semanticKey: 'approve_continue',
    emojiMeaningSource: 'predefined',
  },
  Yes: {
    emojiType: 'Yes',
    emojiDisplay: 'Yes',
    emojiMeaning: '同意模型提出的意见或下一步，继续执行',
    semanticKey: 'approve_continue',
    emojiMeaningSource: 'predefined',
  },
  CheckMark: {
    emojiType: 'CheckMark',
    emojiDisplay: '✓',
    emojiMeaning: '同意模型提出的意见或下一步，继续执行',
    semanticKey: 'approve_continue',
    emojiMeaningSource: 'predefined',
  },
  JIAYI: {
    emojiType: 'JIAYI',
    emojiDisplay: '+1',
    emojiMeaning: '同意模型提出的意见或下一步，继续执行',
    semanticKey: 'approve_continue',
    emojiMeaningSource: 'predefined',
  },

  // ── explain_more ──
  WHAT: {
    emojiType: 'WHAT',
    emojiDisplay: '什么？',
    emojiMeaning: '没有理解模型在说什么，希望继续展开介绍',
    semanticKey: 'explain_more',
    emojiMeaningSource: 'predefined',
  },
  THINKING: {
    emojiType: 'THINKING',
    emojiDisplay: '思考',
    emojiMeaning: '没有理解模型在说什么，希望继续展开介绍',
    semanticKey: 'explain_more',
    emojiMeaningSource: 'predefined',
  },

  // ── user_step_completed ──
  DONE: {
    emojiType: 'DONE',
    emojiDisplay: '完成',
    emojiMeaning: '用户已经完成模型要求其手动完成的事情，可以继续',
    semanticKey: 'user_step_completed',
    emojiMeaningSource: 'predefined',
  },

  // ── stop_current_work ──
  No: {
    emojiType: 'No',
    emojiDisplay: 'No',
    emojiMeaning: '用户认为模型当前方向不对，希望立即停止，语义类似 /stop',
    semanticKey: 'stop_current_work',
    emojiMeaningSource: 'predefined',
  },
  CrossMark: {
    emojiType: 'CrossMark',
    emojiDisplay: '✗',
    emojiMeaning: '用户认为模型当前方向不对，希望立即停止，语义类似 /stop',
    semanticKey: 'stop_current_work',
    emojiMeaningSource: 'predefined',
  },
  MinusOne: {
    emojiType: 'MinusOne',
    emojiDisplay: '-1',
    emojiMeaning: '用户认为模型当前方向不对，希望立即停止，语义类似 /stop',
    semanticKey: 'stop_current_work',
    emojiMeaningSource: 'predefined',
  },
};

/** emojiTypes that map to stop_current_work — used by the control plane fast path. */
export const STOP_EMOJI_TYPES: readonly string[] = ['No', 'CrossMark', 'MinusOne'];

/** Look up a single emojiType. Returns predefined entry on hit, unmapped passthrough otherwise. */
export function lookupReactionSemantics(emojiType: string): ReactionSemanticResult {
  const entry = SEMANTICS_TABLE[emojiType];
  if (entry) return entry;
  return {
    emojiType,
    emojiMeaningSource: 'unmapped',
  };
}

/** True when emojiType is one of the 11 predefined entries. */
export function isPredefinedEmoji(emojiType: string): boolean {
  return emojiType in SEMANTICS_TABLE;
}

/** True when emojiType maps to stop_current_work. */
export function isStopEmoji(emojiType: string): boolean {
  return STOP_EMOJI_TYPES.includes(emojiType);
}
