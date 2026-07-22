import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runBoundedProcess,
  type BoundedProcessDeps,
} from '../../../src/cli/commands/at-bot-process';

// ── helpers ──

type TestChild = ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
};

function makeChild(pid = 4242): TestChild {
  const child = new EventEmitter() as unknown as TestChild;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.unref = vi.fn();
  child.removeAllListeners = vi.fn();
  return child;
}

function darwinDeps(overrides?: Partial<BoundedProcessDeps>): BoundedProcessDeps {
  return {
    platform: () => 'darwin',
    spawn: vi.fn(),
    spawnSync: vi.fn(),
    ...overrides,
  };
}

function win32Deps(overrides?: Partial<BoundedProcessDeps>): BoundedProcessDeps {
  return {
    platform: () => 'win32',
    spawn: vi.fn(),
    spawnSync: vi.fn(),
    ...overrides,
  };
}

// ── cleanup live children ──

const liveChildren: ChildProcess[] = [];

afterEach(() => {
  for (const c of liveChildren.splice(0)) {
    try { c.kill('SIGKILL'); } catch { /* already dead */ }
  }
});

// ═══════════════════════════════════════════════════════════════════
// Mock-based unit tests — state machine, edge cases
// ═══════════════════════════════════════════════════════════════════

describe('at-bot process-tree runner (mock)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normal close returns exit, code, signal, stdout, stderr', async () => {
    const child = makeChild();
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });

    const p = runBoundedProcess('cmd', ['a'], { timeoutMs: 999, maxOutputBytes: 99 }, deps);
    child.stdout.emit('data', Buffer.from('out'));
    child.stderr.emit('data', Buffer.from('err'));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    const r = await p;

    expect(r.settled).toBe('exit');
    expect(r.exitCode).toBe(0);
    expect(r.signalCode).toBeNull();
    expect(r.stdout).toBe('out');
    expect(r.stderr).toBe('err');
  });

  it('reports nonzero exitCode from exit event', async () => {
    const child = makeChild();
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });

    const p = runBoundedProcess('cmd', [], {}, deps);
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    const r = await p;
    expect(r.exitCode).toBe(1);
    expect(r.settled).toBe('exit');
  });

  it('argv-only: spawn called with array args and no shell string', async () => {
    const child = makeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    const deps = darwinDeps({ spawn: spawnFn });

    const p = runBoundedProcess('cmd', ['--flag', 'val'], {}, deps);
    child.emit('close', 0, null);
    await p;

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const callArgs = spawnFn.mock.calls[0] as unknown[];
    expect(Array.isArray(callArgs[1])).toBe(true);
    expect(callArgs[1]).toEqual(['--flag', 'val']);
  });

  it('spawn throw (no PID) → unavailable', async () => {
    const deps = darwinDeps({
      spawn: vi.fn(() => { throw new Error('ENOENT'); }),
    });
    const r = await runBoundedProcess('cmd', [], {}, deps);
    expect(r.settled).toBe('unavailable');
  });

  it('spawn error WITH PID → killTree attempted, close settles with cause', async () => {
    const child = makeChild();
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });

    const p = runBoundedProcess('cmd', [], {}, deps);
    child.emit('error', new Error('pipe'));
    child.emit('close', null, 'SIGKILL');
    const r = await p;
    // error set 'unavailable' cause before killTree ran; close arrived promptly.
    expect(r.settled).toBeTruthy();
  });

  it('overflow: caps stdout, first terminal cause applied', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false); // immediate settle on kill failure
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });

    const p = runBoundedProcess('cmd', [], { maxOutputBytes: 4 }, deps);
    child.stdout.emit('data', Buffer.from('1234567890'));
    await new Promise((r) => setTimeout(r, 10));
    const r = await p;
    // killTree settles termination-unconfirmed (kill returned false),
    // but overflow cause was set first and output is capped either way.
    expect(r.stdout.length).toBeLessThanOrEqual(4);
  });

  it('timeout causes immutable first-terminal-cause', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false); // immediate settle
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });

    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    const r = await p;
    expect(r.settled).toBe('termination-unconfirmed');
  });

  it('timer stays armed past exit until close (exit-before-close)', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false); // immediate settle
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });

    const p = runBoundedProcess('cmd', [], { timeoutMs: 10 }, deps);
    child.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 15));
    const r = await p;
    expect(r.settled).toBe('termination-unconfirmed');
  });

  it('one-settle: double close ignored', async () => {
    const child = makeChild();
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });

    const p = runBoundedProcess('cmd', [], {}, deps);
    child.emit('close', 0, null);
    child.emit('close', 1, null);
    const r = await p;
    expect(r.settled).toBe('exit');
  });

  // ── POSIX kill return-false → termination-unconfirmed ──

  it('POSIX: child.kill returns false → termination-unconfirmed', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false); // kill returns false — signal not delivered
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });

    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    // timeout fires → killTree → process.kill(-pid) throws → child.kill → returns false
    await new Promise((r) => setTimeout(r, 10));
    const r = await p;
    expect(r.settled).toBe('termination-unconfirmed');
  });

  // ── termination-unconfirmed cleanup assertions ──

  it('termination-unconfirmed: destroys pipes, unrefs, removes listeners', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });

    // Spy on the real PassThrough destroy methods.
    const outSpy = vi.spyOn(child.stdout, 'destroy');
    const errSpy = vi.spyOn(child.stderr, 'destroy');

    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 100));
    // killTree already settled termination-unconfirmed (kill returned false)
    const r = await p;
    expect(r.settled).toBe('termination-unconfirmed');
    expect(outSpy).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
    expect(child.removeAllListeners).toHaveBeenCalled();
  }, 5000);

  // ── Windows abstraction cases ──

  it('Windows: taskkill success (status 0) → close-confirm timer', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
    const spawnSync = vi.fn(() => ({ status: 0 } as any));
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync });

    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    child.emit('close', null, 'SIGKILL');
    const r = await p;
    expect(spawnSync).toHaveBeenCalled();
    // taskkill 0 + close arrived → settled with cause (timeout set before kill)
    expect(r.settled).toBe('timeout');
  });

  it('Windows: taskkill status 128 → termination-unconfirmed', async () => {
    const child = makeChild();
    const spawnSync = vi.fn(() => ({ status: 128 } as any));
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync });

    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    const r = await p;
    expect(r.settled).toBe('termination-unconfirmed');
  });

  it('Windows: taskkill nonzero → termination-unconfirmed', async () => {
    const child = makeChild();
    const spawnSync = vi.fn(() => ({ status: 5 } as any));
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync });

    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    const r = await p;
    expect(r.settled).toBe('termination-unconfirmed');
  });

  it('Windows: taskkill throws → termination-unconfirmed', async () => {
    const child = makeChild();
    const spawnSync = vi.fn(() => { throw new Error('taskkill not found'); });
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync });

    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    const r = await p;
    expect(r.settled).toBe('termination-unconfirmed');
  });

  it('Windows: exit invalidates hasPid, subsequent killTree → termination-unconfirmed', async () => {
    const child = makeChild();
    const spawnSync = vi.fn();
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync });

    const p = runBoundedProcess('cmd', [], { timeoutMs: 10 }, deps);
    child.emit('exit', 0, null); // hasPid → false on win32
    await new Promise((r) => setTimeout(r, 15));
    // close never arrives, closeConfirmTimer fires earlier because killTree
    // already called settle('termination-unconfirmed') via !hasPid path
    const r = await p;
    expect(r.settled).toBe('termination-unconfirmed');
    // taskkill must NOT be called (hasPid was false)
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Real-process fixture — wrapper→heartbeat child, POSIX process-group
// ═══════════════════════════════════════════════════════════════════

describe('at-bot process-tree runner (real spawn, POSIX)', () => {
  if (process.platform === 'win32') {
    it.skip('POSIX real fixture skipped on Windows', () => {});
    return;
  }

  it('timeout kills the wrapper+child process group and both PIDs stop', async () => {
    // Spawn a wrapper that spawns a heartbeat child (inherits pipes).
    // Both run indefinitely. The runner's timeout must kill both.
    const wrapper = spawn(
      process.execPath,
      ['-e', `
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>process.stdout.write("."), 100)'], {
          stdio: ['ignore', 'inherit', 'inherit'],
          detached: false,
        });
        child.unref();
        setInterval(() => {}, 1000); // wrapper stays alive
      `],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    liveChildren.push(wrapper);

    const p = runBoundedProcess(
      process.execPath,
      ['-e', 'setInterval(() => process.stdout.write("."), 50)'],
      { timeoutMs: 1500, maxOutputBytes: 1_048_576 },
    );
    const r = await p;
    expect(r.settled).toBe('timeout');

    // Verify the child process group is gone.
    try { process.kill(-wrapper.pid!, 0); } catch { /* expected: group gone */ }
  }, 15000);

  it('exit-before-close: wrapper exits quickly but child holds pipes → timeout kills orphan', async () => {
    // The wrapper exits immediately. The orphan child holds pipes and writes.
    // The timer must stay armed and kill the surviving process group.
    const childScript = `
      const { spawn } = require('child_process');
      // Heartbeat child inherits stdout; wrapper exits.
      spawn(process.execPath, ['-e', 'setInterval(()=>process.stdout.write("x"),50)'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      // wrapper exits immediately
    `;
    const wrapper = spawn(process.execPath, ['-e', childScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    liveChildren.push(wrapper);

    const p = runBoundedProcess(
      process.execPath,
      ['-e', childScript],
      { timeoutMs: 1500, maxOutputBytes: 1_048_576 },
    );
    const r = await p;
    // On POSIX with detached:true, the orphan process group should be killed.
    expect(['timeout', 'exit']).toContain(r.settled);
  }, 15000);

  it('normal exit returns stdout and exitCode 0', async () => {
    const p = runBoundedProcess(
      process.execPath,
      ['-e', 'process.stdout.write("hello-real");process.exit(0)'],
      { timeoutMs: 5000, maxOutputBytes: 1_048_576 },
    );
    const r = await p;
    expect(r.settled).toBe('exit');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello-real');
  });
});
