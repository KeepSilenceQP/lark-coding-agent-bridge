import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBoundedProcess } from '../../../src/cli/commands/at-bot-process';
import { spawnProcess, spawnProcessSync } from '../../../src/platform/spawn';

// Mock the platform spawn module
vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return {
    ...actual,
    spawnProcess: vi.fn(),
    spawnProcessSync: vi.fn(),
  };
});

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

interface TestChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(pid = 4242): TestChild {
  const child = new EventEmitter() as unknown as TestChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('at-bot process-tree runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs a child process to normal exit and returns stdout/stderr', async () => {
    const child = makeChild();
    vi.mocked(spawnProcess).mockReturnValue(child as unknown as ChildProcess);

    const promise = runBoundedProcess('test-cmd', ['arg1'], { timeoutMs: 5000, maxOutputBytes: 1024 });

    // Emit data
    child.stdout.emit('data', Buffer.from('hello stdout'));
    child.stderr.emit('data', Buffer.from('hello stderr'));

    // Emit close (normal completion)
    child.emit('close', 0, null);

    const result = await promise;
    expect(result.exitCode).toBeNull(); // close doesn't set exitCode in mock
    expect(result.stdout).toBe('hello stdout');
    expect(result.stderr).toBe('hello stderr');
    expect(result.settled).toBe('exit');
    expect(vi.mocked(spawnProcess)).toHaveBeenCalledWith(
      'test-cmd',
      ['arg1'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('uses argv array only (no shell command strings)', async () => {
    const child = makeChild();
    vi.mocked(spawnProcess).mockReturnValue(child as unknown as ChildProcess);

    const promise = runBoundedProcess('test-cmd', ['--flag', 'value']);
    child.emit('close', 0, null);
    await promise;

    const callArgs = vi.mocked(spawnProcess).mock.calls[0];
    // Second argument must be an array (argv), not a string
    expect(Array.isArray(callArgs[1])).toBe(true);
    expect(callArgs[1]).toEqual(['--flag', 'value']);
  });

  it('reports unavailable when spawn throws synchronously', async () => {
    vi.mocked(spawnProcess).mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const result = await runBoundedProcess('missing-cmd', []);
    expect(result.settled).toBe('unavailable');
    expect(result.stdout).toBe('');
  });

  it('caps output at configured byte limit per stream', async () => {
    const child = makeChild();
    vi.mocked(spawnProcess).mockReturnValue(child as unknown as ChildProcess);

    const promise = runBoundedProcess('cmd', [], { maxOutputBytes: 10 });

    // Emit more than the cap
    child.stdout.emit('data', Buffer.from('1234567890AB')); // 12 bytes, cap at 10
    // This should trigger overflow

    // Give time for the overflow to be processed
    await new Promise((r) => setTimeout(r, 10));
    child.emit('close', 0, null);

    const result = await promise;
    expect(result.settled).toBe('overflow');
    expect(result.stdout.length).toBeLessThanOrEqual(10);
  });

  // Human-authored integration tests for complex OS-specific process-tree
  // behavior are deferred to the plan's Unit 5 OS matrix. Unit-level
  // coverage of the state machine is provided via the injected mock.

  it('records exit code and signal from the exit event', async () => {
    const child = makeChild();
    vi.mocked(spawnProcess).mockReturnValue(child as unknown as ChildProcess);

    const promise = runBoundedProcess('cmd', []);
    child.emit('exit', 1, 'SIGTERM');
    child.emit('close', 1, 'SIGTERM');

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.signalCode).toBe('SIGTERM');
    expect(result.settled).toBe('exit');
  });
});
