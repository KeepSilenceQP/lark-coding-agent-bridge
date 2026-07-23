import { randomUUID } from 'node:crypto';

// ── Configuration (Plan DD15, B7) ──

/** Max historical chains retained per scope (LRU eviction). Current chains not counted. */
export const MAX_CHAINS_PER_SCOPE = 16;

/** Max historical outbound→chain mappings retained per scope (LRU eviction). */
export const MAX_OUTBOUND_MAP_PER_SCOPE = 256;

/** TTL for historical chain retention (30 min). Current chains not subject to TTL. */
export const HISTORICAL_CHAIN_TTL_MS = 1_800_000;

// ── Internal state ──

interface ChainRecord {
  chainId: string;
  scope: string;
  terminal: boolean;
  createdAt: number;
  lastAccessAt: number;
}

/**
 * In-memory, bounded workChainId store.
 *
 * - Current chains (queued/reserved/active): NOT subject to TTL/LRU caps.
 * - Historical chains (terminal): retained up to HISTORICAL_CHAIN_TTL_MS,
 *   then evicted from historical lookup. Capped at MAX_CHAINS_PER_SCOPE
 *   historical chains and MAX_OUTBOUND_MAP_PER_SCOPE historical mappings per
 *   scope, evicting oldest (LRU) when exceeded.
 * - Restart: all state is lost → fail closed for all stop targets.
 */
export class WorkChainStore {
  /** chainId → ChainRecord */
  private readonly chains = new Map<string, ChainRecord>();

  /** outbound messageId → chainId (both current and historical) */
  private readonly outboundMap = new Map<string, string>();

  /** scope → Set<chainId> for LRU tracking */
  private readonly scopeChains = new Map<string, Set<string>>();

  /** scope → ordered list of historical chainIds (oldest first) for LRU eviction */
  private readonly scopeHistoricalOrder = new Map<string, string[]>();

  // ── Allocation ──

  allocate(scope: string): string {
    const chainId = randomUUID();
    const now = Date.now();
    this.chains.set(chainId, {
      chainId,
      scope,
      terminal: false,
      createdAt: now,
      lastAccessAt: now,
    });
    this.trackScope(scope, chainId);
    return chainId;
  }

  // ── Outbound registration ──

  registerOutbound(chainId: string, messageId: string): void {
    const chain = this.chains.get(chainId);
    if (!chain) return;
    chain.lastAccessAt = Date.now();
    this.outboundMap.set(messageId, chainId);
    this.pruneHistoricalOutbounds(chain.scope);
  }

  // ── Resolution ──

  /** Resolve an outbound message to its workChainId. */
  resolveOutbound(messageId: string): string | undefined {
    return this.outboundMap.get(messageId);
  }

  /**
   * Resolve an outbound message to a CURRENT workChainId.
   * Returns undefined if the chain is terminal or unknown (fail closed for stop).
   */
  resolveCurrentChain(messageId: string): string | undefined {
    const chainId = this.outboundMap.get(messageId);
    if (!chainId) return undefined;
    const chain = this.chains.get(chainId);
    if (!chain) return undefined;
    // Purge if TTL expired for historical chains
    if (chain.terminal && this.isHistoricalExpired(chain)) {
      return undefined;
    }
    if (chain.terminal) return undefined;
    chain.lastAccessAt = Date.now();
    return chainId;
  }

  /**
   * Resolve via outbound message if known, otherwise allocate a new chain.
   * Used when a reply or Reaction targets a Bot message — inherit the chain.
   */
  resolveOrAllocate(scope: string, replyToMessageId?: string): string {
    if (replyToMessageId) {
      const existing = this.outboundMap.get(replyToMessageId);
      if (existing) {
        const chain = this.chains.get(existing);
        if (chain) {
          chain.lastAccessAt = Date.now();
          return existing;
        }
      }
    }
    return this.allocate(scope);
  }

  // ── Lifecycle ──

  isCurrent(chainId: string): boolean {
    const chain = this.chains.get(chainId);
    if (!chain) return false;
    return !chain.terminal;
  }

  markTerminal(chainId: string): void {
    const chain = this.chains.get(chainId);
    if (!chain || chain.terminal) return;
    chain.terminal = true;
    chain.lastAccessAt = Date.now();
    this.trackHistorical(chain.scope, chainId);
    this.pruneHistoricalChains(chain.scope);
  }

  /** Mark a chain as current again (e.g. re-continued via reply). */
  markCurrent(chainId: string): void {
    const chain = this.chains.get(chainId);
    if (!chain) return;
    chain.terminal = false;
    chain.lastAccessAt = Date.now();
    this.removeHistorical(chain.scope, chainId);
  }

  // ── Scope helpers ──

  /** Check if a scope has any active/reserved/queued work. */
  hasCurrentWork(scope: string): boolean {
    const chainSet = this.scopeChains.get(scope);
    if (!chainSet) return false;
    for (const chainId of chainSet) {
      const chain = this.chains.get(chainId);
      if (chain && !chain.terminal) return true;
    }
    return false;
  }

  // ── Internal: scope tracking ──

  private trackScope(scope: string, chainId: string): void {
    let set = this.scopeChains.get(scope);
    if (!set) {
      set = new Set();
      this.scopeChains.set(scope, set);
    }
    set.add(chainId);
  }

  private trackHistorical(scope: string, chainId: string): void {
    let order = this.scopeHistoricalOrder.get(scope);
    if (!order) {
      order = [];
      this.scopeHistoricalOrder.set(scope, order);
    }
    order.push(chainId);
  }

  private removeHistorical(scope: string, chainId: string): void {
    const order = this.scopeHistoricalOrder.get(scope);
    if (!order) return;
    const idx = order.indexOf(chainId);
    if (idx >= 0) order.splice(idx, 1);
  }

  private isHistoricalExpired(chain: ChainRecord): boolean {
    if (!chain.terminal) return false;
    return Date.now() - chain.lastAccessAt > HISTORICAL_CHAIN_TTL_MS;
  }

  // ── LRU eviction ──

  private pruneHistoricalChains(scope: string): void {
    const order = this.scopeHistoricalOrder.get(scope);
    if (!order) return;

    // Remove TTL-expired entries
    const now = Date.now();
    while (order.length > 0) {
      const oldest = order[0];
      const chain = this.chains.get(oldest);
      if (!chain || (chain.terminal && now - chain.lastAccessAt > HISTORICAL_CHAIN_TTL_MS)) {
        order.shift();
        if (chain) this.chains.delete(oldest);
      } else {
        break;
      }
    }

    // LRU evict oldest historical chains if over cap
    while (order.length > MAX_CHAINS_PER_SCOPE) {
      const evicted = order.shift();
      if (evicted) this.chains.delete(evicted);
    }
  }

  private pruneHistoricalOutbounds(scope: string): void {
    // Count historical outbound mappings for this scope
    const historicalMappings: Array<{ messageId: string; chainId: string; accessTime: number }> = [];
    for (const [msgId, chainId] of this.outboundMap) {
      const chain = this.chains.get(chainId);
      if (chain && chain.scope === scope && chain.terminal) {
        historicalMappings.push({ messageId: msgId, chainId, accessTime: chain.lastAccessAt });
      }
    }

    // If over cap, evict oldest (by lastAccessAt)
    if (historicalMappings.length > MAX_OUTBOUND_MAP_PER_SCOPE) {
      historicalMappings.sort((a, b) => a.accessTime - b.accessTime);
      const toEvict = historicalMappings.slice(0, historicalMappings.length - MAX_OUTBOUND_MAP_PER_SCOPE);
      for (const { messageId } of toEvict) {
        this.outboundMap.delete(messageId);
      }
    }
  }
}
