import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRouteLease,
  readRouteLease,
  deleteRouteLease,
  validateRouteLease,
  returnRouteFromLease,
  cleanupExpiredLeases,
  makeRouteId,
  leasePath,
  routeLeaseDir,
  type RouteLease,
  type RouteLeaseInput,
} from '../../../src/runtime/route-lease';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bridge-route-lease-'));
}

function useCleanup(dir: string): void {
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
}

function makeInput(overrides?: Partial<RouteLeaseInput>): RouteLeaseInput {
  return {
    chatId: 'oc_test123',
    threadId: 'omt_thread456',
    replyTo: 'om_lastMsg789',
    bridgePid: 12345,
    runId: 'run-abc',
    ...overrides,
  };
}

describe('route lease store', () => {
  it('creates and reads a route lease', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const lease = await createRouteLease(dir, makeInput());
    expect(lease).not.toBeNull();
    expect(lease!.routeId).toMatch(/^route-/);
    expect(lease!.chatId).toBe('oc_test123');
    expect(lease!.threadId).toBe('omt_thread456');
    expect(lease!.replyTo).toBe('om_lastMsg789');
    expect(lease!.bridgePid).toBe(12345);

    const read = await readRouteLease(dir, lease!.routeId);
    expect(read).toEqual(lease);
  });

  it('each call generates a unique routeId', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const lease1 = await createRouteLease(dir, makeInput());
    const lease2 = await createRouteLease(dir, makeInput());

    expect(lease1!.routeId).not.toBe(lease2!.routeId);
  });

  it('deletes a route lease when routeId matches', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const lease = await createRouteLease(dir, makeInput());
    expect(await readRouteLease(dir, lease!.routeId)).toBeDefined();

    const ok = await deleteRouteLease(dir, lease!.routeId);
    expect(ok).toBe(true);

    expect(await readRouteLease(dir, lease!.routeId)).toBeUndefined();
  });

  it('validateRouteLease succeeds with correct bridgePid', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const lease = await createRouteLease(dir, makeInput({ bridgePid: 12345 }));
    const result = await validateRouteLease(dir, lease!.routeId, 12345);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lease.chatId).toBe('oc_test123');
    }
  });

  it('validateRouteLease fails with wrong bridgePid', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const lease = await createRouteLease(dir, makeInput({ bridgePid: 12345 }));
    const result = await validateRouteLease(dir, lease!.routeId, 99999);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('bridgePid mismatch');
    }
  });

  it('validateRouteLease fails for expired lease', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    // Create a lease that already expired
    const routeId = makeRouteId();
    const leasePath_ = leasePath(dir, routeId);
    const expiredLease: RouteLease = {
      routeId,
      chatId: 'oc_test',
      replyTo: 'om_msg',
      bridgePid: 12345,
      createdAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:01:00.000Z',
    };

    // Write directly (bypass createRouteLease which uses primitiveA)
    await (await import('node:fs/promises')).mkdir(join(leasePath_, '..'), { recursive: true });
    await (await import('node:fs/promises')).writeFile(leasePath_, `${JSON.stringify(expiredLease)}\n`, 'utf8');

    const result = await validateRouteLease(dir, routeId, 12345);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('expired');
    }
  });

  it('validateRouteLease fails for nonexistent lease', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const result = await validateRouteLease(dir, 'route-nonexistent', 12345);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not found');
    }
  });

  it('returnRouteFromLease extracts correct return route', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const lease = await createRouteLease(dir, makeInput({
      chatId: 'oc_chat123',
      threadId: 'omt_thread456',
      replyTo: 'om_reply789',
    }));

    const route = returnRouteFromLease(lease!);
    expect(route).toEqual({
      chatId: 'oc_chat123',
      threadId: 'omt_thread456',
      replyTo: 'om_reply789',
    });
  });

  it('returnRouteFromLease handles missing threadId', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const lease = await createRouteLease(dir, makeInput({ threadId: undefined }));
    const route = returnRouteFromLease(lease!);
    expect(route).toEqual({
      chatId: 'oc_test123',
      replyTo: 'om_lastMsg789',
    });
    expect(route.threadId).toBeUndefined();
  });

  it('cleans up expired leases', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    // Create 3 expired leases + 1 valid
    for (let i = 0; i < 3; i++) {
      const routeId = makeRouteId();
      const lp = leasePath(dir, routeId);
      const expired: RouteLease = {
        routeId,
        chatId: 'oc_test',
        replyTo: 'om_msg',
        bridgePid: 12345,
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:01:00.000Z',
      };
      await (await import('node:fs/promises')).mkdir(join(lp, '..'), { recursive: true });
      await (await import('node:fs/promises')).writeFile(lp, `${JSON.stringify(expired)}\n`, 'utf8');
    }

    // One valid lease
    const valid = await createRouteLease(dir, makeInput());

    const cleaned = await cleanupExpiredLeases(dir);
    expect(cleaned).toBeGreaterThanOrEqual(3);

    // Valid lease still exists
    expect(await readRouteLease(dir, valid!.routeId)).toBeDefined();
  });

  it('concurrent runs do not cross routes — separate leases per run', async () => {
    const dir = await makeTempDir();
    useCleanup(dir);

    const run1 = await createRouteLease(dir, makeInput({ chatId: 'oc_chatA', bridgePid: 111 }));
    const run2 = await createRouteLease(dir, makeInput({ chatId: 'oc_chatB', bridgePid: 222 }));

    expect(run1).not.toBeNull();
    expect(run2).not.toBeNull();
    expect(run1!.routeId).not.toBe(run2!.routeId);

    // Each run's lease is independent
    const r1 = await readRouteLease(dir, run1!.routeId);
    const r2 = await readRouteLease(dir, run2!.routeId);
    expect(r1?.chatId).toBe('oc_chatA');
    expect(r2?.chatId).toBe('oc_chatB');
  });
});
