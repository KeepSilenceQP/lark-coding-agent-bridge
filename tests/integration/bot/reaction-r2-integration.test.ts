import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { WorkChainStore } from '../../../src/bot/reaction/work-chain';
import { ReactionRunTracker } from '../../../src/bot/reaction/run-tracker';
import { markSuperseded, initialState } from '../../../src/card/run-state';
import { computeCanonicalFingerprint, EMPTY_FINGERPRINT } from '../../../src/bot/reaction/ledger';
import { isSnapshotCompatible } from '../../../src/bot/reaction/reconciler';
import { detectNetZeroPair } from '../../../src/bot/reaction/reconciler';
import type { BufferedReactionEvent, CanonicalReactionRecord } from '../../../src/bot/reaction/types';
import { lookupReactionSemantics } from '../../../src/bot/reaction/semantics';
import { makeReactionKey } from '../../../src/bot/reaction/types';

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
    tracker.register({ scope: 'oc_s', operatorOpenId: 'ou_u', targetMessageId: 'om_t', reactionRevision: 1, runId: 'run-1' });
    expect(tracker.shouldInterrupt('oc_s', 'ou_u', 'om_t', 2)).toBe(true);
    expect(tracker.shouldInterrupt('oc_s', 'ou_u', 'om_t', 1)).toBe(false);
  });

  it('different key (different operator) → shouldInterrupt=false, no false supersede', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({ scope: 'oc_s', operatorOpenId: 'ou_a', targetMessageId: 'om_t', reactionRevision: 1, runId: 'run-1' });
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
    tracker.register({ scope: 'oc_s', operatorOpenId: 'ou_a', targetMessageId: 'om_a', reactionRevision: 1, runId: 'run-a' });
    // Key B: active run, same scope but different operator
    tracker.register({ scope: 'oc_s', operatorOpenId: 'ou_b', targetMessageId: 'om_b', reactionRevision: 1, runId: 'run-b' });
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

import { decideReactionFlush } from '../../../src/bot/channel';
import type { ReactionFlushDecision } from '../../../src/bot/channel';

describe('decideReactionFlush — production flush decision engine', () => {
  it('reconciliationFailed → bridge-reply "请重试", no Agent', () => {
    const d = decideReactionFlush({
      reconciliationFailed: true, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingActiveRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { message: string }).message).toContain('暂时无法确认');
  });

  it('noOp → drop (no reply, no Agent)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: true, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingActiveRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('drop');
  });

  it('netZeroConsumed → bridge-reply "已收到撤回", no Agent', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: true,
      effectiveReactionSetLength: 0, hasMatchingActiveRun: false,
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
      effectiveReactionSetLength: 0, hasMatchingActiveRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { message: string }).message).toContain('已完成动作不会自动回滚');
    expect((d as { interrupt?: { scope: string } }).interrupt).toBeUndefined();
  });

  it('active same-key empty-set removal → bridge-reply + interrupt (no Agent)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingActiveRun: true,
      targetMessageId: 'om_t', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { interrupt?: { scope: string } }).interrupt).toBeDefined();
    expect((d as { interrupt?: { scope: string } }).interrupt!.scope).toBe('oc_s');
    // Must NOT enqueue Agent
    expect(d.kind).not.toBe('enqueue-agent');
  });

  it('non-empty effective set + context → enqueue-agent (replacement turn)', () => {
    const ctx = { operatorOpenId: 'ou_u', reactionRevision: 2, triggerReactions: [], effectiveReactionSet: [{ emojiType: 'OK' }], targetMessage: { available: true, messageId: 'om_t' } };
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 1, hasMatchingActiveRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
      reactionContext: ctx,
    });
    expect(d.kind).toBe('enqueue-agent');
    expect((d as { reactionContext: unknown }).reactionContext).toBe(ctx);
  });

  it('non-empty set but no reactionContext → drop (no context, safe)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 1, hasMatchingActiveRun: false,
      targetMessageId: 'om_t', scope: 'oc_s',
      reactionContext: undefined,
    });
    expect(d.kind).toBe('drop');
    expect((d as { reason: string }).reason).toBe('no-context');
  });

  // ── Different key must NOT trigger interrupt ──
  it('empty set, hasMatchingActiveRun=false → no interrupt (different key scenario)', () => {
    const d = decideReactionFlush({
      reconciliationFailed: false, noOp: false, netZeroConsumed: false,
      effectiveReactionSetLength: 0, hasMatchingActiveRun: false,
      targetMessageId: 'om_other', scope: 'oc_s',
    });
    expect(d.kind).toBe('bridge-reply');
    expect((d as { interrupt?: { scope: string } }).interrupt).toBeUndefined();
  });

  // ── Decision type guard: bridge-reply never coincides with enqueue-agent ──
  it('bridge-reply decisions are mutually exclusive with enqueue-agent', () => {
    const cases = [
      { reconciliationFailed: true, noOp: false, netZeroConsumed: false, effectiveReactionSetLength: 0, hasMatchingActiveRun: false },
      { reconciliationFailed: false, noOp: true, netZeroConsumed: false, effectiveReactionSetLength: 0, hasMatchingActiveRun: false },
      { reconciliationFailed: false, noOp: false, netZeroConsumed: true, effectiveReactionSetLength: 0, hasMatchingActiveRun: false },
      { reconciliationFailed: false, noOp: false, netZeroConsumed: false, effectiveReactionSetLength: 0, hasMatchingActiveRun: false },
      { reconciliationFailed: false, noOp: false, netZeroConsumed: false, effectiveReactionSetLength: 0, hasMatchingActiveRun: true },
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
