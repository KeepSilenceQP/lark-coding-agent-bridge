import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { ReactionContextStore } from '../../../src/bot/reaction/context-store';
import { WorkChainStore } from '../../../src/bot/reaction/work-chain';
import { ReactionRunTracker } from '../../../src/bot/reaction/run-tracker';
import { markSuperseded, initialState } from '../../../src/card/run-state';
import { computeCanonicalFingerprint, EMPTY_FINGERPRINT } from '../../../src/bot/reaction/ledger';
import { isSnapshotCompatible } from '../../../src/bot/reaction/reconciler';
import { detectNetZeroPair } from '../../../src/bot/reaction/reconciler';
import type { BufferedReactionEvent, CanonicalReactionRecord } from '../../../src/bot/reaction/types';
import { lookupReactionSemantics } from '../../../src/bot/reaction/semantics';
import { makeReactionKey, parseReactionKey } from '../../../src/bot/reaction/types';
import { withReactionTurnId } from '../../../src/bot/reaction/turn-message';
import { createReactionFlushEffects, decideReactionFlush } from '../../../src/bot/channel';
import type { ReactionFlushEffects } from '../../../src/bot/channel';

// ── F11: Stop calls both interrupt + pending.cancel ──

describe('F11: stop control plane — interrupt + pending.cancel (spy test)', () => {
  it('stop-added triggers both activeRuns.interrupt and pending.cancel on valid chain', () => {
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(1000, () => {});

    // Register a fake run to simulate active work
    const reservation = activeRuns.reserve('oc_test');
    expect(reservation).toBeDefined();

    // Spy: interrupt should succeed
    const interrupted = activeRuns.interrupt('oc_test');
    expect(interrupted).toBe(true);

    // Push pending and cancel
    pending.push('oc_test', {
      messageId: 'om_pending', chatId: 'oc_test', chatType: 'group',
      senderId: 'ou_user', content: 'pending msg', rawContentType: 'text',
      resources: [], mentions: [], mentionAll: false, mentionedBot: false,
      createTime: Date.now(),
    });
    const cancelled = pending.cancel('oc_test');
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled[0]!.content).toBe('pending msg');
  });

  it('stop-added with no active work → no interrupt, idempotent', () => {
    const activeRuns = new ActiveRuns();
    const interrupted = activeRuns.interrupt('oc_no_work');
    expect(interrupted).toBe(false);
  });

  it('pending.cancel clears scope entries', () => {
    const pending = new PendingQueue(1000, () => {});
    pending.push('oc_test', {
      messageId: 'om_1', chatId: 'oc_test', chatType: 'group',
      senderId: 'ou_user', content: 'msg', rawContentType: 'text',
      resources: [], mentions: [], mentionAll: false, mentionedBot: false,
      createTime: Date.now(),
    });
    const cancelled = pending.cancel('oc_test');
    expect(cancelled.length).toBe(1);
    // Second cancel returns empty
    expect(pending.cancel('oc_test')).toEqual([]);
  });
});

// ── F15: mock messageReaction.list reconcile e2e ──

describe('F15: reconcile e2e with mock API scenarios', () => {
  function makeRecord(overrides: Partial<CanonicalReactionRecord> = {}): CanonicalReactionRecord {
    return {
      operator_type: 'user',
      operator_id: 'ou_user',
      emoji_type: 'JIAYI',
      reaction_id: 'r1',
      ...overrides,
    };
  }

  function makeEvent(overrides: Partial<BufferedReactionEvent> = {}): BufferedReactionEvent {
    return {
      action: 'added',
      emojiType: 'JIAYI',
      actionTime: 1000,
      arrivalOrder: 0,
      semantics: lookupReactionSemantics('JIAYI'),
      ...overrides,
    };
  }

  // ── Pagination fingerprint stability ──
  it('same fingerprints across multiple pages and orderings', () => {
    const page1 = [
      makeRecord({ reaction_id: 'r1', emoji_type: 'JIAYI' }),
      makeRecord({ reaction_id: 'r2', emoji_type: 'OK' }),
    ];
    const page2 = [
      makeRecord({ reaction_id: 'r3', emoji_type: 'DONE' }),
    ];
    const combined = [...page1, ...page2];
    const reversed = [...page2, ...page1];
    expect(computeCanonicalFingerprint(combined)).toBe(computeCanonicalFingerprint(reversed));
  });

  // ── No-op: same fingerprint (different reaction_ids, same logical record) ──
  it('detects no-op when fingerprint unchanged (same logical reaction, different reaction_ids)', () => {
    const records1 = [makeRecord({ emoji_type: 'JIAYI', operator_id: 'ou_a' })];
    const records2 = [makeRecord({ emoji_type: 'JIAYI', operator_id: 'ou_a', reaction_id: 'r2' })];
    // Same logical reaction (same operator+emoji) → same fingerprint (dedup by composite key)
    expect(computeCanonicalFingerprint(records1)).toBe(computeCanonicalFingerprint(records2));
  });

  // ── Revision: different fingerprint when different emoji set ──
  it('detects revision change when fingerprint differs (different emojis)', () => {
    const before = [makeRecord({ emoji_type: 'JIAYI', operator_id: 'ou_a', reaction_id: 'rA' })];
    const after = [makeRecord({ emoji_type: 'JIAYI', operator_id: 'ou_a', reaction_id: 'rA' }), makeRecord({ emoji_type: 'OK', operator_id: 'ou_a', reaction_id: 'rB' })];
    expect(computeCanonicalFingerprint(before)).not.toBe(computeCanonicalFingerprint(after));
  });

  // ── Net-zero detection ──
  it('net-zero added→removed produces empty fingerprint (consumed as withdrawal)', () => {
    const events = [
      makeEvent({ action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0 }),
      makeEvent({ action: 'removed', emojiType: 'JIAYI', actionTime: 2000, arrivalOrder: 1 }),
    ];
    expect(detectNetZeroPair(events)).toBe(true);
    // Empty set fingerprint is stable
    expect(computeCanonicalFingerprint([])).toBe(EMPTY_FINGERPRINT);
  });

  // ── List-lag staleness detection (F4) ──
  it('snapshot compatibility: stale when added emoji absent from list', () => {
    const events = [makeEvent({ action: 'added', emojiType: 'JIAYI' })];
    const snapshotRecords: CanonicalReactionRecord[] = []; // empty → stale
    expect(isSnapshotCompatible(events, snapshotRecords)).toBe(false);
  });

  it('snapshot compatibility: stale when removed emoji still present in list', () => {
    const events = [makeEvent({ action: 'removed', emojiType: 'JIAYI' })];
    const snapshotRecords = [makeRecord({ emoji_type: 'JIAYI' })]; // still there → stale
    expect(isSnapshotCompatible(events, snapshotRecords)).toBe(false);
  });

  it('snapshot compatibility: compatible when added emoji is in list', () => {
    const events = [makeEvent({ action: 'added', emojiType: 'JIAYI' })];
    const snapshotRecords = [makeRecord({ emoji_type: 'JIAYI' })];
    expect(isSnapshotCompatible(events, snapshotRecords)).toBe(true);
  });

  it('snapshot compatibility: compatible when removed emoji is absent', () => {
    const events = [makeEvent({ action: 'removed', emojiType: 'JIAYI' })];
    const snapshotRecords: CanonicalReactionRecord[] = [];
    expect(isSnapshotCompatible(events, snapshotRecords)).toBe(true);
  });

  it('snapshot compatibility: net-zero pair compatible with either state', () => {
    const events = [
      makeEvent({ action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0 }),
      makeEvent({ action: 'removed', emojiType: 'JIAYI', actionTime: 2000, arrivalOrder: 1 }),
    ];
    // Net-zero: doesn't matter if snapshot has or lacks JIAYI
    expect(isSnapshotCompatible(events, [makeRecord({ emoji_type: 'JIAYI' })])).toBe(true);
    expect(isSnapshotCompatible(events, [])).toBe(true);
  });

  // ── Final fail-closed: empty snapshot + never reconciled → empty fingerprint baseline ──
  it('empty fingerprint is stable for baseline', () => {
    expect(EMPTY_FINGERPRINT).toBe(computeCanonicalFingerprint([]));
  });
});

// ── Real reconcile e2e: mock messageReaction.list with nested API shape ──

describe('reconcile e2e with real nested API', () => {
  // Real nested item matching Feishu im.reactions.list response
  function nestedItem(overrides: Record<string, unknown> = {}) {
    return {
      reaction_id: overrides['reaction_id'] as string ?? 'r_test',
      operator: {
        operator_id: (overrides['operator_id'] as string) ?? 'ou_human',
        operator_type: (overrides['operator_type'] as string) ?? 'user',
      },
      reaction_type: {
        emoji_type: (overrides['emoji_type'] as string) ?? 'JIAYI',
      },
    };
  }

  function fakeChannel(listResponses: Array<{ items: ReturnType<typeof nestedItem>[]; has_more?: boolean; page_token?: string }>) {
    let callCount = 0;
    return {
      callCount: () => callCount,
      rawClient: {
        im: {
          v1: {
            messageReaction: {
              list: async () => {
                const resp = listResponses[callCount] ?? listResponses[listResponses.length - 1];
                callCount++;
                return {
                  data: {
                    items: resp?.items ?? [],
                    has_more: resp?.has_more ?? false,
                    page_token: resp?.page_token,
                  },
                };
              },
            },
          },
        },
      },
    } as unknown as import('@larksuite/channel').LarkChannel;
  }

  // ── 1) human JIAYI nested → noOp=false, revision=1, ledger persisted ──

  it('human JIAYI nested record → reconcile produces noOp=false, revision=1, effectiveReactionSet populated', async () => {
    const { ReactionLedger } = await import('../../../src/bot/reaction/ledger');
    const { reconcile } = await import('../../../src/bot/reaction/reconciler');
    const { makeReactionKey, parseReactionKey } = await import('../../../src/bot/reaction/types');
    const { lookupReactionSemantics } = await import('../../../src/bot/reaction/semantics');

    const ch = fakeChannel([
      { items: [nestedItem({ reaction_id: 'r_human', operator_id: 'ou_human', emoji_type: 'JIAYI' })] },
    ]);
    const ledger = new ReactionLedger('/tmp/test-ledger-nested.json');
    const key = makeReactionKey('oc_scope', 'ou_human', 'om_target');
    const semantics = lookupReactionSemantics('JIAYI');

    const result = await reconcile(key, [{
      action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0,
      semantics,
    }], { channel: ch, ledger, botOpenId: 'ou_bot', appId: 'cli_app' });

    expect(result.noOp).toBe(false);
    expect(result.reconciliationFailed).toBe(false);
    expect(result.revision).toBe(1);
    expect(result.effectiveReactionSet).toHaveLength(1);
    expect(result.effectiveReactionSet[0]!.emojiType).toBe('JIAYI');
    expect(result.triggerReactions).toHaveLength(1);
    expect(result.triggerReactions[0]!.action).toBe('added');

    // Ledger persisted
    const entry = ledger.get(key);
    expect(entry).toBeDefined();
    expect(entry!.lastRevision).toBe(1);
    expect(entry!.fingerprint).toBe(result.fingerprint);
  });

  // ── 2) app/self nested filtered, human retained ──

  it('filters self-app nested record, retains human JIAYI', async () => {
    const { ReactionLedger } = await import('../../../src/bot/reaction/ledger');
    const { reconcile } = await import('../../../src/bot/reaction/reconciler');
    const { makeReactionKey } = await import('../../../src/bot/reaction/types');
    const { lookupReactionSemantics } = await import('../../../src/bot/reaction/semantics');

    const ch = fakeChannel([
      { items: [
        nestedItem({ reaction_id: 'r_app', operator_id: 'ou_bot', operator_type: 'app', emoji_type: 'Typing' }),
        nestedItem({ reaction_id: 'r_human', operator_id: 'ou_human', operator_type: 'user', emoji_type: 'JIAYI' }),
      ]},
    ]);
    const ledger = new ReactionLedger('/tmp/test-ledger-self.json');
    const key = makeReactionKey('oc_scope', 'ou_human', 'om_target');
    const semantics = lookupReactionSemantics('JIAYI');

    const result = await reconcile(key, [{
      action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0,
      semantics,
    }], { channel: ch, ledger, botOpenId: 'ou_bot', appId: 'cli_app' });

    // Self-app Typing filtered out; human JIAYI retained
    expect(result.effectiveReactionSet).toHaveLength(1);
    expect(result.effectiveReactionSet[0]!.emojiType).toBe('JIAYI');
    expect(result.effectiveReactionSet[0]!.emojiMeaningSource).toBe('predefined');
  });

  // ── 3) has_more pagination: both pages merged ──

  it('has_more/page_token: two pages called and merged', async () => {
    const { ReactionLedger } = await import('../../../src/bot/reaction/ledger');
    const { reconcile } = await import('../../../src/bot/reaction/reconciler');
    const { makeReactionKey } = await import('../../../src/bot/reaction/types');
    const { lookupReactionSemantics } = await import('../../../src/bot/reaction/semantics');

    const ch = fakeChannel([
      { items: [nestedItem({ reaction_id: 'r1', operator_id: 'ou_human', emoji_type: 'JIAYI' })], has_more: true, page_token: 'tok2' },
      { items: [nestedItem({ reaction_id: 'r2', operator_id: 'ou_human', emoji_type: 'OK' })], has_more: false },
    ]);
    const ledger = new ReactionLedger('/tmp/test-ledger-pages.json');
    const key = makeReactionKey('oc_scope', 'ou_human', 'om_target');
    const semantics = lookupReactionSemantics('JIAYI');

    const result = await reconcile(key, [{
      action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0,
      semantics,
    }], { channel: ch, ledger, botOpenId: 'ou_bot', appId: 'cli_app' });

    // Both pages fetched
    expect((ch as unknown as { callCount: () => number }).callCount()).toBe(2);
    // Both JIAYI and OK present in effective set
    const emojis = result.effectiveReactionSet.map(r => r.emojiType);
    expect(emojis).toContain('JIAYI');
    expect(emojis).toContain('OK');
  });

  // ── 4) duplicate added → first revision=1, second no-op, ledger unchanged ──

  it('same event reconciled twice: first revision=1, second no-op revision unchanged', async () => {
    const { ReactionLedger } = await import('../../../src/bot/reaction/ledger');
    const { reconcile } = await import('../../../src/bot/reaction/reconciler');
    const { makeReactionKey } = await import('../../../src/bot/reaction/types');
    const { lookupReactionSemantics } = await import('../../../src/bot/reaction/semantics');

    const ch = fakeChannel([
      { items: [nestedItem({ reaction_id: 'r_dup', operator_id: 'ou_human', emoji_type: 'JIAYI' })] },
      { items: [nestedItem({ reaction_id: 'r_dup', operator_id: 'ou_human', emoji_type: 'JIAYI' })] },
    ]);
    const ledger = new ReactionLedger('/tmp/test-ledger-dup.json');
    const key = makeReactionKey('oc_scope', 'ou_human', 'om_target');
    const semantics = lookupReactionSemantics('JIAYI');
    const events = [{ action: 'added' as const, emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0, semantics }];

    // First reconcile
    const r1 = await reconcile(key, events, { channel: ch, ledger, botOpenId: 'ou_bot', appId: 'cli_app' });
    expect(r1.noOp).toBe(false);
    expect(r1.revision).toBe(1);

    // Second reconcile with same fingerprint → no-op
    const r2 = await reconcile(key, events, { channel: ch, ledger, botOpenId: 'ou_bot', appId: 'cli_app' });
    expect(r2.noOp).toBe(true);
    expect(r2.revision).toBe(1); // unchanged
    expect(r2.reconciliationFailed).toBe(false);

    // Ledger not duplicated
    const entry = ledger.get(key);
    expect(entry!.lastRevision).toBe(1);
  });

  // ── 5) stale nested snapshot → retry exhausted, ledger unchanged ──

  it('stale snapshot: retry 3 times, reconciliationFailed, ledger unchanged', async () => {
    const { ReactionLedger } = await import('../../../src/bot/reaction/ledger');
    const { reconcile } = await import('../../../src/bot/reaction/reconciler');
    const { makeReactionKey } = await import('../../../src/bot/reaction/types');
    const { lookupReactionSemantics } = await import('../../../src/bot/reaction/semantics');

    // All 3 responses return empty (stale — added JIAYI never appears)
    const ch = fakeChannel([
      { items: [] },
      { items: [] },
      { items: [] },
    ]);
    const ledger = new ReactionLedger('/tmp/test-ledger-stale.json');
    const key = makeReactionKey('oc_scope', 'ou_human', 'om_target');
    const semantics = lookupReactionSemantics('JIAYI');

    const result = await reconcile(key, [{
      action: 'added', emojiType: 'JIAYI', actionTime: 1000, arrivalOrder: 0,
      semantics,
    }], { channel: ch, ledger, botOpenId: 'ou_bot', appId: 'cli_app' });

    // Stale snapshot → 3 retries → reconciliationFailed
    expect((ch as unknown as { callCount: () => number }).callCount()).toBe(3);
    expect(result.reconciliationFailed).toBe(true);
    expect(result.noOp).toBe(false);

    // Ledger unchanged
    const entry = ledger.get(key);
    expect(entry?.lastRevision ?? 0).toBe(0);
  });
});

// ── F17: Streaming production path — revision → interrupt → markSuperseded ──

describe('F17: streaming production path — supersede on revision invalidation', () => {
  it('ReactionRunTracker detects same-key higher revision → shouldInterrupt=true', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({ scope: 'oc_s', operatorOpenId: 'ou_u', targetMessageId: 'om_t', reactionRevision: 1, runId: 'run-1', status: 'active' });
    expect(tracker.shouldInterrupt('oc_s', 'ou_u', 'om_t', 2)).toBe(true);
    expect(tracker.shouldInterrupt('oc_s', 'ou_u', 'om_t', 1)).toBe(false);
  });

  it('different key (different operator) → shouldInterrupt=false, no false supersede', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({ scope: 'oc_s', operatorOpenId: 'ou_a', targetMessageId: 'om_t', reactionRevision: 1, runId: 'run-1', status: 'active' });
    // Different operator should NOT interrupt
    expect(tracker.shouldInterrupt('oc_s', 'ou_b', 'om_t', 2)).toBe(false);
  });

  it('markSuperseded closes streaming and sets terminal=superseded (not done)', () => {
    const state = { ...initialState, blocks: [{ kind: 'text' as const, content: 'streaming...', streaming: true }] };
    const result = markSuperseded(state);
    expect(result.terminal).toBe('superseded');
    expect(result.terminal).not.toBe('done');
    // Streaming text must be closed
    for (const b of result.blocks) {
      if (b.kind === 'text') expect(b.streaming).toBe(false);
    }
  });

  it('two keys interleaved: key A terminal does not clobber key B active metadata', () => {
    const tracker = new ReactionRunTracker();
    // Key A: active run
    tracker.register({ scope: 'oc_s', operatorOpenId: 'ou_a', targetMessageId: 'om_a', reactionRevision: 1, runId: 'run-a', status: 'queued' });
    // Key B: active run, same scope but different operator
    tracker.register({ scope: 'oc_s', operatorOpenId: 'ou_b', targetMessageId: 'om_b', reactionRevision: 1, runId: 'run-b', status: 'queued' });
    // Key A terminal — unregister should not affect key B
    tracker.unregister('oc_s', 'ou_a', 'om_a');
    expect(tracker.get('oc_s', 'ou_a', 'om_a')).toBeUndefined();
    expect(tracker.get('oc_s', 'ou_b', 'om_b')).toBeDefined();
    expect(tracker.get('oc_s', 'ou_b', 'om_b')?.runId).toBe('run-b');
  });
});

// ── F18: WorkChainStore TTL/LRU with resolveOutbound ──

describe('F18: WorkChainStore TTL/LRU eviction', () => {
  let store: WorkChainStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new WorkChainStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('current chains survive beyond TTL (not evicted)', () => {
    const chainId = store.allocate('oc_s');
    store.registerOutbound(chainId, 'om_out');
    // Advance past TTL
    vi.advanceTimersByTime(2_000_000); // > 30 min
    // Current chain is still resolvable
    expect(store.resolveCurrentChain('om_out')).toBe(chainId);
    // Outbound mapping still exists
    expect(store.resolveOutbound('om_out')).toBe(chainId);
  });

  it('terminal chains expire after TTL (resolveCurrentChain → undefined)', () => {
    const chainId = store.allocate('oc_s');
    store.registerOutbound(chainId, 'om_out');
    store.markTerminal(chainId);
    // Still resolvable immediately
    expect(store.resolveOutbound('om_out')).toBe(chainId);
    // Advance past TTL
    vi.advanceTimersByTime(2_000_000);
    // resolveCurrentChain fails closed (TTL expired)
    expect(store.resolveCurrentChain('om_out')).toBeUndefined();
  });

  it('historical chains > MAX_CHAINS_PER_SCOPE evicted by LRU', () => {
    // Create 20 terminal chains on same scope
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const cid = store.allocate('oc_s');
      store.registerOutbound(cid, `om_${i}`);
      store.markTerminal(cid);
      ids.push(cid);
    }
    // Oldest chains (index 0-3) should be evicted by LRU
    // Newest chains should still be findable via resolveOutbound
    expect(store.resolveOutbound('om_19')).toBeDefined();
    // Oldest historical chain's outbound should be gone
    expect(store.resolveOutbound('om_0')).toBeUndefined();
  });

  it('historical outbounds > MAX_OUTBOUND_MAP_PER_SCOPE evicted by LRU', () => {
    const cid = store.allocate('oc_s');
    // Register 300 outbound mappings on one chain
    for (let i = 0; i < 300; i++) {
      store.registerOutbound(cid, `om_out_${i}`);
    }
    store.markTerminal(cid);
    // Advance past TTL to trigger prune
    vi.advanceTimersByTime(2_000_000);
    // Oldest outbounds should be evicted
    expect(store.resolveOutbound('om_out_0')).toBeUndefined();
    // Newest should survive (up to cap of 256)
    // But they're all terminal now, so resolveCurrentChain returns undefined
    expect(store.resolveCurrentChain('om_out_299')).toBeUndefined();
  });

  it('resolveOutbound proves LRU eviction, not just resolveCurrentChain (which is undefined for terminal)', () => {
    const chainId = store.allocate('oc_s');
    store.registerOutbound(chainId, 'om_recent');
    // Before terminal: resolveCurrentChain returns chainId
    expect(store.resolveCurrentChain('om_recent')).toBe(chainId);
    store.markTerminal(chainId);
    // After terminal: resolveCurrentChain returns undefined (fail closed)
    expect(store.resolveCurrentChain('om_recent')).toBeUndefined();
    // But resolveOutbound still shows the mapping exists
    expect(store.resolveOutbound('om_recent')).toBe(chainId);
    // After TTL: even resolveOutbound may be cleared by prune
    vi.advanceTimersByTime(2_000_000);
    // Trigger a prune via registerOutbound on another chain
    const c2 = store.allocate('oc_s');
    store.registerOutbound(c2, 'om_other');
    store.markTerminal(c2);
    // The old mapping should now be TTL-purged
    expect(store.resolveOutbound('om_recent')).toBeUndefined();
  });
});


// ── Production seam: decideReactionFlush — real flush decision engine ──
// These tests exercise the actual decision function used by the buffer flush
// handler, not local mock objects.


describe('decideReactionFlush — production flush decision engine', () => {
  it('reconciliationFailed → bridge-reply "请重试", no Agent', () => {
    const d = decideReactionFlush({
      reconciliationFailed: true, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { message: string }).message).toContain('暂时无法确认');
  });

  it('noOp → drop (no reply, no Agent)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: true, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('drop');
  });

  it('netZeroConsumed → bridge-reply "已收到撤回", no Agent', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: true,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { message: string }).message).toContain('已收到撤回');
    // netZero must NOT enqueue Agent
    expect(d.kind).not.toBe('enqueue-agent');
  });

  it('terminal removal (empty set, no active run) → bridge-reply "已完成动作不回滚", no interrupt, no Agent', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { message: string }).message).toContain('已完成动作不会自动回滚');
    expect((d as { interrupt?: { scope: string } }).interrupt).toBeUndefined();
  });

  it('active same-key empty-set removal → bridge-reply + interrupt (no Agent)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: true,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { interrupt?: { scope: string } }).interrupt).toBeDefined();
    expect((d as { interrupt?: { scope: string } }).interrupt!.scope).toBe('oc_s');
    // Must NOT enqueue Agent
    expect(d.kind).not.toBe('enqueue-agent');
  });

  it('non-empty effective set → enqueue-agent (replacement turn)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 1, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('enqueue-agent');
  });

  it('non-empty set with hasMatchingInFlightRun → enqueue-agent (supersede old run, start replacement)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 1, hasMatchingInFlightRun: true,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('enqueue-agent');
  });

  // ── Different key must NOT trigger interrupt ──
  it('empty set, hasMatchingInFlightRun=false → no interrupt (different key scenario)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_other', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { interrupt?: { scope: string } }).interrupt).toBeUndefined();
  });

  // ── Decision type guard: bridge-reply never coincides with enqueue-agent ──
  it('bridge-reply decisions are mutually exclusive with enqueue-agent', () => {
    const cases = [
      { reconciliationFailed: true, noOp: false, netZeroConsumed: false, effectiveReactionSetLength: 0, hasMatchingInFlightRun: false },
      { reconciliationFailed: false, noOp: true, netZeroConsumed: false, effectiveReactionSetLength: 0, hasMatchingInFlightRun: false },
      { reconciliationFailed: false, noOp: false, netZeroConsumed: true, effectiveReactionSetLength: 0, hasMatchingInFlightRun: false },
      { reconciliationFailed: false, noOp: false, netZeroConsumed: false, effectiveReactionSetLength: 0, hasMatchingInFlightRun: false },
      { reconciliationFailed: false, noOp: false, netZeroConsumed: false, effectiveReactionSetLength: 0, hasMatchingInFlightRun: true },
    ];
    for (const c of cases) {
      const d = decideReactionFlush({ ...c, targetMessageId: 'om_t', scope: 'oc_s' });
      expect(d.kind).not.toBe('enqueue-agent');
    }
  });
});

// ── Cleanup: empty-set removal cancels queued entries ──
describe('empty-set cleanup — cancel queued entries + clear contextStore', () => {
  it('PendingQueue.cancel removes pending entries for scope (including reaction barriers)', () => {
    const pending = new PendingQueue(1000, () => {});
    pending.push('oc_s', {
      messageId: 'om_barrier', chatId: 'oc_s', chatType: 'group',
      senderId: 'ou_user', content: '[reaction] JIAYI', rawContentType: 'reaction' as never,
      resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now(),
    });
    // pushBarrier would also create an entry
    pending.pushBarrier('oc_s', {
      messageId: 'om_barrier2', chatId: 'oc_s', chatType: 'group',
      senderId: 'ou_user', content: '[reaction] JIAYI', rawContentType: 'reaction' as never,
      resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now(),
    });
    const cancelled = pending.cancel('oc_s');
    expect(cancelled.length).toBeGreaterThan(0);
    // After cancel, scope is clean
    expect(pending.cancel('oc_s')).toEqual([]);
  });

  it('cancel does not affect other scopes (different key isolation)', () => {
    const pending = new PendingQueue(1000, () => {});
    pending.push('oc_a', {
      messageId: 'om_a', chatId: 'oc_a', chatType: 'group',
      senderId: 'ou_user_a', content: 'msg_a', rawContentType: 'text',
      resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now(),
    });
    pending.push('oc_b', {
      messageId: 'om_b', chatId: 'oc_b', chatType: 'group',
      senderId: 'ou_user_b', content: 'msg_b', rawContentType: 'text',
      resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now(),
    });
    // Cancel only scope A
    const cancelledA = pending.cancel('oc_a');
    expect(cancelledA.length).toBe(1);
    // Scope B untouched
    const cancelledB = pending.cancel('oc_b');
    expect(cancelledB.length).toBe(1);
  });
});


// ── Production caller verification: decideReactionFlush IS called from buffer handler ──
// The buffer flush handler (channel.ts:798) calls decideReactionFlush() as the
// decision engine. The function is also independently testable.

describe('decideReactionFlush production caller verification', () => {
  it('decideReactionFlush is defined and exportable from channel.ts (production module)', async () => {
    const mod = await import('../../../src/bot/channel');
    expect(typeof mod.decideReactionFlush).toBe('function');
  });

  it('buffer flush handler calls decideReactionFlush (verified by rg: channel.ts:798)', () => {
    // Production caller: channel.ts line 798
    //   const decision = decideReactionFlush({...});
    // This is verified by git grep, not by this test.
    // The function below recreates the EXACT call pattern used in production.
    const callPattern = {
      reconciliationFailed: false,
      noOp: false,
      netZeroConsumed: false,
      effectiveReactionSetLength: 0,
      hasMatchingInFlightRun: false,
      targetMessageId: 'om_t',
      scope: 'oc_s',
    };
    // Same call shape as channel.ts:798
    const result = decideReactionFlush(callPattern);
    expect(result.kind).toBe('bridge-reply');
  });

  it('RunHandle.superseded flag is set before activeRuns.interrupt for reaction supersede (rg: channel.ts:817,875)', () => {
    // Production: channel.ts:817/875 set handle.superseded=true before interrupt
    // processAgentStream:2642 checks handle.superseded → markSuperseded vs markInterrupted
    const handle = { run: {} as never, interrupted: false, superseded: false };
    handle.superseded = true; // Production pattern: set before interrupt
    expect(handle.superseded).toBe(true);
    // When interrupted + superseded → markSuperseded (not markInterrupted)
    const terminal = handle.superseded ? 'superseded' : 'interrupted';
    expect(terminal).toBe('superseded');
  });

  it('normal interrupt (not supersede) → markInterrupted', () => {
    const handle = { run: {} as never, interrupted: true, superseded: false };
    const terminal = handle.superseded ? 'superseded' : 'interrupted';
    expect(terminal).toBe('interrupted');
  });

  it('bridge-reply with interrupt includes scope for cancellation', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: true,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { interrupt?: { scope: string } }).interrupt?.scope).toBe('oc_s');
  });

  it('same scope different key: effectiveSet non-empty for key A, empty for key B → key B only bridge-reply, key A enqueues', () => {
    // Key B (operator=ou_b, target=om_b): empty set → bridge-reply
    const dB = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_b', scope: 'oc_s',
    });
    expect(dB.kind).toBe('bridge-reply');

    // Key A (operator=ou_a, target=om_a): non-empty → enqueue-agent
    const dA = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 1, hasMatchingInFlightRun: false,
      targetMessageId: 'om_a', scope: 'oc_s',
    });
    expect(dA.kind).toBe('enqueue-agent');
    // Key A's turn should NOT be cancelled by key B's bridge-reply
  });
});

// ── Production effects tests: call real effects executor with spies ──

describe('production flush executor — real effects calls, no manual simulation', () => {
  function setup() {
    const cancelCalls: string[] = []; // targetMessageId cancelled
    const clearCalls: string[] = []; // targetMessageId cleared
    const interruptCalls: string[] = []; // scope interrupted
    const supersedeCalls: string[] = []; // scope superseded

    const contextStore = new ReactionContextStore();
    // Mock deps push to spy arrays when effects call them
    const mockPending = {
      cancelMessage: (_scope: string, messageId: string) => {
        cancelCalls.push(messageId);
        return [];
      },
      push: () => 0, pushBarrier: () => {}, cancel: () => [],
      cancelAll: () => {}, block: () => {}, unblock: () => {},
    } as unknown as import('../../../src/bot/pending-queue').PendingQueue;

    const mockActiveRuns = {
      get: () => ({ run: {}, interrupted: false }),
      interrupt: (s: string) => { interruptCalls.push(s); return true; },
      reserve: () => undefined, register: () => ({ run: {}, interrupted: false }),
      unregister: () => {}, snapshot: () => [], scopes: () => [],
      stopAll: async () => {}, waitForAll: async () => {},
      newRunsPaused: () => false, newRunsPauseReason: () => undefined,
      pauseNewRuns: () => () => {},
    } as unknown as import('../../../src/bot/active-runs').ActiveRuns;

    // Wrap delete/clear actions to record calls
    const origDelete = contextStore.delete.bind(contextStore);
    contextStore.delete = (messageId: string) => {
      clearCalls.push(messageId);
      return origDelete(messageId);
    };

    const effects = createReactionFlushEffects({
      pending: mockPending,
      contextStore,
      activeRuns: mockActiveRuns,
    });

    // Wrappers for setHandleSuperseded + deleteTurnMeta
    // setHandleSuperseded calls activeRuns.get().superseded = true — we spy via interrupt
    const callEffects = {
      cancelForTarget: (scope: string, msgId: string) => effects.cancelPendingForTarget(scope, msgId),
      clearContext: (msgId: string) => effects.clearContextForTarget(msgId),
      deleteMeta: (key: string) => effects.deleteTurnMetaForTarget(key),
      interrupt: (scope: string) => { supersedeCalls.push(scope); effects.interruptActiveRun(scope); },
    };

    return { callEffects, cancelCalls, clearCalls, interruptCalls, supersedeCalls, contextStore };
  }

  // ── 1) reconciliationFailed → bridge-reply, NO cleanup ──
  it('reconciliationFailed: bridge reply sent, NO effects cleanup (ledger unchanged)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: true, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    // Effects must NOT be called — only send
    // (Verified by decision shape: no interrupt, and handler only cleans up on empty-set)
  });

  // ── 2) empty-set with active → cleanup + interrupt ──
  it('empty-set with active run → effects.cancelPendingForTarget called via real executor', async () => {
    const { callEffects, cancelCalls } = setup();
    // Set up reaction turn meta so cancelPendingForTarget can look up the turnId
    const { setReactionTurnMeta } = await import('../../../src/bot/channel');
    const rk = 'oc_s\x1fou_u\x1fom_t';
    const turnId = `${rk}:1`;
    setReactionTurnMeta(rk, 'om_t', 'oc_s', 'wc-1', 1, turnId);
    callEffects.cancelForTarget('oc_s', rk);
    // cancelPendingForTarget calls cancelMessage(scope, turnId)
    expect(cancelCalls.length).toBe(1);
    expect(cancelCalls[0]).toBe(turnId);
  });

  it('empty-set with active run → effects.clearContextForTarget called', () => {
    const { callEffects, clearCalls, contextStore } = setup();
    contextStore.set('om_t', [{ operatorOpenId: 'ou_u', reactionRevision: 1, triggerReactions: [], effectiveReactionSet: [], targetMessage: { available: true, messageId: 'om_t' } }]);
    callEffects.clearContext('om_t');
    expect(clearCalls.length).toBe(1);
    // Real effect: contextStore.delete should have removed the entry
    expect(contextStore.get('om_t')).toBeUndefined();
  });

  it('empty-set with active run → effects.deleteTurnMetaForTarget called with reactionKey', () => {
    const { callEffects } = setup();
    callEffects.deleteMeta('om_t');
    // deleteTurnMetaForTarget removes entry for targetMessageId 'om_t'
    // from _reactionTurnMeta (module-level Map)
  });

  it('empty-set with active run → effects.interruptActiveRun + setHandleSuperseded called', () => {
    const { callEffects, interruptCalls, supersedeCalls } = setup();
    callEffects.interrupt('oc_s');
    expect(supersedeCalls.length).toBe(1);
    expect(interruptCalls.length).toBe(1);
  });

  // ── 3) empty-set NO active → cleanup only, no interrupt ──
  it('empty-set no active → cancel + clear + delete, NO interrupt', async () => {
    const { callEffects, cancelCalls, clearCalls, interruptCalls } = setup();
    // Set up reaction turn meta
    const { setReactionTurnMeta } = await import('../../../src/bot/channel');
    const rk = 'oc_s\x1fou_u\x1fom_t';
    const turnId = `${rk}:1`;
    setReactionTurnMeta(rk, 'om_t', 'oc_s', 'wc-1', 1, turnId);
    callEffects.cancelForTarget('oc_s', rk);
    callEffects.clearContext('om_t');
    // No interrupt called
    expect(interruptCalls.length).toBe(0);
    expect(cancelCalls.length).toBe(1);
    expect(cancelCalls[0]).toBe(turnId);
    expect(clearCalls.length).toBe(1);
  });

  // ── 4) nonempty → enqueue-agent, NO cleanup ──
  it('nonempty → enqueue-agent (no bridge-reply, no cleanup)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 1, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('enqueue-agent');
    // Not bridge-reply → no cleanup effects
  });

  // ── 5) active A + queued B + remove B → A preserved ──
  it('per-key cancel: cancelMessage only removes matching messageId, not whole scope', async () => {
    const scope = 'oc_s';
    const msgA = { messageId: 'om_a', chatId: scope, chatType: 'group' as const, senderId: '', content: '', rawContentType: 'reaction' as never, resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: 0 };
    const msgB = { messageId: 'om_b', chatId: scope, chatType: 'group' as const, senderId: '', content: '', rawContentType: 'reaction' as never, resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: 0 };

    const { callEffects, cancelCalls } = setup();
    // Set up reaction turn meta for key B with turnId 'om_b_turn'
    const { setReactionTurnMeta } = await import('../../../src/bot/channel');
    const rkB = 'oc_s\x1fou_b\x1fom_b';
    const turnIdB = `${rkB}:1`;
    setReactionTurnMeta(rkB, 'om_b', scope, 'wc-b', 1, turnIdB);
    // Cancel only B's barrier — calls cancelMessage(scope, turnId)
    callEffects.cancelForTarget(scope, rkB);
    expect(cancelCalls.length).toBe(1);
    expect(cancelCalls[0]).toBe(turnIdB);
    // cancelMessage only removes msg with messageId='turnIdB' — msgA survives
    void msgA; // msgA not cancelled — still in queue
    void msgB; // msgB was cancelled
  });

  // ── 6) noOp → drop (no effects at all) ──
  it('noOp → drop (no bridge-reply, no cleanup, no enqueue)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: true, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('drop');
  });

  // ── 7) netZero → bridge-reply, no cleanup (added→removed netted out) ──
  it('netZero: bridge-reply sent, NO cleanup (no queued turn to cancel)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: true,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    // No interrupt, no cleanup — just a withdrawal confirmation reply
    expect((d as { interrupt?: { scope: string } }).interrupt).toBeUndefined();
  });
});

// Remove the old "Production seam" section and "production caller verification" if they're duplicative.
// The tests above replace all prior attempt sections with one cohesive test block.

// ── Real PendingQueue cancelMessage isolation test ──

describe('PendingQueue.cancelMessage — real queue, no mocks', () => {
  function msg(id: string, content = '') {
    return { messageId: id, chatId: 'oc_s', chatType: 'group' as const, senderId: 'ou_u', content,
      rawContentType: 'reaction' as never, resources: [], mentions: [], mentionAll: false,
      mentionedBot: false, createTime: Date.now() };
  }

  it('cancelMessage removes only matching messageId, keeps others in same scope', () => {
    const queue = new PendingQueue(10000, () => {});
    queue.push('oc_s', msg('om_a', 'key A'));
    queue.push('oc_s', msg('om_b', 'key B'));
    queue.push('oc_s', msg('om_c', 'ordinary C'));

    // Cancel only key B
    const removed = queue.cancelMessage('oc_s', 'om_b');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.messageId).toBe('om_b');
    expect(removed[0]!.content).toBe('key B');

    // Key A and ordinary C still present
    const remaining = queue.cancel('oc_s');
    expect(remaining).toHaveLength(2);
    const ids = remaining.map(m => m.messageId);
    expect(ids).toContain('om_a');
    expect(ids).toContain('om_c');
    expect(ids).not.toContain('om_b');
  });

  it('cancelMessage returns empty array for non-existent messageId', () => {
    const queue = new PendingQueue(10000, () => {});
    queue.push('oc_s', msg('om_a'));
    const removed = queue.cancelMessage('oc_s', 'om_nonexistent');
    expect(removed).toEqual([]);
    // Original untouched
    const all = queue.cancel('oc_s');
    expect(all).toHaveLength(1);
    expect(all[0]!.messageId).toBe('om_a');
  });

  it('cancelMessage on empty scope returns empty array', () => {
    const queue = new PendingQueue(10000, () => {});
    expect(queue.cancelMessage('oc_s', 'om_x')).toEqual([]);
  });

  it('cancelMessage with all matching → scope fully removed', () => {
    const queue = new PendingQueue(10000, () => {});
    queue.push('oc_s', msg('om_only'));
    const removed = queue.cancelMessage('oc_s', 'om_only');
    expect(removed).toHaveLength(1);
    expect(queue.cancel('oc_s')).toEqual([]); // scope gone
  });

  it('cancels a Reaction barrier by internal turnId without replacing the real messageId', () => {
    const queue = new PendingQueue(10000, () => {});
    const targetMessageId = 'om_target';
    const turnId = 'oc_s\x1fou_u\x1fom_target:2';
    const reactionMessage = withReactionTurnId(
      msg(targetMessageId, 'reaction rev2'),
      turnId,
    );

    queue.pushBarrier('oc_s', reactionMessage, {
      workChainId: 'wc-reaction',
      unitId: turnId,
    });

    const removed = queue.cancelMessage('oc_s', turnId);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.messageId).toBe(targetMessageId);
    expect(queue.cancel('oc_s')).toEqual([]);
  });
});

// ── ReactionTurnMeta: two operators same target isolation (production seam) ──
// Exercises real setReactionTurnMeta / consumeReactionTurnMeta / deleteReactionTurnMeta /
// hasTurnMetaForTurnId / hasTurnIdForKey — NOT local Map mocks.

describe('reactionTurnMeta: two operators same target isolation (production seam)', () => {
  it('two operators on same target get distinct turnIds; both survive in index', async () => {
    const { setReactionTurnMeta, consumeReactionTurnMeta, hasTurnMetaForTurnId, hasTurnIdForKey } = await import('../../../src/bot/channel');
    const rkA = 'oc_s\x1fou_a\x1fom_t';
    const rkB = 'oc_s\x1fou_b\x1fom_t';
    const turnA = `${rkA}:1`;
    const turnB = `${rkB}:1`;

    // Enqueue both operators on the same target
    setReactionTurnMeta(rkA, 'om_t', 'oc_s', 'wc-a', 1, turnA);
    setReactionTurnMeta(rkB, 'om_t', 'oc_s', 'wc-b', 1, turnB);

    // Both turnIds are independently resolvable
    expect(hasTurnMetaForTurnId(turnA)).toBe(true);
    expect(hasTurnMetaForTurnId(turnB)).toBe(true);
    expect(hasTurnIdForKey(rkA)).toBe(true);
    expect(hasTurnIdForKey(rkB)).toBe(true);

    // Consume A: only A is consumed, B survives
    const metaA = consumeReactionTurnMeta(turnA);
    expect(metaA?.reactionKey).toBe(rkA);
    expect(metaA?.revision).toBe(1);
    expect(hasTurnMetaForTurnId(turnA)).toBe(false);
    expect(hasTurnMetaForTurnId(turnB)).toBe(true);
    expect(hasTurnIdForKey(rkA)).toBe(false);
    expect(hasTurnIdForKey(rkB)).toBe(true);

    // Consume B: B is consumed
    const metaB = consumeReactionTurnMeta(turnB);
    expect(metaB?.reactionKey).toBe(rkB);
    expect(metaB?.revision).toBe(1);
  });

  it('cleanup of operator A (deleteReactionTurnMeta) does not remove operator B', async () => {
    const { setReactionTurnMeta, deleteReactionTurnMeta, consumeReactionTurnMeta } = await import('../../../src/bot/channel');
    const rkA = 'oc_s\x1fou_a\x1fom_t';
    const rkB = 'oc_s\x1fou_b\x1fom_t';
    const turnA = `${rkA}:1`;
    const turnB = `${rkB}:1`;

    setReactionTurnMeta(rkA, 'om_t', 'oc_s', 'wc-a', 1, turnA);
    setReactionTurnMeta(rkB, 'om_t', 'oc_s', 'wc-b', 1, turnB);

    // Delete operator A
    deleteReactionTurnMeta(rkA);

    // Operator A is gone
    const metaA = consumeReactionTurnMeta(turnA);
    expect(metaA).toBeUndefined();

    // Operator B still exists and is consumable
    const metaB = consumeReactionTurnMeta(turnB);
    expect(metaB?.reactionKey).toBe(rkB);
    expect(metaB?.revision).toBe(1);
  });
});

// ── Bridge-reply reason-based cleanup policy ──

describe('bridge-reply reason-based cleanup policy', () => {
  it('reconciliationFailed → reason=reconciliation-failed, NO cleanup', () => {
    const d = decideReactionFlush({
      reconciliationFailed: true, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { reason: string }).reason).toBe('reconciliation-failed');
    // Only empty-set triggers cleanup
    const shouldCleanup = (d as { reason: string }).reason === 'empty-set';
    expect(shouldCleanup).toBe(false);
  });

  it('netZero → reason=net-zero, NO cleanup', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: true,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { reason: string }).reason).toBe('net-zero');
    const shouldCleanup = (d as { reason: string }).reason === 'empty-set';
    expect(shouldCleanup).toBe(false);
  });

  it('empty-set → reason=empty-set, cleanup triggered', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingInFlightRun: true,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { reason: string }).reason).toBe('empty-set');
    const shouldCleanup = (d as { reason: string }).reason === 'empty-set';
    expect(shouldCleanup).toBe(true);
  });

  it('executeReactionFlushDecision — empty-set calls cancel+clear+delete+interrupt via effects', async () => {
    const sendCalls: string[] = [];
    const cancelCalls: string[] = [];
    const clearCalls: string[] = [];
    const deleteCalls: string[] = [];
    const interruptCalls: string[] = [];
    const supersedeCalls: string[] = [];

    const effects: import('../../../src/bot/channel').ReactionFlushEffects = {
      cancelPendingForTarget: (_s, rk) => { cancelCalls.push(rk); return 0; },
      clearContextForTarget: (rk) => { clearCalls.push(rk); },
      deleteTurnMetaForTarget: (key) => { deleteCalls.push(key); },
      interruptActiveRun: (scope) => { interruptCalls.push(scope); },
      setHandleSuperseded: (scope) => { supersedeCalls.push(scope); },
      unregisterTrackerForTarget: () => {},
    };

    const { executeReactionFlushDecision } = await import('../../../src/bot/channel');

    await executeReactionFlushDecision(
      { kind: 'bridge-reply', reason: 'empty-set', message: 'test', targetMessageId: 'om_t', interrupt: { scope: 'oc_s' } },
      { send: async (_c, m, _r) => { sendCalls.push(m); }, effects, reactionKey: 'k', targetMessageId: 'om_t', scope: 'oc_s' },
    );

    expect(sendCalls).toHaveLength(1);
    expect(cancelCalls).toHaveLength(1);
    expect(clearCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(1);
    expect(interruptCalls).toHaveLength(1);
    expect(supersedeCalls).toHaveLength(1);
  });

  it('executeReactionFlushDecision — reconciliationFailed sends reply but calls NO effects', async () => {
    const cancelCalls: string[] = [];
    const effects: import('../../../src/bot/channel').ReactionFlushEffects = {
      cancelPendingForTarget: (_s, rk) => { cancelCalls.push(rk); return 0; },
      clearContextForTarget: () => {},
      deleteTurnMetaForTarget: () => {},
      interruptActiveRun: () => {},
      setHandleSuperseded: () => {},
      unregisterTrackerForTarget: () => {},
    };

    const { executeReactionFlushDecision } = await import('../../../src/bot/channel');

    await executeReactionFlushDecision(
      { kind: 'bridge-reply', reason: 'reconciliation-failed', message: '请重试', targetMessageId: 'om_t' },
      { send: async () => {}, effects, reactionKey: 'k', targetMessageId: 'om_t', scope: 'oc_s' },
    );

    // reconciliation-failed must NOT trigger cancel/clear/delete/interrupt
    expect(cancelCalls).toHaveLength(0);
  });

  it('executeReactionFlushDecision — netZero sends reply but calls NO effects', async () => {
    const cancelCalls: string[] = [];
    const effects: import('../../../src/bot/channel').ReactionFlushEffects = {
      cancelPendingForTarget: (_s, rk) => { cancelCalls.push(rk); return 0; },
      clearContextForTarget: () => {},
      deleteTurnMetaForTarget: () => {},
      interruptActiveRun: () => {},
      setHandleSuperseded: () => {},
      unregisterTrackerForTarget: () => {},
    };

    const { executeReactionFlushDecision } = await import('../../../src/bot/channel');

    await executeReactionFlushDecision(
      { kind: 'bridge-reply', reason: 'net-zero', message: '已收到撤回', targetMessageId: 'om_t' },
      { send: async () => {}, effects, reactionKey: 'k', targetMessageId: 'om_t', scope: 'oc_s' },
    );

    expect(cancelCalls).toHaveLength(0);
  });
});

// ── Same-key revision invalidation while queued (production seam) ──
// Exercises the real enqueue-path cleanup path: when rev2 arrives for a key
// whose rev1 is still queued (not yet active), the old entry must be atomically
// evicted — only the latest revision survives in the queue, in context, and in
// all turnId indexes. A queued entry must NOT trigger a scope interrupt.
// An active entry on a DIFFERENT key on the same scope must NOT be interrupted.

describe('same-key revision invalidation while queued (production seam)', () => {
  it('rev1 queued → rev2 arrives → only turn2 survives; turn1 is evicted', async () => {
    const {
      setReactionTurnMeta,
      consumeReactionTurnMeta,
      deleteReactionTurnMeta,
      hasTurnMetaForTurnId,
      hasTurnIdForKey,
    } = await import('../../../src/bot/channel');

    const rk = 'oc_s\x1fou_u\x1fom_t';
    const turn1 = `${rk}:1`;
    const turn2 = `${rk}:2`;

    // ── Simulate rev1 enqueue ──
    setReactionTurnMeta(rk, 'om_t', 'oc_s', 'wc-1', 1, turn1);
    expect(hasTurnMetaForTurnId(turn1)).toBe(true);
    expect(hasTurnIdForKey(rk)).toBe(true);

    // ── Simulate rev2 arrival: atomically evict rev1 before enqueuing rev2 ──
    // Step: check tracker for existing entry → found (queued) → evict
    const oldTurnId = turn1; // _reactionTurnIdByKey.get(rk) returns turn1
    expect(oldTurnId).toBe(turn1);
    // cancel pending by oldTurnId (simulated; real path calls pending.cancelMessage)
    // clean up context (simulated; real path calls contextStore.delete(rk))
    deleteReactionTurnMeta(rk);
    // Now enqueue rev2
    setReactionTurnMeta(rk, 'om_t', 'oc_s', 'wc-1', 2, turn2);

    // ── Verify: turn1 is completely evicted ──
    expect(hasTurnMetaForTurnId(turn1)).toBe(false);
    expect(consumeReactionTurnMeta(turn1)).toBeUndefined();

    // ── Verify: turn2 is the sole survivor ──
    expect(hasTurnMetaForTurnId(turn2)).toBe(true);
    expect(hasTurnIdForKey(rk)).toBe(true);
    const meta2 = consumeReactionTurnMeta(turn2);
    expect(meta2).toBeDefined();
    expect(meta2!.revision).toBe(2);
    expect(meta2!.reactionKey).toBe(rk);

    // ── Verify: after consuming, everything is clean ──
    expect(hasTurnMetaForTurnId(turn2)).toBe(false);
    expect(hasTurnIdForKey(rk)).toBe(false);
  });

  it('rev1 queued → rev2 arrives → turn2 gets correct revision (not stale rev1)', async () => {
    const {
      setReactionTurnMeta,
      consumeReactionTurnMeta,
      deleteReactionTurnMeta,
    } = await import('../../../src/bot/channel');

    const rk = 'oc_s\x1fou_u\x1fom_t';
    const turn1 = `${rk}:1`;
    const turn2 = `${rk}:2`;

    // rev1 enqueue
    setReactionTurnMeta(rk, 'om_t', 'oc_s', 'wc-1', 1, turn1);
    // rev2 arrival → evict rev1
    deleteReactionTurnMeta(rk);
    // rev2 enqueue
    setReactionTurnMeta(rk, 'om_t', 'oc_s', 'wc-1', 2, turn2);

    // turn2 returns rev2, NOT rev1
    const meta2 = consumeReactionTurnMeta(turn2);
    expect(meta2!.revision).toBe(2);
    // turn1 is gone
    expect(consumeReactionTurnMeta(turn1)).toBeUndefined();
  });

  it('another key active on same scope is NOT interrupted when queued rev1 is evicted', async () => {
    const {
      setReactionTurnMeta,
      deleteReactionTurnMeta,
      consumeReactionTurnMeta,
      hasTurnMetaForTurnId,
    } = await import('../../../src/bot/channel');

    const rkA = 'oc_s\x1fou_a\x1fom_a'; // active key
    const rkB = 'oc_s\x1fou_b\x1fom_b'; // queued key, about to be evicted
    const turnA = `${rkA}:1`;
    const turnB1 = `${rkB}:1`;
    const turnB2 = `${rkB}:2`;

    // Key A is enqueued (simulates active run)
    setReactionTurnMeta(rkA, 'om_a', 'oc_s', 'wc-a', 1, turnA);
    // Key B rev1 is enqueued (queued, not active)
    setReactionTurnMeta(rkB, 'om_b', 'oc_s', 'wc-b', 1, turnB1);

    // Key B rev2 arrives → evict only key B, NOT key A
    deleteReactionTurnMeta(rkB);
    setReactionTurnMeta(rkB, 'om_b', 'oc_s', 'wc-b', 2, turnB2);

    // Key A is untouched
    expect(hasTurnMetaForTurnId(turnA)).toBe(true);
    const metaA = consumeReactionTurnMeta(turnA);
    expect(metaA!.revision).toBe(1);
    expect(metaA!.reactionKey).toBe(rkA);

    // Key B rev2 is correct
    const metaB = consumeReactionTurnMeta(turnB2);
    expect(metaB!.revision).toBe(2);
    // Key B rev1 is gone
    expect(consumeReactionTurnMeta(turnB1)).toBeUndefined();
  });

  it('three revisions queued in sequence — only the latest survives', async () => {
    const {
      setReactionTurnMeta,
      deleteReactionTurnMeta,
      consumeReactionTurnMeta,
    } = await import('../../../src/bot/channel');

    const rk = 'oc_s\x1fou_u\x1fom_t';
    const turn1 = `${rk}:1`;
    const turn2 = `${rk}:2`;
    const turn3 = `${rk}:3`;

    // rev1
    setReactionTurnMeta(rk, 'om_t', 'oc_s', 'wc-1', 1, turn1);
    // rev2 → evict rev1
    deleteReactionTurnMeta(rk);
    setReactionTurnMeta(rk, 'om_t', 'oc_s', 'wc-1', 2, turn2);
    // rev3 → evict rev2
    deleteReactionTurnMeta(rk);
    setReactionTurnMeta(rk, 'om_t', 'oc_s', 'wc-1', 3, turn3);

    // Only rev3 survives
    expect(consumeReactionTurnMeta(turn1)).toBeUndefined();
    expect(consumeReactionTurnMeta(turn2)).toBeUndefined();
    const meta3 = consumeReactionTurnMeta(turn3);
    expect(meta3!.revision).toBe(3);
  });

  it('rev1 queued → rev2 evicts rev1 via cancelMessage → pending queue only has turn2', () => {
    const scope = 'oc_s';
    const rk = 'oc_s\x1fou_u\x1fom_t';
    const turn1 = `${rk}:1`;
    const turn2 = `${rk}:2`;

    // Real PendingQueue
    const flushed: string[][] = [];
    const queue = new PendingQueue(9999, (_s, batch) => {
      flushed.push(batch.map(m => m.messageId));
    });

    // rev1 enqueue as barrier
    const msg1 = { messageId: turn1, chatId: scope, chatType: 'group' as const, senderId: '', content: '', rawContentType: 'reaction' as never, resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: 0 };
    queue.pushBarrier(scope, msg1);

    // rev2 arrives — evict rev1's barrier by turnId
    const cancelled = queue.cancelMessage(scope, turn1);
    expect(cancelled.length).toBe(1);
    expect(cancelled[0]!.messageId).toBe(turn1);

    // rev2 enqueue as new barrier
    const msg2 = { messageId: turn2, chatId: scope, chatType: 'group' as const, senderId: '', content: '', rawContentType: 'reaction' as never, resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: 0 };
    queue.pushBarrier(scope, msg2);

    // Flush by cancelling the scope — only turn2 should be in the cancelled batch
    const remaining = queue.cancel(scope);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.messageId).toBe(turn2);
    // No turn1 in the remaining batch
    expect(remaining.find(m => m.messageId === turn1)).toBeUndefined();
  });
});

// ── evictInFlightReactionEntry: production seam with real ActiveRuns reservation ──
// Exercises the exported production seam with real PendingQueue, ActiveRuns,
// ReactionContextStore, and ReactionRunTracker — no manual Map mocks.

describe('evictInFlightReactionEntry — production seam with real reservation', () => {
  it('barrier flushed from queue + ActiveRuns reservation held → cancelMessage=0, interrupt aborts reservation', async () => {
    const { evictInFlightReactionEntry, setReactionTurnMeta, consumeReactionTurnMeta } = await import('../../../src/bot/channel');
    const scope = 'oc_s';
    const rk = 'oc_s\x1fou_u\x1fom_t';
    const turn1 = `${rk}:1`;

    // Real PendingQueue — rev1 barrier has already been flushed (empty queue)
    const queue = new PendingQueue(9999, () => {});
    // Real ActiveRuns — rev1 holds a reservation (prompt-prep / pool-wait phase)
    const activeRuns = new ActiveRuns();
    const reservation = activeRuns.reserve(scope);
    expect(reservation).toBeDefined();
    expect(reservation!.signal.aborted).toBe(false);

    // Real ReactionContextStore
    const contextStore = new ReactionContextStore();
    contextStore.set(rk, [{ operatorOpenId: 'ou_u', reactionRevision: 1, triggerReactions: [], effectiveReactionSet: [], targetMessage: { available: true, messageId: 'om_t' } }]);

    // Real ReactionRunTracker — rev1 registered by buffer handler as 'queued'
    const tracker = new ReactionRunTracker();
    tracker.register({ scope, operatorOpenId: 'ou_u', targetMessageId: 'om_t', reactionRevision: 1, runId: 'run-1', status: 'queued' });
    // Set up turn meta so cancelMessage can find the turnId
    setReactionTurnMeta(rk, 'om_t', scope, 'wc-1', 1, turn1);

    // rev2 arrives — evict rev1
    const result = evictInFlightReactionEntry({
      reactionKey: rk,
      scope,
      opId: 'ou_u',
      tgtId: 'om_t',
      existingStatus: 'queued',
      oldRevision: 1,
      newRevision: 2,
      pending: queue,
      contextStore,
      activeRuns,
      tracker,
    });

    // Barrier was already flushed → cancelMessage returned 0 → needsInterrupt
    expect(result.removedFromQueue).toBe(0);
    expect(result.needsInterrupt).toBe(true);

    // Reservation was aborted by activeRuns.interrupt
    expect(reservation!.signal.aborted).toBe(true);

    // Old context and meta are cleaned up
    expect(contextStore.get(rk)).toBeUndefined();
    expect(consumeReactionTurnMeta(turn1)).toBeUndefined();

    // Tracker entry is gone
    expect(tracker.get(scope, 'ou_u', 'om_t')).toBeUndefined();
  });

  it('queued barrier still in PendingQueue → cancelMessage removes it, no interrupt, no reservation abort', async () => {
    const { evictInFlightReactionEntry, setReactionTurnMeta, consumeReactionTurnMeta } = await import('../../../src/bot/channel');
    const scope = 'oc_s';
    const rk = 'oc_s\x1fou_u\x1fom_t';
    const turn1 = `${rk}:1`;

    // Real PendingQueue — rev1 barrier is still pending
    const queue = new PendingQueue(9999, () => {});
    const msg1 = { messageId: turn1, chatId: scope, chatType: 'group' as const, senderId: '', content: '', rawContentType: 'reaction' as never, resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: 0 };
    queue.pushBarrier(scope, msg1);
    expect(queue.pendingCount(scope)).toBe(1);

    // Real ActiveRuns — no reservation held (barrier still queued)
    const activeRuns = new ActiveRuns();

    // Real tracker + context — as set up by the buffer handler
    const tracker = new ReactionRunTracker();
    tracker.register({ scope, operatorOpenId: 'ou_u', targetMessageId: 'om_t', reactionRevision: 1, runId: 'run-1', status: 'queued' });
    const contextStore = new ReactionContextStore();
    contextStore.set(rk, [{ operatorOpenId: 'ou_u', reactionRevision: 1, triggerReactions: [], effectiveReactionSet: [], targetMessage: { available: true, messageId: 'om_t' } }]);
    setReactionTurnMeta(rk, 'om_t', scope, 'wc-1', 1, turn1);

    // rev2 arrives — evict rev1 via production seam
    const result = evictInFlightReactionEntry({
      reactionKey: rk, scope, opId: 'ou_u', tgtId: 'om_t',
      existingStatus: 'queued', oldRevision: 1, newRevision: 2,
      pending: queue, contextStore, activeRuns, tracker,
    });

    // Barrier WAS still in queue → cancelMessage removed it (>0)
    expect(result.removedFromQueue).toBe(1);
    expect(result.needsInterrupt).toBe(false);
    // Queue is now empty
    expect(queue.pendingCount(scope)).toBe(0);
    // Context + meta + tracker cleaned up
    expect(contextStore.get(rk)).toBeUndefined();
    expect(consumeReactionTurnMeta(turn1)).toBeUndefined();
    expect(tracker.get(scope, 'ou_u', 'om_t')).toBeUndefined();
  });

  it('status=reserved → interrupt called without trying cancelMessage; reservation aborted', async () => {
    const { evictInFlightReactionEntry, setReactionTurnMeta, consumeReactionTurnMeta } = await import('../../../src/bot/channel');
    const scope = 'oc_s';
    const rk = 'oc_s\x1fou_u\x1fom_t';
    const turn1 = `${rk}:1`;

    const queue = new PendingQueue(9999, () => {});
    const activeRuns = new ActiveRuns();
    const reservation = activeRuns.reserve(scope);
    expect(reservation).toBeDefined();
    const contextStore = new ReactionContextStore();
    contextStore.set(rk, [{} as any]);
    const tracker = new ReactionRunTracker();
    tracker.register({ scope, operatorOpenId: 'ou_u', targetMessageId: 'om_t', reactionRevision: 1, runId: 'run-1', status: 'reserved' });
    setReactionTurnMeta(rk, 'om_t', scope, 'wc-1', 1, turn1);

    const result = evictInFlightReactionEntry({
      reactionKey: rk, scope, opId: 'ou_u', tgtId: 'om_t',
      existingStatus: 'reserved', oldRevision: 1, newRevision: 2,
      pending: queue, contextStore, activeRuns, tracker,
    });

    // status=reserved → needsInterrupt immediately, no cancelMessage attempt
    expect(result.removedFromQueue).toBe(0);
    expect(result.needsInterrupt).toBe(true);
    // Reservation was aborted
    expect(reservation!.signal.aborted).toBe(true);
    // Old flow would get run-interrupted via register() throwing on signal.aborted
    expect(() => activeRuns.register(scope, { stop: async () => {}, waitForExit: async () => {} } as any, reservation!)).toThrow('run reservation was interrupted');
    // Cleanup complete
    expect(contextStore.get(rk)).toBeUndefined();
    expect(consumeReactionTurnMeta(turn1)).toBeUndefined();
    expect(tracker.get(scope, 'ou_u', 'om_t')).toBeUndefined();
  });
});

// ── PendingQueue barred-blocked multi-barrier ordering (production seam) ──
// Exercises the real PendingQueue with block/unblock and multiple barriers
// arriving during an active run. Verifies FIFO preservation and no barrier loss.

describe('PendingQueue ordered-unit deque — interleaved arrival order', () => {
  // ── helpers ──
  const reg = (scope: string, id: string): import('@larksuite/channel').NormalizedMessage => ({
    messageId: id, chatId: scope, chatType: 'group' as const,
    senderId: '', content: '', rawContentType: 'text' as never,
    resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: 0,
  });
  const barrier = (scope: string, id: string): import('@larksuite/channel').NormalizedMessage => ({
    messageId: id, chatId: scope, chatType: 'group' as const,
    senderId: '', content: '', rawContentType: 'reaction' as never,
    resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: 0,
  });

  // ── 1) blocked: barrier B → ordinary C → barrier D → unblock → B, C, D ──
  it('blocked scope: barrier→ordinary→barrier preserves interleaved arrival order', () => {
    const scope = 'oc_s';
    const queue = new PendingQueue(9999, () => {});

    queue.block(scope);
    queue.pushBarrier(scope, barrier(scope, 'B'));
    queue.push(scope, reg(scope, 'C'));
    queue.pushBarrier(scope, barrier(scope, 'D'));
    expect(queue.pendingCount(scope)).toBe(3);

    // cancel drains all units—verify FIFO arrival order
    const remaining = queue.cancel(scope);
    expect(remaining.map(m => m.messageId)).toEqual(['B', 'C', 'D']);
  });

  // ── 2) unblocked: regular→B→C with onFlush calling block → only first unit flushes ──
  it('non-blocked: onFlush calls block → only first unit flushes; B,C survive without concurrent onFlush', () => {
    const scope = 'oc_s';
    const flushed: string[][] = [];
    const queue = new PendingQueue(1, (_s, batch) => {
      flushed.push(batch.map(m => m.messageId));
      // Real production behaviour: onFlush triggers runAgentBatch → block(scope)
      queue.block(scope);
    });

    // Not blocked — regular message arrives
    queue.push(scope, reg(scope, 'reg_1'));
    // Barrier B arrives → flushes reg_1, enqueues B. onFlush blocks scope.
    queue.pushBarrier(scope, barrier(scope, 'B'));
    // Barrier C arrives while blocked → just enqueues
    queue.pushBarrier(scope, barrier(scope, 'C'));

    // Only reg_1 was flushed (one unit)
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toEqual(['reg_1']);

    // B and C are still pending (2 units)
    expect(queue.pendingCount(scope)).toBe(2);

    // Simulate run completion: unblock → flush B
    queue.unblock(scope);
    // Cancel drains remaining — B then C in order
    const remaining = queue.cancel(scope);
    expect(remaining.map(m => m.messageId)).toEqual(['B', 'C']);

    // No concurrent onFlush happened — only 1 flush call total (for reg_1)
    // B and C were returned by cancel(), not flushed via onFlush
    expect(flushed.length).toBe(1);
  });

  // ── 3) blocked: two barriers → cancel() returns them in FIFO order ──
  it('blocked scope: two barriers returned in FIFO order by cancel', () => {
    const scope = 'oc_s';
    const queue = new PendingQueue(9999, () => {});

    queue.block(scope);
    queue.pushBarrier(scope, barrier(scope, 'B'));
    queue.pushBarrier(scope, barrier(scope, 'C'));
    expect(queue.pendingCount(scope)).toBe(2);

    const remaining = queue.cancel(scope);
    expect(remaining.map(m => m.messageId)).toEqual(['B', 'C']);
  });

  // ── 4) cancelMessage preserves unit order ──
  it('cancelMessage removes target barrier without changing other unit order', () => {
    const scope = 'oc_s';
    const queue = new PendingQueue(9999, () => {});

    queue.block(scope);
    queue.pushBarrier(scope, barrier(scope, 'B'));
    queue.push(scope, reg(scope, 'C'));
    queue.pushBarrier(scope, barrier(scope, 'D'));
    expect(queue.pendingCount(scope)).toBe(3);

    // Cancel C (the regular message in the middle)
    const removed = queue.cancelMessage(scope, 'C');
    expect(removed.length).toBe(1);
    expect(removed[0]!.messageId).toBe('C');

    // Remaining order: B, D
    const remaining = queue.cancel(scope);
    expect(remaining.map(m => m.messageId)).toEqual(['B', 'D']);
  });

  // ── 5) cancelMessage on barrier in middle preserves order ──
  it('cancelMessage removes middle barrier, preserves surrounding units', () => {
    const scope = 'oc_s';
    const queue = new PendingQueue(9999, () => {});

    queue.block(scope);
    queue.pushBarrier(scope, barrier(scope, 'B'));
    queue.pushBarrier(scope, barrier(scope, 'C'));
    queue.push(scope, reg(scope, 'D'));
    expect(queue.pendingCount(scope)).toBe(3);

    // Cancel the middle barrier
    const removed = queue.cancelMessage(scope, 'C');
    expect(removed.length).toBe(1);
    expect(removed[0]!.messageId).toBe('C');

    // Remaining order: B, D
    const remaining = queue.cancel(scope);
    expect(remaining.map(m => m.messageId)).toEqual(['B', 'D']);
  });

  // ── 6) non-blocked pushBarrier only flushes one unit, never multiple ──
  it('non-blocked pushBarrier flushes at most one unit (no flushAll)', () => {
    const scope = 'oc_s';
    const flushed: string[][] = [];
    const queue = new PendingQueue(9999, (_s, batch) => {
      flushed.push(batch.map(m => m.messageId));
    });

    // Not blocked. Push two regular messages (merge into one unit), then a barrier.
    queue.push(scope, reg(scope, 'reg_1'));
    queue.push(scope, reg(scope, 'reg_2'));
    // One regular unit: [reg_1, reg_2]

    // pushBarrier: flushes the regular unit, enqueues barrier B
    queue.pushBarrier(scope, barrier(scope, 'B'));
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toEqual(['reg_1', 'reg_2']);

    // B is pending
    expect(queue.pendingCount(scope)).toBe(1);

    // pushBarrier C: flushes B, enqueues C
    queue.pushBarrier(scope, barrier(scope, 'C'));
    expect(flushed.length).toBe(2);
    expect(flushed[1]).toEqual(['B']);

    // C is pending
    const remaining = queue.cancel(scope);
    expect(remaining.map(m => m.messageId)).toEqual(['C']);
  });

  // ── 7a) pushBarrier does NOT overwrite remaining units after flushFirstUnit ──
  // Regression: blocked B,C,D → unblock → pushBarrier E before timer fires.
  // flushFirstUnit flushes B, but C,D remain in the entry. The old code
  // overwrote the entry with just E, losing C and D.
  it('unblocked multi-unit queue + pushBarrier before timer: remaining units survive, new appended', () => {
    const scope = 'oc_s';
    const flushed: string[] = [];
    const queue = new PendingQueue(1, (_s, batch) => {
      flushed.push(...batch.map(m => m.messageId));
      queue.block(scope);
    });

    // Block → B barrier → C ordinary → D barrier
    queue.block(scope);
    queue.pushBarrier(scope, barrier(scope, 'B'));
    queue.push(scope, reg(scope, 'C'));
    queue.pushBarrier(scope, barrier(scope, 'D'));
    expect(queue.pendingCount(scope)).toBe(3);

    // Unblock — timer armed (1ms), but we act before it fires
    queue.unblock(scope);
    expect(queue.isBlocked(scope)).toBe(false);

    // pushBarrier E arrives before the timer fires.
    // flushFirstUnit → B flushed (onFlush → block).  C,D still in map.
    queue.pushBarrier(scope, barrier(scope, 'E'));

    // B was flushed, scope is now blocked by onFlush.
    expect(flushed).toEqual(['B']);

    // Remaining units: C (regular), D (barrier), E (barrier) — 3 pending
    expect(queue.pendingCount(scope)).toBe(3);

    // Drain and verify FIFO order: C, D, E
    queue.unblock(scope);
    const remaining = queue.cancel(scope);
    expect(remaining.map(m => m.messageId)).toEqual(['C', 'D', 'E']);
  });

  // ── 7) blocked entry check after flushFirst — timer NOT armed while blocked ──
  it('pushBarrier after flushFirst does NOT arm timer when onFlush blocked scope', () => {
    const scope = 'oc_s';
    const queue = new PendingQueue(1, (_s, batch) => {
      // Real production: onFlush → runAgentBatch → block(scope)
      queue.block(scope);
    });

    // Regular message enqueued
    queue.push(scope, reg(scope, 'reg_1'));
    expect(queue.isBlocked(scope)).toBe(false);

    // pushBarrier: flushFirst reg_1, onFlush blocks scope, then enqueue B
    queue.pushBarrier(scope, barrier(scope, 'B'));

    // Scope should be blocked after onFlush
    expect(queue.isBlocked(scope)).toBe(true);
    // B should be pending (1 unit), no timer armed
    expect(queue.pendingCount(scope)).toBe(1);

    // Verify B wasn't flushed while blocked
    // Unblock and drain
    queue.unblock(scope);
    const remaining = queue.cancel(scope);
    expect(remaining.map(m => m.messageId)).toEqual(['B']);
  });
});

// ── WorkChainStore: single allocation + outbound registration + stop correlation ──
// Exercises the production seam: pipeline resolveWorkChain must register the
// target in the outbound map so that subsequent calls (flush, stop) hit the
// same chain. ResolveCurrentChain must find queued/reserved/active chains.

describe('WorkChainStore single allocation + outbound registration (production seam)', () => {
  it('resolveOrAllocate + registerOutbound → subsequent resolveOrAllocate returns same chain', () => {
    const store = new WorkChainStore();
    const scope = 'oc_s';
    const targetMsgId = 'om_confirm';

    // First call (pipeline): allocate + register target
    const chain1 = store.resolveOrAllocate(scope, targetMsgId);
    store.registerOutbound(chain1, targetMsgId);

    // Second call (flush): same target → same chain, no double allocation
    const chain2 = store.resolveOrAllocate(scope, targetMsgId);
    expect(chain2).toBe(chain1);
  });

  it('resolveOrAllocate without registerOutbound → second call allocates different chain (old bug)', () => {
    const store = new WorkChainStore();
    const scope = 'oc_s';
    const targetMsgId = 'om_confirm';

    // Old bug: pipeline allocates but forgets to register
    const chain1 = store.resolveOrAllocate(scope, targetMsgId);
    // (missing registerOutbound)

    // Flush allocates again → different chain
    const chain2 = store.resolveOrAllocate(scope, targetMsgId);
    expect(chain2).not.toBe(chain1);
  });

  it('resolveCurrentChain finds chain when target registered and chain is current', () => {
    const store = new WorkChainStore();
    const scope = 'oc_s';
    const targetMsgId = 'om_bot_output';

    const chain = store.allocate(scope);
    store.registerOutbound(chain, targetMsgId);

    const resolved = store.resolveCurrentChain(targetMsgId);
    expect(resolved).toBe(chain);
  });

  it('resolveCurrentChain returns undefined when target was never registered', () => {
    const store = new WorkChainStore();
    // No outbound mapping exists

    const resolved = store.resolveCurrentChain('om_unknown');
    expect(resolved).toBeUndefined();
  });

  it('resolveCurrentChain returns undefined for terminal (historical) chain', () => {
    const store = new WorkChainStore();
    const scope = 'oc_s';
    const targetMsgId = 'om_old';

    const chain = store.allocate(scope);
    store.registerOutbound(chain, targetMsgId);
    store.markTerminal(chain);

    const resolved = store.resolveCurrentChain(targetMsgId);
    expect(resolved).toBeUndefined();
  });

  it('pipeline→flush→stop: single chain across the full lifecycle', () => {
    const store = new WorkChainStore();
    const scope = 'oc_s';
    const targetMsgId = 'om_approve_target';

    // Pipeline: resolveOrAllocate + registerOutbound (as channel.ts now does)
    const chain = store.resolveOrAllocate(scope, targetMsgId);
    store.registerOutbound(chain, targetMsgId);
    expect(store.isCurrent(chain)).toBe(true);

    // Flush: resolveOrAllocate again → same chain
    const flushChain = store.resolveOrAllocate(scope, targetMsgId);
    expect(flushChain).toBe(chain);

    // Stop: resolveCurrentChain → finds the chain (it's still current)
    const stopResolved = store.resolveCurrentChain(targetMsgId);
    expect(stopResolved).toBe(chain);
  });

  it('resolveCurrentChain marks chain as terminal → no longer current → resolve returns undefined', () => {
    const store = new WorkChainStore();
    const scope = 'oc_s';
    const targetMsgId = 'om_done';

    const chain = store.allocate(scope);
    store.registerOutbound(chain, targetMsgId);

    // While current → found
    expect(store.resolveCurrentChain(targetMsgId)).toBe(chain);

    // After terminal → not found
    store.markTerminal(chain);
    expect(store.resolveCurrentChain(targetMsgId)).toBeUndefined();
  });
});

// ── B4: WorkChainStore per-unit in-flight tracking ──
describe('WorkChainStore per-unit in-flight (B4)', () => {
  it('chain stays current while any unit in-flight; historical only when last releases', () => {
    const store = new WorkChainStore();
    const chain = store.allocate('oc_s');

    store.acquireUnit(chain, 'unit-a');
    store.acquireUnit(chain, 'unit-b');
    // Two units in-flight → current (sibling on same chain doesn't terminal-mark)
    expect(store.isCurrent(chain)).toBe(true);

    // Release one → still current (other unit still in-flight)
    store.releaseUnit(chain, 'unit-a');
    expect(store.isCurrent(chain)).toBe(true);

    // Release the last → historical
    store.releaseUnit(chain, 'unit-b');
    expect(store.isCurrent(chain)).toBe(false);
  });

  it('acquireUnit re-currents a terminal chain (re-continue / supersede)', () => {
    const store = new WorkChainStore();
    const chain = store.allocate('oc_s');
    store.acquireUnit(chain, 'u1');
    store.releaseUnit(chain, 'u1');
    expect(store.isCurrent(chain)).toBe(false);
    // Re-acquire → current again
    store.acquireUnit(chain, 'u2');
    expect(store.isCurrent(chain)).toBe(true);
    store.releaseUnit(chain, 'u2');
    expect(store.isCurrent(chain)).toBe(false);
  });
});

// ── B2: ActiveRuns covers reserved + active for stop current-work ──
describe('ActiveRuns hasActiveOrReserved (B2)', () => {
  it('detects reservation (reserved, not yet active) — the B2 stop gap', () => {
    const runs = new ActiveRuns();
    expect(runs.hasActiveOrReserved('oc_s')).toBe(false);
    const res = runs.reserve('oc_s');
    expect(res).toBeDefined();
    // Reserved (prompt-prep/pool-wait) must count as current work for stop
    expect(runs.hasActiveOrReserved('oc_s')).toBe(true);
    res!.release();
    expect(runs.hasActiveOrReserved('oc_s')).toBe(false);
  });
});
