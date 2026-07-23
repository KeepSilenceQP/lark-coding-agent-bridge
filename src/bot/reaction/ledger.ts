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
 * 1. Dedup by reaction_id (if present)
 * 2. Normalize to { operator_type, operator_id, emoji_type }
 * 3. Deterministic sort by operator_id then emoji_type (case-sensitive)
 * 4. SHA-256 hash of the sorted, stable JSON representation
 */
export function computeCanonicalFingerprint(records: CanonicalReactionRecord[]): string {
  // Dedup by reaction_id when available
  const seen = new Set<string>();
  const deduped: CanonicalReactionRecord[] = [];
  for (const r of records) {
    const dedupKey = r.reaction_id ?? `${r.operator_type}\x1f${r.operator_id}\x1f${r.emoji_type}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    deduped.push(r);
  }

  // Stable sort: operator_id then emoji_type (case-sensitive)
  const sorted = deduped
    .map((r) => ({ operator_type: r.operator_type, operator_id: r.operator_id, emoji_type: r.emoji_type }))
    .sort((a, b) => {
      const cmpId = a.operator_id.localeCompare(b.operator_id);
      if (cmpId !== 0) return cmpId;
      return a.emoji_type.localeCompare(b.emoji_type);
    });

  const hash = createHash('sha256');
  hash.update(JSON.stringify(sorted));
  return hash.digest('hex');
}

/** Empty set fingerprint — used when no reactions exist. */
export const EMPTY_FINGERPRINT = computeCanonicalFingerprint([]);
