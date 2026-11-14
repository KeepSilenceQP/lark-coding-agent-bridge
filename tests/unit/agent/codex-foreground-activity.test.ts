import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexForegroundActivity } from '../../../src/agent/codex/foreground-activity';
import type { CodexTurnState } from '../../../src/agent/codex/turn-state-probe';

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  const parent: CodexTurnState = {
    id: 'current', status: 'inProgress', itemCount: 1, foregroundChildThreadIds: ['child'],
  };
  const child: CodexTurnState = {
    id: 'child-turn', status: 'inProgress', itemCount: 1, parentThreadId: 'parent',
  };
  let fail = false;
  const probe = vi.fn(async (id: string) => {
    if (id === 'parent') return parent;
    if (fail) throw new Error('unavailable');
    return child;
  });
  return { parent, child, probe, activity: new CodexForegroundActivity(probe, 'parent', 'previous'),
    setFailure: (value: boolean) => { fail = value; } };
}

describe('verified foreground child progress', () => {
  it('renews parent activity when a result is persisted before stdout catches up', async () => {
    const { activity, parent } = fixture();
    parent.foregroundChildThreadIds = undefined;
    parent.progressToken = 'before-result';
    await activity.read();
    await vi.advanceTimersByTimeAsync(599_000);
    parent.progressToken = 'result-persisted';
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 600_000 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await activity.check(600_000)).toBeUndefined();
  });

  it('accepts a missing child parent field only with a verified legacy parent spawn', async () => {
    const { activity, parent, child } = fixture();
    child.parentThreadId = undefined;
    expect(await activity.check(600_000)).toBeUndefined();
    parent.foregroundLinkSource = 'legacy-rollout';
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 600_000 });
    child.parentThreadId = 'different-parent';
    expect(await activity.check(600_000)).toBeUndefined();
  });

  it('renews only on changed lifecycle evidence and expires a static running status', async () => {
    const { activity, child } = fixture();
    expect(await activity.check(600_000)).toEqual({ remainingMs: 600_000, timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(590_000);
    expect(await activity.check(600_000)).toEqual({ remainingMs: 10_000, timeoutMs: 600_000 });
    child.itemCount++;
    expect(await activity.check(600_000)).toEqual({ remainingMs: 600_000, timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await activity.check(600_000)).toEqual({ remainingMs: 0, timeoutMs: 600_000 });
  });

  it('retains the 65-minute bound for an actual outstanding child tool', async () => {
    const { activity, child } = fixture();
    child.hasRunningTool = true;
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 65 * 60_000 });
    await vi.advanceTimersByTimeAsync(65 * 60_000);
    expect(await activity.check(600_000)).toEqual({ remainingMs: 0, timeoutMs: 65 * 60_000 });
  });

  it('gives an observed child completion one normal idle interval, without declaring the parent done', async () => {
    const { activity, child, parent } = fixture();
    await activity.read();
    await vi.advanceTimersByTimeAsync(600_000);
    child.status = 'completed';
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 600_000 });
    expect(parent.status).toBe('inProgress');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 0 });
  });

  it.each(['background', 'unrelated', 'baseline', 'already-completed'])(
    'does not extend idle for %s evidence', async (kind) => {
      const { activity, parent, child } = fixture();
      if (kind === 'background') parent.foregroundChildThreadIds = undefined;
      if (kind === 'unrelated') child.parentThreadId = 'another-parent';
      if (kind === 'baseline') parent.id = 'previous';
      if (kind === 'already-completed') child.status = 'completed';
      expect(await activity.check(600_000)).toBeUndefined();
    },
  );

  it('bounds reads to recent linked children without disabling a long parent turn', async () => {
    const { activity, parent, child, probe } = fixture();
    parent.foregroundChildThreadIds = Array.from({ length: 12 }, (_, i) => 'child-' + i);
    probe.mockImplementation(async (id: string) => id === 'parent' ? parent :
      id === 'child-11' ? child : { ...child, status: 'completed' });
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 600_000 });
    expect(probe.mock.calls.map(([id]) => id)).toEqual(['parent',
      'child-4', 'child-5', 'child-6', 'child-7', 'child-8', 'child-9', 'child-10', 'child-11']);
  });

  it('does not renew unchanged activity after a failed child query', async () => {
    const { activity, setFailure } = fixture();
    await activity.read();
    await vi.advanceTimersByTimeAsync(300_000);
    setFailure(true);
    expect(await activity.check(600_000)).toBeUndefined();
    setFailure(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 0 });
  });

  it('does not follow an unrelated later parent turn or revive after close', async () => {
    const { activity, parent } = fixture();
    await activity.read();
    parent.id = 'another-turn';
    expect(await activity.check(600_000)).toBeUndefined();
    activity.close();
    expect(await activity.check(600_000)).toBeUndefined();
  });

  it('allows bounded terminal recovery when parent completion races an idle check', async () => {
    const { activity, parent } = fixture();
    await activity.read();
    parent.status = 'completed';
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 600_000 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 0 });
  });

  it('keeps progress private to each run even if thread IDs coincide', async () => {
    const { activity, probe, child } = fixture();
    await activity.read();
    await vi.advanceTimersByTimeAsync(600_000);
    const second = new CodexForegroundActivity(probe, 'parent', 'previous');
    child.itemCount++;
    await second.read();
    child.itemCount--;
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 0 });
  });

  it('does not let an older completed child expire a later active foreground wait', async () => {
    const { activity, probe, parent, child } = fixture();
    await activity.read();
    child.status = 'completed';
    await activity.read();
    const nextChild: CodexTurnState = { ...child, id: 'next-turn', status: 'inProgress' };
    parent.foregroundChildThreadIds = ['child', 'next-child'];
    probe.mockImplementation(async (id: string) => id === 'parent' ? parent : id === 'child' ? child : nextChild);
    await activity.read();
    await vi.advanceTimersByTimeAsync(600_000);
    nextChild.itemCount++;
    expect(await activity.check(600_000)).toMatchObject({ remainingMs: 600_000 });
  });
});
