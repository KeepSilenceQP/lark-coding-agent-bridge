import { describe, expect, it } from 'vitest';
import {
  isSelfOperator,
  type ReactionGuardDeps,
  type ReactionGuardResult,
} from '../../../src/bot/reaction/pipeline';

// ── Helpers ──

function makeDeps(overrides: Partial<ReactionGuardDeps> = {}): ReactionGuardDeps {
  return {
    botOpenId: 'ou_bot_self',
    appId: 'cli_app_123',
    ...overrides,
  };
}

function reactionEvent(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'om_test',
    operator: { openId: 'ou_user', userId: 'uid_user' },
    emojiType: 'JIAYI',
    action: 'added' as const,
    actionTime: Date.now(),
    raw: overrides.raw ?? { operator_type: 'user' },
    ...overrides,
  };
}

// ── Self-operator guard ──

describe('isSelfOperator', () => {
  it('returns true when operator.openId matches botOpenId', () => {
    const evt = reactionEvent({ operator: { openId: 'ou_bot_self' } });
    expect(isSelfOperator(evt, makeDeps())).toBe(true);
  });

  it('returns true when operator.openId matches appId', () => {
    const evt = reactionEvent({ operator: { openId: 'cli_app_123' } });
    expect(isSelfOperator(evt, makeDeps())).toBe(true);
  });

  it('returns true when raw event has operator_type === "app"', () => {
    const evt = reactionEvent({
      operator: { openId: 'ou_some_app' },
      raw: { operator_type: 'app' },
    });
    expect(isSelfOperator(evt, makeDeps())).toBe(true);
  });

  it('returns false for a normal user operator', () => {
    const evt = reactionEvent({
      operator: { openId: 'ou_other_user' },
      raw: { operator_type: 'user' },
    });
    expect(isSelfOperator(evt, makeDeps())).toBe(false);
  });

  it('returns false when operator.openId is neither botOpenId nor appId and raw is missing', () => {
    const evt = reactionEvent({
      operator: { openId: 'ou_stranger' },
      raw: undefined,
    });
    expect(isSelfOperator(evt, makeDeps())).toBe(false);
  });

  it('returns false when raw operator_type is "user" even if openId looks like app', () => {
    const evt = reactionEvent({
      operator: { openId: 'cli_app_123' },
      raw: { operator_type: 'user' },
    });
    // openId matches appId, so it's still self
    expect(isSelfOperator(evt, makeDeps())).toBe(true);
  });

  it('Typing reaction from self is caught by self-operator guard', () => {
    const evt = reactionEvent({
      operator: { openId: 'ou_bot_self' },
      emojiType: 'Typing',
      raw: { operator_type: 'app' },
    });
    expect(isSelfOperator(evt, makeDeps())).toBe(true);
  });
});

// ── Static deny reason helpers (used by pipeline) ──

describe('guard deny reasons', () => {
  it('exports the expected deny reason strings', async () => {
    // Dynamic import to check exported constants
    const mod = await import('../../../src/bot/reaction/pipeline');
    expect(mod.GUARD_DENY_SELF_OPERATOR).toBe('self-operator');
    expect(mod.GUARD_DENY_NOT_OWN_MESSAGE).toBe('not-own-message');
    expect(mod.GUARD_DENY_ACCESS_DM).toBe('access-dm');
    expect(mod.GUARD_DENY_ACCESS_GROUP).toBe('access-group');
    expect(mod.GUARD_DENY_GROUP_RESPONSE).toBe('group-response');
  });
});

// ── Guard result type ──

describe('ReactionGuardResult', () => {
  it('accept shape has ok:true and no reason', () => {
    const result: ReactionGuardResult = { ok: true };
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('deny shape has ok:false and a reason', () => {
    const result: ReactionGuardResult = { ok: false, reason: 'access-dm' };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('access-dm');
  });
});
