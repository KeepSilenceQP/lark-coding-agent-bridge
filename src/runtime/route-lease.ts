import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReturnRoute } from './restart-receipt';
import { primitiveA, primitiveC, isMissingFile } from './restart-receipt';

// ── Directory ──────────────────────────────────────────────────────────

const LEASE_DIR = 'route-leases';

export function routeLeaseDir(profileDir: string): string {
  return join(profileDir, LEASE_DIR);
}

// ── Types ──────────────────────────────────────────────────────────────

export interface RouteLease {
  routeId: string;
  chatId: string;
  threadId?: string;
  replyTo: string;
  bridgePid: number;
  runId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface RouteLeaseInput {
  chatId: string;
  threadId?: string;
  replyTo: string;
  bridgePid: number;
  runId?: string;
  ttlMs?: number;
}

// ── Lease store ────────────────────────────────────────────────────────

const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function makeRouteId(): string {
  return `route-${randomUUID()}`;
}

export function leasePath(profileDir: string, routeId: string): string {
  return join(routeLeaseDir(profileDir), `${safeLeaseName(routeId)}.json`);
}

function safeLeaseName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Create a route lease via primitive A.
 * Returns the lease (with generated routeId) or null if EEXIST.
 */
export async function createRouteLease(
  profileDir: string,
  input: RouteLeaseInput,
): Promise<RouteLease | null> {
  const routeId = makeRouteId();
  const now = new Date();
  const ttl = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const lease: RouteLease = {
    routeId,
    chatId: input.chatId,
    threadId: input.threadId,
    replyTo: input.replyTo,
    bridgePid: input.bridgePid,
    runId: input.runId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
  const ok = await primitiveA(leasePath(profileDir, routeId), lease);
  return ok ? lease : null;
}

/**
 * Read a route lease by routeId.
 */
export async function readRouteLease(
  profileDir: string,
  routeId: string,
): Promise<RouteLease | undefined> {
  try {
    const data = await readFile(leasePath(profileDir, routeId), 'utf8');
    return JSON.parse(data) as RouteLease;
  } catch (err) {
    if (isMissingFile(err)) return undefined;
    throw err;
  }
}

/**
 * Delete a route lease by routeId (verified delete).
 */
export async function deleteRouteLease(
  profileDir: string,
  routeId: string,
): Promise<boolean> {
  return primitiveC(leasePath(profileDir, routeId), routeId, 'routeId');
}

/**
 * Validate a route lease: must exist, bridgePid must match, must not be expired.
 */
export async function validateRouteLease(
  profileDir: string,
  routeId: string,
  bridgePid: number,
): Promise<{ ok: true; lease: RouteLease } | { ok: false; reason: string }> {
  const lease = await readRouteLease(profileDir, routeId);
  if (!lease) {
    return { ok: false, reason: `route lease not found: ${routeId}` };
  }
  if (lease.bridgePid !== bridgePid) {
    return {
      ok: false,
      reason: `route lease bridgePid mismatch: expected ${bridgePid}, got ${lease.bridgePid}`,
    };
  }
  if (new Date(lease.expiresAt) < new Date()) {
    return { ok: false, reason: `route lease expired at ${lease.expiresAt}` };
  }
  return { ok: true, lease };
}

/**
 * Extract return route from a validated lease.
 */
export function returnRouteFromLease(lease: RouteLease): ReturnRoute {
  return {
    chatId: lease.chatId,
    threadId: lease.threadId,
    replyTo: lease.replyTo,
  };
}

/**
 * Clean up expired leases (TTL-based cleanup).
 */
export async function cleanupExpiredLeases(profileDir: string): Promise<number> {
  const dir = routeLeaseDir(profileDir);
  let files: { name: string }[];
  try {
    files = await readdir(dir, { withFileTypes: true }).then((items) =>
      items.filter((d) => d.isFile()).map((d) => ({ name: d.name })),
    );
  } catch {
    return 0;
  }
  let cleaned = 0;
  const now = new Date();
  for (const { name } of files) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(dir, name);
    try {
      const data = JSON.parse(await readFile(filePath, 'utf8')) as RouteLease;
      if (new Date(data.expiresAt) < now) {
        await unlink(filePath);
        cleaned++;
      }
    } catch {
      // corrupt file — clean it up
      await unlink(filePath).catch(() => {});
      cleaned++;
    }
  }
  return cleaned;
}
