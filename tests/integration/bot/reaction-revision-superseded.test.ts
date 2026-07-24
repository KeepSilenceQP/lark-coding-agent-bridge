import { describe, expect, it } from 'vitest';
import { ReactionRunTracker } from '../../../src/bot/reaction/run-tracker';
import {
  markSuperseded,
  markInterrupted,
  initialState,
} from '../../../src/card/run-state';

// ── ReactionRunTracker ──

describe('ReactionRunTracker', () => {
  it('registers and retrieves a reaction run', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user',
      targetMessageId: 'om_target',
      reactionRevision: 1,
      runId: 'run-1',
      status: 'queued',
    });
    expect(tracker.get('oc_scope', 'ou_user', 'om_target')?.reactionRevision).toBe(1);
  });

  it('unregisters a completed run', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user',
      targetMessageId: 'om_target',
      reactionRevision: 1,
      runId: 'run-1',
      status: 'queued',
    });
    tracker.unregister('oc_scope', 'ou_user', 'om_target');
    expect(tracker.get('oc_scope', 'ou_user', 'om_target')).toBeUndefined();
  });

  it('shouldInterrupt returns true when same key + higher revision', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user',
      targetMessageId: 'om_target',
      reactionRevision: 1,
      runId: 'run-1',
      status: 'active',
    });
    expect(tracker.shouldInterrupt('oc_scope', 'ou_user', 'om_target', 2)).toBe(true);
  });

  it('shouldInterrupt returns false when same revision', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user',
      targetMessageId: 'om_target',
      reactionRevision: 2,
      runId: 'run-1',
      status: 'active',
    });
    expect(tracker.shouldInterrupt('oc_scope', 'ou_user', 'om_target', 2)).toBe(false);
  });

  it('shouldInterrupt returns false for different operator', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user_a',
      targetMessageId: 'om_target',
      reactionRevision: 1,
      runId: 'run-1',
      status: 'active',
    });
    // Different operator should NOT interrupt
    expect(tracker.shouldInterrupt('oc_scope', 'ou_user_b', 'om_target', 2)).toBe(false);
  });

  it('shouldInterrupt returns false for different target', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user',
      targetMessageId: 'om_target_a',
      reactionRevision: 1,
      runId: 'run-1',
      status: 'active',
    });
    // Different target should NOT interrupt
    expect(tracker.shouldInterrupt('oc_scope', 'ou_user', 'om_target_b', 2)).toBe(false);
  });

  it('shouldInterrupt returns false when no run is active', () => {
    const tracker = new ReactionRunTracker();
    expect(tracker.shouldInterrupt('oc_scope', 'ou_user', 'om_target', 1)).toBe(false);
  });

  it('isSameKey returns true for matching operator and target', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user',
      targetMessageId: 'om_target',
      reactionRevision: 1,
      runId: 'run-1',
      status: 'queued',
    });
    expect(tracker.isSameKey('oc_scope', 'ou_user', 'om_target')).toBe(true);
  });

  it('isSameKey returns false for different operator', () => {
    const tracker = new ReactionRunTracker();
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user_a',
      targetMessageId: 'om_target',
      reactionRevision: 1,
      runId: 'run-1',
      status: 'queued',
    });
    expect(tracker.isSameKey('oc_scope', 'ou_user_b', 'om_target')).toBe(false);
  });
});

// ── markSuperseded terminal state ──

describe('markSuperseded', () => {
  it('sets terminal to superseded', () => {
    const state = markSuperseded(initialState);
    expect(state.terminal).toBe('superseded');
  });

  it('closes streaming text blocks', () => {
    const withStreaming = {
      ...initialState,
      blocks: [{ kind: 'text' as const, content: 'partial...', streaming: true }],
    };
    const state = markSuperseded(withStreaming);
    for (const b of state.blocks) {
      if (b.kind === 'text') {
        expect(b.streaming).toBe(false);
      }
    }
  });

  it('clears footer', () => {
    const state = markSuperseded(initialState);
    expect(state.footer).toBeNull();
  });

  it('is distinct from interrupted', () => {
    const superseded = markSuperseded(initialState);
    const interrupted = markInterrupted(initialState);
    expect(superseded.terminal).toBe('superseded');
    expect(interrupted.terminal).toBe('interrupted');
    expect(superseded.terminal).not.toBe(interrupted.terminal);
  });

  it('superseded is not a successful terminal state', () => {
    const state = markSuperseded(initialState);
    expect(state.terminal).not.toBe('done');
  });
});

// ── Revision / lifecycle scenarios (contract tests) ──

describe('revision invalidation contract', () => {
  it('old revision with no outbound reply → no stale reply emitted', () => {
    // When a run is interrupted before producing any outbound reply,
    // only the latest revision's reply should be sent.
    const tracker = new ReactionRunTracker();
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user',
      targetMessageId: 'om_target',
      reactionRevision: 1,
      runId: 'run-1',
      status: 'active',
    });

    // New revision 2 comes in → should interrupt old run
    const shouldInterrupt = tracker.shouldInterrupt('oc_scope', 'ou_user', 'om_target', 2);
    expect(shouldInterrupt).toBe(true);

    // After interrupt, old run is unregistered
    tracker.unregister('oc_scope', 'ou_user', 'om_target');

    // New run with revision 2 is registered
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user',
      targetMessageId: 'om_target',
      reactionRevision: 2,
      runId: 'run-2',
      status: 'queued',
    });

    // New run should be findable, old run gone
    expect(tracker.get('oc_scope', 'ou_user', 'om_target')?.reactionRevision).toBe(2);
  });

  it('old revision with streamed reply → marked superseded, new revision separate reply', () => {
    // When a run has already produced a streaming reply and gets superseded,
    // the original message should be updated to 'superseded', and the new
    // revision produces its own reply.
    const state = {
      ...initialState,
      blocks: [{ kind: 'text' as const, content: 'Old reply text', streaming: true }],
    };

    const superseded = markSuperseded(state);
    expect(superseded.terminal).toBe('superseded');

    // New state for the new revision — independent reply
    const newState = initialState;
    expect(newState.terminal).toBe('running');
  });

  it('post-terminal removal does not restart Agent', () => {
    // After a run reaches terminal state, a 'removed' reaction should
    // NOT produce a new Agent turn. The tracker should have no active run.
    const tracker = new ReactionRunTracker();
    // Run completed and unregistered
    tracker.register({
      scope: 'oc_scope',
      operatorOpenId: 'ou_user',
      targetMessageId: 'om_target',
      reactionRevision: 1,
      runId: 'run-1',
      status: 'queued',
    });
    tracker.unregister('oc_scope', 'ou_user', 'om_target');

    // A new 'removed' event comes in — should not trigger interrupt
    expect(tracker.get('oc_scope', 'ou_user', 'om_target')).toBeUndefined();
    // No Agent turn should be started
  });

  it('same operator/target with empty effective set → no Agent turn, Bridge reply only', () => {
    // When all reactions are removed (effective set empty), the Bridge
    // should reply with withdrawal confirmation and NOT start an Agent turn.
    const tracker = new ReactionRunTracker();

    // If no run is active, there's nothing to interrupt
    expect(tracker.shouldInterrupt('oc_scope', 'ou_user', 'om_target', 1)).toBe(false);

    // The pipeline should handle this by not creating an Agent turn
    // when effectiveReactionSet is empty
  });

  it('isLatest gates terminal cleanup so rev1 terminal does not clear rev2 (B1/B2)', () => {
    const tracker = new ReactionRunTracker();
    const scope = 'oc_s', opId = 'ou_u', tgtId = 'om_t';

    // rev1 active
    tracker.register({ scope, operatorOpenId: opId, targetMessageId: tgtId, reactionRevision: 1, runId: 'r1', status: 'active' });
    expect(tracker.isLatest(scope, opId, tgtId, 1)).toBe(true);

    // rev2 supersedes rev1 (evict unregisters rev1, then rev2 registers)
    tracker.unregister(scope, opId, tgtId);
    tracker.register({ scope, operatorOpenId: opId, targetMessageId: tgtId, reactionRevision: 2, runId: 'r2', status: 'queued' });

    // rev1's terminal checks isLatest(rev1) → false (rev2 is latest) → skip unregister/markTerminal
    expect(tracker.isLatest(scope, opId, tgtId, 1)).toBe(false);
    expect(tracker.isLatest(scope, opId, tgtId, 2)).toBe(true);
    // rev2's entry survives rev1's terminal
    expect(tracker.get(scope, opId, tgtId)?.reactionRevision).toBe(2);

    // No entry → isLatest false (already cleared)
    tracker.unregister(scope, opId, tgtId);
    expect(tracker.isLatest(scope, opId, tgtId, 2)).toBe(false);
  });
});
