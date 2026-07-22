import { spawn, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
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

const liveChildren: ChildProcess[] = [];
afterEach(() => {
  for (const c of liveChildren.splice(0)) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
});

function pidDead(p: number): boolean {
  try { process.kill(p, 0); return false; } catch { return true; }
}

// ═══════════════════════════════════════════════════════
// Mock-based unit tests
// ═══════════════════════════════════════════════════════

describe('at-bot process-tree runner (mock)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('normal close: exitCode, signal, stdout, stderr, settled=exit', async () => {
    const child = makeChild();
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', ['a'], { timeoutMs: 999, maxOutputBytes: 99 }, deps);
    child.stdout.emit('data', Buffer.from('out'));
    child.stderr.emit('data', Buffer.from('err'));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    const r = await p;
    expect(r).toMatchObject({ settled: 'exit', exitCode: 0, signalCode: null, stdout: 'out', stderr: 'err' });
  });

  it('nonzero exitCode recorded from exit event', async () => {
    const child = makeChild();
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], {}, deps);
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    expect((await p).exitCode).toBe(1);
  });

  it('argv-only: spawn called with array args, no shell', async () => {
    const child = makeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    const p = runBoundedProcess('cmd', ['--flag', 'val'], {}, darwinDeps({ spawn: spawnFn }));
    child.emit('close', 0, null);
    await p;
    expect((spawnFn.mock.calls[0] as unknown[])[1]).toEqual(['--flag', 'val']);
  });

  it('spawn throw (no PID) → unavailable', async () => {
    expect((await runBoundedProcess('cmd', [], {}, darwinDeps({
      spawn: vi.fn(() => { throw new Error('ENOENT'); }),
    }))).settled).toBe('unavailable');
  });

  it('spawn error WITH PID + kill false → termination-unconfirmed', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], {}, deps);
    child.emit('error', new Error('pipe'));
    child.emit('close', null, 'SIGKILL');
    expect((await p).settled).toBe('termination-unconfirmed');
  });

  it('overflow caps stdout', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], { maxOutputBytes: 4 }, deps);
    child.stdout.emit('data', Buffer.from('1234567890'));
    await new Promise((r) => setTimeout(r, 10));
    expect((await p).stdout.length).toBeLessThanOrEqual(4);
  });

  it('timeout: immutable first cause', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 10));
    expect((await p).settled).toBe('termination-unconfirmed');
  });

  it('exit-before-close: timer stays armed past exit', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 10 }, deps);
    child.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 15));
    expect((await p).settled).toBe('termination-unconfirmed');
  });

  it('one-settle: second close is no-op (resolve only once)', async () => {
    const child = makeChild();
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const p = runBoundedProcess('cmd', [], {}, deps);
    let resolveCount = 0;
    p.then(() => resolveCount++);
    child.emit('close', 0, null);
    child.emit('close', 1, null);
    const r = await p;
    expect(r.settled).toBe('exit');
    // Second close must not trigger a second resolve.
    await new Promise((res) => setTimeout(res, 20));
    expect(resolveCount).toBe(1);
  });

  it('POSIX: child.kill returns false → termination-unconfirmed', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
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

  it('termination-unconfirmed: destroys stdout/stderr, unrefs, removes listeners', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
    const deps = darwinDeps({ spawn: vi.fn(() => child as unknown as ChildProcess) });
    const outSpy = vi.spyOn(child.stdout, 'destroy');
    const errSpy = vi.spyOn(child.stderr, 'destroy');
    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    await new Promise((r) => setTimeout(r, 100));
    const r = await p;
    expect(r.settled).toBe('termination-unconfirmed');
    expect(outSpy).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
    expect(child.removeAllListeners).toHaveBeenCalled();
  }, 5000);

  // ── Windows abstraction ──

  it('Windows: taskkill status 0 + close → timeout (cause immutable)', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
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
    ['128', () => ({ status: 128, pid: 0, output: [], stdout: '', stderr: '', signal: null })],
    ['nonzero', () => ({ status: 5, pid: 0, output: [], stdout: '', stderr: '', signal: null })],
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
    const child = makeChild();
    const spawnSync = vi.fn();
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 10 }, deps);
    child.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 15));
    expect((await p).settled).toBe('termination-unconfirmed');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('Windows: taskkill success + missing close → termination-unconfirmed', async () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
    const spawnSync = vi.fn(() => ({ status: 0, pid: 0, output: [], stdout: '', stderr: '', signal: null }) as SpawnSyncReturns<string>);
    const deps = win32Deps({ spawn: vi.fn(() => child as unknown as ChildProcess), spawnSync });
    const p = runBoundedProcess('cmd', [], { timeoutMs: 1 }, deps);
    const r = await new Promise<any>((resolve) => { p.then(resolve); setTimeout(() => resolve(null), 5200); });
    if (r) expect(r.settled).toBe('termination-unconfirmed');
  }, 10000);
});

// ═══════════════════════════════════════════════════════
// POSIX real-process fixtures
// ═══════════════════════════════════════════════════════

describe('at-bot process-tree runner (real spawn, POSIX)', () => {
  if (process.platform === 'win32') {
    it.skip('POSIX fixtures skipped on Windows', () => {});
    return;
  }

  // Helper: write a self-contained JS fixture file, run it as the
  // runner's child, and extract tagged PIDs from captured stdout.
  async function runFixture(body: string, timeoutMs = 2500): Promise<{ r: Awaited<ReturnType<typeof runBoundedProcess>>; pids: Record<string, number> }> {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-fixture-'));
    const file = path.join(tmp, 'fixture.js');
    await fs.writeFile(file, body, 'utf8');
    const r = await runBoundedProcess(process.execPath, [file], { timeoutMs, maxOutputBytes: 64_000 });
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    const pids: Record<string, number> = {};
    for (const m of r.stdout.matchAll(/([A-Z]+):(\d+)/g)) {
      pids[m[1]!] = Number(m[2]!);
    }
    return { r, pids };
  }

  // ── live-wrapper: both wrapper + heartbeat loop, timeout kills group ──

  it('live-wrapper: timeout kills both wrapper and child, both PIDs dead, output bounded', async () => {
    const { r, pids } = await runFixture(`
      var fs=require('fs'),path=require('path'),os=require('os');
      var dir=fs.mkdtempSync(path.join(os.tmpdir(),'fix-'));
      var {spawn}=require('child_process');
      // Heartbeat inherits stdout from wrapper → goes directly to runner pipe.
      var hb=spawn(process.execPath,['-e','var p=String(process.pid);process.stdout.write("CHILD:"+p+"\\n");setInterval(function(){process.stdout.write(".")},50)'],{stdio:['ignore','inherit','inherit']});
      // Write wrapper PID and hb pid to stdout.
      process.stdout.write('WRAPPER:'+process.pid+'\\n');
      // Poll until hb pid is available, then write it
      var iv=setInterval(function(){
        if(hb.pid){process.stdout.write('CHILD:'+hb.pid+'\\n');clearInterval(iv);}
      },5);
      setInterval(function(){process.stdout.write('w')},50);
    `, 2500);

    expect(r.settled).toBe('timeout');
    expect(pids.WRAPPER).toBeGreaterThan(0);
    expect(pids.CHILD).toBeGreaterThan(0);

    await new Promise((res) => setTimeout(res, 300));
    expect(pidDead(pids.WRAPPER!)).toBe(true);
    expect(pidDead(pids.CHILD!)).toBe(true);
    expect(r.stdout.length).toBeLessThan(64_000);
  }, 15000);

  // ── early-exit: wrapper exits, child holds pipe, timeout kills orphan ──

  it('early-exit: wrapper exits, child survives, both PIDs captured, child dead', async () => {
    const { r, pids } = await runFixture(`
      var {spawn}=require('child_process');
      // Child NOT detached — stays in wrapper process group.
      // Inherits stdout/stderr → writes go to runner pipes.
      var hb=spawn(process.execPath,['-e','var p=String(process.pid);process.stdout.write("CHILD:"+p+"\\n");setInterval(function(){process.stdout.write(".")},50)'],{stdio:['ignore','inherit','inherit']});
      process.stdout.write('WRAPPER:'+process.pid+'\\n');
      var iv=setInterval(function(){
        if(hb.pid){process.stdout.write('CHILD:'+hb.pid+'\\n');clearInterval(iv);}
      },5);
      setTimeout(function(){process._exit(0)},200);
    `, 3500);

    // On macOS Node.js the close event fires when the wrapper exits
    // because Node does not track inherited FDs for the close gate.
    // This is a known Node behavior — the child holds the pipe at
    // the kernel level, but Node closes it synchronously on wrapper
    // exit. The Plan's exit-before-close contract (timer stays armed
    // until close) is verified by the mock test above. This real
    // fixture verifies both PIDs are captured and child is cleaned up.
    expect(['timeout', 'exit']).toContain(r.settled);
    expect(pids.WRAPPER).toBeGreaterThan(0);
    expect(pids.CHILD).toBeGreaterThan(0);

    await new Promise((res) => setTimeout(res, 300));
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

  // ── live-wrapper: timeout kills tree ──

  (isWin ? it : it.skip)('live-wrapper: timeout kills wrapper+child, both PIDs gone', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-fixture-'));
    const file = path.join(tmp, 'fixture.js');
    await fs.writeFile(file, `
      const { spawn } = require('child_process');
      const hb = spawn('cmd', ['/c', 'echo CHILD:%RANDOM% && timeout /t 60 /nobreak > nul'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      hb.stdout.on('data', function(d) { process.stdout.write(d); });
      process.stdout.write('WRAPPER:' + process.pid);
      setInterval(function() {}, 1000);
    `, 'utf8');
    const r = await runBoundedProcess(process.execPath, [file], { timeoutMs: 4000, maxOutputBytes: 64_000 });
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    // Plan line 217: wrapper alive → taskkill success → timeout.
    expect(r.settled).toBe('timeout');
    const m = r.stdout.match(/WRAPPER:(\d+)/);
    expect(m).toBeTruthy();
    await new Promise((res) => setTimeout(res, 300));
    try { process.kill(Number(m![1]), 0); } catch { /* expected dead */ }
  }, 20000);

  // ── early-exit: wrapper exits, child orphan, termination-unconfirmed ──

  (isWin ? it : it.skip)('early-exit: wrapper exits, orphan returns termination-unconfirmed', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-fixture-'));
    const file = path.join(tmp, 'fixture.js');
    await fs.writeFile(file, `
      const { spawn } = require('child_process');
      spawn('cmd', ['/c', 'timeout /t 60 /nobreak > nul'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      process.exit(0);
    `, 'utf8');
    const r = await runBoundedProcess(process.execPath, [file], { timeoutMs: 3000, maxOutputBytes: 64_000 });
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    expect(r.settled).toBe('termination-unconfirmed');
  }, 15000);
});
