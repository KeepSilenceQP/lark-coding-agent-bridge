import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { link, open } from 'node:fs/promises';
import { join } from 'node:path';

// ── Directory ──────────────────────────────────────────────────────────

const RECEIPT_DIR = 'restart-receipt';

export function receiptDir(profileDir: string): string {
  return join(profileDir, RECEIPT_DIR);
}

// ── Types ──────────────────────────────────────────────────────────────

export interface ReturnRoute {
  chatId: string;
  threadId?: string;
  replyTo: string;
}

export type ReceiptKind = 'success' | 'failure';

export interface PendingRequest {
  receiptId: string;
  profile: string;
  oldPid: number;
  requestedAt: string;
  returnRoute: ReturnRoute;
  deployRevision?: string;
}

export interface ClaimDescriptor {
  receiptId: string;
  kind: ReceiptKind;
  payload: ReturnRoute;
  uuid: string;
  claimedAt: string;
}

export interface AttemptLease {
  receiptId: string;
  ownerPid: number;
  attemptedAt: string;
}

export interface TerminalOutcome {
  receiptId: string;
  kind: ReceiptKind;
  outcome: 'completed' | 'delivery-failed';
  messageId?: string;
  reason?: string;
}

export interface ReceiptPaths {
  dir: string;
  pending: string;
  claim(receiptId: string): string;
  attempt(receiptId: string): string;
  terminal(receiptId: string): string;
  abandoned(receiptId: string): string;
}

export function receiptPaths(profileDir: string): ReceiptPaths {
  const dir = receiptDir(profileDir);
  return {
    dir,
    pending: join(dir, 'pending.json'),
    claim: (receiptId: string) => join(dir, `claim.${safeName(receiptId)}.json`),
    attempt: (receiptId: string) => join(dir, `attempt.${safeName(receiptId)}.json`),
    terminal: (receiptId: string) => join(dir, `terminal.${safeName(receiptId)}.json`),
    abandoned: (receiptId: string) => join(dir, `abandoned.${safeName(receiptId)}.json`),
  };
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ── Primitive A — exclusive full-content create ────────────────────────
//
// Writes temp file with full JSON → link(temp, target) → unlink(temp).
// link() is atomic and exclusive: EEXIST if target already exists.
// POSIX link / Windows CreateHardLink. Target appears with complete
// immutable content — no empty files / locks.

export async function primitiveA(
  target: string,
  content: object,
): Promise<boolean> {
  await mkdir(join(target, '..'), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(content)}\n`, 'utf8');
    await link(temp, target);
    return true;
  } catch (err) {
    if (isEexist(err)) return false;
    throw err;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

// ── Primitive R — atomic rename (quarantine) ───────────────────────────

export async function primitiveR(src: string, dst: string): Promise<void> {
  await mkdir(join(dst, '..'), { recursive: true });
  await rename(src, dst);
}

// ── Primitive C — verified delete ──────────────────────────────────────

export async function primitiveC(
  filePath: string,
  receiptId: string,
  idField: 'receiptId' | 'routeId' = 'receiptId',
): Promise<boolean> {
  try {
    const data = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    if (data[idField] !== receiptId) return false;
    await unlink(filePath);
    return true;
  } catch (err) {
    if (isMissingFile(err)) return true; // already gone = clean
    throw err;
  }
}

// ── Pending ────────────────────────────────────────────────────────────
//
// Creates pending.json via primitive A. EEXIST → reject (no overwrite).

export async function createPending(
  profileDir: string,
  request: PendingRequest,
): Promise<boolean> {
  const paths = receiptPaths(profileDir);
  return primitiveA(paths.pending, request);
}

export async function readPending(
  profileDir: string,
): Promise<PendingRequest | undefined> {
  const paths = receiptPaths(profileDir);
  try {
    return JSON.parse(await readFile(paths.pending, 'utf8')) as PendingRequest;
  } catch {
    return undefined;
  }
}

export async function deletePending(
  profileDir: string,
  receiptId: string,
): Promise<boolean> {
  const paths = receiptPaths(profileDir);
  return primitiveC(paths.pending, receiptId);
}

// ── Claim ──────────────────────────────────────────────────────────────
//
// Creates claim.<receiptId>.json via primitive A. Immutable: kind+uuid
// fixed at creation. EEXIST → already claimed.

export async function createClaim(
  profileDir: string,
  descriptor: ClaimDescriptor,
): Promise<boolean> {
  const paths = receiptPaths(profileDir);
  return primitiveA(paths.claim(descriptor.receiptId), descriptor);
}

export async function readClaim(
  profileDir: string,
  receiptId: string,
): Promise<ClaimDescriptor | undefined> {
  const paths = receiptPaths(profileDir);
  try {
    return JSON.parse(
      await readFile(paths.claim(receiptId), 'utf8'),
    ) as ClaimDescriptor;
  } catch {
    return undefined;
  }
}

export async function deleteClaim(
  profileDir: string,
  receiptId: string,
): Promise<boolean> {
  const paths = receiptPaths(profileDir);
  return primitiveC(paths.claim(receiptId), receiptId);
}

// ── Attempt ────────────────────────────────────────────────────────────
//
// Creates attempt.<receiptId>.json via primitive A. EEXIST → already owned.
// Only one owner per receiptId.

export async function createAttempt(
  profileDir: string,
  lease: AttemptLease,
): Promise<boolean> {
  const paths = receiptPaths(profileDir);
  return primitiveA(paths.attempt(lease.receiptId), lease);
}

export async function readAttempt(
  profileDir: string,
  receiptId: string,
): Promise<AttemptLease | undefined> {
  const paths = receiptPaths(profileDir);
  try {
    return JSON.parse(
      await readFile(paths.attempt(receiptId), 'utf8'),
    ) as AttemptLease;
  } catch {
    return undefined;
  }
}

export async function deleteAttempt(
  profileDir: string,
  receiptId: string,
): Promise<boolean> {
  const paths = receiptPaths(profileDir);
  return primitiveC(paths.attempt(receiptId), receiptId);
}

// ── Terminal ───────────────────────────────────────────────────────────
//
// Single authoritative terminal.<receiptId>.json via primitive A.
// outcome=completed|delivery-failed. Same schema, same target.
// EEXIST → terminal already set, all actors must use it.

export async function createTerminal(
  profileDir: string,
  outcome: TerminalOutcome,
): Promise<boolean> {
  const paths = receiptPaths(profileDir);
  return primitiveA(paths.terminal(outcome.receiptId), outcome);
}

export async function readTerminal(
  profileDir: string,
  receiptId: string,
): Promise<TerminalOutcome | undefined> {
  const paths = receiptPaths(profileDir);
  try {
    return JSON.parse(
      await readFile(paths.terminal(receiptId), 'utf8'),
    ) as TerminalOutcome;
  } catch {
    return undefined;
  }
}

// ── Stale quarantine ───────────────────────────────────────────────────

export async function quarantineStalePending(
  profileDir: string,
  receiptId: string,
): Promise<boolean> {
  const paths = receiptPaths(profileDir);
  try {
    // verify pending still exists before rename
    const pending = await readPending(profileDir);
    if (!pending || pending.receiptId !== receiptId) return false;
    await primitiveR(paths.pending, paths.abandoned(receiptId));
    return true;
  } catch (err) {
    if (isMissingFile(err)) return false;
    throw err;
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────

export async function cleanupReceiptArtifacts(
  profileDir: string,
  receiptId: string,
): Promise<void> {
  const paths = receiptPaths(profileDir);
  await deleteClaim(profileDir, receiptId).catch(() => {});
  await deleteAttempt(profileDir, receiptId).catch(() => {});
  // Don't clean terminal — it's the authoritative record.
}

// ── Scan ───────────────────────────────────────────────────────────────

export interface ReceiptScanEntry {
  receiptId: string;
  hasTerminal: boolean;
  hasClaim: boolean;
  hasAttempt: boolean;
}

export async function scanReceipts(
  profileDir: string,
): Promise<ReceiptScanEntry[]> {
  const dir = receiptDir(profileDir);
  let entries: { name: string }[];
  try {
    entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true })
      .then((items) => items.filter((d) => d.isFile()).map((d) => ({ name: d.name })));
  } catch {
    return [];
  }
  const map = new Map<string, ReceiptScanEntry>();
  for (const { name } of entries) {
    const m = name.match(/^(claim|attempt|terminal)\.(.+)\.json$/);
    if (!m || !m[1] || !m[2]) continue;
    const id: string = m[2];
    const kind: string = m[1];
    if (!map.has(id)) {
      map.set(id, { receiptId: id, hasTerminal: false, hasClaim: false, hasAttempt: false });
    }
    const entry = map.get(id)!;
    if (kind === 'claim') entry.hasClaim = true;
    else if (kind === 'attempt') entry.hasAttempt = true;
    else if (kind === 'terminal') entry.hasTerminal = true;
  }
  return [...map.values()];
}

// ── UUID helpers ───────────────────────────────────────────────────────

export function makeReceiptId(): string {
  return `restart-${randomUUID()}`;
}

// ── Deterministic UUIDv5 ────────────────────────────────────────────────
//
// RFC 4122 §4.3 UUIDv5: SHA-1(namespace || name) → set version=5,
// variant=10xx. Same receiptId+kind always produces the same UUID.
// Success and failure claims for the same receiptId get different UUIDs
// because the kind differs. Recovery preserves the descriptor's uuid
// so resends use the identical value.

const UUID_NAMESPACE_BYTES = hexToBytes(
  'a1b2c3d4e5f64789ab01cdef01234567', // Custom namespace for lark-channel-bridge receipts.
);

export function makeClaimUuid(receiptId: string, kind: ReceiptKind): string {
  const name = `${receiptId}:${kind}`;
  return uuidV5(UUID_NAMESPACE_BYTES, name);
}

export function isValidClaimUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function uuidV5(namespace: Uint8Array, name: string): string {
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1')
    .update(Buffer.from(namespace))
    .update(nameBytes)
    .digest();

  // Take first 16 bytes of SHA-1 output.
  const bytes = new Uint8Array(hash.buffer, hash.byteOffset, 16);

  // Set version nibble to 5 (byte index 6, high nibble = 0101).
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;

  // Set variant bits to 10 (byte index 8, top 2 bits = 10).
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return uuidString(bytes);
}

function uuidString(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// ── Orphan cleanup ─────────────────────────────────────────────────────

/**
 * Remove orphan .tmp files from the receipt directory that are older than
 * the given TTL. These are left behind when primitiveA crashes between
 * writeFile and link/unlink. Called on bridge startup.
 */
export async function cleanupOrphanTemps(
  profileDir: string,
  maxAgeMs = 60_000,
): Promise<number> {
  const dir = receiptDir(profileDir);
  let cleaned = 0;
  let entries: { name: string }[];
  try {
    entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true })
      .then((items) => items.filter((d) => d.isFile()).map((d) => ({ name: d.name })));
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const { name } of entries) {
    if (!name.endsWith('.tmp')) continue;
    const filePath = join(dir, name);
    try {
      const stat = await (await import('node:fs/promises')).stat(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await unlink(filePath);
        cleaned++;
      }
    } catch {
      // Corrupt/inaccessible — try to remove
      await unlink(filePath).catch(() => {});
      cleaned++;
    }
  }
  return cleaned;
}

// ── Helpers ────────────────────────────────────────────────────────────

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EEXIST';
}

function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export { isEexist, isMissingFile };
