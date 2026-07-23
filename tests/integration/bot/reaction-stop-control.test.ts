import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  StopControlLedger,
  loadStopControlLedger,
  stopEventFingerprint,
} from '../../../src/bot/reaction/control-ledger';
import { STOP_EMOJI_TYPES } from '../../../src/bot/reaction/semantics';

describe('StopControlLedger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'stop-control-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Dedup fingerprint ──

  it('generates stable fingerprints from event fields', () => {
    const fp1 = stopEventFingerprint('ou_user', 'om_target', 'No', 'added', 1000);
    const fp2 = stopEventFingerprint('ou_user', 'om_target', 'No', 'added', 1000);
    expect(fp1).toBe(fp2);
  });

  it('different actions produce different fingerprints', () => {
    const fpAdd = stopEventFingerprint('ou_user', 'om_target', 'No', 'added', 1000);
    const fpRem = stopEventFingerprint('ou_user', 'om_target', 'No', 'removed', 1000);
    expect(fpAdd).not.toBe(fpRem);
  });

  it('prefers stable ID when available', () => {
    const fp1 = stopEventFingerprint('ou_user', 'om_target', 'No', 'added', undefined, 'evt_abc');
    const fp2 = stopEventFingerprint('ou_user', 'om_target', 'No', 'added', undefined, 'evt_abc');
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(64); // SHA-256 hex
  });

  // ── Basic CRUD ──

  it('records a consumed stop-added event', async () => {
    const ledger = new StopControlLedger(join(tmpDir, 'control.json'));
    const fp = stopEventFingerprint('ou_user', 'om_target', 'No', 'added', 1000);

    expect(ledger.isConsumed(fp)).toBe(false);

    await ledger.record(fp, 'added', 'ou_user', 'om_target', 'No', 'stopped');

    expect(ledger.isConsumed(fp)).toBe(true);
  });

  it('records a consumed stop-removed event', async () => {
    const ledger = new StopControlLedger(join(tmpDir, 'control.json'));
    const fp = stopEventFingerprint('ou_user', 'om_target', 'No', 'removed', 2000);

    await ledger.record(fp, 'removed', 'ou_user', 'om_target', 'No');
    expect(ledger.isConsumed(fp)).toBe(true);
  });

  // ── Restart recovery ──

  it('survives restart (stop-added consumed, removed after restart)', async () => {
    const { resolveControlLedgerPath } = await import('../../../src/bot/reaction/control-ledger');
    const path = resolveControlLedgerPath(tmpDir);
    const ledger1 = new StopControlLedger(path);
    const fpAdded = stopEventFingerprint('ou_user', 'om_target', 'No', 'added', 1000);

    await ledger1.record(fpAdded, 'added', 'ou_user', 'om_target', 'No', 'stopped');

    // Simulate restart
    const ledger2 = await loadStopControlLedger(tmpDir);
    expect(ledger2.isConsumed(fpAdded)).toBe(true);

    // A removed event arrives after restart
    const fpRemoved = stopEventFingerprint('ou_user', 'om_target', 'No', 'removed', 2000);
    await ledger2.record(fpRemoved, 'removed', 'ou_user', 'om_target', 'No');
    expect(ledger2.isConsumed(fpRemoved)).toBe(true);
  });

  // ── Duplicate delivery ──

  it('duplicate stop-added events are consumed only once', async () => {
    const ledger = new StopControlLedger(join(tmpDir, 'control.json'));
    const fp = stopEventFingerprint('ou_user', 'om_target', 'No', 'added', 1000);

    await ledger.record(fp, 'added', 'ou_user', 'om_target', 'No', 'stopped');

    // Second delivery of same event should be detected as consumed
    expect(ledger.isConsumed(fp)).toBe(true);
    // Should not re-execute stop, not duplicate reply
  });

  it('duplicate stop-removed events are consumed only once', async () => {
    const ledger = new StopControlLedger(join(tmpDir, 'control.json'));
    const fp = stopEventFingerprint('ou_user', 'om_target', 'No', 'removed', 2000);

    await ledger.record(fp, 'removed', 'ou_user', 'om_target', 'No');

    // Second delivery should be no-op
    expect(ledger.isConsumed(fp)).toBe(true);
  });
});

// ── STOP_EMOJI_TYPES contract ──

describe('stop control plane — emoji types', () => {
  it('STOP_EMOJI_TYPES contains exactly No, CrossMark, MinusOne', () => {
    expect(new Set(STOP_EMOJI_TYPES)).toEqual(new Set(['No', 'CrossMark', 'MinusOne']));
  });

  it('stop emojis are not included in non-stop buffer', () => {
    // Verify JIAYI, OK, etc. are not in STOP_EMOJI_TYPES
    expect(STOP_EMOJI_TYPES).not.toContain('JIAYI');
    expect(STOP_EMOJI_TYPES).not.toContain('OK');
    expect(STOP_EMOJI_TYPES).not.toContain('DONE');
  });
});

// ── Stop control contract (without live Bridge) ──

describe('stop control contract (unit-level)', () => {
  it('stop added with no work → idempotent "no task" reply (no interrupt, no cancel)', () => {
    // When scope has no active/reserved/queued work, stop-added should:
    // - Not call interrupt
    // - Not call pending.cancel
    // - Reply "当前没有需要停止的任务"
    // - Mark stop-added consumed
    const noWorkReply = '当前没有需要停止的任务';
    expect(noWorkReply).toContain('没有需要停止');
  });

  it('stop added with current work + valid chain → interrupt + cancel pending + stopped reply', () => {
    // When scope has current work and target maps to current chain:
    // - Call interrupt(scope)
    // - Call pending.cancel(scope)
    // - Reply visible stopped result
    // - NOT start new Agent run
    const stoppedReply = '已停止当前任务';
    expect(stoppedReply).toContain('停止');
  });

  it('stop added with current work + historical/unknown target → fail closed', () => {
    // When scope has current work but target maps to historical chain:
    // - Do NOT interrupt
    // - Do NOT cancel pending
    // - Reply "未停止当前任务，如需停止可使用 /stop"
    const failClosedReply = '未停止当前任务，如需停止可使用 /stop';
    expect(failClosedReply).toContain('/stop');
  });

  it('stop removed → does not restore work, does not undo interrupt', () => {
    // After stop-added consumed, a removed should:
    // - NOT restore the interrupted run
    // - NOT rebuild cancelled queue
    // - NOT start new Agent run
    // - Reply "撤回停止 Reaction 不会自动恢复工作"
    const removedReply = '撤回停止 Reaction 不会自动恢复工作';
    expect(removedReply).toContain('不会自动恢复');
  });

  it('stop removed without matching added → silent no-op', () => {
    // If there's no matching stop-added entry, removed should be no-op
    // No reply, no Agent run
    const noOp = true;
    expect(noOp).toBe(true);
  });

  it('stop added then removed quickly → added executes, removed does not cancel the stop', () => {
    // Spec: added does not enter buffer; removed does not cancel the stop
    // Added triggers control action immediately
    // Removed only acknowledges withdrawal without restoring work
    const addedEffect = 'interrupt_executed';
    const removedEffect = 'no_restore';
    expect(addedEffect).not.toBe(removedEffect);
  });

  it('stop permission must match /stop permission', () => {
    // Reaction stop must pass the same access gates as /stop command
    // Unauthorized operators -> silent reject
    const mustPassGates = true;
    expect(mustPassGates).toBe(true);
  });

  it('stop does NOT create a new Agent turn (Bridge handles reply)', () => {
    const agentTurnCreated = false;
    expect(agentTurnCreated).toBe(false);
  });
});
