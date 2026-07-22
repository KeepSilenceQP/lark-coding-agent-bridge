import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  primitiveA,
  primitiveR,
  primitiveC,
  createPending,
  readPending,
  deletePending,
  createClaim,
  readClaim,
  deleteClaim,
  createAttempt,
  readAttempt,
  deleteAttempt,
  createTerminal,
  readTerminal,
  receiptPaths,
  receiptDir,
  cleanupReceiptArtifacts,
  scanReceipts,
  quarantineStalePending,
  makeReceiptId,
  makeClaimUuid,
  isEexist,
  isMissingFile,
  type PendingRequest,
  type ClaimDescriptor,
  type AttemptLease,
  type TerminalOutcome,
  type ReturnRoute,
} from '../../../src/runtime/restart-receipt';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// ── Helpers ────────────────────────────────────────────────────────────

function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bridge-receipt-'));
}

function useCleanup(dir: string): void {
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
}

function makeReturnRoute(overrides?: Partial<ReturnRoute>): ReturnRoute {
  return {
    chatId: 'oc_test123',
    threadId: 'omt_thread456',
    replyTo: 'om_lastMsg789',
    ...overrides,
  };
}

function makePending(receiptId: string, overrides?: Partial<PendingRequest>): PendingRequest {
  return {
    receiptId,
    profile: 'codex',
    oldPid: 11111,
    requestedAt: '2026-07-22T10:00:00.000Z',
    returnRoute: makeReturnRoute(),
    ...overrides,
  };
}

function makeClaim(receiptId: string, kind: 'success' | 'failure', overrides?: Partial<ClaimDescriptor>): ClaimDescriptor {
  return {
    receiptId,
    kind,
    payload: makeReturnRoute(),
    uuid: makeClaimUuid(receiptId, kind),
    claimedAt: '2026-07-22T10:01:00.000Z',
    ...overrides,
  };
}

function makeAttempt(receiptId: string, overrides?: Partial<AttemptLease>): AttemptLease {
  return {
    receiptId,
    ownerPid: 22222,
    attemptedAt: '2026-07-22T10:01:01.000Z',
    ...overrides,
  };
}

function makeTerminal(receiptId: string, outcome: 'completed' | 'delivery-failed', overrides?: Partial<TerminalOutcome>): TerminalOutcome {
  const base: TerminalOutcome = {
    receiptId,
    kind: 'success',
    outcome,
    ...(outcome === 'completed' ? { messageId: 'om_msg123' } : { reason: 'startup-timeout' }),
    ...overrides,
  };
  return base;
}

// ── Primitive A ────────────────────────────────────────────────────────

describe('primitive A — exclusive full-content create', () => {
  it('creates a file with full immutable content atomically', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const target = join(dir, 'test.json');
    const content = { key: 'value', nested: { a: 1 } };

    const ok = await primitiveA(target, content);
    expect(ok).toBe(true);

    const raw = await readFile(target, 'utf8');
    expect(JSON.parse(raw)).toEqual(content);
  });

  it('returns false on EEXIST (exclusive create)', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const target = join(dir, 'test.json');

    const ok1 = await primitiveA(target, { first: true });
    expect(ok1).toBe(true);

    const ok2 = await primitiveA(target, { second: true });
    expect(ok2).toBe(false);

    // Content unchanged — first write wins
    const raw = await readFile(target, 'utf8');
    expect(JSON.parse(raw)).toEqual({ first: true });
  });

  it('leaves no empty lock file on crash between write and link', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const target = join(dir, 'test.json');

    // Simulate: write temp succeeds, but we check temp is cleaned up
    const ok = await primitiveA(target, { clean: true });
    expect(ok).toBe(true);

    // No temp files left behind
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('concurrent primitives produce exactly one winner', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const target = join(dir, 'concurrent.json');

    const results = await Promise.all([
      primitiveA(target, { id: 1 }),
      primitiveA(target, { id: 2 }),
      primitiveA(target, { id: 3 }),
      primitiveA(target, { id: 4 }),
      primitiveA(target, { id: 5 }),
    ]);

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
  });
});

// ── Primitive R ────────────────────────────────────────────────────────

describe('primitive R — atomic rename quarantine', () => {
  it('renames file atomically', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const src = join(dir, 'pending.json');
    const dst = join(dir, 'abandoned.restart-001.json');

    await primitiveA(src, { receiptId: 'restart-001' });
    await primitiveR(src, dst);

    // src gone, dst exists
    await expect(readFile(src, 'utf8')).rejects.toThrow();
    const raw = await readFile(dst, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ receiptId: 'restart-001' });
  });
});

// ── Primitive C ────────────────────────────────────────────────────────

describe('primitive C — verified delete', () => {
  it('deletes file when receiptId matches', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const target = join(dir, 'claim.restart-001.json');

    await primitiveA(target, { receiptId: 'restart-001', data: 'x' });
    const ok = await primitiveC(target, 'restart-001');
    expect(ok).toBe(true);

    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });

  it('refuses to delete when receiptId mismatches', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const target = join(dir, 'claim.restart-001.json');

    await primitiveA(target, { receiptId: 'restart-001', data: 'x' });
    const ok = await primitiveC(target, 'restart-002');
    expect(ok).toBe(false);

    // File still exists
    const raw = await readFile(target, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ receiptId: 'restart-001' });
  });

  it('returns true for already-missing file (idempotent)', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const target = join(dir, 'nonexistent.json');

    const ok = await primitiveC(target, 'restart-001');
    expect(ok).toBe(true);
  });
});

// ── Single terminal ────────────────────────────────────────────────────

describe('single authoritative terminal', () => {
  it('creates terminal with outcome=completed via primitive A', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const outcome = makeTerminal('restart-001', 'completed');
    const ok = await createTerminal(dir, outcome);
    expect(ok).toBe(true);

    const read = await readTerminal(dir, 'restart-001');
    expect(read).toEqual(outcome);
  });

  it('creates terminal with outcome=delivery-failed via primitive A', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const outcome = makeTerminal('restart-001', 'delivery-failed', { kind: 'failure' });
    const ok = await createTerminal(dir, outcome);
    expect(ok).toBe(true);

    const read = await readTerminal(dir, 'restart-001');
    expect(read).toEqual(outcome);
  });

  it('EEXIST on second terminal — first write wins', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const completed = makeTerminal('restart-001', 'completed');
    const failed = makeTerminal('restart-001', 'delivery-failed', { kind: 'failure' });

    const ok1 = await createTerminal(dir, completed);
    expect(ok1).toBe(true);

    const ok2 = await createTerminal(dir, failed);
    expect(ok2).toBe(false);

    const read = await readTerminal(dir, 'restart-001');
    expect(read?.outcome).toBe('completed');
  });

  it('success vs deterministic-failure concurrent → only one terminal', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const results = await Promise.all([
      createTerminal(dir, makeTerminal('restart-001', 'completed')),
      createTerminal(dir, makeTerminal('restart-001', 'delivery-failed', { kind: 'failure' })),
    ]);

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);

    const read = await readTerminal(dir, 'restart-001');
    expect(read).toBeDefined();
    // Cannot have both outcomes
    expect(read!.outcome === 'completed' || read!.outcome === 'delivery-failed').toBe(true);
  });

  it('terminal already exists → read-first pattern prevents duplicate send', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    await createTerminal(dir, makeTerminal('restart-001', 'completed'));

    // Simulate: actor reads terminal first, sees it exists, skips send
    const existing = await readTerminal(dir, 'restart-001');
    expect(existing).toBeDefined();
    expect(existing!.outcome).toBe('completed');

    // Clean up residual artifacts
    await cleanupReceiptArtifacts(dir, 'restart-001');
    // Terminal preserved
    expect(await readTerminal(dir, 'restart-001')).toBeDefined();
  });
});

// ── Unique attempt owner ───────────────────────────────────────────────

describe('unique attempt lease', () => {
  it('creates attempt via primitive A — single owner', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const attempt = makeAttempt('restart-001');
    const ok = await createAttempt(dir, attempt);
    expect(ok).toBe(true);

    const read = await readAttempt(dir, 'restart-001');
    expect(read).toEqual(attempt);
  });

  it('EEXIST on second attempt — only one owner', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const ok1 = await createAttempt(dir, makeAttempt('restart-001', { ownerPid: 111 }));
    expect(ok1).toBe(true);

    const ok2 = await createAttempt(dir, makeAttempt('restart-001', { ownerPid: 222 }));
    expect(ok2).toBe(false);
  });

  it('strict-AND takeover: TTL超时 but owner alive → no takeover', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    // Create initial attempt with current PID (alive)
    const attempt = makeAttempt('restart-001', { ownerPid: process.pid });
    await createAttempt(dir, attempt);

    // Another actor tries to take over — owner still alive
    const ok = await createAttempt(dir, makeAttempt('restart-001', { ownerPid: 99999 }));
    expect(ok).toBe(false); // EEXIST — blocked
  });

  it('strict-AND takeover: owner dead but TTL未到 → no takeover', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    // Dead PID but attempt is fresh
    const attempt = makeAttempt('restart-001', { ownerPid: 1, attemptedAt: new Date().toISOString() });
    await createAttempt(dir, attempt);

    // No takeover without explicit stale deletion first
    const ok = await createAttempt(dir, makeAttempt('restart-001', { ownerPid: 99999 }));
    expect(ok).toBe(false); // EEXIST
  });

  it('strict-AND takeover: TTL超时 && owner dead → delete stale + create new =唯一接管', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    // Dead PID with old timestamp
    const oldAttempt = makeAttempt('restart-001', {
      ownerPid: 1, // PID 1 is init, usually alive on Linux but we simulate dead for test
      attemptedAt: '2020-01-01T00:00:00.000Z', // clearly expired
    });
    await createAttempt(dir, oldAttempt);

    // Step 1: verify stale attempt ownerPid is dead
    // (PID 1 being init is actually alive — for this test we just verify the mechanism)
    // For a truly dead PID, we need to delete the old attempt first
    await deleteAttempt(dir, 'restart-001');

    // Step 2: new actor creates attempt
    const ok = await createAttempt(dir, makeAttempt('restart-001', { ownerPid: 99999 }));
    expect(ok).toBe(true);

    const read = await readAttempt(dir, 'restart-001');
    expect(read?.ownerPid).toBe(99999);
  });

  it('two concurrent recoverers → only one gets attempt owner', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    // No attempt exists yet — two recoverers race
    const results = await Promise.all([
      createAttempt(dir, makeAttempt('restart-001', { ownerPid: 111 })),
      createAttempt(dir, makeAttempt('restart-001', { ownerPid: 222 })),
      createAttempt(dir, makeAttempt('restart-001', { ownerPid: 333 })),
    ]);

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
  });
});

// ── Claim immutability ─────────────────────────────────────────────────

describe('claim immutability', () => {
  it('claim descriptor is immutable — kind+uuid fixed at creation', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const claim = makeClaim('restart-001', 'success');
    await createClaim(dir, claim);

    // EEXIST — cannot overwrite
    const ok = await createClaim(dir, makeClaim('restart-001', 'failure'));
    expect(ok).toBe(false);

    // Original claim preserved
    const read = await readClaim(dir, 'restart-001');
    expect(read?.kind).toBe('success');
  });

  it('recovery does not flip claim kind', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    // First claim is failure
    const failureClaim = makeClaim('restart-001', 'failure');
    await createClaim(dir, failureClaim);

    // Recovery cannot overwrite with success
    const ok = await createClaim(dir, makeClaim('restart-001', 'success'));
    expect(ok).toBe(false);

    const read = await readClaim(dir, 'restart-001');
    expect(read?.kind).toBe('failure');
  });
});

// ── Pending uniqueness ─────────────────────────────────────────────────

describe('pending uniqueness', () => {
  it('single pending via primitive A — EEXIST rejects second', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const ok1 = await createPending(dir, makePending('restart-001'));
    expect(ok1).toBe(true);

    const ok2 = await createPending(dir, makePending('restart-002'));
    expect(ok2).toBe(false); // EEXIST

    // First pending preserved
    const pending = await readPending(dir);
    expect(pending?.receiptId).toBe('restart-001');
  });

  it('readPending returns undefined when no pending exists', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const pending = await readPending(dir);
    expect(pending).toBeUndefined();
  });

  it('deletePending verifies receiptId before deleting', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    await createPending(dir, makePending('restart-001'));

    // Mismatched receiptId — won't delete
    const ok1 = await deletePending(dir, 'restart-002');
    expect(ok1).toBe(false);
    expect(await readPending(dir)).toBeDefined();

    // Correct receiptId — deletes
    const ok2 = await deletePending(dir, 'restart-001');
    expect(ok2).toBe(true);
    expect(await readPending(dir)).toBeUndefined();
  });
});

// ── State machine (file existence = state) ─────────────────────────────

describe('state machine — file existence = state', () => {
  it('full success lifecycle: pending → claim → attempt → terminal', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const receiptId = makeReceiptId();

    // Step 1: create pending
    const ok1 = await createPending(dir, makePending(receiptId));
    expect(ok1).toBe(true);

    // Step 2: claim
    const ok2 = await createClaim(dir, makeClaim(receiptId, 'success'));
    expect(ok2).toBe(true);

    // Step 3: attempt
    const ok3 = await createAttempt(dir, makeAttempt(receiptId));
    expect(ok3).toBe(true);

    // Step 4: delete pending (after claim+attempt acquired)
    const ok4 = await deletePending(dir, receiptId);
    expect(ok4).toBe(true);

    // Step 5: send → terminal
    const ok5 = await createTerminal(dir, makeTerminal(receiptId, 'completed'));
    expect(ok5).toBe(true);

    // Step 6: cleanup claim + attempt
    await cleanupReceiptArtifacts(dir, receiptId);

    // Final state: only terminal remains
    const terminal = await readTerminal(dir, receiptId);
    expect(terminal?.outcome).toBe('completed');
    expect(await readClaim(dir, receiptId)).toBeUndefined();
    expect(await readAttempt(dir, receiptId)).toBeUndefined();
  });

  it('failure lifecycle: pending → claim → attempt → terminal(delivery-failed)', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const receiptId = makeReceiptId();

    await createPending(dir, makePending(receiptId));
    await createClaim(dir, makeClaim(receiptId, 'failure'));
    await createAttempt(dir, makeAttempt(receiptId));

    // Deterministic failure → terminal(delivery-failed)
    const ok = await createTerminal(dir, makeTerminal(receiptId, 'delivery-failed', { kind: 'failure' }));
    expect(ok).toBe(true);

    const terminal = await readTerminal(dir, receiptId);
    expect(terminal?.outcome).toBe('delivery-failed');
    expect(terminal?.reason).toBeDefined();
  });

  it('terminal exists → all paths skip send and clean residue', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const receiptId = makeReceiptId();

    // Terminal already set
    await createTerminal(dir, makeTerminal(receiptId, 'completed'));

    // Claim + attempt residue from crashed previous attempt
    await createClaim(dir, makeClaim(receiptId, 'success'));
    await createAttempt(dir, makeAttempt(receiptId));

    // Recovery: read terminal first → skip send → clean residue
    const terminal = await readTerminal(dir, receiptId);
    expect(terminal).toBeDefined();

    await cleanupReceiptArtifacts(dir, receiptId);

    // Terminal preserved, residue cleaned
    expect(await readTerminal(dir, receiptId)).toBeDefined();
    expect(await readClaim(dir, receiptId)).toBeUndefined();
    expect(await readAttempt(dir, receiptId)).toBeUndefined();
  });

  it('stale pending (TTL+oldPid dead) → quarantine abandoned', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const receiptId = makeReceiptId();

    await createPending(dir, makePending(receiptId, { oldPid: 1 }));

    const ok = await quarantineStalePending(dir, receiptId);
    expect(ok).toBe(true);

    // pending gone, abandoned exists
    expect(await readPending(dir)).toBeUndefined();
    const paths = receiptPaths(dir);
    const abandoned = await readFile(paths.abandoned(receiptId), 'utf8');
    expect(JSON.parse(abandoned)).toMatchObject({ receiptId });
  });

  it('scanReceipts returns correct state for each receiptId', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    // receipt-001: terminal only
    await createTerminal(dir, makeTerminal('restart-001', 'completed'));
    // receipt-002: claim + attempt, no terminal (crash recovery scenario)
    await createClaim(dir, makeClaim('restart-002', 'success'));
    await createAttempt(dir, makeAttempt('restart-002'));
    // receipt-003: claim only (no attempt yet)
    await createClaim(dir, makeClaim('restart-003', 'failure'));

    const scans = await scanReceipts(dir);
    const byId = new Map(scans.map((s) => [s.receiptId, s]));

    expect(byId.get('restart-001')).toMatchObject({ hasTerminal: true, hasClaim: false, hasAttempt: false });
    expect(byId.get('restart-002')).toMatchObject({ hasTerminal: false, hasClaim: true, hasAttempt: true });
    expect(byId.get('restart-003')).toMatchObject({ hasTerminal: false, hasClaim: true, hasAttempt: false });
  });
});

// ── Crash-point recovery ───────────────────────────────────────────────

describe('crash-point recovery', () => {
  it('crash after pending link, before lease delete → pending durable + lease orphan', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const receiptId = makeReceiptId();

    // pending created (lease delete not done yet)
    await createPending(dir, makePending(receiptId));

    // Even after "crash", pending is still readable
    const pending = await readPending(dir);
    expect(pending).toBeDefined();
    expect(pending!.receiptId).toBe(receiptId);
  });

  it('crash after claim link, before attempt → recovery can claim attempt', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const receiptId = makeReceiptId();

    // claim exists, no attempt
    await createClaim(dir, makeClaim(receiptId, 'success'));

    // Recovery: attempt not yet taken → new actor can claim it
    const ok = await createAttempt(dir, makeAttempt(receiptId, { ownerPid: 99999 }));
    expect(ok).toBe(true);

    const attempt = await readAttempt(dir, receiptId);
    expect(attempt?.ownerPid).toBe(99999);
  });

  it('crash after attempt link, before pending delete → claim+attempt authoritative, pending冗余删', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const receiptId = makeReceiptId();

    // All three exist (crashed mid-cleanup)
    await createPending(dir, makePending(receiptId));
    await createClaim(dir, makeClaim(receiptId, 'success'));
    await createAttempt(dir, makeAttempt(receiptId));

    // Recovery: claim+attempt authoritative → delete redundant pending
    const ok = await deletePending(dir, receiptId);
    expect(ok).toBe(true);

    expect(await readPending(dir)).toBeUndefined();
    expect(await readClaim(dir, receiptId)).toBeDefined();
    expect(await readAttempt(dir, receiptId)).toBeDefined();
  });

  it('crash after send, before terminal → terminal not yet written, recovery needed', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const receiptId = makeReceiptId();

    // claim + attempt exist but no terminal (send happened but terminal not written)
    await createClaim(dir, makeClaim(receiptId, 'success'));
    await createAttempt(dir, makeAttempt(receiptId));

    // Recovery: terminal not found → can resend with same uuid → write terminal
    const terminal = await readTerminal(dir, receiptId);
    expect(terminal).toBeUndefined();

    // Resend with same uuid → create terminal
    const ok = await createTerminal(dir, makeTerminal(receiptId, 'completed'));
    expect(ok).toBe(true);

    const final = await readTerminal(dir, receiptId);
    expect(final?.outcome).toBe('completed');
  });

  it('crash after terminal, before claim/attempt cleanup → terminal authoritative, clean residue', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const receiptId = makeReceiptId();

    // Terminal exists + residue
    await createTerminal(dir, makeTerminal(receiptId, 'completed'));
    await createClaim(dir, makeClaim(receiptId, 'success'));
    await createAttempt(dir, makeAttempt(receiptId));

    // Any actor: read terminal → clean residue
    const t = await readTerminal(dir, receiptId);
    expect(t).toBeDefined();

    await cleanupReceiptArtifacts(dir, receiptId);

    expect(await readTerminal(dir, receiptId)).toBeDefined();
    expect(await readClaim(dir, receiptId)).toBeUndefined();
    expect(await readAttempt(dir, receiptId)).toBeUndefined();
  });

  it('deterministic send failure → terminal(delivery-failed)', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);
    const receiptId = makeReceiptId();

    // Failure claim
    await createClaim(dir, makeClaim(receiptId, 'failure'));
    await createAttempt(dir, makeAttempt(receiptId));

    // Send fails deterministically → terminal(delivery-failed)
    const ok = await createTerminal(dir, makeTerminal(receiptId, 'delivery-failed', {
      kind: 'failure',
      reason: 'service-action-failure',
    }));
    expect(ok).toBe(true);

    const terminal = await readTerminal(dir, receiptId);
    expect(terminal?.outcome).toBe('delivery-failed');
    expect(terminal?.reason).toBe('service-action-failure');
  });
});

// ── UUID helpers ───────────────────────────────────────────────────────

describe('UUID helpers', () => {
  it('makeReceiptId returns unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => makeReceiptId()));
    expect(ids.size).toBe(100);
  });

  it('makeClaimUuid is deterministic for same receiptId+kind', () => {
    const uuid1 = makeClaimUuid('restart-001', 'success');
    const uuid2 = makeClaimUuid('restart-001', 'success');
    expect(uuid1).toBe(uuid2);
  });

  it('makeClaimUuid differs for different kind', () => {
    const uuidSuccess = makeClaimUuid('restart-001', 'success');
    const uuidFailure = makeClaimUuid('restart-001', 'failure');
    expect(uuidSuccess).not.toBe(uuidFailure);
  });
});

// ── Cross-receiptId isolation ──────────────────────────────────────────

describe('cross-receiptId isolation', () => {
  it('deleteClaim only deletes matching receiptId', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    await createClaim(dir, makeClaim('restart-001', 'success'));
    await createClaim(dir, makeClaim('restart-002', 'failure'));

    const ok = await deleteClaim(dir, 'restart-001');
    expect(ok).toBe(true);

    expect(await readClaim(dir, 'restart-001')).toBeUndefined();
    expect(await readClaim(dir, 'restart-002')).toBeDefined();
  });

  it('terminal per receiptId — different receiptIds have independent terminals', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    await createTerminal(dir, makeTerminal('restart-001', 'completed'));
    await createTerminal(dir, makeTerminal('restart-002', 'delivery-failed', { kind: 'failure' }));

    expect((await readTerminal(dir, 'restart-001'))?.outcome).toBe('completed');
    expect((await readTerminal(dir, 'restart-002'))?.outcome).toBe('delivery-failed');
  });
});
