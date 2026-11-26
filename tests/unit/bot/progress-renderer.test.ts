import { describe, expect, it, vi } from 'vitest';
import { createProgressRenderer } from '../../../src/bot/progress-renderer';

describe('progress renderer', () => {
  it('coalesces pending updates in order while a network write is blocked', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const render = vi.fn(async (state: number) => { if (state === 1) await gate; });
    const sink = createProgressRenderer(render);
    sink.enqueue(1);
    sink.enqueue(2);
    sink.enqueue(3);
    expect(render.mock.calls).toEqual([[1]]);
    release();
    await sink.settle();
    expect(render.mock.calls).toEqual([[1], [3]]);
  });

  it('observes failures without an unhandled rejection and exposes them at settlement', async () => {
    const error = new Error('update rejected');
    const render = vi.fn(async () => { throw error; });
    const sink = createProgressRenderer(render);
    sink.enqueue(1);
    await expect(sink.settle()).rejects.toBe(error);
    sink.enqueue(2);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('never replays pending or late progress after abandonment', async () => {
    let release!: () => void;
    const render = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const sink = createProgressRenderer(render);
    sink.enqueue(1);
    sink.enqueue(2);
    sink.abandon();
    sink.enqueue(3);
    release();
    await sink.settle();
    expect(render.mock.calls).toEqual([[1]]);
  });
});
