import type { ReactionEvent } from '@larksuite/channel';
import { log } from '../../core/logger';
import { DEFAULT_REACTION_POLICY, type ReactionPolicy } from './policy';
import { lookupReactionSemantics, isPassiveReaction, isStopEmoji, isRestartEmoji } from './semantics';
import type { BufferedReactionEvent, ReactionKey } from './types';

// ── Configuration ──

export const BUFFER_QUIET_MS = 600;
export const BUFFER_MAX_WAIT_MS = 5_000;

// ── Buffer state ──

interface BufferEntry {
  policy: ReactionPolicy;
  policyOrder: number;
  events: BufferedReactionEvent[];
  firstArrival: number;
  quietTimer?: ReturnType<typeof setTimeout>;
  maxTimer?: ReturnType<typeof setTimeout>;
  nextOrder: number;
}

export type ReactionFlushHandler = (
  key: ReactionKey,
  events: BufferedReactionEvent[],
  policy: ReactionPolicy,
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
  private readonly flushing = new Map<ReactionKey, Promise<void>>();
  private nextAdmissionOrder = 0;
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

  /** Push an actionable reaction; stop controls and passive markers are ignored. */
  push(
    key: ReactionKey,
    evt: ReactionEvent,
    policy: ReactionPolicy = DEFAULT_REACTION_POLICY,
    intakeOrder = ++this.nextAdmissionOrder,
  ): void {
    this.nextAdmissionOrder = Math.max(this.nextAdmissionOrder, intakeOrder);
    let existing = this.map.get(key);
    // Routing performs async API reads. A slow older event must not roll a
    // pending batch back to the policy captured before a newer admitted event.
    if (existing && existing.policyOrder > intakeOrder) policy = existing.policy;
    if (isStopEmoji(evt.emojiType, policy) || isPassiveReaction(evt.emojiType, policy)
      || isRestartEmoji(evt.emojiType, policy)) return;

    // A batch still in its merge window uses the latest admitted event's policy.
    // Rebind all pending meanings together; never retroactively run controls.
    // Once flushed, the snapshot passed to the async handler is immutable.
    if (existing && existing.policy.version !== policy.version) {
      existing.policy = policy;
      existing.events = existing.events
        .filter(event => !isPassiveReaction(event.emojiType, policy)
          && !isStopEmoji(event.emojiType, policy) && !isRestartEmoji(event.emojiType, policy))
        .map(event => ({ ...event, semantics: lookupReactionSemantics(event.emojiType, policy) }));
      if (existing.events.length === 0) {
        this.cancel(key);
        existing = undefined;
      }
    }
    const semantics = lookupReactionSemantics(evt.emojiType, policy);
    const event: BufferedReactionEvent = {
      action: evt.action,
      emojiType: evt.emojiType,
      actionTime: evt.actionTime ?? Date.now(),
      arrivalOrder: existing ? existing.nextOrder++ : 0,
      semantics,
    };

    if (existing) {
      existing.policyOrder = Math.max(existing.policyOrder, intakeOrder);
      if (existing.quietTimer) clearTimeout(existing.quietTimer);
      existing.events.push(event);
      existing.quietTimer = this.armQuiet(key, existing);
      return;
    }

    const entry: BufferEntry = {
      policy,
      policyOrder: intakeOrder,
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

    const previous = this.flushing.get(key);
    const run = previous
      ? previous.then(() => this.onFlush(key, sorted, entry.policy))
      : this.onFlush(key, sorted, entry.policy);
    const completion = run.catch(err => log.fail('reaction-flush', err)).finally(() => {
      if (this.flushing.get(key) === completion) this.flushing.delete(key);
    });
    this.flushing.set(key, completion);
  }
}
