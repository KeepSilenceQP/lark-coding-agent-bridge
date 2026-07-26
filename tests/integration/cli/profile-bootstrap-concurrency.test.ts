import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preFlightChecks: vi.fn(async () => {
    throw new Error('post-bootstrap-stop');
  }),
  validateAppCredentials: vi.fn(async (appId: string) => ({
    ok: true,
    botName: `Bot ${appId}`,
  })),
  setSecret: vi.fn(async () => {}),
}));

vi.mock('../../../src/cli/preflight', () => ({
  preFlightChecks: mocks.preFlightChecks,
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: mocks.validateAppCredentials,
}));

vi.mock('../../../src/config/keystore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/keystore')>();
  return {
    ...actual,
    setSecret: mocks.setSecret,
  };
});

vi.mock('../../../src/daemon/service-adapter', () => ({
  getServiceAdapter: vi.fn(() => ({
    isRunning: vi.fn(() => false),
  })),
}));

describe('profile bootstrap commit concurrency', () => {
  let root = '';
  let previousHome: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bridge-profile-concurrency-'));
    previousHome = process.env.LARK_CHANNEL_HOME;
    process.env.LARK_CHANNEL_HOME = root;
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        activeProfile: '',
        preferences: {},
        botRegistry: {
          entries: [{ name: 'Remote Bot', aliases: [], appId: 'cli_remote' }],
        },
        profiles: {},
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  });

  afterAll(async () => {
    if (previousHome === undefined) {
      delete process.env.LARK_CHANNEL_HOME;
    } else {
      process.env.LARK_CHANNEL_HOME = previousHome;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('serializes run, service, and profile-create commits without deadlock or lost updates', async () => {
    const [{ runStart }, { runServiceStart }, { runProfileCreate }, { loadRootConfig }] =
      await Promise.all([
        import('../../../src/cli/commands/start'),
        import('../../../src/cli/commands/service'),
        import('../../../src/cli/commands/profile'),
        import('../../../src/config/profile-store'),
      ]);

    const results = await withTimeout(
      Promise.allSettled([
        runStart({
          config: join(root, 'config.json'),
          profile: 'run-entry',
          agent: 'claude',
          appId: 'cli_run',
          appSecret: 'run-secret',
          tenant: 'feishu',
          skipCheckLarkCli: true,
        }),
        runServiceStart({
          profile: 'service-entry',
          agent: 'claude',
          appId: 'cli_service',
          appSecret: 'service-secret',
          tenant: 'feishu',
          skipCheckLarkCli: true,
        }),
        runProfileCreate('create-entry', {
          rootDir: root,
          agent: 'claude',
          appId: 'cli_create',
          appSecret: 'create-secret',
          tenant: 'feishu',
        }),
      ]),
      5_000,
    );

    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'post-bootstrap-stop' }),
    });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'post-bootstrap-stop' }),
    });
    expect(results[2]).toMatchObject({ status: 'fulfilled' });

    const loaded = await loadRootConfig(join(root, 'config.json'));
    expect(loaded).toBeDefined();
    expect(Object.keys(loaded!.profiles).sort()).toEqual([
      'create-entry',
      'run-entry',
      'service-entry',
    ]);
    expect(loaded!.botRegistry?.entries.map((entry) => entry.appId).sort()).toEqual([
      'cli_create',
      'cli_remote',
      'cli_run',
      'cli_service',
    ]);
    expect(Object.keys(loaded!.profiles)).toContain(loaded!.activeProfile);
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe(
      `${loaded!.activeProfile}\n`,
    );
    expect(mocks.preFlightChecks).toHaveBeenCalledTimes(2);
  });
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
