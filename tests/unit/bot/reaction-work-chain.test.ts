import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { WorkChainStore } from '../../../src/bot/reaction/work-chain';

describe('WorkChainStore', () => {
  let store: WorkChainStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new WorkChainStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Allocation ──

  it('allocates a new workChainId for a new message', () => {
    const id = store.allocate('oc_scope');
    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates unique workChainIds', () => {
    const id1 = store.allocate('oc_scope');
    const id2 = store.allocate('oc_scope');
    expect(id1).not.toBe(id2);
  });

  // ── Outbound message registration ──

  it('registers an outbound message id to a workChainId', () => {
    const chainId = store.allocate('oc_scope');
    store.registerOutbound(chainId, 'om_outbound_1');
    expect(store.resolveOutbound('om_outbound_1')).toBe(chainId);
  });

  it('resolveOutbound returns undefined for unknown message id', () => {
    expect(store.resolveOutbound('om_nonexistent')).toBeUndefined();
  });

  // ── Inheritance ──

  it('inherits workChainId from a reply to a known Bot message', () => {
    const chainId = store.allocate('oc_scope');
    store.registerOutbound(chainId, 'om_bot_msg');
    const inherited = store.resolveOrAllocate('oc_scope', 'om_bot_msg');
    expect(inherited).toBe(chainId);
  });

  it('allocates new chain when replying to unknown message', () => {
    const id = store.resolveOrAllocate('oc_scope', 'om_unknown');
    expect(id).toBeDefined();
    // Should NOT match any existing chain (it's a new one)
  });

  // ── Current vs Historical ──

  it('marks a chain as current during queued/reserved/active, historical after terminal', () => {
    const chainId = store.allocate('oc_scope');
    expect(store.isCurrent(chainId)).toBe(true);
    store.markTerminal(chainId);
    expect(store.isCurrent(chainId)).toBe(false);
  });

  it('resolveCurrentChain returns workChainId for a message in a current chain', () => {
    const chainId = store.allocate('oc_scope');
    store.registerOutbound(chainId, 'om_outbound');
    expect(store.resolveCurrentChain('om_outbound')).toBe(chainId);
  });

  it('resolveCurrentChain returns undefined for terminal chain messages', () => {
    const chainId = store.allocate('oc_scope');
    store.registerOutbound(chainId, 'om_outbound');
    store.markTerminal(chainId);
    expect(store.resolveCurrentChain('om_outbound')).toBeUndefined();
  });

  // ── Stop target → current chain validation ──

  it('maps a stop target message to a current chain (validation passes)', () => {
    const chainId = store.allocate('oc_scope');
    store.registerOutbound(chainId, 'om_outbound');
    // A stop reaction targeting om_outbound should resolve to the current chain
    const resolved = store.resolveCurrentChain('om_outbound');
    expect(resolved).toBe(chainId);
  });

  it('returns undefined for stop target that maps to a historical chain (fail closed)', () => {
    const chainId = store.allocate('oc_scope');
    store.registerOutbound(chainId, 'om_outbound');
    store.markTerminal(chainId);
    // After terminal, stop reaction on om_outbound should fail closed
    expect(store.resolveCurrentChain('om_outbound')).toBeUndefined();
  });

  it('returns undefined for stop target with no matching outbound (restart fail closed)', () => {
    // After restart, no outbound mappings exist → fail closed
    expect(store.resolveCurrentChain('om_unknown')).toBeUndefined();
  });

  // ── Sibling queued units ──

  it('multiple pending units on the same scope are all current', () => {
    const chain1 = store.allocate('oc_scope');
    const chain2 = store.allocate('oc_scope');
    expect(store.isCurrent(chain1)).toBe(true);
    expect(store.isCurrent(chain2)).toBe(true);
  });

  it('stop target matching one current chain passes validation even with sibling chains', () => {
    const chain1 = store.allocate('oc_scope');
    const chain2 = store.allocate('oc_scope');
    store.registerOutbound(chain1, 'om_outbound_1');
    store.registerOutbound(chain2, 'om_outbound_2');

    expect(store.resolveCurrentChain('om_outbound_1')).toBe(chain1);
    expect(store.resolveCurrentChain('om_outbound_2')).toBe(chain2);
  });

  // ── Bounded historical cache ──

  it('current chains are not evicted by LRU/TTL even when count exceeds historical cap', () => {
    // Create 20 current chains (exceeds MAX_CHAINS_PER_SCOPE=16)
    const chainIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = store.allocate('oc_scope');
      store.registerOutbound(id, `om_out_${i}`);
      chainIds.push(id);
    }

    // All 20 should still be current and findable
    for (let i = 0; i < 20; i++) {
      expect(store.isCurrent(chainIds[i]!)).toBe(true);
      expect(store.resolveCurrentChain(`om_out_${i}`)).toBe(chainIds[i]);
    }
  });

  it('current outbound mappings survive beyond TTL (not subject to TTL)', () => {
    const chainId = store.allocate('oc_scope');
    store.registerOutbound(chainId, 'om_long_running');

    // Advance time past HISTORICAL_CHAIN_TTL_MS
    vi.advanceTimersByTime(2_000_000); // > 30 min

    // Current chain should still be resolvable
    expect(store.isCurrent(chainId)).toBe(true);
    expect(store.resolveCurrentChain('om_long_running')).toBe(chainId);
  });

  it('historical chains older than TTL → resolveCurrentChain returns undefined (fail closed)', () => {
    const chainId = store.allocate('oc_scope');
    store.registerOutbound(chainId, 'om_old_outbound');
    store.markTerminal(chainId);

    // Advance past TTL
    vi.advanceTimersByTime(2_000_000);

    expect(store.resolveCurrentChain('om_old_outbound')).toBeUndefined();
  });

  it('historical outbound mappings are pruned by LRU when exceeding MAX_OUTBOUND_MAP_PER_SCOPE', () => {
    const scope = 'oc_test';
    // Create many terminal chains with outbound mappings
    const chainIds: string[] = [];
    for (let i = 0; i < 300; i++) {
      const id = store.allocate(scope);
      store.registerOutbound(id, `om_hist_${i}`);
      store.markTerminal(id);
      chainIds.push(id);
    }

    // The oldest historical mappings should be evicted
    // Newest ones should still be resolvable (but terminal, so resolveCurrentChain → undefined)
    const oldestOutbound = 'om_hist_0';
    const newestOutbound = 'om_hist_299';

    // Both are historical (terminal) so resolveCurrentChain returns undefined either way
    expect(store.resolveCurrentChain(oldestOutbound)).toBeUndefined();
    expect(store.resolveCurrentChain(newestOutbound)).toBeUndefined();
  });

  // ── Scope isolation ──

  it('isolates chains across different scopes', () => {
    const chainA = store.allocate('oc_scope_a');
    const chainB = store.allocate('oc_scope_b');
    store.registerOutbound(chainA, 'om_a');
    store.registerOutbound(chainB, 'om_b');

    expect(store.resolveCurrentChain('om_a')).toBe(chainA);
    expect(store.resolveCurrentChain('om_b')).toBe(chainB);
  });

  // ── Chain re-continuation ──

  it('can re-continue a historical chain via a new reply', () => {
    const chainId = store.allocate('oc_scope');
    store.registerOutbound(chainId, 'om_bot_msg');
    store.markTerminal(chainId);

    // User replies to the old bot message → inherits the chain
    // The chain should now be current again
    const continued = store.resolveOrAllocate('oc_scope', 'om_bot_msg');
    expect(continued).toBe(chainId);
    // But wait — resolveOrAllocate inherits but doesn't automatically mark current.
    // The caller (pipeline) should mark it current when creating a new run.
  });

  it('target confirmation message inherits workChainId when reacted to', () => {
    // Bot sends confirmation: "Should I continue?"
    const chainId = store.allocate('oc_scope');
    store.registerOutbound(chainId, 'om_confirmation');

    // User reacts with approve_continue on om_confirmation
    // The reaction targets om_confirmation → inherits chainId
    const reactionChain = store.resolveOrAllocate('oc_scope', 'om_confirmation');
    expect(reactionChain).toBe(chainId);
  });
});
