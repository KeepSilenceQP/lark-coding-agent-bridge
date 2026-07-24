import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';
import { reactionTurnIdOf } from './reaction/turn-message';

// ── Ordered-unit deque ──
// Every arrival is appended as a unit. Consecutive regular messages merge into
// the tail regular unit (debounce) — when both carry a lease, only if they
// share the same workChainId (same target/chain). Barriers are always
// independent units and never merge. This preserves exact arrival order for
// interleaved regular + barrier traffic.

/**
 * Work-chain lifecycle token carried by a PendingUnit (R3-F1). When present,
 * the queue acquires it at unit creation and releases it on cancel; on flush
 * it is TRANSFERRED to the run (onFlush receives it) which releases it on
 * terminal/abort. This replaces the per-messageId side-map approach which
 * leaked merged messages' lifecycle (only firstMsg was released).
 *
 * `lease` is optional so queue-mechanics tests (which don't exercise the
 * work-chain lifecycle) can call push/pushBarrier without it; production paths
 * (intakeMessage / reaction flush handler) always provide it.
 */
export type WorkLease = { workChainId: string; unitId: string };

type PendingUnit =
  | {
      kind: 'regular';
      messages: NormalizedMessage[];
      lease: WorkLease | undefined;
      replyTo: string | undefined;
      triggerMessageIds: string[];
    }
  | { kind: 'barrier'; message: NormalizedMessage; lease: WorkLease | undefined };

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

/** Hooks that resolve/acquire/release a lease on the work-chain store. */
export interface LeaseHooks {
  resolveOrAllocate: (scope: string, replyTo?: string) => string;
  acquire: (lease: WorkLease) => void;
  release: (lease: WorkLease) => void;
  registerTrigger?: (lease: WorkLease, messageId: string) => void;
}

export interface PendingPushOptions {
  /** True only for trusted, real human inbound IM messages. */
  registerAsTrigger?: boolean;
}

export type FlushHandler = (
  scope: string,
  batch: NormalizedMessage[],
  lease: WorkLease | undefined,
) => void;

export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  private readonly delayMs: number;
  private readonly onFlush: FlushHandler;
  private readonly leaseHooks: LeaseHooks | undefined;
  private unitIdSeq = 0;

  constructor(delayMs: number, onFlush: FlushHandler, leaseHooks?: LeaseHooks) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
    this.leaseHooks = leaseHooks;
  }

  private nextUnitId(): string {
    this.unitIdSeq += 1;
    return `u${this.unitIdSeq}`;
  }

  private acquireLease(lease: WorkLease): void {
    this.leaseHooks?.acquire(lease);
  }

  /** Release a unit's lease (idempotent via the store's releaseUnit Set). */
  releaseLease(lease: WorkLease): void {
    this.leaseHooks?.release(lease);
  }

  // ── push (regular message) ──
  // Production derives replyTo from the message itself so every producer
  // (ordinary IM, Card callback, future synthetic inputs) follows the same
  // inheritance contract. Queue-mechanics tests may omit leaseHooks.

  push(scope: string, msg: NormalizedMessage, options: PendingPushOptions = {}): number {
    const registerAsTrigger = options.registerAsTrigger === true;
    const replyTo = msg.replyToMessageId;
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      const last = existing.units[existing.units.length - 1];
      let resolvedWorkChainId: string | undefined;
      // Identical targets (including top-level) merge without probing/allocating
      // a second chain. Different explicit targets may still merge when both
      // resolve to the same inherited chain.
      const sameUnit =
        last?.kind === 'regular' &&
        (this.leaseHooks
          ? last.replyTo === replyTo
            ? true
            : Boolean(
                (resolvedWorkChainId = this.resolveWorkChain(scope, replyTo)) &&
                  last.lease?.workChainId === resolvedWorkChainId,
              )
          : last.replyTo === replyTo);
      if (sameUnit) {
        last.messages.push(msg);
        if (registerAsTrigger && last.lease && !last.triggerMessageIds.includes(msg.messageId)) {
          last.triggerMessageIds.push(msg.messageId);
          this.leaseHooks?.registerTrigger?.(last.lease, msg.messageId);
        }
        // shared lease — no new acquire
      } else {
        const lease = this.allocateLease(scope, replyTo, resolvedWorkChainId);
        if (lease) this.acquireLease(lease);
        const triggerMessageIds = registerAsTrigger ? [msg.messageId] : [];
        if (lease && registerAsTrigger) this.leaseHooks?.registerTrigger?.(lease, msg.messageId);
        existing.units.push({ kind: 'regular', messages: [msg], lease, replyTo, triggerMessageIds });
      }
      existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope);
      return totalLength(existing);
    }
    const lease = this.allocateLease(scope, replyTo);
    if (lease) this.acquireLease(lease);
    const triggerMessageIds = registerAsTrigger ? [msg.messageId] : [];
    if (lease && registerAsTrigger) this.leaseHooks?.registerTrigger?.(lease, msg.messageId);
    this.map.set(scope, {
      units: [{ kind: 'regular', messages: [msg], lease, replyTo, triggerMessageIds }],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
    });
    return 1;
  }

  private resolveWorkChain(scope: string, replyTo?: string): string {
    return this.leaseHooks?.resolveOrAllocate(scope, replyTo) ?? '';
  }

  /** Allocate a workChainId + lease for a new unit. Per-unit (not per-message):
   *  merged messages share the unit's lease. */
  private allocateLease(
    scope: string,
    replyTo?: string,
    resolvedWorkChainId?: string,
  ): WorkLease | undefined {
    const workChainId = resolvedWorkChainId ?? this.resolveWorkChain(scope, replyTo);
    if (!workChainId) return undefined;
    return { workChainId, unitId: this.nextUnitId() };
  }

  // ── pushBarrier (reaction turn — independent unit, never merged) ──
  // lease is optional (production provides workChainId+unitId=turnId).

  pushBarrier(scope: string, msg: NormalizedMessage, lease?: WorkLease): void {
    if (lease) this.acquireLease(lease);
    if (this.blocked.has(scope)) {
      const existing = this.map.get(scope);
      if (existing) {
        existing.units.push({ kind: 'barrier', message: msg, lease });
      } else {
        this.map.set(scope, { units: [{ kind: 'barrier', message: msg, lease }] });
      }
      return;
    }
    this.flushFirstUnit(scope);
    const existing = this.map.get(scope);
    if (existing) {
      existing.units.push({ kind: 'barrier', message: msg, lease });
      if (!this.blocked.has(scope) && !existing.timer) {
        existing.timer = this.armTimer(scope);
      }
    } else {
      this.map.set(scope, {
        units: [{ kind: 'barrier', message: msg, lease }],
        timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
      });
    }
  }

  // ── cancel / cancelMessage ──

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    const out: NormalizedMessage[] = [];
    for (const u of entry.units) {
      // R3-F1/F2/F3: release each cancelled unit's lease.
      if (u.lease) this.releaseLease(u.lease);
      if (u.kind === 'regular') out.push(...u.messages);
      else out.push(u.message);
    }
    return out;
  }

  /**
   * Per-key cancel: remove only messages matching a specific messageId.
   * Releases the lease of any unit that is fully removed (barrier match, or a
   * regular unit that becomes empty after removing matching messages).
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
        if (keptMsgs.length > 0) {
          kept.push({
            kind: 'regular',
            messages: keptMsgs,
            lease: u.lease,
            replyTo: u.replyTo,
            triggerMessageIds: u.triggerMessageIds.filter((id) => id !== messageId),
          });
        } else {
          // Unit fully emptied → release its lease (R3-F2).
          if (u.lease) this.releaseLease(u.lease);
        }
      } else {
        const barrierId = reactionTurnIdOf(u.message) ?? u.message.messageId;
        if (barrierId === messageId) {
          removed.push(u.message);
          if (u.lease) this.releaseLease(u.lease); // barrier removed → release (R3-F2)
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
      for (const u of entry.units) if (u.lease) this.releaseLease(u.lease);
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

  private flushFirstUnit(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry || entry.units.length === 0) return;

    const unit = entry.units.shift()!;

    if (entry.units.length === 0) {
      this.map.delete(scope);
      if (entry.timer) clearTimeout(entry.timer);
    } else if (!this.blocked.has(scope)) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = this.armTimer(scope);
    }

    // Transfer the unit's lease to the run (onFlush). The run releases it on
    // terminal/abort — the queue does NOT release here.
    this.invokeFlush(scope, unit);
  }

  private armTimer(scope: string): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry || entry.units.length === 0) return;

    const unit = entry.units.shift()!;

    if (entry.units.length === 0) {
      this.map.delete(scope);
      if (entry.timer) clearTimeout(entry.timer);
    } else {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = this.armTimer(scope);
    }

    this.invokeFlush(scope, unit);
  }

  private invokeFlush(scope: string, unit: PendingUnit): void {
    const lease = unit.lease;
    try {
      if (unit.kind === 'regular') {
        this.onFlush(scope, unit.messages, lease);
      } else {
        this.onFlush(scope, [unit.message], lease);
      }
    } catch (err) {
      // onFlush threw before the run could take ownership of the lease →
      // release it here so the chain doesn't stay current forever (R3-F4).
      if (lease) this.releaseLease(lease);
      log.fail('queue', err, {
        scope,
        batchSize: unit.kind === 'regular' ? unit.messages.length : 1,
      });
    }
  }
}
