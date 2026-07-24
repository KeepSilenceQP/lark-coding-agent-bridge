import { makeReactionKey } from './types';

/**
 * Tracks active reaction runs with per-run (operator, target, revision) metadata.
 *
 * ActiveRuns only keys by scope for scheduling mutex — this tracker keys by
 * reaction identity (operator + target) so that:
 * - Different operators on the same scope don't clobber each other
 * - Different targets on the same scope don't clobber each other
 * - Same operator+target with new revision correctly interrupts old run
 * - The reaction key is the same key used by buffer/ledger/reconciler
 *
 * F23: Scope is still used for scheduling mutex (via ActiveRuns), but
 * reaction run metadata is stored by reaction key, not scope.
 */

export interface ReactionRunMeta {
  scope: string;
  operatorOpenId: string;
  targetMessageId: string;
  reactionRevision: number;
  runId: string;
  /** true when the run is actually active (not just queued/reserved). Only active entries can be interrupted. */
  active: boolean;
}

/**
 * Tracks active reaction runs alongside ActiveRuns.
 *
 * When a new revision comes in for the same operator+target, the old run
 * must be interrupted and superseded. Different operator or different target
 * on the same scope do NOT interrupt each other.
 */
export class ReactionRunTracker {
  /** reactionKey → active reaction run metadata (F23: keyed by identity, not scope) */
  private readonly active = new Map<string, ReactionRunMeta>();
  /** scope → set of reactionKeys active on this scope */
  private readonly scopeIndex = new Map<string, Set<string>>();

  register(meta: ReactionRunMeta): void {
    const key = makeReactionKey(meta.scope, meta.operatorOpenId, meta.targetMessageId);
    this.active.set(key, meta);
    // Index by scope
    let keys = this.scopeIndex.get(meta.scope);
    if (!keys) {
      keys = new Set();
      this.scopeIndex.set(meta.scope, keys);
    }
    keys.add(key);
  }

  get(scope: string, operatorOpenId: string, targetMessageId: string): ReactionRunMeta | undefined {
    const key = makeReactionKey(scope, operatorOpenId, targetMessageId);
    return this.active.get(key);
  }

  /** Get ALL active runs for a scope (for stop-all / pending cancel). */
  getAllForScope(scope: string): ReactionRunMeta[] {
    const keys = this.scopeIndex.get(scope);
    if (!keys) return [];
    const result: ReactionRunMeta[] = [];
    for (const key of keys) {
      const meta = this.active.get(key);
      if (meta) result.push(meta);
    }
    return result;
  }

  unregister(scope: string, operatorOpenId: string, targetMessageId: string): void {
    const key = makeReactionKey(scope, operatorOpenId, targetMessageId);
    this.active.delete(key);
    const keys = this.scopeIndex.get(scope);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) this.scopeIndex.delete(scope);
    }
  }

  /**
   * Check if a new revision for the same operator+target should interrupt
   * the current run. Returns true when:
   * - There IS an active run for this reaction key
   * - The new revision is HIGHER than the active run's revision
   */
  /**
   * Check if a new revision should interrupt an ACTIVE run for the same key.
   * Only active runs (not queued/reserved) are interruptible.
   */
  shouldInterrupt(
    scope: string,
    operatorOpenId: string,
    targetMessageId: string,
    newRevision: number,
  ): boolean {
    const current = this.get(scope, operatorOpenId, targetMessageId);
    if (!current) return false;
    if (!current.active) return false; // queued/reserved — not interruptible
    return newRevision > current.reactionRevision;
  }

  /** Mark a queued/reserved entry as active when the run actually starts. */
  markActive(scope: string, operatorOpenId: string, targetMessageId: string): void {
    const current = this.get(scope, operatorOpenId, targetMessageId);
    if (current) current.active = true;
  }

  /**
   * Check if any other key on the same scope has an active run.
   * Returns false if only the exact same key is active (or nothing is).
   */
  hasOtherKeyActive(
    scope: string,
    operatorOpenId: string,
    targetMessageId: string,
  ): boolean {
    const keys = this.scopeIndex.get(scope);
    if (!keys) return false;
    const thisKey = makeReactionKey(scope, operatorOpenId, targetMessageId);
    for (const key of keys) {
      if (key !== thisKey) return true;
    }
    return false;
  }

  /** True when a specific reaction key has an active run. */
  isSameKey(
    scope: string,
    operatorOpenId: string,
    targetMessageId: string,
  ): boolean {
    return this.get(scope, operatorOpenId, targetMessageId) !== undefined;
  }

  /** Number of active reaction runs. */
  get size(): number {
    return this.active.size;
  }
}
