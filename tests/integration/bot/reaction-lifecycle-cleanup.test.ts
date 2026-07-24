import { describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import {
  createReactionFlushEffects,
  executeReactionFlushDecision,
  hasTurnMetaForTurnId,
  hasTurnIdForKey,
  releaseEnqueuedTurn,
  releaseFlushedTurnAfterError,
  setReactionTurnMeta,
} from '../../../src/bot/channel';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { ReactionContextStore } from '../../../src/bot/reaction/context-store';
import { ReactionRunTracker } from '../../../src/bot/reaction/run-tracker';
import { WorkChainStore } from '../../../src/bot/reaction/work-chain';
import { makeReactionKey, type ReactionContext } from '../../../src/bot/reaction/types';

function setup(revision: number, acquire = true) {
  const scope = 'oc_scope';
  const operatorOpenId = 'ou_operator';
  const targetMessageId = `om_target_${revision}`;
  const reactionKey = makeReactionKey(scope, operatorOpenId, targetMessageId);
  const turnId = `${reactionKey}:${revision}`;
  const workChainStore = new WorkChainStore();
  const workChainId = workChainStore.resolveOrAllocate(scope, targetMessageId);
  workChainStore.registerOutbound(workChainId, targetMessageId);
  if (acquire) workChainStore.acquireUnit(workChainId, turnId);
  const reactionContextStore = new ReactionContextStore();
  reactionContextStore.set(reactionKey, [{} as ReactionContext]);
  const reactionRunTracker = new ReactionRunTracker();
  reactionRunTracker.register({
    scope,
    operatorOpenId,
    targetMessageId,
    reactionRevision: revision,
    runId: `run-${revision}`,
    status: 'queued',
  });
  setReactionTurnMeta(reactionKey, targetMessageId, scope, workChainId, revision, turnId);
  return {
    scope,
    operatorOpenId,
    targetMessageId,
    reactionKey,
    turnId,
    workChainId,
    workChainStore,
    reactionContextStore,
    reactionRunTracker,
  };
}

function expectCleaned(state: ReturnType<typeof setup>) {
  expect(state.reactionContextStore.size).toBe(0);
  expect(hasTurnMetaForTurnId(state.turnId)).toBe(false);
  expect(hasTurnIdForKey(state.reactionKey)).toBe(false);
  expect(
    state.reactionRunTracker.get(
      state.scope,
      state.operatorOpenId,
      state.targetMessageId,
    ),
  ).toBeUndefined();
  expect(state.workChainStore.hasCurrentWork(state.scope)).toBe(false);
}

describe('Reaction lifecycle cleanup production seams', () => {
  it('direct cancellation cleanup clears context, meta, tracker, and lease state', () => {
    const state = setup(101);
    releaseEnqueuedTurn(state.scope, state.turnId, state);
    expectCleaned(state);
  });

  it('async flush failure clears the transferred lease and all Reaction side-state', () => {
    const state = setup(102);
    releaseFlushedTurnAfterError(
      state.scope,
      state.turnId,
      { workChainId: state.workChainId, unitId: state.turnId },
      state,
    );
    expectCleaned(state);
  });

  it('command-style pending.cancel plus releaseEnqueuedTurn clears the real queued unit', () => {
    const state = setup(103, false);
    const pending = new PendingQueue(60_000, () => {}, {
      resolveOrAllocate: () => state.workChainId,
      acquire: (lease) => state.workChainStore.acquireUnit(lease.workChainId, lease.unitId),
      release: (lease) => state.workChainStore.releaseUnit(lease.workChainId, lease.unitId),
    });
    pending.block(state.scope);
    pending.pushBarrier(
      state.scope,
      {
        messageId: state.turnId,
        chatId: state.scope,
        chatType: 'group',
        senderId: state.operatorOpenId,
        content: '[reaction] test',
        rawContentType: 'reaction' as never,
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
      },
      { workChainId: state.workChainId, unitId: state.turnId },
    );

    const dropped = pending.cancel(state.scope);
    for (const item of dropped) releaseEnqueuedTurn(state.scope, item.messageId, state);

    expect(dropped.map((item) => item.messageId)).toEqual([state.turnId]);
    expectCleaned(state);
  });

  it('empty-set decision clears a queued Reaction without starting an Agent turn', async () => {
    const state = setup(104, false);
    const pending = new PendingQueue(60_000, () => {}, {
      resolveOrAllocate: () => state.workChainId,
      acquire: (lease) => state.workChainStore.acquireUnit(lease.workChainId, lease.unitId),
      release: (lease) => state.workChainStore.releaseUnit(lease.workChainId, lease.unitId),
    });
    pending.block(state.scope);
    pending.pushBarrier(
      state.scope,
      {
        messageId: state.turnId,
        chatId: state.scope,
        chatType: 'group',
        senderId: state.operatorOpenId,
        content: '[reaction] removed',
        rawContentType: 'reaction' as never,
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
      },
      { workChainId: state.workChainId, unitId: state.turnId },
    );
    const effects = createReactionFlushEffects({
      pending,
      contextStore: state.reactionContextStore,
      activeRuns: new ActiveRuns(),
      runTracker: state.reactionRunTracker,
    });

    await executeReactionFlushDecision(
      {
        kind: 'bridge-reply',
        reason: 'empty-set',
        message: '已收到撤回，已完成动作不会自动回滚。',
        targetMessageId: state.targetMessageId,
      },
      {
        send: async () => {},
        effects,
        reactionKey: state.reactionKey,
        targetMessageId: state.targetMessageId,
        scope: state.scope,
      },
    );

    expect(pending.pendingCount(state.scope)).toBe(0);
    expectCleaned(state);
  });
});
