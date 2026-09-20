import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';

function run(runId: string): AgentRun {
  return {
    runId,
    events: { async *[Symbol.asyncIterator]() {} },
    stop: vi.fn(async () => {}),
    waitForExit: vi.fn(async () => true),
  };
}

describe('ActiveRuns replacement reservations', () => {
  it('holds the exact active handle until confirmed exit and registers one successor', () => {
    const runs = new ActiveRuns();
    const oldRun = run('old');
    const normal = runs.reserve('scope');
    expect(normal).toBeDefined();
    const oldHandle = runs.register('scope', oldRun, normal);
    normal?.release();

    const replacement = runs.reserveReplacement('scope', oldHandle);
    expect(replacement).toBeDefined();
    expect(runs.reserve('scope')).toBeUndefined();
    expect(runs.get('scope')).toBe(oldHandle);
    expect(runs.reserveReplacement('scope', { ...oldHandle })).toBeUndefined();
    expect(replacement?.revalidate()).toBe(true);
    expect(replacement?.beginStop()).toBe(true);
    expect(replacement?.confirmExit()).toBe(true);
    expect(runs.get('scope')).toBeUndefined();

    const successor = replacement?.register(run('corrected'));
    expect(successor?.run.runId).toBe('corrected');
    expect(runs.get('scope')).toBe(successor);
    expect(() => replacement?.register(run('duplicate'))).toThrow(/replacement/i);
  });

  it('rejects stale handles and releases an unconfirmed hold idempotently', () => {
    const runs = new ActiveRuns();
    const reservation = runs.reserve('scope')!;
    const current = runs.register('scope', run('current'), reservation);
    reservation.release();

    expect(runs.reserveReplacement('scope', { ...current })).toBeUndefined();
    const replacement = runs.reserveReplacement('scope', current)!;
    replacement.release();
    replacement.release();

    expect(runs.get('scope')).toBe(current);
    expect(runs.hasReplacement('scope')).toBe(false);
  });

  it('invalidates a held replacement when exact ownership is cleaned up before stop', () => {
    const runs = new ActiveRuns();
    const reservation = runs.reserve('scope')!;
    const oldRun = run('old');
    const current = runs.register('scope', oldRun, reservation);
    reservation.release();
    const replacement = runs.reserveReplacement('scope', current)!;

    runs.unregister('scope', oldRun);

    expect(replacement.revalidate()).toBe(false);
    expect(replacement.beginStop()).toBe(false);
    expect(runs.get('scope')).toBeUndefined();
  });

  it('does not treat stream cleanup during stopping as confirmed process exit', () => {
    const runs = new ActiveRuns();
    const reservation = runs.reserve('scope')!;
    const oldRun = run('old');
    const current = runs.register('scope', oldRun, reservation);
    reservation.release();
    const replacement = runs.reserveReplacement('scope', current)!;
    expect(replacement.beginStop()).toBe(true);

    // Event-stream cleanup can race ahead of authoritative OS-process exit.
    runs.unregister('scope', oldRun);
    replacement.release();

    expect(runs.get('scope')).toBe(current);
    expect(runs.hasReplacement('scope')).toBe(false);
  });
});
