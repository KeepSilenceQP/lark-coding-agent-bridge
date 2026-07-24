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
  /** scope → ordered list of historical outbound msgIds (oldest first) for O(1) prune */
  private readonly scopeHistoricalOutbounds = new Map<string, string[]>();

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
    // F13/F14: Track in scoped historical list if chain is terminal, for O(1) prune
    if (chain.terminal) {
      this.trackHistoricalOutbound(chain.scope, messageId);
    }
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
   *
   * F10: When inheriting a historical (terminal) chain, calls markCurrent()
   * so the chain becomes current again and can be stopped by a subsequent
   * stop reaction targeting the confirmation/continuation message.
   */
  resolveOrAllocate(scope: string, replyToMessageId?: string): string {
    if (replyToMessageId) {
      const existing = this.outboundMap.get(replyToMessageId);
      if (existing) {
        const chain = this.chains.get(existing);
        if (chain) {
          chain.lastAccessAt = Date.now();
          // F10: re-continue a historical chain
          if (chain.terminal) {
            this.markCurrent(existing);
          }
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
    // F13/F14: Move all outbound mappings for this chain to historical tracking
    for (const [msgId, cId] of this.outboundMap) {
      if (cId === chainId) this.trackHistoricalOutbound(chain.scope, msgId);
    }
    this.pruneHistoricalChains(chain.scope);
    this.pruneHistoricalOutbounds(chain.scope);
  }

  /** Mark a chain as current again (e.g. re-continued via reply). */
  markCurrent(chainId: string): void {
    const chain = this.chains.get(chainId);
    if (!chain) return;
    chain.terminal = false;
    chain.lastAccessAt = Date.now();
    this.removeHistorical(chain.scope, chainId);
    this.removeHistoricalOutbounds(chain.scope, chainId);
  }

  // ── B4: per-unit in-flight tracking ──
  // A chain stays current while ANY unit is in-flight; it goes historical only
  // when the LAST unit releases. This prevents one sibling run's terminal from
  // marking a shared chain historical while other queued/reserved/active units
  // on the same chain are still live (covers same-chain different-key + ordinary
  // siblings, which isLatest alone cannot protect).
  private readonly inFlightUnits = new Map<string, Set<string>>();

  /** Acquire an in-flight unit on a chain (run start). Keeps the chain current. */
  acquireUnit(chainId: string, unitId: string): void {
    const chain = this.chains.get(chainId);
    if (!chain) return;
    chain.terminal = false;
    chain.lastAccessAt = Date.now();
    this.removeHistorical(chain.scope, chainId);
    this.removeHistoricalOutbounds(chain.scope, chainId);
    let units = this.inFlightUnits.get(chainId);
    if (!units) { units = new Set(); this.inFlightUnits.set(chainId, units); }
    units.add(unitId);
  }

  /** Release an in-flight unit (run terminal). Chain goes historical only if
   *  this was the last in-flight unit on that chain. */
  releaseUnit(chainId: string, unitId: string): void {
    const units = this.inFlightUnits.get(chainId);
    if (!units) return;
    units.delete(unitId);
    if (units.size === 0) {
      this.inFlightUnits.delete(chainId);
      this.markTerminal(chainId); // last in-flight unit → historical
    }
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
      const oldest = order[0]!;
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

  private trackHistoricalOutbound(scope: string, messageId: string): void {
    let order = this.scopeHistoricalOutbounds.get(scope);
    if (!order) {
      order = [];
      this.scopeHistoricalOutbounds.set(scope, order);
    }
    if (!order.includes(messageId)) order.push(messageId);
  }

  /** A reactivated chain is current and none of its outbound mappings may
   * participate in historical TTL/LRU eviction (DD15). Keep the mappings in
   * outboundMap, but remove their IDs from the historical eviction order. */
  private removeHistoricalOutbounds(scope: string, chainId: string): void {
    const order = this.scopeHistoricalOutbounds.get(scope);
    if (!order) return;
    const kept = order.filter((messageId) => this.outboundMap.get(messageId) !== chainId);
    if (kept.length === 0) this.scopeHistoricalOutbounds.delete(scope);
    else this.scopeHistoricalOutbounds.set(scope, kept);
  }

  /**
   * F13/F14: Bounded O(K) prune where K = historical outbounds for THIS scope
   * (capped at MAX_OUTBOUND_MAP_PER_SCOPE + small overage). Does NOT scan
   * the global outboundMap. Also purges TTL-expired entries.
   */
  private pruneHistoricalOutbounds(scope: string): void {
    const order = this.scopeHistoricalOutbounds.get(scope);
    if (!order) return;

    // Remove TTL-expired entries (chain is gone or expired)
    const now = Date.now();
    let i = 0;
    while (i < order.length) {
      const msgId = order[i]!;
      const chainId = this.outboundMap.get(msgId);
      const chain = chainId ? this.chains.get(chainId) : undefined;
      if (chain && !chain.terminal) {
        // Defensive convergence for chains reactivated before an older runtime
        // learned to remove their mappings from the historical order.
        order.splice(i, 1);
        continue;
      }
      if (!chain || now - chain.lastAccessAt > HISTORICAL_CHAIN_TTL_MS) {
        order.splice(i, 1);
        this.outboundMap.delete(msgId);
        // Don't increment i — we removed the element
        continue;
      }
      i++;
    }

    // LRU evict oldest if over cap (oldest at index 0)
    while (order.length > MAX_OUTBOUND_MAP_PER_SCOPE) {
      const evicted = order.shift();
      if (evicted) this.outboundMap.delete(evicted);
    }
  }
}
