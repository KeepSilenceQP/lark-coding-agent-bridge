import { describe, expect, it, vi } from 'vitest';
import {
  decideStopAdded,
  executeStopAdded,
} from '../../../src/bot/reaction/stop-target';

describe('stop target eligibility', () => {
  it('silently drops an unknown user target before the no-work branch', () => {
    expect(decideStopAdded({
      targetClass: 'user',
      hasWork: false,
      trigger: undefined,
      botTargetIsCurrent: false,
    })).toEqual({ kind: 'silent-drop', reason: 'unknown-user-trigger' });
  });

  it('returns no-work for a retained historical user trigger when the scope is idle', () => {
    expect(decideStopAdded({
      targetClass: 'user',
      hasWork: false,
      trigger: { chainId: 'wc_old', status: 'historical' },
      botTargetIsCurrent: false,
    })).toEqual({ kind: 'no-work' });
  });

  it('fails closed for a retained historical user trigger when another chain is current', () => {
    expect(decideStopAdded({
      targetClass: 'user',
      hasWork: true,
      trigger: { chainId: 'wc_old', status: 'historical' },
      botTargetIsCurrent: false,
    })).toEqual({ kind: 'fail-closed' });
  });

  it('stops work for a current user trigger', () => {
    expect(decideStopAdded({
      targetClass: 'user',
      hasWork: true,
      trigger: { chainId: 'wc_current', status: 'current' },
      botTargetIsCurrent: false,
    })).toEqual({ kind: 'stop' });
  });

  it('preserves Bot-target no-work, fail-closed and current-stop behavior', () => {
    const base = {
      targetClass: 'bot' as const,
      trigger: undefined,
    };
    expect(decideStopAdded({
      ...base,
      hasWork: false,
      botTargetIsCurrent: false,
    })).toEqual({ kind: 'no-work' });
    expect(decideStopAdded({
      ...base,
      hasWork: true,
      botTargetIsCurrent: false,
    })).toEqual({ kind: 'fail-closed' });
    expect(decideStopAdded({
      ...base,
      hasWork: true,
      botTargetIsCurrent: true,
    })).toEqual({ kind: 'stop' });
  });

  it.each([
    ['idle scope', false],
    ['another current task', true],
  ])('performs no reply or control effects for an unknown user target with %s', (_label, hasWork) => {
    const interrupt = vi.fn();
    const cancelPending = vi.fn();

    const result = executeStopAdded(
      decideStopAdded({
        targetClass: 'user',
        hasWork,
        trigger: undefined,
        botTargetIsCurrent: false,
      }),
      { interrupt, cancelPending },
    );

    expect(result).toBeUndefined();
    expect(interrupt).not.toHaveBeenCalled();
    expect(cancelPending).not.toHaveBeenCalled();
  });

  it('executes control effects only for the stop decision', () => {
    const calls: string[] = [];
    const effects = {
      interrupt: () => calls.push('interrupt'),
      cancelPending: () => calls.push('cancel'),
    };

    expect(executeStopAdded({ kind: 'no-work' }, effects)).toEqual({
      replyKind: 'no-work',
      message: '当前没有需要停止的任务。',
    });
    expect(executeStopAdded({ kind: 'fail-closed' }, effects)).toEqual({
      replyKind: 'fail-closed',
      message: '该 Reaction 未停止当前任务，如需停止请使用 /stop 命令。',
    });
    expect(calls).toEqual([]);
    expect(executeStopAdded({ kind: 'stop' }, effects)).toEqual({
      replyKind: 'stopped',
      message: '已停止当前任务。',
    });
    expect(calls).toEqual(['interrupt', 'cancel']);
  });
});
