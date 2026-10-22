import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveAccessConfig, type MutableProfileState } from '../../../src/config/config-ops';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('access config legacy projection', () => {
  it('saves and clears topic-root mention settings without replacing per-chat mention overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-config-ops-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };
    const state: MutableProfileState = {
      profile: 'claude',
      configPath,
      cfg: { accounts: { app } },
      profileConfig: createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: { app },
        access: { chatRequireMention: { oc_topic: false } },
      }),
    };
    await writeFile(configPath, JSON.stringify(state.cfg));

    await saveAccessConfig(state, access => ({
      ...access,
      topicRootRequireMention: { oc_topic: true, oc_other: false },
    }));
    expect(state.cfg.preferences?.access?.topicRootRequireMention).toEqual({ oc_topic: true, oc_other: false });
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.preferences.access.topicRootRequireMention).toEqual({ oc_topic: true, oc_other: false });
    expect(saved.preferences.access.chatRequireMention).toEqual({ oc_topic: false });

    await saveAccessConfig(state, access => ({ ...access, topicRootRequireMention: {} }));
    const cleared = JSON.parse(await readFile(configPath, 'utf8'));
    expect(cleared.preferences.access).not.toHaveProperty('topicRootRequireMention');
    expect(cleared.preferences.access.chatRequireMention).toEqual({ oc_topic: false });
  });
});
