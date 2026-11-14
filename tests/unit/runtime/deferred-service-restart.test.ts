import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeDeferredServiceRestart,
  launchDeferredServiceRestart,
  requestDeferredServiceRestart,
} from '../../../src/runtime/deferred-service-restart';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('deferred service restart', () => {
  it.each(['error', 'exit'])('reports asynchronous helper %s to the surviving supervisor', (event) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const onFailure = vi.fn();
    launchDeferredServiceRestart('trae-cli', {
      serviceId: 'supervisor', onFailure, spawn: () => child,
      execPath: '/node', cliPath: '/bridge.mjs', env: {},
    });
    if (event === 'error') child.emit('error', new Error('spawn failed'));
    else child.emit('exit', 1, null);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('keeps the receipt profile while launching the supervisor service helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-supervisor-helper-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const profileDir = join(root, 'profiles', 'trae-cli');
    await requestDeferredServiceRestart(profileDir, {
      profile: 'trae-cli', serviceId: 'supervisor', bridgePid: 1234,
      requestedAt: new Date().toISOString(),
    });
    expect(await consumeDeferredServiceRestart(profileDir, 1234)).toMatchObject({
      profile: 'trae-cli', serviceId: 'supervisor',
    });
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    launchDeferredServiceRestart('trae-cli', {
      serviceId: 'supervisor', spawn, execPath: '/node', cliPath: '/bridge.mjs',
      env: { LARK_CHANNEL_HOME: root, LARK_CHANNEL: '1', LARK_CHANNEL_PROFILE: 'trae-cli' },
    });
    expect(spawn).toHaveBeenCalledWith('/node',
      ['/bridge.mjs', 'restart', '--web-ui', '--profile', 'trae-cli'],
      expect.objectContaining({ env: { LARK_CHANNEL_HOME: root } }));
  });

  it('persists a restart request and consumes it only in the requesting bridge process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-deferred-restart-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const profileDir = join(root, 'profiles', 'codex');

    await requestDeferredServiceRestart(profileDir, {
      profile: 'codex',
      bridgePid: 1234,
      requestedAt: '2026-07-14T10:00:00.000Z',
    });

    const marker = JSON.parse(
      await readFile(join(profileDir, '.deferred-service-restart.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({ profile: 'codex', bridgePid: 1234 });
    expect(await consumeDeferredServiceRestart(profileDir, 9999)).toBeUndefined();

    await requestDeferredServiceRestart(profileDir, {
      profile: 'codex',
      bridgePid: 1234,
      requestedAt: '2026-07-14T10:00:00.000Z',
    });
    expect(await consumeDeferredServiceRestart(profileDir, 1234)).toMatchObject({
      format: 'old',
      profile: 'codex',
    });
    expect(await consumeDeferredServiceRestart(profileDir, 1234)).toBeUndefined();
  });

  it('launches a detached restart helper without bridge-bound environment', () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));

    launchDeferredServiceRestart('codex', {
      spawn,
      execPath: '/usr/local/bin/node',
      cliPath: '/repo/bin/lark-channel-bridge.mjs',
      env: {
        PATH: '/usr/bin',
        LARK_CHANNEL: '1',
        LARK_CHANNEL_PROFILE: 'codex',
        LARK_CHANNEL_BRIDGE_PID: '1234',
      },
    });

    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/node',
      ['/repo/bin/lark-channel-bridge.mjs', 'restart', '--profile', 'codex'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: { PATH: '/usr/bin' },
      }),
    );
    expect(unref).toHaveBeenCalledOnce();
  });
});
