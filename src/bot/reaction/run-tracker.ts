/**
 * Tracks active reaction runs with per-run (operator, target, revision) metadata.
 *
 * ActiveRuns only keys by scope — this adds the reaction-specific dimensions
 * needed for revision invalidation and same-key interrupt decisions (DD12, B6).
 */

export interface ReactionRunMeta {
  scope: string;
  operatorOpenId: string;
  targetMessageId: string;
  reactionRevision: number;
  runId: string;
}

/**
 * Tracks active reaction runs alongside ActiveRuns.
 *
 * When a new revision comes in for the same operator+target, the old run
 * must be interrupted and superseded.
 */
export class ReactionRunTracker {
  /** scope → active reaction run metadata */
  private readonly active = new Map<string, ReactionRunMeta>();

  register(meta: ReactionRunMeta): void {
    this.active.set(meta.scope, meta);
  }

  get(scope: string): ReactionRunMeta | undefined {
    return this.active.get(scope);
  }

  unregister(scope: string): void {
    this.active.delete(scope);
  }

  /**
   * Check if a new revision for the same operator+target should interrupt
   * the current run on this scope. Returns true when:
   * - There IS an active run on this scope
   * - The active run has the SAME operator+target
   * - The new revision is HIGHER than the active run's revision
   */
  shouldInterrupt(
    scope: string,
    operatorOpenId: string,
    targetMessageId: string,
    newRevision: number,
  ): boolean {
    const current = this.active.get(scope);
    if (!current) return false;
    if (current.operatorOpenId !== operatorOpenId) return false;
    if (current.targetMessageId !== targetMessageId) return false;
    return newRevision > current.reactionRevision;
  }

  /**
   * Returns true when an active run on this scope would NOT be interrupted
   * by a change from a different operator or different target.
   */
  isSameKey(
    scope: string,
    operatorOpenId: string,
    targetMessageId: string,
  ): boolean {
    const current = this.active.get(scope);
    if (!current) return false;
    return (
      current.operatorOpenId === operatorOpenId &&
      current.targetMessageId === targetMessageId
    );
  }
}
