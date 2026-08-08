import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import {
  configuredOwnerId,
  persistOwnerIdentity,
} from '../../../src/policy/owner';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('owner persistence', () => {
  it('stores owner identity with its application id and reloads it', async () => {
    const { configPath } = await createConfig('cli_test');

    expect(await persistOwnerIdentity({
      configPath,
      profile: 'codex',
      appId: 'cli_test',
      openId: 'ou_owner',
    })).toBe(true);

    const root = await loadRootConfig(configPath);
    const profile = root?.profiles.codex;
    expect(profile?.access.owner).toEqual({ appId: 'cli_test', openId: 'ou_owner' });
    expect(profile && configuredOwnerId(profile, 'cli_test')).toBe('ou_owner');
    expect(profile && configuredOwnerId(profile, 'cli_other')).toBeUndefined();
  });

  it('does not attach an old owner result after the application changes', async () => {
    const { configPath } = await createConfig('cli_new');

    expect(await persistOwnerIdentity({
      configPath,
      profile: 'codex',
      appId: 'cli_old',
      openId: 'ou_old_owner',
    })).toBe(false);

    expect((await loadRootConfig(configPath))?.profiles.codex?.access.owner).toBeUndefined();
  });
});

async function createConfig(appId: string): Promise<{ configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-owner-persistence-'));
  roots.push(root);
  const configPath = join(root, 'config.json');
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: appId, secret: 'secret', tenant: 'feishu' } },
    codex: { binaryPath: '/usr/local/bin/codex' },
  });
  await saveRootConfig(createRootConfig('codex', profile), configPath);
  return { configPath };
}
