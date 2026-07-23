import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write.js';

// ── Types ──

export interface StopControlEntry {
  /** Dedup fingerprint. */
  fingerprint: string;
  /** 'added' or 'removed' */
  action: 'added' | 'removed';
  /** Operator that performed the reaction. */
  operatorOpenId: string;
  /** Target message the reaction was on. */
  targetMessageId: string;
  /** Emoji type of the stop reaction. */
  emojiType: string;
  /** When the event was consumed. */
  consumedAt: number;
  /** For 'added': the result reply that was sent. */
  replyKind?: 'no-work' | 'stopped' | 'fail-closed';
}

export interface StopControlLedgerDocument {
  schemaVersion: 1;
  /** fingerprint → StopControlEntry */
  entries: Record<string, StopControlEntry>;
}

// ── Path ──

export function resolveControlLedgerPath(profileDir: string): string {
  return join(profileDir, 'reaction-stop-control.v1.json');
}

// ── Helpers ──

/**
 * Generate a stable dedup fingerprint from event fields.
 * Prefer a stable event_id from `evt.raw.header.event_id` if available,
 * otherwise use normalized fields + actionTime.
 */
export function stopEventFingerprint(
  operatorOpenId: string,
  targetMessageId: string,
  emojiType: string,
  action: 'added' | 'removed',
  actionTime?: number,
  stableId?: string,
): string {
  const hash = createHash('sha256');
  if (stableId) {
    hash.update(`id:${stableId}`);
  } else {
    // Canonical composite key — deterministic field order, \x1f separator.
    hash.update(
      `fields:${operatorOpenId}\x1f${targetMessageId}\x1f${emojiType}\x1f${action}\x1f${actionTime ?? 0}`,
    );
  }
  return hash.digest('hex');
}

// ── Serialization ──

function serialize(doc: StopControlLedgerDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function parseDoc(raw: string): StopControlLedgerDocument {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error('invalid stop control ledger: bad schemaVersion');
  }
  const doc = parsed as StopControlLedgerDocument;
  if (!doc.entries || typeof doc.entries !== 'object') {
    throw new Error('invalid stop control ledger: missing entries');
  }
  return doc;
}

// ── Ledger ──

export class StopControlLedger {
  private doc: StopControlLedgerDocument;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, initial?: StopControlLedgerDocument) {
    this.doc = initial ? structuredClone(initial) : { schemaVersion: 1, entries: {} };
  }

  /** Check if an event fingerprint has already been consumed. */
  isConsumed(fingerprint: string): boolean {
    return fingerprint in this.doc.entries;
  }

  /**
   * Find a matching stop-added entry for the given operator + target + emoji.
   * Used by the 'removed' path: removed only replies after matching a
   * previously-consumed added entry (F6/F7).
   */
  findMatchingAdded(
    operatorOpenId: string,
    targetMessageId: string,
    emojiType: string,
  ): { fingerprint: string; entry: StopControlEntry } | undefined {
    for (const [fp, entry] of Object.entries(this.doc.entries)) {
      if (
        entry.action === 'added' &&
        entry.operatorOpenId === operatorOpenId &&
        entry.targetMessageId === targetMessageId &&
        entry.emojiType === emojiType
      ) {
        return { fingerprint: fp, entry };
      }
    }
    return undefined;
  }

  /**
   * Record a consumed stop event. Persists atomically to disk.
   * Callers MUST check isConsumed() first — duplicate events are no-ops.
   */
  async record(
    fingerprint: string,
    action: 'added' | 'removed',
    operatorOpenId: string,
    targetMessageId: string,
    emojiType: string,
    replyKind?: StopControlEntry['replyKind'],
  ): Promise<StopControlEntry> {
    const transaction = this.queue.then(async () => {
      let disk: StopControlLedgerDocument;
      try {
        disk = parseDoc(await readFile(this.filePath, 'utf8'));
      } catch {
        disk = structuredClone(this.doc);
      }

      if (fingerprint in disk.entries) {
        return disk.entries[fingerprint]!;
      }

      const entry: StopControlEntry = {
        fingerprint,
        action,
        operatorOpenId,
        targetMessageId,
        emojiType,
        consumedAt: Date.now(),
        replyKind,
      };
      disk.entries[fingerprint] = entry;
      await this.persist(disk);
      this.doc = disk;
      return entry;
    });
    this.queue = transaction.then(
      () => undefined,
      () => undefined,
    );
    return transaction;
  }

  /** Return a shallow snapshot of all consumed entries. */
  allEntries(): StopControlEntry[] {
    return Object.values(this.doc.entries);
  }

  private async persist(doc: StopControlLedgerDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFileAtomic(this.filePath, serialize(doc), { mode: 0o600 });
  }
}

// ── Factory ──

export async function loadStopControlLedger(
  profileDir: string,
): Promise<StopControlLedger> {
  const path = resolveControlLedgerPath(profileDir);
  let doc: StopControlLedgerDocument | undefined;
  try {
    doc = parseDoc(await readFile(path, 'utf8'));
  } catch {
    // Missing or corrupt — start fresh.
  }
  return new StopControlLedger(path, doc);
}
