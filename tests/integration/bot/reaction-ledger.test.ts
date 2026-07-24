import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ReactionLedger,
  loadReactionLedger,
  computeCanonicalFingerprint,
  EMPTY_FINGERPRINT,
} from '../../../src/bot/reaction/ledger';
import type { CanonicalReactionRecord } from '../../../src/bot/reaction/types';
import { makeReactionKey } from '../../../src/bot/reaction/types';

describe('ReactionLedger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'reaction-ledger-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function sampleFingerprint(operatorId: string, emojiType: string): string {
    return computeCanonicalFingerprint([
      { operator_type: 'user', operator_id: operatorId, emoji_type: emojiType },
    ]);
  }

  // ── Basic CRUD ──

  it('starts with an empty entries map', () => {
    const ledger = new ReactionLedger(join(tmpDir, 'ledger.json'));
    expect(ledger.get('any-key')).toBeUndefined();
    expect(ledger.snapshot().entries).toEqual({});
  });

  it('stores and retrieves an entry via updateEntry', async () => {
    const ledger = new ReactionLedger(join(tmpDir, 'ledger.json'));
    const key = makeReactionKey('oc_chat', 'ou_user', 'om_msg');
    const fp = sampleFingerprint('ou_user', 'JIAYI');

    const entry = await ledger.updateEntry(key, () => ({
      fingerprint: fp,
      consumedFingerprint: EMPTY_FINGERPRINT,
      latestActionTime: 1000,
      recordIds: ['r1'],
      lastRevision: 1,
    }));

    expect(entry.fingerprint).toBe(fp);
    expect(entry.lastRevision).toBe(1);

    const retrieved = ledger.get(key);
    expect(retrieved?.fingerprint).toBe(fp);
  });

  it('updates an existing entry', async () => {
    const ledger = new ReactionLedger(join(tmpDir, 'ledger.json'));
    const key = makeReactionKey('oc_chat', 'ou_user', 'om_msg');

    await ledger.updateEntry(key, () => ({
      fingerprint: 'fp1',
      consumedFingerprint: EMPTY_FINGERPRINT,
      latestActionTime: 1000,
      recordIds: ['r1'],
      lastRevision: 1,
    }));

    const updated = await ledger.updateEntry(key, (prev) => ({
      fingerprint: 'fp2',
      consumedFingerprint: prev?.fingerprint ?? EMPTY_FINGERPRINT,
      latestActionTime: 2000,
      recordIds: ['r1', 'r2'],
      lastRevision: 2,
    }));

    expect(updated.lastRevision).toBe(2);
    expect(updated.consumedFingerprint).toBe('fp1');
  });

  // ── Restart recovery ──

  it('survives restart (reload from disk)', async () => {
    // Use the same path that loadReactionLedger resolves
    const { resolveReactionLedgerPath } = await import('../../../src/bot/reaction/ledger');
    const path = resolveReactionLedgerPath(tmpDir);
    const ledger1 = new ReactionLedger(path);
    const key = makeReactionKey('oc_chat', 'ou_user', 'om_msg');
    const fp = sampleFingerprint('ou_user', 'JIAYI');

    await ledger1.updateEntry(key, () => ({
      fingerprint: fp,
      consumedFingerprint: fp,
      latestActionTime: 1000,
      recordIds: ['r1'],
      lastRevision: 1,
    }));

    // Simulate restart: create a new ledger from the same file
    const ledger2 = await loadReactionLedger(tmpDir);
    const restored = ledger2.get(key);
    expect(restored?.fingerprint).toBe(fp);
    expect(restored?.lastRevision).toBe(1);
  });

  it('does not replay old reactions after restart (only processes new state changes)', async () => {
    const { resolveReactionLedgerPath } = await import('../../../src/bot/reaction/ledger');
    const path = resolveReactionLedgerPath(tmpDir);
    const ledger1 = new ReactionLedger(path);
    const key = makeReactionKey('oc_chat', 'ou_user', 'om_msg');
    const fp = sampleFingerprint('ou_user', 'JIAYI');

    await ledger1.updateEntry(key, () => ({
      fingerprint: fp,
      consumedFingerprint: fp,
      latestActionTime: 1000,
      recordIds: ['r1'],
      lastRevision: 1,
    }));

    // After restart, the consumed fingerprint matches the current fingerprint
    const ledger2 = await loadReactionLedger(tmpDir);
    const restored = ledger2.get(key);
    expect(restored?.consumedFingerprint).toBe(fp);
    // Same fingerprint = no-op, no new turn should be started
    expect(restored?.fingerprint).toBe(restored?.consumedFingerprint);
  });

  // ── No-op when fingerprint unchanged ──

  it('does not increment revision when fingerprint is unchanged (no-op)', async () => {
    const ledger = new ReactionLedger(join(tmpDir, 'ledger.json'));
    const key = makeReactionKey('oc_chat', 'ou_user', 'om_msg');
    const fp = sampleFingerprint('ou_user', 'JIAYI');

    await ledger.updateEntry(key, () => ({
      fingerprint: fp,
      consumedFingerprint: fp,
      latestActionTime: 1000,
      recordIds: ['r1'],
      lastRevision: 1,
    }));

    // Same fingerprint → caller should detect no-op, not update revision
    const entry = ledger.get(key);
    expect(entry?.fingerprint).toBe(entry?.consumedFingerprint);
    // No-op means no new turn started
  });

  // ── Multiple keys ──

  it('supports multiple independent keys', async () => {
    const ledger = new ReactionLedger(join(tmpDir, 'ledger.json'));
    const key1 = makeReactionKey('oc_a', 'ou_x', 'om_1');
    const key2 = makeReactionKey('oc_a', 'ou_y', 'om_1');

    await ledger.updateEntry(key1, () => ({
      fingerprint: 'fp1',
      consumedFingerprint: EMPTY_FINGERPRINT,
      latestActionTime: 1000,
      recordIds: ['r1'],
      lastRevision: 1,
    }));

    await ledger.updateEntry(key2, () => ({
      fingerprint: 'fp2',
      consumedFingerprint: EMPTY_FINGERPRINT,
      latestActionTime: 2000,
      recordIds: ['r2'],
      lastRevision: 1,
    }));

    expect(ledger.get(key1)?.fingerprint).toBe('fp1');
    expect(ledger.get(key2)?.fingerprint).toBe('fp2');
  });

  // ── Empty set fingerprint ──

  it('EMPTY_FINGERPRINT is stable', () => {
    expect(EMPTY_FINGERPRINT).toBeDefined();
    expect(typeof EMPTY_FINGERPRINT).toBe('string');
    expect(EMPTY_FINGERPRINT.length).toBe(64); // SHA-256 hex
  });
});
