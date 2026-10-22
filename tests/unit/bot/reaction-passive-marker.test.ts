import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannel, ReactionEvent } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactionBuffer, BUFFER_QUIET_MS } from '../../../src/bot/reaction/buffer';
import {
  computeCanonicalFingerprint,
  EMPTY_FINGERPRINT,
  loadReactionLedger,
  resolveReactionLedgerPath,
} from '../../../src/bot/reaction/ledger';
import { reconcile } from '../../../src/bot/reaction/reconciler';
import { lookupReactionSemantics } from '../../../src/bot/reaction/semantics';
import { makeReactionKey } from '../../../src/bot/reaction/types';
import type {
  BufferedReactionEvent,
  CanonicalReactionRecord,
} from '../../../src/bot/reaction/types';

const key = makeReactionKey('oc_chat:omt_topic', 'ou_user', 'om_target');

function record(emojiType: string): CanonicalReactionRecord {
  return {
    reaction_id: `r_${emojiType}`,
    operator_type: 'user',
    operator_id: 'ou_user',
    emoji_type: emojiType,
  };
}

function event(
  emojiType: string,
  action: 'added' | 'removed' = 'added',
  order = 0,
): BufferedReactionEvent {
  return {
    emojiType,
    action,
    actionTime: 1000 + order,
    arrivalOrder: order,
    semantics: lookupReactionSemantics(emojiType),
  };
}

function fakeApi(initialRecords: CanonicalReactionRecord[]) {
  let records = initialRecords;
  const list = vi.fn(async () => ({
    data: {
      items: records.map(r => ({
        reaction_id: r.reaction_id,
        operator: { operator_id: r.operator_id, operator_type: r.operator_type },
        reaction_type: { emoji_type: r.emoji_type },
      })),
      has_more: false,
    },
  }));
  return {
    list,
    setRecords: (next: CanonicalReactionRecord[]) => { records = next; },
    channel: {
      rawClient: { im: { v1: { messageReaction: { list } } } },
    } as unknown as LarkChannel,
  };
}

// Fixed v1 serialization, independent of the new fingerprint helpers. DONE
// precedes JIAYI in the old canonical order and used to affect the stored hash.
const legacyDoneJiayiFingerprint = createHash('sha256').update(
  'ot:user\x1foi:ou_user\x1fet:DONE\x1f'
  + 'ot:user\x1foi:ou_user\x1fet:JIAYI\x1f',
).digest('hex');

describe('passive DONE reconciliation and persistence', () => {
  let profileDir: string;

  beforeEach(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'reaction-passive-marker-'));
  });

  afterEach(async () => {
    await rm(profileDir, { recursive: true, force: true });
  });

  async function writeLegacyLedger() {
    await writeFile(resolveReactionLedgerPath(profileDir), JSON.stringify({
      schemaVersion: 1,
      entries: {
        [key]: {
          fingerprint: legacyDoneJiayiFingerprint,
          consumedFingerprint: legacyDoneJiayiFingerprint,
          recordIds: ['r_DONE', 'r_JIAYI'],
          lastRevision: 7,
          latestActionTime: 1000,
        },
      },
    }));
    return loadReactionLedger(profileDir);
  }

  it.each([
    { label: 'added', events: [event('DONE')] },
    { label: 'removed', events: [event('DONE', 'removed')] },
    { label: 'added then removed', events: [event('DONE'), event('DONE', 'removed', 1)] },
  ])('$label alone makes no API call or ledger change', async ({ events }) => {
    const ledger = await writeLegacyLedger();
    const before = ledger.snapshot();
    const diskBefore = await readFile(resolveReactionLedgerPath(profileDir), 'utf8');
    const update = vi.spyOn(ledger, 'updateEntry');
    const api = fakeApi([]);

    const result = await reconcile(key, events, { channel: api.channel, ledger });

    expect(result).toMatchObject({
      noOp: true,
      reconciliationFailed: false,
      netZeroConsumed: false,
      revision: 7,
      triggerReactions: [],
      effectiveReactionSet: [],
    });
    expect(api.list).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(ledger.snapshot()).toEqual(before);
    expect(await readFile(resolveReactionLedgerPath(profileDir), 'utf8')).toBe(diskBefore);
  });

  it.each([
    { label: 'added but absent from API', events: [event('DONE')], hasDone: false },
    { label: 'removed but stale in API', events: [event('DONE', 'removed')], hasDone: true },
    { label: 'add/remove pair still in API', events: [event('DONE'), event('DONE', 'removed', 1)], hasDone: true },
  ])('ignores DONE $label beside an actionable change', async ({ events, hasDone }) => {
    const active = record('JIAYI');
    const api = fakeApi([active, ...(hasDone ? [record('DONE')] : [])]);
    const ledger = await loadReactionLedger(profileDir);

    const result = await reconcile(key, [...events, event('JIAYI', 'added', 2)], {
      channel: api.channel, ledger,
    });

    expect(api.list).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      noOp: false, netZeroConsumed: false, reconciliationFailed: false, revision: 1,
      fingerprint: computeCanonicalFingerprint([active]),
    });
    expect(result.triggerReactions.map(r => r.emojiType)).toEqual(['JIAYI']);
    expect(result.effectiveReactionSet.map(r => r.emojiType)).toEqual(['JIAYI']);
    expect(ledger.get(key)?.recordIds).toEqual(['r_JIAYI']);
    expect(computeCanonicalFingerprint([active, record('DONE')])).toBe(result.fingerprint);
    expect(computeCanonicalFingerprint([record('DONE')])).toBe(EMPTY_FINGERPRINT);
  });

  it('keeps a consumed active snapshot unchanged across marker presence and marker pairs', async () => {
    const active = record('JIAYI');
    const api = fakeApi([active, record('DONE')]);
    const ledger = await loadReactionLedger(profileDir);
    await reconcile(key, [event('JIAYI')], { channel: api.channel, ledger });
    const before = ledger.snapshot();
    const update = vi.spyOn(ledger, 'updateEntry');

    for (const records of [[active, record('DONE')], [active]]) {
      api.setRecords(records);
      const result = await reconcile(key, [event('DONE'), event('JIAYI'), event('DONE', 'removed', 2)], {
        channel: api.channel, ledger,
      });
      expect(result).toMatchObject({ noOp: true, revision: 1, netZeroConsumed: false });
      expect(result.triggerReactions.map(r => r.emojiType)).toEqual(['JIAYI']);
      expect(result.effectiveReactionSet.map(r => r.emojiType)).toEqual(['JIAYI']);
    }
    expect(update).toHaveBeenCalledTimes(2);
    expect(ledger.get(key)).toMatchObject({
      fingerprint: before.entries[key]!.fingerprint,
      consumedFingerprint: before.entries[key]!.consumedFingerprint,
      lastRevision: before.entries[key]!.lastRevision,
      rawRecords: [active],
    });
  });

  it.each([true, false])('normalizes a consumed v1 ledger without replay (DONE present: %s)', async hasDone => {
    const ledger = await writeLegacyLedger();
    const active = record('JIAYI');
    const expectedFingerprint = computeCanonicalFingerprint([active]);
    expect(legacyDoneJiayiFingerprint).not.toBe(expectedFingerprint);
    const api = fakeApi([active, ...(hasDone ? [record('DONE')] : [])]);

    const result = await reconcile(key, [event('JIAYI')], { channel: api.channel, ledger });

    expect(result).toMatchObject({
      noOp: true, revision: 7, netZeroConsumed: false, fingerprint: expectedFingerprint,
    });
    const reloaded = await loadReactionLedger(profileDir);
    expect(reloaded.get(key)).toMatchObject({
      fingerprint: expectedFingerprint,
      consumedFingerprint: expectedFingerprint,
      recordIds: ['r_JIAYI'],
      lastRevision: 7,
    });
    const replay = await reconcile(key, [event('JIAYI')], { channel: api.channel, ledger: reloaded });
    expect(replay).toMatchObject({ noOp: true, revision: 7, fingerprint: expectedFingerprint });
  });

  it('does not swallow a new actionable signal when upgrading a v1 ledger', async () => {
    const ledger = await writeLegacyLedger();
    const active = [record('JIAYI'), record('OK')];
    const api = fakeApi([...active, record('DONE')]);

    const result = await reconcile(key, [event('OK')], { channel: api.channel, ledger });

    expect(result).toMatchObject({ noOp: false, revision: 8, netZeroConsumed: false });
    expect(result.triggerReactions.map(r => r.emojiType)).toEqual(['OK']);
    expect(result.effectiveReactionSet.map(r => r.emojiType)).toEqual(['JIAYI', 'OK']);
    const reloaded = await loadReactionLedger(profileDir);
    expect(reloaded.get(key)).toMatchObject({
      fingerprint: computeCanonicalFingerprint(active),
      consumedFingerprint: computeCanonicalFingerprint(active),
      recordIds: ['r_JIAYI', 'r_OK'],
      lastRevision: 8,
    });
  });
});

describe('passive DONE buffering', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('neither creates a pending key nor delays the quiet window of actionable work', async () => {
    vi.useFakeTimers();
    const flush = vi.fn(async () => {});
    const buffer = new ReactionBuffer(flush);
    const rawEvent = (emojiType: string, action: 'added' | 'removed' = 'added'): ReactionEvent => ({
      messageId: 'om_target', operator: { openId: 'ou_user' }, emojiType, action,
      actionTime: Date.now(), raw: {},
    });

    buffer.push(key, rawEvent('DONE'));
    buffer.push(key, rawEvent('DONE', 'removed'));
    expect(buffer.pendingKeys).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    buffer.push(key, rawEvent('JIAYI'));
    await vi.advanceTimersByTimeAsync(BUFFER_QUIET_MS - 100);
    buffer.push(key, rawEvent('DONE'));
    buffer.push(key, rawEvent('DONE', 'removed'));
    await vi.advanceTimersByTimeAsync(99);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith(key, [expect.objectContaining({ emojiType: 'JIAYI' })], expect.anything());
    expect(buffer.pendingKeys).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
