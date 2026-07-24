import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

interface PendingEntry {
  messages: NormalizedMessage[];
  timer?: NodeJS.Timeout;
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
 * `pushBarrier(scope, msg)` flushes any currently-pending regular messages
 * for the scope immediately, then enqueues the barrier message as its own
 * independent entry. This ensures Reaction turns never merge with regular
 * messages and always flush as a separate batch.
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
      return existing.messages.length;
    }
    this.map.set(scope, {
      messages: [msg],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
    });
    return 1;
  }

  /**
   * Push a barrier entry (e.g. Reaction turn). Flushes any pending regular
   * messages for this scope first, then enqueues this message independently
   * so it never merges with regular text messages.
   */
  pushBarrier(scope: string, msg: NormalizedMessage): void {
    // Flush any pending regular messages immediately
    this.flushNow(scope);
    // Enqueue the barrier message as its own batch
    this.map.set(scope, {
      messages: [msg],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
    });
  }

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.messages;
  }

  /**
   * Per-key cancel: remove only messages matching a specific messageId
   * within a scope. Does NOT cancel other keys or regular messages
   * in the same scope.
   */
  cancelMessage(scope: string, messageId: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    // Collect actually removed messages, not fake placeholders
    const removed: NormalizedMessage[] = [];
    const kept: NormalizedMessage[] = [];
    for (const m of entry.messages) {
      if (m.messageId === messageId) {
        removed.push(m);
      } else {
        kept.push(m);
      }
    }
    if (removed.length === 0) return [];
    entry.messages = kept;
    if (entry.messages.length === 0) {
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
    log.info('queue', 'blocked', { scope, queued: entry?.messages.length ?? 0 });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }

  /** Immediately flush a scope without waiting for the quiet window. */
  private flushNow(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry || entry.messages.length === 0) return;
    this.map.delete(scope);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: entry.messages.length });
    }
  }

  private armTimer(scope: string): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: entry.messages.length });
    }
  }
}
