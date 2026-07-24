import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

interface PendingEntry {
  /** Accumulated regular (non-barrier) messages. Flushed as a single batch. */
  messages: NormalizedMessage[];
  /** FIFO queue of barrier messages. Each is flushed as its own batch, never merged. */
  barriers: NormalizedMessage[];
  timer?: NodeJS.Timeout;
}

function totalLength(entry: PendingEntry): number {
  return entry.messages.length + entry.barriers.length;
}

export type FlushHandler = (scope: string, batch: NormalizedMessage[]) => void;

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * Accumulates messages within the same scope inside a quiet window, then
 * flushes as a single batch.
 *
 * `block(scope)` pauses the debounce timer while an agent run is active on
 * that scope — pushed messages still accumulate but no flush fires until
 * `unblock(scope)`, which arms a fresh quiet window.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 *
 * ## Reaction barrier (DD11)
 *
 * `pushBarrier(scope, msg)` creates an independent entry that never merges
 * with regular messages. When the scope is blocked (active run in progress),
 * barriers are queued FIFO and flushed one at a time after each unblock.
 * This preserves ordered delivery of multiple reaction turns during a run.
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

  push(scope: string, msg: NormalizedMessage): number {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope);
      return totalLength(existing);
    }
    this.map.set(scope, {
      messages: [msg],
      barriers: [],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
    });
    return 1;
  }

  /**
   * Push a barrier entry (e.g. Reaction turn). When the scope is NOT blocked,
   * flushes any pending messages + barriers first, then enqueues the new
   * barrier. When blocked, the barrier is appended to a FIFO queue — no
   * flush fires until unblock. This ensures barriers are never lost or
   * reordered during an active run.
   */
  pushBarrier(scope: string, msg: NormalizedMessage): void {
    if (this.blocked.has(scope)) {
      // Active run in progress — queue the barrier, don't flush anything.
      const existing = this.map.get(scope);
      if (existing) {
        existing.barriers.push(msg);
      } else {
        this.map.set(scope, { messages: [], barriers: [msg] });
      }
      return;
    }
    // Not blocked: drain everything that arrived before this barrier,
    // then enqueue the new barrier as its own entry.
    this.flushAll(scope);
    this.map.set(scope, {
      messages: [],
      barriers: [msg],
      timer: this.armTimer(scope),
    });
  }

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return [...entry.messages, ...entry.barriers];
  }

  /**
   * Per-key cancel: remove only messages matching a specific messageId
   * within a scope. Searches both regular messages and barriers.
   * Does NOT cancel other keys or regular messages in the same scope.
   */
  cancelMessage(scope: string, messageId: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    const removed: NormalizedMessage[] = [];

    // Search regular messages
    const keptMsgs: NormalizedMessage[] = [];
    for (const m of entry.messages) {
      if (m.messageId === messageId) {
        removed.push(m);
      } else {
        keptMsgs.push(m);
      }
    }
    entry.messages = keptMsgs;

    // Search barriers
    const keptBarriers: NormalizedMessage[] = [];
    for (const b of entry.barriers) {
      if (b.messageId === messageId) {
        removed.push(b);
      } else {
        keptBarriers.push(b);
      }
    }
    entry.barriers = keptBarriers;

    if (removed.length === 0) return [];

    if (totalLength(entry) === 0) {
      if (entry.timer) clearTimeout(entry.timer);
      this.map.delete(scope);
    } else if (!this.blocked.has(scope)) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = this.armTimer(scope);
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

  /** Pause the debounce timer; pushed messages keep accumulating. */
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

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: entry ? totalLength(entry) : 0 });
    if (!entry || totalLength(entry) === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }

  /** Number of pending items (messages + barriers) for a scope. */
  pendingCount(scope: string): number {
    const entry = this.map.get(scope);
    return entry ? totalLength(entry) : 0;
  }

  /** True if the scope is currently blocked. */
  isBlocked(scope: string): boolean {
    return this.blocked.has(scope);
  }

  // ── private ──

  /** Flush everything for a scope: regular messages first, then barriers one by one. */
  private flushAll(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.messages.length > 0) {
      try {
        this.onFlush(scope, entry.messages);
      } catch (err) {
        log.fail('queue', err, { scope, batchSize: entry.messages.length });
      }
    }
    for (const barrier of entry.barriers) {
      try {
        this.onFlush(scope, [barrier]);
      } catch (err) {
        log.fail('queue', err, { scope, batchSize: 1 });
      }
    }
  }

  private armTimer(scope: string): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;

    // Flush regular messages first (FIFO — they arrived before any barriers)
    if (entry.messages.length > 0) {
      const msgs = entry.messages;
      entry.messages = [];
      if (totalLength(entry) === 0) {
        this.map.delete(scope);
        if (entry.timer) clearTimeout(entry.timer);
      }
      try {
        this.onFlush(scope, msgs);
      } catch (err) {
        log.fail('queue', err, { scope, batchSize: msgs.length });
      }
      return;
    }

    // Flush the first barrier as its own batch (never merged)
    if (entry.barriers.length > 0) {
      const barrier = entry.barriers.shift()!;
      if (totalLength(entry) === 0) {
        this.map.delete(scope);
        if (entry.timer) clearTimeout(entry.timer);
      } else {
        // More barriers or messages pending — re-arm the timer
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = this.armTimer(scope);
      }
      try {
        this.onFlush(scope, [barrier]);
      } catch (err) {
        log.fail('queue', err, { scope, batchSize: 1 });
      }
      return;
    }

    // Both empty — clean up
    this.map.delete(scope);
    if (entry.timer) clearTimeout(entry.timer);
  }
}
