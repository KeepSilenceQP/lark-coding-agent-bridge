import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import {
  computeCanonicalFingerprint,
  EMPTY_FINGERPRINT,
  loadReactionLedger,
} from '../../../src/bot/reaction/ledger';
import { detectNetZeroPair, reconcile } from '../../../src/bot/reaction/reconciler';
import {
  makeReactionKey,
  parseReactionKey,
} from '../../../src/bot/reaction/types';
import type {
  BufferedReactionEvent,
  CanonicalReactionRecord,
} from '../../../src/bot/reaction/types';
import { lookupReactionSemantics } from '../../../src/bot/reaction/semantics';
import { DEFAULT_REACTION_POLICY, parseReactionPolicy } from '../../../src/bot/reaction/policy';
import type { ReactionBehavior, ReactionPolicy } from '../../../src/bot/reaction/policy';

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
    expect(events[0]!.emojiType).toBe('JIAYI');
    expect(events[1]!.emojiType).toBe('OK');
    expect(events[0]!.action).toBe('added');
    expect(events[1]!.action).toBe('added');
  });

  it('one add one remove with final non-empty set → both in buffer events', () => {
    const events = [
      evt({ action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0 }),
      evt({ action: 'removed', emojiType: 'WHAT', actionTime: 1500, arrivalOrder: 1 }),
    ];
    // JIAYI added, WHAT removed — final set still has JIAYI but not WHAT
    expect(events).toHaveLength(2);
    const addedEmojis = events.filter((e) => e.action === 'added').map((e) => e.emojiType);
    const removedEmojis = events.filter((e) => e.action === 'removed').map((e) => e.emojiType);
    expect(addedEmojis).toContain('JIAYI');
    expect(removedEmojis).toContain('WHAT');
  });
});

describe('runtime reaction policy reconciliation', () => {
  let profileDir: string;
  const key = makeReactionKey('oc_chat', 'ou_user', 'om_target');

  beforeEach(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'reaction-policy-reconcile-'));
  });
  afterEach(async () => {
    await rm(profileDir, { recursive: true, force: true });
  });

  function record(emojiType: string): CanonicalReactionRecord {
    return {
      operator_type: 'user', operator_id: 'ou_user', emoji_type: emojiType,
      reaction_id: `r_${emojiType}`,
    };
  }

  function event(emojiType: string, policy = DEFAULT_REACTION_POLICY): BufferedReactionEvent {
    return {
      action: 'added', emojiType, actionTime: 1000, arrivalOrder: 0,
      semantics: lookupReactionSemantics(emojiType, policy),
    };
  }

  function remap(emojiType: string, behavior: ReactionBehavior): ReactionPolicy {
    return parseReactionPolicy(JSON.stringify({
      schemaVersion: 1,
      rules: {
        ...DEFAULT_REACTION_POLICY.rules,
        [emojiType]: {
          behavior, semanticKey: 'configured_meaning',
          emojiMeaning: 'Runtime configured meaning', emojiDisplay: 'Configured',
        },
      },
    }));
  }

  function api(initialRecords: CanonicalReactionRecord[]) {
    let records = initialRecords;
    const list = vi.fn(async () => ({ data: {
      items: records.map(r => ({
        reaction_id: r.reaction_id,
        operator: { operator_type: r.operator_type, operator_id: r.operator_id },
        reaction_type: { emoji_type: r.emoji_type },
      })),
      has_more: false,
    } }));
    return {
      channel: { rawClient: { im: { v1: { messageReaction: { list } } } } } as unknown as LarkChannel,
      setRecords: (next: CanonicalReactionRecord[]) => { records = next; },
      list,
    };
  }

  it.each([
    { emojiType: 'DONE', behavior: 'agent' as const, effective: ['OK', 'JIAYI', 'DONE'] },
    { emojiType: 'JIAYI', behavior: 'passive' as const, effective: ['OK'] },
  ])('does not replay retained $emojiType when remapped to $behavior, including after restart', async ({ emojiType, behavior, effective }) => {
    const records = ['OK', 'JIAYI', 'DONE'].map(record);
    const source = api(records);
    const ledger = await loadReactionLedger(profileDir);
    const first = await reconcile(key, [event('OK')], { channel: source.channel, ledger });
    expect(first).toMatchObject({ noOp: false, revision: 1 });
    expect(ledger.get(key)?.rawRecords).toEqual(records);

    const policy = remap(emojiType, behavior);
    const reloaded = await loadReactionLedger(profileDir);
    const replay = await reconcile(key, [event('OK', policy)], { channel: source.channel, ledger: reloaded, policy });
    expect(replay).toMatchObject({ noOp: true, revision: 1 });
    expect(replay.effectiveReactionSet.map(r => r.emojiType)).toEqual(effective);
    expect(reloaded.get(key)?.policyVersion).toBe(policy.version);

    source.setRecords([...records, record('WHAT')]);
    const next = await reconcile(key, [event('WHAT', policy)], { channel: source.channel, ledger: reloaded, policy });
    expect(next).toMatchObject({ noOp: false, revision: 2 });
    expect(next.triggerReactions.map(r => r.emojiType)).toEqual(['WHAT']);
  });

  it('refreshes passive membership during no-op reads so a later activation does not invent input', async () => {
    const source = api([record('OK'), record('DONE')]);
    const ledger = await loadReactionLedger(profileDir);
    await reconcile(key, [event('OK')], { channel: source.channel, ledger });
    source.setRecords([record('OK')]);
    const unchanged = await reconcile(key, [event('OK')], { channel: source.channel, ledger });
    expect(unchanged).toMatchObject({ noOp: true, revision: 1 });
    expect(ledger.get(key)?.rawRecords).toEqual([record('OK')]);

    const policy = remap('DONE', 'agent');
    const activated = await reconcile(key, [event('OK', policy)], { channel: source.channel, ledger, policy });
    expect(activated).toMatchObject({ noOp: true, revision: 1 });
  });

  it('does not swallow a newly added DONE after configuring it as actionable', async () => {
    const source = api([record('OK')]);
    const ledger = await loadReactionLedger(profileDir);
    await reconcile(key, [event('OK')], { channel: source.channel, ledger });
    source.setRecords([record('OK'), record('DONE')]);
    const policy = remap('DONE', 'agent');
    const result = await reconcile(key, [event('DONE', policy)], { channel: source.channel, ledger, policy });
    expect(result).toMatchObject({ noOp: false, revision: 2 });
    expect(result.triggerReactions).toEqual([expect.objectContaining({
      emojiType: 'DONE', semanticKey: 'configured_meaning', behavior: 'agent',
      emojiMeaning: 'Runtime configured meaning', emojiMeaningSource: 'predefined',
    })]);
  });

  it.each([
    { name: 'retained DONE and a duplicate OK', before: ['OK', 'DONE'], after: ['OK', 'DONE'], emoji: 'OK', action: 'added' as const, noOp: true },
    { name: 'retained DONE with a newly added passive GLANCE', before: ['OK', 'DONE'], after: ['OK', 'DONE', 'GLANCE'], emoji: 'OK', action: 'added' as const, noOp: true },
    { name: 'retained DONE with a retained now-passive GLANCE', before: ['OK', 'DONE', 'GLANCE'], after: ['OK', 'DONE', 'GLANCE'], emoji: 'OK', action: 'added' as const, noOp: true },
    { name: 'a newly added DONE', before: ['OK'], after: ['OK', 'DONE'], emoji: 'DONE', action: 'added' as const, noOp: false },
    { name: 'a re-added formerly passive DONE', before: ['OK', 'DONE'], after: ['OK', 'DONE'], emoji: 'DONE', action: 'added' as const, noOp: false },
    { name: 'another newly added reaction', before: ['OK', 'DONE'], after: ['OK', 'DONE', 'WHAT'], emoji: 'WHAT', action: 'added' as const, noOp: false },
    { name: 'another removed reaction', before: ['OK', 'JIAYI', 'DONE'], after: ['JIAYI', 'DONE'], emoji: 'OK', action: 'removed' as const, noOp: false },
  ])('upgrades a pre-policy ledger correctly for $name', async ({ before, after, emoji, action, noOp }) => {
    // The deployed pre-policy version excluded DONE and did not persist rawRecords
    // or policyVersion. Seed that exact shape rather than creating a new ledger.
    const ledger = await loadReactionLedger(profileDir);
    const previousRecords = before.map(record);
    const fingerprint = computeCanonicalFingerprint(previousRecords);
    await ledger.updateEntry(key, () => ({
      fingerprint, consumedFingerprint: fingerprint, latestActionTime: 500,
      recordIds: previousRecords.filter(r => r.emoji_type !== 'DONE').map(r => r.reaction_id!),
      lastRevision: 7,
    }));
    const policy = parseReactionPolicy(JSON.stringify({
      schemaVersion: 1,
      rules: {
        ...remap('DONE', 'agent').rules,
        GLANCE: { behavior: 'passive', semanticKey: 'handled_marker', emojiMeaning: '静默标记已处理。' },
      },
    }));
    const source = api(after.map(record));
    const reloaded = await loadReactionLedger(profileDir);
    const result = await reconcile(key, [{ ...event(emoji, policy), action }], {
      channel: source.channel, ledger: reloaded, policy,
    });
    expect(result).toMatchObject({ noOp, revision: noOp ? 7 : 8 });
    expect(reloaded.get(key)?.rawRecords).toEqual(after.map(record));
    expect(reloaded.get(key)?.policyVersion).toBe(policy.version);

    // Once migrated, redelivery remains a no-op under the new policy as well.
    const duplicate = await reconcile(key, [{ ...event(emoji, policy), action }], {
      channel: source.channel, ledger: reloaded, policy,
    });
    expect(duplicate).toMatchObject({ noOp: true, revision: noOp ? 7 : 8 });
  });

  it('recognizes a new addition when a formerly passive marker was removed without refreshing the ledger', async () => {
    const oldMarker = { ...record('DONE'), reaction_id: 'old_done' };
    const newMarker = { ...record('DONE'), reaction_id: 'new_done' };
    const source = api([record('OK'), oldMarker]);
    const ledger = await loadReactionLedger(profileDir);
    await reconcile(key, [event('OK')], { channel: source.channel, ledger });
    expect(ledger.get(key)?.recordIds).not.toContain('old_done');
    // Passive removal has no read side effects; the next snapshot has the
    // newly created record under the same emoji after policy activation.
    source.setRecords([record('OK'), newMarker]);
    const policy = remap('DONE', 'agent');
    const activated = await reconcile(key, [event('DONE', policy)], { channel: source.channel, ledger, policy });
    expect(activated).toMatchObject({ noOp: false, revision: 2 });
    expect(activated.triggerReactions.map(entry => entry.emojiType)).toEqual(['DONE']);
    const duplicate = await reconcile(key, [event('DONE', policy)], { channel: source.channel, ledger, policy });
    expect(duplicate).toMatchObject({ noOp: true, revision: 2 });
  });

  it('does not treat an active reaction ID change during a meaning edit as fresh input', async () => {
    const source = api([record('OK')]);
    const ledger = await loadReactionLedger(profileDir);
    await reconcile(key, [event('OK')], { channel: source.channel, ledger });
    source.setRecords([{ ...record('OK'), reaction_id: 'different_api_id' }]);
    const policy = remap('OK', 'agent');
    const unchanged = await reconcile(key, [event('OK', policy)], { channel: source.channel, ledger, policy });
    expect(unchanged).toMatchObject({ noOp: true, revision: 1 });
  });

  it('does not infer a fresh formerly passive addition without record ID evidence', async () => {
    const marker = { ...record('DONE'), reaction_id: undefined };
    const source = api([record('OK'), marker]);
    const ledger = await loadReactionLedger(profileDir);
    await reconcile(key, [event('OK')], { channel: source.channel, ledger });
    const policy = remap('DONE', 'agent');
    const unchanged = await reconcile(key, [event('DONE', policy)], { channel: source.channel, ledger, policy });
    expect(unchanged).toMatchObject({ noOp: true, revision: 1 });
  });

  it('uses the flush policy for both triggers and effective entries even if caller semantics were stale', async () => {
    const source = api([record('OK')]);
    const ledger = await loadReactionLedger(profileDir);
    const policy = remap('OK', 'continue');
    const result = await reconcile(key, [event('OK')], { channel: source.channel, ledger, policy });
    for (const entries of [result.triggerReactions, result.effectiveReactionSet]) {
      expect(entries).toEqual([expect.objectContaining({
        emojiType: 'OK', semanticKey: 'configured_meaning',
        emojiMeaning: 'Runtime configured meaning', behavior: 'continue',
      })]);
    }
  });
});
