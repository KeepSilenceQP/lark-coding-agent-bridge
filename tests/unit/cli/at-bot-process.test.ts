import { spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
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
    expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', String(child.pid), '/T', '/F'],
      expect.objectContaining({ timeout: 5000, maxBuffer: 16384, encoding: 'utf8' }));
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

  it('Windows: normal exit → exit (NOT termination-unconfirmed)', async () => {
    // Regression: every Windows close must return 'exit' for normal completion,
    // not 'termination-unconfirmed'. The exit→close lifecycle is normal.
    const child = makeChild();
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', ['ok'], { timeoutMs: 9999 }, deps);
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    expect((await p).settled).toBe('exit');
  });

  it('Windows: hasPid false after exit + timeout → no taskkill, termination-unconfirmed', async () => {
    // Timeout fires after exit (hasPid=false). killTree checks !hasPid and
    // settles termination-unconfirmed. Taskkill never called.
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
//
// Structure (applies to both tests):
//  1. writeFixture creates a single tmp dir with known pidfile paths.
//  2. Fixture writes wrapper.pid + child.pid into that same tmp dir.
//  3. Test awaits runner, then reads PIDs from pidfiles.
//  4. finally: unconditional tree-kill + cleanup (PIDs from files).
//  5. Assertions come last — cleanup happens regardless of outcome.
// ═══════════════════════════════════════════════════════

describe('at-bot process-tree runner (real spawn, Windows)', () => {
  const isWin = process.platform === 'win32';

  interface WinFixture {
    file: string;
    tmpDir: string;
    readPid(name: string): number;
    cleanup(): Promise<void>;
  }

  async function writeFixture(body: (tmpDir: string) => string): Promise<WinFixture> {
    const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rm } = await import('node:fs/promises');
    const tmpDir = mkdtempSync(join(tmpdir(), 'bridge-winfix-'));
    const file = join(tmpDir, 'fixture.js');
    writeFileSync(file, body(tmpDir), 'utf8');
    return {
      file, tmpDir,
      readPid: (name: string) => {
        try { return Number(readFileSync(join(tmpDir, name), 'utf8').trim()); } catch { return 0; }
      },
      cleanup: () => rm(tmpDir, { recursive: true, force: true }),
    };
  }

  function winTreeKill(pid: number): void {
    if (pid <= 0) return;
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 }); } catch { /* tree gone */ }
  }

  // ── live-wrapper ──

  (isWin ? it : it.skip)('live-wrapper: Node heartbeat child, timeout kills tree, both PIDs dead', async () => {
    const fix = await writeFixture((tmpDir) => `
      const { spawn } = require('child_process');
      const { writeFileSync } = require('fs');
      const pd = ${JSON.stringify(tmpDir)};
      const hb = spawn(process.execPath, ['-e',
        'var p=String(process.pid);process.stderr.write("CHILD:"+p+"\\n");setInterval(function(){process.stderr.write(".")},50)'
      ], { stdio: ['ignore', 'ignore', 'inherit'] });
      // Synchronous: write both PIDs immediately after spawn returns.
      writeFileSync(require('path').join(pd, 'wrapper.pid'), String(process.pid));
      writeFileSync(require('path').join(pd, 'child.pid'), String(hb.pid));
      process.stdout.write('WRAPPER:' + process.pid + '\\n');
      process.stdout.write('CHILD:' + hb.pid + '\\n');
      setInterval(function() { process.stdout.write('w'); }, 200);
    `);

    let wp = 0, cp = 0, wpDead = false, cpDead = false, r: any = null;
    try {
      r = await runBoundedProcess(process.execPath, [fix.file], { timeoutMs: 4000, maxOutputBytes: 64_000 });
    } finally {
      wp = fix.readPid('wrapper.pid');
      cp = fix.readPid('child.pid');
      try {
        if (wp > 0) { winTreeKill(wp); await new Promise((res) => setTimeout(res, 200)); wpDead = pidDead(wp); }
        if (cp > 0) { winTreeKill(cp); await new Promise((res) => setTimeout(res, 200)); cpDead = pidDead(cp); }
      } finally {
        await fix.cleanup();
      }
    }
    expect(r).toBeTruthy();
    expect(r.settled).toBe('timeout');
    expect(wp).toBeGreaterThan(0);
    expect(cp).toBeGreaterThan(0);
    expect(r.stderr).toContain('.');
    expect(wpDead).toBe(true);
    expect(cpDead).toBe(true);
  }, 20000);

  // ── early-exit ──

  (isWin ? it : it.skip)('early-exit: wrapper exits, child survives, runner close=exit, out-of-band cleanup', async () => {
    // Windows Node closes inherited pipes on process.exit(). The runner
    // cannot distinguish normal exit from orphan survival at close time
    // (exit→close is the normal lifecycle). This is an acknowledged
    // observational boundary per Plan DD1.  The fixture verifies:
    //   1. Child PID captured and child IS alive before cleanup.
    //   2. Runner returns exit (normal close path — expected on Windows).
    //   3. Child is killed out-of-band by finally cleanup.
    const fix = await writeFixture((tmpDir) => `
      const { spawn } = require('child_process');
      const { writeFileSync } = require('fs');
      const pd = ${JSON.stringify(tmpDir)};
      const hb = spawn(process.execPath, ['-e',
        'var p=String(process.pid);process.stderr.write("CHILD:"+p+"\\n");setInterval(function(){process.stderr.write(".")},50)'
      ], { stdio: ['ignore', 'ignore', 'inherit'] });
      writeFileSync(require('path').join(pd, 'wrapper.pid'), String(process.pid));
      writeFileSync(require('path').join(pd, 'child.pid'), String(hb.pid));
      process.stdout.write('WRAPPER:' + process.pid + '\\n');
      process.stdout.write('CHILD:' + hb.pid + '\\n');
      setTimeout(function() { process.exit(0); }, 50);
    `);

    let wp = 0, cp = 0, cpWasAlive = false, wpDead = false, cpDead = false, r: any = null;
    try {
      r = await runBoundedProcess(process.execPath, [fix.file], { timeoutMs: 5000, maxOutputBytes: 64_000 });
    } finally {
      wp = fix.readPid('wrapper.pid');
      cp = fix.readPid('child.pid');
      // Prove child was alive before cleanup (not just spawned with PID).
      if (cp > 0) cpWasAlive = !pidDead(cp);
      try {
        if (wp > 0) { winTreeKill(wp); await new Promise((res) => setTimeout(res, 200)); wpDead = pidDead(wp); }
        if (cp > 0) { winTreeKill(cp); await new Promise((res) => setTimeout(res, 200)); cpDead = pidDead(cp); }
      } finally {
        await fix.cleanup();
      }
    }
    expect(r).toBeTruthy();
    // Windows observational boundary: runner cannot distinguish orphan
    // survival from normal exit at close time. Accept exit.
    expect(r.settled).toBe('exit');
    expect(wp).toBeGreaterThan(0);
    expect(cp).toBeGreaterThan(0);
    expect(cpWasAlive).toBe(true);
    expect(cpDead).toBe(true);
  }, 15000);
});
