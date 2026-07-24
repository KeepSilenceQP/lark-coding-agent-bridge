import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write.js';
import type { ReactionKey, ReactionLedgerEntry } from './types';

// ── Document shape ──

export interface ReactionLedgerDocument {
  schemaVersion: 1;
  /** Map of ReactionKey → ReactionLedgerEntry */
  entries: Record<string, ReactionLedgerEntry>;
}

// ── Paths ──

export function resolveReactionLedgerPath(profileDir: string): string {
  return join(profileDir, 'reaction-ledger.v1.json');
}

// ── Serialization ──

function serialize(doc: ReactionLedgerDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function parseLedger(raw: string): ReactionLedgerDocument {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error('invalid reaction ledger: bad schemaVersion');
  }
  const doc = parsed as ReactionLedgerDocument;
  if (!doc.entries || typeof doc.entries !== 'object') {
    throw new Error('invalid reaction ledger: missing entries map');
  }
  return doc;
}

// ── Ledger class ──

export class ReactionLedger {
  private doc: ReactionLedgerDocument;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    initial?: ReactionLedgerDocument,
  ) {
    this.doc = initial ? structuredClone(initial) : { schemaVersion: 1, entries: {} };
  }

  /** Current in-memory snapshot (not a disk read). */
  snapshot(): ReactionLedgerDocument {
    return structuredClone(this.doc);
  }

  get(key: ReactionKey): ReactionLedgerEntry | undefined {
    const entry = this.doc.entries[key];
    return entry ? { ...entry } : undefined;
  }

  /**
   * Read-modify-write a single key. Persists to disk atomically.
   * Returns the new entry.
   */
  async updateEntry(
    key: ReactionKey,
    mutator: (current: ReactionLedgerEntry | undefined) => ReactionLedgerEntry,
  ): Promise<ReactionLedgerEntry> {
    const transaction = this.queue.then(async () => {
      // Re-read from disk to catch external changes
      let disk: ReactionLedgerDocument;
      try {
        disk = parseLedger(await readFile(this.filePath, 'utf8'));
      } catch {
        disk = structuredClone(this.doc);
      }
      const entry = mutator(disk.entries[key]);
      disk.entries[key] = entry;
      await this.persist(disk);
      this.doc = disk;
      return { ...entry };
    });
    this.queue = transaction.then(
      () => undefined,
      () => undefined,
    );
    return transaction;
  }

  private async persist(doc: ReactionLedgerDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFileAtomic(this.filePath, serialize(doc), { mode: 0o600 });
  }
}

// ── Factory ──

export async function loadReactionLedger(
  profileDir: string,
): Promise<ReactionLedger> {
  const path = resolveReactionLedgerPath(profileDir);
  let doc: ReactionLedgerDocument | undefined;
  try {
    doc = parseLedger(await readFile(path, 'utf8'));
  } catch {
    // File missing or corrupt — start fresh.
  }
  return new ReactionLedger(path, doc);
}

// ── Fingerprint helpers ──

import { createHash } from 'node:crypto';
import type { CanonicalReactionRecord } from './types';

/**
 * Compute a canonical fingerprint from a set of reaction records.
 *
 * 1. Dedup by reaction_id (if present), then by stable composite key
 *    (operator_type + operator_id + emoji_type) as secondary dedup (F8/F9).
 * 2. Normalize to { operator_type, operator_id, emoji_type }.
 * 3. Deterministic sort by operator_id then emoji_type (case-sensitive).
 * 4. Serialize with explicit sorted-field order (cross-platform deterministic
 *    byte order — no reliance on JSON.stringify key insertion order).
 * 5. SHA-256 hash of the serialized representation.
 */
/** Byte-order comparison (F8): compares strings by UTF-16 code units,
 *  producing the same order on any platform/locale. */
function byteCompare(a: string, b: string): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

export function computeCanonicalFingerprint(records: CanonicalReactionRecord[]): string {
  // Primary dedup: by reaction_id when available
  const seenIds = new Set<string>();
  // Secondary dedup (F8/F9): by stable composite key to prevent pseudo-revision
  // when the same logical record appears with different reaction_ids across pages.
  const seenComposite = new Set<string>();
  const deduped: CanonicalReactionRecord[] = [];

  for (const r of records) {
    if (r.reaction_id) {
      if (seenIds.has(r.reaction_id)) continue;
      seenIds.add(r.reaction_id);
    }
    const compositeKey = `${r.operator_type}\x1f${r.operator_id}\x1f${r.emoji_type}`;
    if (seenComposite.has(compositeKey)) continue;
    seenComposite.add(compositeKey);
    deduped.push(r);
  }

  // Stable sort: operator_id then emoji_type (case-sensitive)
  const sorted = deduped
    .map((r) => ({ operator_type: r.operator_type, operator_id: r.operator_id, emoji_type: r.emoji_type }))
    .sort((a, b) => {
      // F8: Use code-unit/byte comparator (not localeCompare) for
      // cross-platform deterministic ordering regardless of locale.
      const cmpId = byteCompare(a.operator_id, b.operator_id);
      if (cmpId !== 0) return cmpId;
      return byteCompare(a.emoji_type, b.emoji_type);
    });

  // Cross-platform deterministic serialization (F8): explicit field order
  // using a format that is guaranteed to produce identical bytes on any
  // platform / endianness.
  const hash = createHash('sha256');
  for (const item of sorted) {
    hash.update(`ot:${item.operator_type}\x1foi:${item.operator_id}\x1fet:${item.emoji_type}\x1f`);
  }
  return hash.digest('hex');
}

/** Empty set fingerprint — used when no reactions exist. */
export const EMPTY_FINGERPRINT = computeCanonicalFingerprint([]);
