import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PromptActivationTimeout,
  PromptRunAdmissionController,
  PromptRunAdmissionPaused,
} from '../../../src/session/prompt-run-admission';

afterEach(() => vi.useRealTimers());

describe('PromptRunAdmissionController', () => {
  it('closes admission before draining already-admitted dormant runs', async () => {
    const controller = new PromptRunAdmissionController();
    const admitted = controller.admit({ runId: 'run-1', source: 'im' });

    const activation = controller.beginActivation();

    expect(() => controller.admit({ runId: 'run-2', source: 'comment' })).toThrow(
      PromptRunAdmissionPaused,
    );
    let drained = false;
    void activation.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    admitted.markIdentifierDurable();
    const lease = await activation;
    expect(drained).toBe(true);

    lease.release();
    expect(controller.admit({ runId: 'run-3', source: 'comment' })).toBeDefined();
  });

  it('reopens dormant admission when activation drainage times out', async () => {
    vi.useFakeTimers();
    const controller = new PromptRunAdmissionController();
    const admitted = controller.admit({ runId: 'run-1', source: 'im' });

    const activation = controller.beginActivation({ timeoutMs: 100 });
    const rejected = expect(activation).rejects.toBeInstanceOf(PromptActivationTimeout);
    await vi.advanceTimersByTimeAsync(101);

    await rejected;
    expect(controller.admit({ runId: 'run-2', source: 'comment' })).toBeDefined();
    admitted.finishWithoutIdentifier();
  });

  it('does not drain an observed identifier until its compatibility mirrors are durable', async () => {
    const controller = new PromptRunAdmissionController();
    const admitted = controller.admit({ runId: 'run-1', source: 'im' });
    let resolveDurability!: () => void;
    const durability = new Promise<void>((resolve) => {
      resolveDurability = resolve;
    });
    admitted.trackIdentifierDurability(durability);
    admitted.finishWithoutIdentifier();

    let drained = false;
    const activation = controller.beginActivation().then((lease) => {
      drained = true;
      return lease;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveDurability();
    const lease = await activation;
    expect(drained).toBe(true);
    lease.release();
  });

  it('fails activation when an observed dormant identifier cannot be persisted', async () => {
    const controller = new PromptRunAdmissionController();
    const admitted = controller.admit({ runId: 'run-1', source: 'comment' });
    admitted.trackIdentifierDurability(Promise.reject(new Error('mirror fsync failed')));

    await expect(controller.beginActivation()).rejects.toThrow('mirror fsync failed');
  });
});
