import { describe, expect, it } from 'vitest';
import {
  SEMANTICS_TABLE,
  SEMANTICS_SCHEMA_VERSION,
  lookupReactionSemantics,
  isPredefinedEmoji,
  isStopEmoji,
  STOP_EMOJI_TYPES,
  EDITED_MESSAGE_RESTART_EMOJI_TYPE,
  isEditedMessageRestartReaction,
  isPassiveReaction,
} from '../../../src/bot/reaction/semantics';

// ── RED: schema version exists ──

describe('reaction semantics table', () => {
  it('has a schema version', () => {
    expect(typeof SEMANTICS_SCHEMA_VERSION).toBe('number');
    expect(SEMANTICS_SCHEMA_VERSION).toBe(2);
  });

  it('has a table export that is an object', () => {
    expect(SEMANTICS_TABLE).toBeDefined();
    expect(typeof SEMANTICS_TABLE).toBe('object');
  });

  // ── Strictly 10 actionable predefined emojiType entries ──

  it('contains strictly 10 predefined emojiType entries (v2)', () => {
    const predefined = Object.entries(SEMANTICS_TABLE).filter(
      ([, v]) => v.emojiMeaningSource === 'predefined',
    );
    expect(predefined).toHaveLength(10);
  });

  // ── approve_continue: OK, LGTM, Yes, CheckMark, JIAYI ──

  it.each([
    ['OK', 'approve_continue'],
    ['LGTM', 'approve_continue'],
    ['Yes', 'approve_continue'],
    ['CheckMark', 'approve_continue'],
    ['JIAYI', 'approve_continue'],
  ])('maps %s → approve_continue (case-sensitive)', (emojiType, semanticKey) => {
    const entry = SEMANTICS_TABLE[emojiType];
    expect(entry, `missing entry for ${emojiType}`).toBeDefined();
    if (!entry) return;
    expect(entry.semanticKey).toBe(semanticKey);
    expect(entry.emojiMeaningSource).toBe('predefined');
    expect(entry.emojiType).toBe(emojiType);
    expect(typeof entry.emojiDisplay).toBe('string');
    expect(typeof entry.emojiMeaning).toBe('string');
  });

  // ── explain_more: WHAT, THINKING ──

  it.each([
    ['WHAT', 'explain_more'],
    ['THINKING', 'explain_more'],
  ])('maps %s → explain_more (case-sensitive)', (emojiType, semanticKey) => {
    const entry = SEMANTICS_TABLE[emojiType];
    expect(entry, `missing entry for ${emojiType}`).toBeDefined();
    if (!entry) return;
    expect(entry.semanticKey).toBe(semanticKey);
    expect(entry.emojiMeaningSource).toBe('predefined');
  });

  it('reserves DONE as a passive marker outside actionable semantics', () => {
    expect(isPassiveReaction('DONE')).toBe(true);
    expect(isPassiveReaction('done')).toBe(false);
    expect(SEMANTICS_TABLE.DONE).toBeUndefined();
    expect(isPredefinedEmoji('DONE')).toBe(false);
    for (const emoji of ['CheckMark', 'GoGoGo', 'JIAYI', 'No', 'Get', 'CUSTOM_EMOJI_123']) {
      expect(isPassiveReaction(emoji)).toBe(false);
    }
  });

  // ── stop_current_work: No, CrossMark, MinusOne ──

  it.each([
    ['No', 'stop_current_work'],
    ['CrossMark', 'stop_current_work'],
    ['MinusOne', 'stop_current_work'],
  ])('maps %s → stop_current_work (case-sensitive)', (emojiType, semanticKey) => {
    const entry = SEMANTICS_TABLE[emojiType];
    expect(entry, `missing entry for ${emojiType}`).toBeDefined();
    if (!entry) return;
    expect(entry.semanticKey).toBe(semanticKey);
    expect(entry.emojiMeaningSource).toBe('predefined');
  });

  // ── Case sensitivity ──

  it('is case-sensitive (lowercase variant not found)', () => {
    expect(SEMANTICS_TABLE['ok']).toBeUndefined();
    expect(SEMANTICS_TABLE['yes']).toBeUndefined();
    expect(SEMANTICS_TABLE['done']).toBeUndefined();
    expect(SEMANTICS_TABLE['no']).toBeUndefined();
  });

  // ── Get stays unmapped ──

  it('does NOT include Get as a predefined emoji', () => {
    const entry = SEMANTICS_TABLE['Get'];
    // Get must not exist in the table at all — not even as predefined.
    expect(entry, 'Get must not be in the predefined table').toBeUndefined();
  });
});

// ── lookupReactionSemantics ──

describe('lookupReactionSemantics', () => {
  it('returns predefined entry with emojiMeaningSource=predefined for known emoji', () => {
    const result = lookupReactionSemantics('JIAYI');
    expect(result.emojiMeaningSource).toBe('predefined');
    expect(result.semanticKey).toBe('approve_continue');
    expect(result.emojiType).toBe('JIAYI');
  });

  it('returns unmapped entry for unknown emoji (passthrough, not discarded)', () => {
    const result = lookupReactionSemantics('Get');
    expect(result.emojiMeaningSource).toBe('unmapped');
    expect(result.emojiType).toBe('Get');
    // Must not be promoted to predefined
    expect(result.semanticKey).toBeUndefined();
  });

  it('returns unmapped for any arbitrary emojiType (not discarded)', () => {
    const result = lookupReactionSemantics('CUSTOM_EMOJI_123');
    expect(result.emojiMeaningSource).toBe('unmapped');
    expect(result.emojiType).toBe('CUSTOM_EMOJI_123');
  });

  it('returns unmapped for empty string (not silently dropped)', () => {
    const result = lookupReactionSemantics('');
    expect(result.emojiMeaningSource).toBe('unmapped');
  });
});

// ── Helper predicates ──

describe('isPredefinedEmoji', () => {
  it('returns true for all 10 predefined emojiTypes', () => {
    const predefined = ['OK', 'LGTM', 'Yes', 'CheckMark', 'JIAYI', 'WHAT', 'THINKING', 'No', 'CrossMark', 'MinusOne'];
    for (const et of predefined) {
      expect(isPredefinedEmoji(et), `${et} should be predefined`).toBe(true);
    }
  });

  it('returns false for Get', () => {
    expect(isPredefinedEmoji('Get')).toBe(false);
  });

  it('returns false for unknown emoji', () => {
    expect(isPredefinedEmoji('RANDOM')).toBe(false);
  });
});

describe('isStopEmoji / STOP_EMOJI_TYPES', () => {
  it('STOP_EMOJI_TYPES contains exactly No, CrossMark, MinusOne', () => {
    expect(new Set(STOP_EMOJI_TYPES)).toEqual(new Set(['No', 'CrossMark', 'MinusOne']));
  });

  it('isStopEmoji returns true for stop emojiTypes', () => {
    expect(isStopEmoji('No')).toBe(true);
    expect(isStopEmoji('CrossMark')).toBe(true);
    expect(isStopEmoji('MinusOne')).toBe(true);
  });

  it('isStopEmoji returns false for non-stop emojiTypes', () => {
    expect(isStopEmoji('JIAYI')).toBe(false);
    expect(isStopEmoji('Get')).toBe(false);
  });
});

describe('edited-message restart reaction', () => {
  it('matches only exact case-sensitive added + Loudspeaker without becoming model-visible semantics', () => {
    expect(EDITED_MESSAGE_RESTART_EMOJI_TYPE).toBe('Loudspeaker');
    expect(isEditedMessageRestartReaction({ emojiType: 'Loudspeaker', action: 'added' })).toBe(true);
    expect(isEditedMessageRestartReaction({ emojiType: 'loudspeaker', action: 'added' })).toBe(false);
    expect(isEditedMessageRestartReaction({ emojiType: 'Loudspeaker', action: 'removed' })).toBe(false);
    expect(SEMANTICS_TABLE.Loudspeaker).toBeUndefined();
    expect(lookupReactionSemantics('Loudspeaker')).toMatchObject({
      emojiMeaningSource: 'unmapped',
    });
  });
});
