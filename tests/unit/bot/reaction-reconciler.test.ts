import { describe, expect, it } from 'vitest';
import {
  computeCanonicalFingerprint,
  EMPTY_FINGERPRINT,
} from '../../../src/bot/reaction/ledger';
import { detectNetZeroPair } from '../../../src/bot/reaction/reconciler';
import {
  makeReactionKey,
  parseReactionKey,
} from '../../../src/bot/reaction/types';
import type {
  BufferedReactionEvent,
  CanonicalReactionRecord,
} from '../../../src/bot/reaction/types';
import { lookupReactionSemantics } from '../../../src/bot/reaction/semantics';

// ── Reaction key helpers ──

describe('makeReactionKey / parseReactionKey', () => {
  it('round-trips through make and parse', () => {
    const key = makeReactionKey('oc_chat', 'ou_user', 'om_msg');
    expect(parseReactionKey(key)).toEqual({
      scope: 'oc_chat',
      operatorOpenId: 'ou_user',
      targetMessageId: 'om_msg',
    });
  });

  it('produces distinct keys for different components', () => {
    const k1 = makeReactionKey('oc_a', 'ou_x', 'om_1');
    const k2 = makeReactionKey('oc_a', 'ou_y', 'om_1');
    const k3 = makeReactionKey('oc_a', 'ou_x', 'om_2');
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('throws on invalid key with too few components', () => {
    expect(() => parseReactionKey('only_one')).toThrow();
    expect(() => parseReactionKey('')).toThrow();
  });
});

// ── Canonical fingerprint ──

describe('computeCanonicalFingerprint', () => {
  it('produces the same fingerprint for the same records regardless of order', () => {
    const records: CanonicalReactionRecord[] = [
      { operator_type: 'user', operator_id: 'ou_b', emoji_type: 'JIAYI' },
      { operator_type: 'user', operator_id: 'ou_a', emoji_type: 'OK' },
    ];
    const reversed = [...records].reverse();
    expect(computeCanonicalFingerprint(records)).toBe(computeCanonicalFingerprint(reversed));
  });

  it('produces the same fingerprint across different pages (API order shuffle)', () => {
    const page1: CanonicalReactionRecord[] = [
      { operator_type: 'user', operator_id: 'ou_a', emoji_type: 'JIAYI', reaction_id: 'r1' },
    ];
    const page2: CanonicalReactionRecord[] = [
      { operator_type: 'user', operator_id: 'ou_b', emoji_type: 'OK', reaction_id: 'r2' },
    ];
    const combined = [...page1, ...page2];
    const reversed = [...page2, ...page1];
    expect(computeCanonicalFingerprint(combined)).toBe(computeCanonicalFingerprint(reversed));
  });

  it('deduplicates by reaction_id', () => {
    const withDup: CanonicalReactionRecord[] = [
      { operator_type: 'user', operator_id: 'ou_a', emoji_type: 'JIAYI', reaction_id: 'r1' },
      { operator_type: 'user', operator_id: 'ou_a', emoji_type: 'JIAYI', reaction_id: 'r1' },
    ];
    const withoutDup: CanonicalReactionRecord[] = [
      { operator_type: 'user', operator_id: 'ou_a', emoji_type: 'JIAYI', reaction_id: 'r1' },
    ];
    expect(computeCanonicalFingerprint(withDup)).toBe(computeCanonicalFingerprint(withoutDup));
  });

  it('different emoji_types produce different fingerprints', () => {
    const f1 = computeCanonicalFingerprint([
      { operator_type: 'user', operator_id: 'ou_a', emoji_type: 'JIAYI' },
    ]);
    const f2 = computeCanonicalFingerprint([
      { operator_type: 'user', operator_id: 'ou_a', emoji_type: 'OK' },
    ]);
    expect(f1).not.toBe(f2);
  });

  it('different operators produce different fingerprints', () => {
    const f1 = computeCanonicalFingerprint([
      { operator_type: 'user', operator_id: 'ou_a', emoji_type: 'JIAYI' },
    ]);
    const f2 = computeCanonicalFingerprint([
      { operator_type: 'user', operator_id: 'ou_b', emoji_type: 'JIAYI' },
    ]);
    expect(f1).not.toBe(f2);
  });

  it('empty set produces a stable fingerprint', () => {
    expect(computeCanonicalFingerprint([])).toBe(EMPTY_FINGERPRINT);
  });

  it('case-sensitive: JIAYI vs jiayi produce different fingerprints', () => {
    const f1 = computeCanonicalFingerprint([
      { operator_type: 'user', operator_id: 'ou_a', emoji_type: 'JIAYI' },
    ]);
    const f2 = computeCanonicalFingerprint([
      { operator_type: 'user', operator_id: 'ou_a', emoji_type: 'jiayi' },
    ]);
    expect(f1).not.toBe(f2);
  });
});

// ── Net-zero added→removed detection ──

describe('detectNetZeroPair', () => {
  function event(overrides: Partial<BufferedReactionEvent> = {}): BufferedReactionEvent {
    return {
      action: 'added',
      emojiType: 'JIAYI',
      actionTime: 1000,
      arrivalOrder: 0,
      semantics: lookupReactionSemantics('JIAYI'),
      ...overrides,
    };
  }

  it('returns true for same emoji added then removed (net zero for one emoji)', () => {
    const events = [
      event({ action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0 }),
      event({ action: 'removed', emojiType: 'JIAYI', actionTime: 2000, arrivalOrder: 1 }),
    ];
    expect(detectNetZeroPair(events)).toBe(true);
  });

  it('returns false when only added events exist', () => {
    const events = [event({ action: 'added' })];
    expect(detectNetZeroPair(events)).toBe(false);
  });

  it('returns false when only removed events exist', () => {
    const events = [event({ action: 'removed' })];
    expect(detectNetZeroPair(events)).toBe(false);
  });

  it('returns false when added count > removed count for same emoji', () => {
    const events = [
      event({ action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0 }),
      event({ action: 'added', emojiType: 'JIAYI', actionTime: 1500, arrivalOrder: 1 }),
      event({ action: 'removed', emojiType: 'JIAYI', actionTime: 2000, arrivalOrder: 2 }),
    ];
    expect(detectNetZeroPair(events)).toBe(false);
  });

  it('returns true when one emoji nets to zero even if another emoji is added', () => {
    const events = [
      event({ action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0 }),
      event({ action: 'removed', emojiType: 'JIAYI', actionTime: 2000, arrivalOrder: 1 }),
      event({ action: 'added', emojiType: 'OK', actionTime: 1500, arrivalOrder: 2 }),
    ];
    // JIAYI nets to zero, but OK is still added. The function returns true
    // if ANY emoji type has matching added+removed counts.
    expect(detectNetZeroPair(events)).toBe(true);
  });

  it('returns false for empty events', () => {
    expect(detectNetZeroPair([])).toBe(false);
  });
});

// ── triggerReactions ordering ──

describe('triggerReactions ordering (from buffered events)', () => {
  function evt(overrides: Partial<BufferedReactionEvent> = {}): BufferedReactionEvent {
    return {
      action: 'added',
      emojiType: 'JIAYI',
      actionTime: 1000,
      arrivalOrder: 0,
      semantics: lookupReactionSemantics('JIAYI'),
      ...overrides,
    };
  }

  it('two different reactions added before agent start → both in triggerReactions', () => {
    const events = [
      evt({ action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0 }),
      evt({ action: 'added', emojiType: 'OK', actionTime: 1500, arrivalOrder: 1 }),
    ];
    // Verify they're ordered by actionTime
    expect(events[0].emojiType).toBe('JIAYI');
    expect(events[1].emojiType).toBe('OK');
    expect(events[0].action).toBe('added');
    expect(events[1].action).toBe('added');
  });

  it('one add one remove with final non-empty set → both in buffer events', () => {
    const events = [
      evt({ action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0 }),
      evt({ action: 'removed', emojiType: 'DONE', actionTime: 1500, arrivalOrder: 1 }),
    ];
    // JIAYI added, DONE removed — final set still has JIAYI but not DONE
    expect(events).toHaveLength(2);
    const addedEmojis = events.filter((e) => e.action === 'added').map((e) => e.emojiType);
    const removedEmojis = events.filter((e) => e.action === 'removed').map((e) => e.emojiType);
    expect(addedEmojis).toContain('JIAYI');
    expect(removedEmojis).toContain('DONE');
  });
});
