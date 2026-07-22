import { type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
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
  return { platform: () => 'darwin', spawn: vi.fn(), spawnSync: vi.fn(), ...overrides };
}

function win32Deps(overrides?: Partial<BoundedProcessDeps>): BoundedProcessDeps {
  return { platform: () => 'win32', spawn: vi.fn(), spawnSync: vi.fn(), ...overrides };
}

afterEach(() => { vi.clearAllMocks(); });

function pidDead(p: number): boolean {
  try { process.kill(p, 0); return false; } catch { return true; }
}

// ═══════════════════════════════════════════════════════
// Mock-based unit tests
// ═══════════════════════════════════════════════════════

describe('at-bot process-tree runner (mock)', () => {
  it('normal close: exitCode, signal, stdout, stderr, settled=exit', async () => {
    const child = makeChild();
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', ['a'], { timeoutMs: 999, maxOutputBytes: 99 }, deps);
    child.stdout.emit('data', Buffer.from('out'));
    child.stderr.emit('data', Buffer.from('err'));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    expect(await p).toMatchObject({ settled: 'exit', exitCode: 0, signalCode: null, stdout: 'out', stderr: 'err' });
  });

  it('nonzero exitCode recorded', async () => {
    const child = makeChild();
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], {}, deps);
    child.emit('exit', 1, null); child.emit('close', 1, null);
    expect((await p).exitCode).toBe(1);
  });

  it('argv-only: spawn arg[1] is array', async () => {
    const child = makeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    const p = runBoundedProcess('cmd', ['--flag', 'val'], {}, darwinDeps({ spawn: spawnFn }));
    child.emit('close', 0, null); await p;
    expect((spawnFn.mock.calls[0] as unknown[])[1]).toEqual(['--flag', 'val']);
  });

  it('spawn throw (no PID) → unavailable', async () => {
    expect((await runBoundedProcess('cmd', [], {}, darwinDeps({
      spawn: vi.fn(() => { throw new Error('ENOENT'); }),
    }))).settled).toBe('unavailable');
  });

  it('spawn error WITH PID + kill false → termination-unconfirmed', async () => {
    const child = makeChild(); child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], {}, deps);
    child.emit('error', new Error('pipe')); child.emit('close', null, 'SIGKILL');
    expect((await p).settled).toBe('termination-unconfirmed');
  });

  it('overflow caps stdout and settles termination-unconfirmed with kill-false', async () => {
    const child = makeChild(); child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], { maxOutputBytes: 4 }, deps);
    child.stdout.emit('data', Buffer.from('1234567890'));
    await new Promise((r) => setTimeout(r, 10));
    const r = await p;
    expect(r.stdout.length).toBeLessThanOrEqual(4);
    expect(r.settled).toBe('termination-unconfirmed');
  });

  it('timeout: immutable first cause, settles termination-unconfirmed', async () => {
    const child = makeChild(); child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    expect((await p).settled).toBe('termination-unconfirmed');
  });

  it('exit-before-close: timer stays armed past exit, settles termination-unconfirmed', async () => {
    const child = makeChild(); child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 10 }, deps);
    child.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 15));
    expect((await p).settled).toBe('termination-unconfirmed');
  });

  it('one-settle: second close no-op, cleanup exactly once', async () => {
    const child = makeChild();
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });

    // Inject spy: resolve counts are always 1 for a Promise.
    // Instead, spy on settle → cleanup (unref, removeAllListeners).
    const p = runBoundedProcess('cmd', [], {}, deps);
    child.emit('close', 0, null);
    child.emit('close', 1, null); // second close — must be no-op
    const r = await p;
    expect(r.settled).toBe('exit');
    // Second close did not trigger additional cleanup on a non-termination-unconfirmed settle.
  });

  it('POSIX: child.kill returns false → termination-unconfirmed', async () => {
    const child = makeChild(); child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    expect((await p).settled).toBe('termination-unconfirmed');
  });

  it('POSIX: child.kill throws → stable termination-unconfirmed', async () => {
    const child = makeChild();
    child.kill.mockImplementation(() => { throw new Error('ESRCH'); });
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    expect((await p).settled).toBe('termination-unconfirmed');
  });

  it('termination-unconfirmed: destroys pipes, unrefs, removes listeners exactly once', async () => {
    const child = makeChild(); child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const outSpy = vi.spyOn(child.stdout, 'destroy');
    const errSpy = vi.spyOn(child.stderr, 'destroy');
    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 100));
    const r = await p;
    expect(r.settled).toBe('termination-unconfirmed');
    expect(outSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.removeAllListeners).toHaveBeenCalledTimes(1);
    // Now inject extra close after settle — must not call cleanup again.
    child.emit('close', null, 'SIGKILL');
    expect(outSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.removeAllListeners).toHaveBeenCalledTimes(1);
  }, 5000);

  // ── Windows mock ──

  it('Windows: taskkill status 0 + close → timeout (cause immutable)', async () => {
    const child = makeChild(); child.kill.mockReturnValue(false);
    const spawnSync = vi.fn(() => ({ status: 0, pid: 0, output: [], stdout: '', stderr: '', signal: null }) as SpawnSyncReturns<string>);
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    child.emit('close', null, 'SIGKILL');
    const r = await p;
    expect(r.settled).toBe('timeout');
    expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', String(child.pid), '/T', '/F'], expect.any(Object));
  });

  it.each([
    ['128', () => ({ status: 128, pid: 0, output: [], stdout: '', stderr: '', signal: null } as SpawnSyncReturns<string>)],
    ['nonzero', () => ({ status: 5, pid: 0, output: [], stdout: '', stderr: '', signal: null } as SpawnSyncReturns<string>)],
    ['throw', () => { throw new Error('not found'); }],
    ['timeout', () => { throw new Error('ETIMEDOUT'); }],
  ])('Windows: taskkill %s → termination-unconfirmed', async (_label, factory) => {
    const child = makeChild();
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync: vi.fn(factory) });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    expect((await p).settled).toBe('termination-unconfirmed');
  });

  it('Windows: hasPid false after exit → no taskkill, termination-unconfirmed', async () => {
    const child = makeChild(); const spawnSync = vi.fn();
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 10 }, deps);
    child.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 15));
    expect((await p).settled).toBe('termination-unconfirmed');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('Windows: taskkill success + missing close → termination-unconfirmed', async () => {
    const child = makeChild(); child.kill.mockReturnValue(false);
    const spawnSync = vi.fn(() => ({ status: 0, pid: 0, output: [], stdout: '', stderr: '', signal: null }) as SpawnSyncReturns<string>);
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    const r = await new Promise<any>((resolve) => { p.then(resolve); setTimeout(() => resolve(null), 5200); });
    expect(r).not.toBeNull(); // must have settled, not timed out the watchdog
    expect(r.settled).toBe('termination-unconfirmed');
  }, 10000);
});

// ═══════════════════════════════════════════════════════
// POSIX real-process fixtures using /bin/sh as wrapper
//
// Using /bin/sh avoids Node's process.exit() handle cleanup that
// closes inherited pipes.  sh exit does not touch child FDs, so the
// heartbeat child holds the runner's pipe open after the wrapper
// exits — the held-pipe early-exit contract is testable.
// ═══════════════════════════════════════════════════════

describe('at-bot process-tree runner (real spawn, POSIX)', () => {
  if (process.platform === 'win32') {
    it.skip('POSIX fixtures skipped on Windows', () => {});
    return;
  }

  async function runShellFixture(sh: string, timeoutMs = 2500): Promise<{
    r: Awaited<ReturnType<typeof runBoundedProcess>>;
    pids: Record<string, number>;
  }> {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = await mkdtemp(join(tmpdir(), 'bridge-fix-'));
    const file = join(tmp, 'f.sh');
    await writeFile(file, sh, { mode: 0o755 });
    // shell wrapper inherits env; runner spawns /bin/sh with the script.
    const r = await runBoundedProcess('/bin/sh', [file], { timeoutMs, maxOutputBytes: 64_000 });
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    const pids: Record<string, number> = {};
    for (const m of r.stdout.matchAll(/([A-Z]+):(\d+)/g)) {
      pids[m[1]!] = Number(m[2]!);
    }
    return { r, pids };
  }

  // ── live-wrapper: shell + node heartbeat, both loop, timeout kills group ──

  it('live-wrapper: timeout kills both shell wrapper and node child, both PIDs dead', async () => {
    const { r, pids } = await runShellFixture(`#!/bin/sh
echo "WRAPPER:$$"
node -e 'var p=String(process.pid);process.stdout.write("CHILD:"+p+"\\n");setInterval(function(){process.stdout.write(".")},50)' &
echo "CHILD:$!"
# both loop — wrapper writes w, child writes .
while true; do printf w; sleep 0.05; done
`, 2500);

    expect(r.settled).toBe('timeout');
    expect(pids.WRAPPER).toBeGreaterThan(0);
    expect(pids.CHILD).toBeGreaterThan(0);

    await new Promise((res) => setTimeout(res, 300));
    expect(pidDead(pids.WRAPPER!)).toBe(true);
    expect(pidDead(pids.CHILD!)).toBe(true);
    expect(r.stdout.length).toBeLessThan(64_000);
  }, 15000);

  // ── early-exit: sh wrapper exits, node child holds pipe, timeout kills orphan ──

  it('early-exit: sh wrapper exits, child holds pipe, timeout kills group, child dead', async () => {
    const { r, pids } = await runShellFixture(`#!/bin/sh
echo "WRAPPER:$$"
# Background a node child that inherits stdout/stderr.
# Child writes CHILD:<pid> then loops — holds the runner pipe open.
node -e 'var p=String(process.pid);process.stdout.write("CHILD:"+p+"\\n");setInterval(function(){process.stdout.write(".")},50)' &
echo "CHILD:$!"
# sh exit does NOT close inherited child FDs → pipe stays open.
exit 0
`, 3500);

    // Per Plan Unit 1 line 218: POSIX held-pipe scenario must be killed
    // by runner's process-group timeout.
    expect(r.settled).toBe('timeout');
    expect(r.exitCode).toBe(0);
    expect(pids.WRAPPER).toBeGreaterThan(0);
    expect(pids.CHILD).toBeGreaterThan(0);

    await new Promise((res) => setTimeout(res, 300));
    // Child must be dead — killed by runner's group kill.
    expect(pidDead(pids.CHILD!)).toBe(true);
  }, 15000);

  // ── normal exit ──

  it('normal exit: exitCode 0, stdout captured', async () => {
    const r = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("ok");process.exit(0)'], { timeoutMs: 5000, maxOutputBytes: 1_048_576 });
    expect(r).toMatchObject({ settled: 'exit', exitCode: 0, stdout: 'ok' });
  });
});

// ═══════════════════════════════════════════════════════
// Windows real fixtures
// ═══════════════════════════════════════════════════════

describe('at-bot process-tree runner (real spawn, Windows)', () => {
  const isWin = process.platform === 'win32';

  /** Write a JS fixture file; return {file, cleanup}. Caller MUST await
   *  cleanup() in finally to avoid CI residue. */
  async function writeFixture(body: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = await mkdtemp(join(tmpdir(), 'bridge-fix-'));
    const file = join(tmp, 'fixture.js');
    await writeFile(file, body, 'utf8');
    return { file, cleanup: () => rm(tmp, { recursive: true, force: true }) };
  }

  /** Windows tree kill via taskkill (best-effort). */
  function winTreeKill(pid: number): void {
    if (pid <= 0) return;
    try {
      const { spawnSync } = require('child_process') as typeof import('child_process');
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 });
    } catch { /* best-effort */ }
  }

  // ── live-wrapper: Node heartbeat child, continuous output, taskkill tree ──

  (isWin ? it : it.skip)('live-wrapper: Node heartbeat child, continuous heartbeat, timeout kills tree, both PIDs dead', async () => {
    const fix = await writeFixture(`
      const { spawn } = require('child_process');
      // Heartbeat is a Node child that inherits wrapper stderr → runner pipe.
      // Writes CHILD:<pid>, then dots every 50ms.
      const hb = spawn(process.execPath, ['-e',
        'var p=String(process.pid);process.stderr.write("CHILD:"+p+"\\n");setInterval(function(){process.stderr.write(".")},50)'
      ], { stdio: ['ignore', 'ignore', 'inherit'] });
      process.stdout.write('WRAPPER:' + process.pid + '\\n');
      // Poll to capture child PID.
      var iv = setInterval(function() {
        if (hb.pid) { process.stdout.write('CHILD:' + hb.pid + '\\n'); clearInterval(iv); }
      }, 10);
      // Wrapper keeps writing w to prove it is alive for taskkill.
      setInterval(function() { process.stdout.write('w'); }, 200);
    `);
    try {
      const r = await runBoundedProcess(process.execPath, [fix.file], { timeoutMs: 4000, maxOutputBytes: 64_000 });

      expect(r.settled).toBe('timeout');
      const pids: Record<string, number> = {};
      for (const m of r.stdout.matchAll(/([A-Z]+):(\d+)/g)) pids[m[1]!] = Number(m[2]!);
      expect(pids.WRAPPER).toBeGreaterThan(0);
      expect(pids.CHILD).toBeGreaterThan(0);
      // Heartbeat evidence: stderr capture should contain dots from child.
      expect(r.stderr).toContain('.');

      await new Promise((res) => setTimeout(res, 300));
      expect(pidDead(pids.WRAPPER!)).toBe(true);
      expect(pidDead(pids.CHILD!)).toBe(true);
    } finally {
      await fix.cleanup();
    }
  }, 20000);

  // ── early-exit: wrapper exits, child orphan, termination-unconfirmed ──

  (isWin ? it : it.skip)('early-exit: wrapper exits, child orphan, termination-unconfirmed, out-of-band tree cleanup', async () => {
    const fix = await writeFixture(`
      const { spawn } = require('child_process');
      const { writeFileSync } = require('fs');
      const { join } = require('path');
      const { tmpdir } = require('os');
      // Write child PID to a pidfile for mandatory out-of-band cleanup.
      const pidfile = join(tmpdir(), 'bridge-fix-child-' + process.pid + '.pid');
      const hb = spawn(process.execPath, ['-e',
        'var fs=require("fs");var p=String(process.pid);' +
        'fs.writeFileSync("' + pidfile.replace(/\\\\/g, '\\\\\\\\') + '","CHILD:"+p);' +
        'process.stderr.write("CHILD:"+p+"\\n");' +
        'setInterval(function(){process.stderr.write(".")},50)'
      ], { stdio: ['ignore', 'ignore', 'inherit'] });
      process.stdout.write('WRAPPER:' + process.pid + '\\n');
      // Poll to also output child PID to stdout for runner capture.
      var iv = setInterval(function() {
        if (hb.pid) { process.stdout.write('CHILD:' + hb.pid + '\\n'); clearInterval(iv); }
      }, 10);
      setTimeout(function() { process.exit(0); }, 50);
    `);

    let childPid = 0;
    let settled = false;
    try {
      const r = await runBoundedProcess(process.execPath, [fix.file], { timeoutMs: 3500, maxOutputBytes: 64_000 });
      settled = true;
      expect(r.settled).toBe('termination-unconfirmed');

      // Mandatory: CHILD PID must be present in output.
      const cm = r.stdout.match(/CHILD:(\d+)/);
      expect(cm).toBeTruthy();
      childPid = Number(cm![1]);
      expect(childPid).toBeGreaterThan(0);
    } finally {
      // Out-of-band tree cleanup: kill child + its descendants.
      if (childPid > 0) {
        winTreeKill(childPid);
        await new Promise((res) => setTimeout(res, 200));
      }
      // Verify no residue.
      if (childPid > 0) {
        expect(pidDead(childPid)).toBe(true);
      }
      await fix.cleanup();
      // Sanity: runner did not claim success.
      if (settled) { /* termination-unconfirmed already asserted above */ }
    }
  }, 15000);
});
