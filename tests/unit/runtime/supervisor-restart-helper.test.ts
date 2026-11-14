import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { helperRestartAndWait, sendHelperFailureReceipt } from '../../../src/cli/commands/service';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createPending } from '../../../src/runtime/restart-receipt';
import type { ServiceAdapter } from '../../../src/daemon/service-adapter';
import type { ProcessEntry } from '../../../src/runtime/registry';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'supervisor-receipt-'));
  roots.push(rootDir);
  const profileConfig = (id: string) => createDefaultProfileConfig({ agentKind: 'codex',
    codex: { binaryPath: '/fixture/codex' },
    accounts: { app: { id, secret: 'fixture-only', tenant: 'feishu' } } });
  const config = createRootConfig('trae-cli', profileConfig('cli_trae-cli'));
  config.profiles.codex = profileConfig('cli_codex');
  await saveRootConfig(config, join(rootDir, 'config.json'));
  for (const profile of ['trae-cli', 'codex']) {
    await createPending(resolveAppPaths({ rootDir, profile }).profileDir, {
      receiptId: `restart-${profile}`, profile, serviceId: 'supervisor', oldPid: 1234,
      requestedAt: new Date().toISOString(),
      returnRoute: { chatId: `oc_${profile}`, threadId: `omt_${profile}`, replyTo: `om_${profile}` },
    });
  }
  const adapter: ServiceAdapter = {
    platformName: 'fixture', servicePath: () => '/fixture', fileExists: () => true,
    isRunning: () => true, install: async () => {},
    start: vi.fn(() => ({ ok: true, stderr: '' })),
    stop: () => ({ ok: true, stderr: '' }),
    stopAndDisableAutostart: () => ({ ok: true, stderr: '' }),
    disableAutostart: () => ({ ok: true, stderr: '' }),
    restart: vi.fn(() => ({ ok: true, stderr: '' })), waitUntilStopped: async () => true,
    deleteFile: async () => {}, describeStatus: () => '', parseStatus: () => ({ pid: '1234' }),
  };
  const old = ['trae-cli', 'codex'].map((profile) => entry(profile, 1234));
  const fresh = ['trae-cli', 'codex'].map((profile) => entry(profile, 5678));
  const readRegistry = vi.fn().mockReturnValueOnce(old).mockReturnValue(fresh);
  const failure = vi.fn<typeof sendHelperFailureReceipt>(async () => {});
  const deps = {
    readRegistry, sendFailureReceipt: failure, waitTimeoutMs: 0,
    resolveRuntime: vi.fn().mockImplementation(async ({ profile }: { profile?: string }) =>
      ({ cfg: { accounts: { app: { id: `cli_${profile}` } } } })),
    exit: (code: number): never => { throw new Error(`exit:${code}`); },
  };
  const paths = resolveAppPaths({ rootDir, profile: 'trae-cli' });
  return { rootDir, adapter, old, fresh, readRegistry, failure, deps, paths };
}

describe('supervisor restart helper receipts', () => {
  it('restarts once and observes every requesting profile without sending premature success', async () => {
    const h = await fixture();
    await helperRestartAndWait('trae-cli', h.adapter, h.paths, h.deps);
    expect(h.adapter.restart).toHaveBeenCalledOnce();
    expect(h.failure).not.toHaveBeenCalled();
  });

  it('sends startup failure only to the profile that did not reconnect', async () => {
    const h = await fixture();
    h.readRegistry.mockReset().mockReturnValueOnce(h.old).mockReturnValue([h.fresh[0]]);
    await expect(helperRestartAndWait('trae-cli', h.adapter, h.paths, h.deps)).rejects.toThrow('exit:1');
    expect(h.failure).toHaveBeenCalledOnce();
    expect(h.failure).toHaveBeenCalledWith('codex', expect.anything(), 'restart-codex',
      { chatId: 'oc_codex', threadId: 'omt_codex', replyTo: 'om_codex' }, 'startup-timeout');
  });

  it('reports service-action failure to all concurrent requesting profiles', async () => {
    const h = await fixture();
    h.adapter.restart = vi.fn(() => ({ ok: false, stderr: 'fixture failure' }));
    await expect(helperRestartAndWait('trae-cli', h.adapter, h.paths, h.deps)).rejects.toThrow('exit:1');
    expect(h.failure.mock.calls.map((call) => call[0])).toEqual(['trae-cli', 'codex']);
  });

  it('does not restart an already replaced supervisor a second time', async () => {
    const h = await fixture();
    h.adapter.parseStatus = () => ({ pid: '5678' });
    h.readRegistry.mockReset().mockReturnValue(h.fresh);
    await helperRestartAndWait('trae-cli', h.adapter, h.paths, h.deps);
    expect(h.adapter.restart).not.toHaveBeenCalled();
    expect(h.failure).not.toHaveBeenCalled();
  });

  it('does not operate on a supervisor whose PID cannot be verified', async () => {
    const h = await fixture();
    h.adapter.parseStatus = () => ({});
    await expect(helperRestartAndWait('trae-cli', h.adapter, h.paths, h.deps)).rejects.toThrow('exit:1');
    expect(h.adapter.restart).not.toHaveBeenCalled();
    expect(h.failure).toHaveBeenCalledTimes(2);
  });

  it('reports a failed sibling even after the old supervisor registry entries were removed', async () => {
    const h = await fixture();
    h.adapter.parseStatus = () => ({ pid: '5678' });
    h.readRegistry.mockReset().mockReturnValue([h.fresh[0]]);
    await expect(helperRestartAndWait('trae-cli', h.adapter, h.paths, h.deps)).rejects.toThrow('exit:1');
    expect(h.adapter.restart).not.toHaveBeenCalled();
    expect(h.failure).toHaveBeenCalledOnce();
    expect(h.failure).toHaveBeenCalledWith('codex', expect.anything(), 'restart-codex',
      { chatId: 'oc_codex', threadId: 'omt_codex', replyTo: 'om_codex' }, 'startup-timeout');
  });
});

function entry(profileName: string, pid: number): ProcessEntry {
  return { id: profileName, pid, appId: `cli_${profileName}`, tenant: 'feishu', profileName,
    agentKind: 'codex', configPath: '/fixture/config.json', startedAt: new Date().toISOString(),
    version: 'fixture', botName: profileName };
}
