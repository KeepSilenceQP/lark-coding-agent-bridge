import type { ReactionContext } from './types';

/**
 * Keyed store mapping reactionKey → ReactionContext[].
 *
 * F1: This is the production bridge between the reaction pipeline (which
 * produces reconciled ReactionContexts) and buildPrompt (which consumes
 * them).  Since NormalizedMessage is a vendored SDK type not easily extended,
 * this store is the "keyed store" pattern that carries reactionContexts
 * alongside the batch without modifying the SDK type.
 *
 * Callers:
 * - pipeline flush handler: store.set(reactionKey, contexts) after reconciliation
 * - channel.ts buildPrompt: resolves turnId → reactionKey, then gets/removes it
 */
export class ReactionContextStore {
  private readonly map = new Map<string, ReactionContext[]>();

  /** Associate reaction contexts with a reaction key. */
  set(reactionKey: string, contexts: ReactionContext[]): void {
    this.map.set(reactionKey, contexts);
  }

  /** Get reaction contexts for a reaction key without removing. */
  get(reactionKey: string): ReactionContext[] | undefined {
    return this.map.get(reactionKey);
  }

  /**
   * Extract and remove all reaction contexts for a batch of message IDs.
   * Called by buildPrompt when constructing the agent prompt.
   */
  consume(messageIds: string[]): ReactionContext[] {
    const result: ReactionContext[] = [];
    for (const id of messageIds) {
      const ctx = this.map.get(id);
      if (ctx) {
        result.push(...ctx);
        this.map.delete(id);
      }
    }
    return result;
  }

  /** Remove entry for a reaction key. */
  delete(reactionKey: string): void {
    this.map.delete(reactionKey);
  }

  /** Number of stored entries. */
  get size(): number {
    return this.map.size;
  }
}
