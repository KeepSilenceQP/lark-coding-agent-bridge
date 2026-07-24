import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

// ── Ordered-unit deque ──
// Every arrival is appended as a unit. Consecutive regular messages merge into
// the tail regular unit (debounce). Barriers are always independent units and
// never merge. This preserves exact arrival order for interleaved regular +
// barrier traffic.

type PendingUnit =
  | { kind: 'regular'; messages: NormalizedMessage[] }
  | { kind: 'barrier'; message: NormalizedMessage };

function unitLength(u: PendingUnit): number {
  return u.kind === 'regular' ? u.messages.length : 1;
}

interface PendingEntry {
  units: PendingUnit[]; // FIFO ordered
  timer?: NodeJS.Timeout;
}

function totalLength(entry: PendingEntry): number {
  let n = 0;
  for (const u of entry.units) n += unitLength(u);
  return n;
}

export type FlushHandler = (scope: string, batch: NormalizedMessage[]) => void;

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 *
 * Internally stores arrivals as ordered FIFO units. Consecutive regular
 * messages merge into the tail regular unit (standard debounce). Barriers are
 * always independent units and never merge — this guarantees that a barrier
 * arriving after a regular message is flushed after it, and vice versa.
 *
 * `block(scope)` pauses the timer while an agent run is active.  Arrivals
 * still accumulate. `unblock(scope)` arms a fresh quiet window if anything is
 * queued.
 *
 * Only ONE unit is ever flushed per call — never multiple units in one go.
 * The onFlush callback is expected to call block(scope) synchronously, which
 * prevents the next unit from firing until the run finishes and unblock is
 * called.
 */
export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  private readonly delayMs: number;
  private readonly onFlush: FlushHandler;

  constructor(delayMs: number, onFlush: FlushHandler) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
  }

  // ── push (regular message) ──

  push(scope: string, msg: NormalizedMessage): number {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      const last = existing.units[existing.units.length - 1];
      if (last && last.kind === 'regular') {
        last.messages.push(msg);
      } else {
        existing.units.push({ kind: 'regular', messages: [msg] });
      }
      existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope);
      return totalLength(existing);
    }
    this.map.set(scope, {
      units: [{ kind: 'regular', messages: [msg] }],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
    });
    return 1;
  }

  // ── pushBarrier (reaction turn — independent unit, never merged) ──

  pushBarrier(scope: string, msg: NormalizedMessage): void {
    if (this.blocked.has(scope)) {
      // Active run in progress — append to queue, don't flush anything.
      const existing = this.map.get(scope);
      if (existing) {
        existing.units.push({ kind: 'barrier', message: msg });
      } else {
        this.map.set(scope, { units: [{ kind: 'barrier', message: msg }] });
      }
      return;
    }

    // Not blocked: flush the FIRST pending unit (if any) so that messages
    // arriving before this barrier are delivered first.  onFlush will call
    // block(scope) — only one unit is ever consumed here.
    this.flushFirstUnit(scope);

    // flushFirstUnit may have triggered onFlush → block(scope).  Re-check
    // before arming a timer so the new barrier doesn't fire during the run.
    this.map.set(scope, {
      units: [{ kind: 'barrier', message: msg }],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
    });
  }

  // ── cancel / cancelMessage ──

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    const out: NormalizedMessage[] = [];
    for (const u of entry.units) {
      if (u.kind === 'regular') out.push(...u.messages);
      else out.push(u.message);
    }
    return out;
  }

  /**
   * Per-key cancel: remove only messages matching a specific messageId.
   * Searches all units while preserving order of remaining units.
   */
  cancelMessage(scope: string, messageId: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    const removed: NormalizedMessage[] = [];
    const kept: PendingUnit[] = [];

    for (const u of entry.units) {
      if (u.kind === 'regular') {
        const keptMsgs: NormalizedMessage[] = [];
        for (const m of u.messages) {
          if (m.messageId === messageId) removed.push(m);
          else keptMsgs.push(m);
        }
        if (keptMsgs.length > 0) kept.push({ kind: 'regular', messages: keptMsgs });
      } else {
        if (u.message.messageId === messageId) {
          removed.push(u.message);
        } else {
          kept.push(u);
        }
      }
    }

    if (removed.length === 0) return [];

    if (kept.length === 0) {
      if (entry.timer) clearTimeout(entry.timer);
      this.map.delete(scope);
    } else {
      entry.units = kept;
      if (!this.blocked.has(scope)) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = this.armTimer(scope);
      }
    }
    return removed;
  }

  cancelAll(): void {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
  }

  // ── block / unblock ──

  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    log.info('queue', 'blocked', { scope, queued: entry ? totalLength(entry) : 0 });
  }

  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: entry ? totalLength(entry) : 0 });
    if (!entry || entry.units.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }

  // ── query ──

  pendingCount(scope: string): number {
    const entry = this.map.get(scope);
    return entry ? totalLength(entry) : 0;
  }

  isBlocked(scope: string): boolean {
    return this.blocked.has(scope);
  }

  // ── private ──

  /** Flush the FIRST unit only. If more units remain and scope is NOT blocked, arm timer. */
  private flushFirstUnit(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry || entry.units.length === 0) return;

    const unit = entry.units.shift()!;

    if (entry.units.length === 0) {
      this.map.delete(scope);
      if (entry.timer) clearTimeout(entry.timer);
    } else if (!this.blocked.has(scope)) {
      // Scope not yet blocked (onFlush hasn't fired).  Arm timer so the
      // next unit fires after the quiet window.  If onFlush calls block(),
      // the timer will be cleared synchronously — safe.
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = this.armTimer(scope);
    }
    // else: scope is already blocked — remaining units stay queued, no timer.

    if (unit.kind === 'regular') {
      try {
        this.onFlush(scope, unit.messages);
      } catch (err) {
        log.fail('queue', err, { scope, batchSize: unit.messages.length });
      }
    } else {
      try {
        this.onFlush(scope, [unit.message]);
      } catch (err) {
        log.fail('queue', err, { scope, batchSize: 1 });
      }
    }
  }

  // ── timer ──

  private armTimer(scope: string): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  /** Timer callback: flush ONE unit. If more remain, arm next timer. */
  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry || entry.units.length === 0) return;

    const unit = entry.units.shift()!;

    if (entry.units.length === 0) {
      this.map.delete(scope);
      if (entry.timer) clearTimeout(entry.timer);
    } else {
      // Arm timer for the next unit.  onFlush calls block() which clears
      // the timer synchronously, so this is effectively a no-op when the
      // scope is about to become active.
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = this.armTimer(scope);
    }

    if (unit.kind === 'regular') {
      try {
        this.onFlush(scope, unit.messages);
      } catch (err) {
        log.fail('queue', err, { scope, batchSize: unit.messages.length });
      }
    } else {
      try {
        this.onFlush(scope, [unit.message]);
      } catch (err) {
        log.fail('queue', err, { scope, batchSize: 1 });
      }
    }
  }
}
