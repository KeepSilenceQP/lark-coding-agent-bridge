import type { ReactionEvent } from '@larksuite/channel';
import { lookupReactionSemantics, isStopEmoji } from './semantics';
import type { BufferedReactionEvent, ReactionKey } from './types';

// ── Configuration ──

export const BUFFER_QUIET_MS = 600;
export const BUFFER_MAX_WAIT_MS = 5_000;

// ── Buffer state ──

interface BufferEntry {
  events: BufferedReactionEvent[];
  firstArrival: number;
  quietTimer?: ReturnType<typeof setTimeout>;
  maxTimer?: ReturnType<typeof setTimeout>;
  nextOrder: number;
}

export type ReactionFlushHandler = (
  key: ReactionKey,
  events: BufferedReactionEvent[],
) => Promise<void>;

/**
 * In-memory short buffer for same-key reaction events.
 *
 * Stop events (No, CrossMark, MinusOne) are filtered BEFORE entering this
 * buffer and go directly to the stop control plane (DD16).
 *
 * Events for the same key accumulate during a quiet window (default 600ms).
 * After the quiet window expires OR the max wait (default 5s) is reached,
 * the buffer flushes all accumulated events to the async handler.
 */
export class ReactionBuffer {
  private readonly map = new Map<ReactionKey, BufferEntry>();
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly onFlush: ReactionFlushHandler;

  constructor(
    onFlush: ReactionFlushHandler,
    quietMs = BUFFER_QUIET_MS,
    maxWaitMs = BUFFER_MAX_WAIT_MS,
  ) {
    this.onFlush = onFlush;
    this.quietMs = quietMs;
    this.maxWaitMs = maxWaitMs;
  }

  /** Push a non-stop reaction event. Stop events are silently ignored here. */
  push(key: ReactionKey, evt: ReactionEvent): void {
    if (isStopEmoji(evt.emojiType)) return;

    const existing = this.map.get(key);
    const semantics = lookupReactionSemantics(evt.emojiType);
    const event: BufferedReactionEvent = {
      action: evt.action,
      emojiType: evt.emojiType,
      actionTime: evt.actionTime ?? Date.now(),
      arrivalOrder: existing ? existing.nextOrder++ : 0,
      semantics,
    };

    if (existing) {
      if (existing.quietTimer) clearTimeout(existing.quietTimer);
      existing.events.push(event);
      existing.quietTimer = this.armQuiet(key, existing);
      return;
    }

    const entry: BufferEntry = {
      events: [event],
      firstArrival: Date.now(),
      nextOrder: 1,
    };
    entry.quietTimer = this.armQuiet(key, entry);
    entry.maxTimer = this.armMaxWait(key, entry);
    this.map.set(key, entry);
  }

  cancel(key: ReactionKey): BufferedReactionEvent[] {
    const entry = this.map.get(key);
    if (!entry) return [];
    if (entry.quietTimer) clearTimeout(entry.quietTimer);
    if (entry.maxTimer) clearTimeout(entry.maxTimer);
    this.map.delete(key);
    return entry.events;
  }

  cancelAll(): void {
    for (const entry of this.map.values()) {
      if (entry.quietTimer) clearTimeout(entry.quietTimer);
      if (entry.maxTimer) clearTimeout(entry.maxTimer);
    }
    this.map.clear();
  }

  /** Number of pending buffer keys. */
  get pendingKeys(): number {
    return this.map.size;
  }

  private armQuiet(key: ReactionKey, entry: BufferEntry): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.flush(key), this.quietMs);
  }

  private armMaxWait(key: ReactionKey, entry: BufferEntry): ReturnType<typeof setTimeout> {
    const elapsed = Date.now() - entry.firstArrival;
    const remaining = Math.max(0, this.maxWaitMs - elapsed);
    return setTimeout(() => {
      const current = this.map.get(key);
      if (current === entry) this.flush(key);
    }, remaining);
  }

  private flush(key: ReactionKey): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    if (entry.quietTimer) clearTimeout(entry.quietTimer);
    if (entry.maxTimer) clearTimeout(entry.maxTimer);

    const sorted = [...entry.events].sort((a, b) => {
      const cmp = a.actionTime - b.actionTime;
      if (cmp !== 0) return cmp;
      return a.arrivalOrder - b.arrivalOrder;
    });

    void this.onFlush(key, sorted);
  }
}
