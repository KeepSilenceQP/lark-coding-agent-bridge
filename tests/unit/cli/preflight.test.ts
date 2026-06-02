import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/schema';

const mocks = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
  spawnProcessSync: vi.fn(),
  calls: [] as Array<{
    cmd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }>,
  exitCodes: [] as number[],
  outputs: [] as string[],
  onSpawn: undefined as undefined | ((callIndex: number, args: string[], env?: NodeJS.ProcessEnv) => void),
}));

vi.mock('../../../src/platform/spawn', () => ({
  mergeProcessEnv: (base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv) => ({
    ...base,
    ...overrides,
  }),
  spawnProcess: mocks.spawnProcess,
  spawnProcessSync: mocks.spawnProcessSync,
}));

const { preFlightChecks } = await import('../../../src/cli/preflight');
const { resolveAppPaths } = await import('../../../src/config/app-paths');

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-preflight-'));
  roots.push(root);
  return root;
}

const bridgeConfig: AppConfig = {
  accounts: {
    app: {
      id: 'cli_codex',
      tenant: 'feishu',
      secret: {
        source: 'exec',
        provider: 'bridge',
        id: 'app-cli_codex',
      },
    },
  },
  secrets: {
    providers: {
      bridge: {
        source: 'exec',
        command: '/stale/secrets-getter',
        args: [],
      },
    },
  },
};

describe('lark-cli preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls = [];
    mocks.exitCodes = [];
    mocks.outputs = [];
    mocks.onSpawn = undefined;
    mocks.spawnProcessSync.mockReturnValue({ status: 0 });
    mocks.spawnProcess.mockImplementation(
      (cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
        mocks.calls.push({ cmd, args, env: options.env });
        mocks.onSpawn?.(mocks.calls.length, args, options.env);
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn();
        const exitCode = mocks.exitCodes.shift() ?? 0;
        const output = mocks.outputs.shift() ?? '';
        queueMicrotask(() => {
          if (output) child.stderr.write(output);
          child.emit('exit', exitCode);
        });
        return child;
      },
    );
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('binds lark-cli into the bridge-private config dir when target config is missing', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    mocks.exitCodes = [0];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
    expect(mocks.calls[0]?.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex',
      LARK_CHANNEL_HOME: root,
      LARK_CHANNEL_CONFIG: appPaths.larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: appPaths.larkCliConfigDir,
    });
    const source = JSON.parse(await readFile(appPaths.larkCliSourceConfigFile, 'utf8')) as {
      accounts: { app: { id: string } };
    };
    expect(source.accounts.app.id).toBe('cli_codex');
  });

  it('falls back through a locked root source overlay for lark-cli builds without LARK_CHANNEL_CONFIG support', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await writeFile(
      appPaths.configFile,
      `${JSON.stringify({
        schemaVersion: 2,
        activeProfile: 'codex',
        profiles: {
          codex: {
            accounts: bridgeConfig.accounts,
            agentKind: 'codex',
          },
        },
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const originalRoot = await readFile(appPaths.configFile, 'utf8');
    mocks.exitCodes = [2, 0];
    mocks.outputs = [
      JSON.stringify({
        ok: false,
        error: {
          type: 'lark-channel',
          message: `accounts.app.id missing in ${appPaths.configFile}`,
        },
      }),
      '',
    ];
    let rootDuringLegacyBind: { accounts?: { app?: { id?: string } } } | undefined;
    mocks.onSpawn = (callIndex) => {
      if (callIndex !== 2) return;
      rootDuringLegacyBind = JSON.parse(readFileSync(appPaths.configFile, 'utf8')) as {
        accounts?: { app?: { id?: string } };
      };
    };

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
    expect(mocks.calls[0]?.env).toMatchObject({
      LARK_CHANNEL_CONFIG: appPaths.larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: appPaths.larkCliConfigDir,
    });
    expect(mocks.calls[1]?.env).toMatchObject({
      LARKSUITE_CLI_CONFIG_DIR: appPaths.larkCliConfigDir,
    });
    expect(mocks.calls[0]?.env?.HOME).toBe(process.env.HOME);
    expect(mocks.calls[1]?.env?.HOME).toBe(process.env.HOME);
    expect(rootDuringLegacyBind?.accounts?.app?.id).toBe('cli_codex');
    expect(await readFile(appPaths.configFile, 'utf8')).toBe(originalRoot);
  });

  it('falls back when lark-cli prints a JSON-escaped bridge root path', async () => {
    const parent = await tempRoot();
    const root = join(parent, 'root\\with\\backslashes');
    await mkdir(root, { recursive: true });
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await writeFile(
      appPaths.configFile,
      `${JSON.stringify({
        schemaVersion: 2,
        activeProfile: 'codex',
        profiles: {
          codex: {
            accounts: bridgeConfig.accounts,
            agentKind: 'codex',
          },
        },
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    mocks.exitCodes = [2, 0];
    mocks.outputs = [
      JSON.stringify({
        ok: false,
        error: {
          type: 'lark-channel',
          message: `accounts.app.id missing in ${appPaths.configFile}`,
        },
      }),
      '',
    ];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
  });

  it('restores the bridge root config when legacy overlay bind fails', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const originalRoot = `${JSON.stringify({
      schemaVersion: 2,
      activeProfile: 'codex',
      profiles: {
        codex: {
          accounts: bridgeConfig.accounts,
          agentKind: 'codex',
        },
      },
    }, null, 2)}\n`;
    await writeFile(appPaths.configFile, originalRoot, { mode: 0o600 });
    mocks.exitCodes = [2, 3];
    mocks.outputs = [
      `accounts.app.id missing in ${appPaths.configFile}`,
      'keychain unavailable: test failure',
    ];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls).toHaveLength(2);
    expect(await readFile(appPaths.configFile, 'utf8')).toBe(originalRoot);
  });

  it('does not overlay the bridge root config when lark-cli is too old for lark-channel source', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const originalRoot = `${JSON.stringify({
      schemaVersion: 2,
      activeProfile: 'codex',
      profiles: {
        codex: {
          accounts: bridgeConfig.accounts,
          agentKind: 'codex',
        },
      },
    }, null, 2)}\n`;
    await writeFile(appPaths.configFile, originalRoot, { mode: 0o600 });
    mocks.exitCodes = [2];
    mocks.outputs = ['invalid --source "lark-channel"; valid values: env, file'];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
    expect(await readFile(appPaths.configFile, 'utf8')).toBe(originalRoot);
  });

  it('treats lark-cli builds without config bind source support as too old', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const originalRoot = `${JSON.stringify({
      schemaVersion: 2,
      activeProfile: 'codex',
      profiles: {
        codex: {
          accounts: bridgeConfig.accounts,
          agentKind: 'codex',
        },
      },
    }, null, 2)}\n`;
    await writeFile(appPaths.configFile, originalRoot, { mode: 0o600 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.exitCodes = [1];
    mocks.outputs = [
      [
        'Usage:',
        '  lark-cli config [command]',
        '',
        'Error: unknown flag: --source',
      ].join('\n'),
    ];

    let printed = '';
    try {
      await preFlightChecks({
        larkChannel: {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          configPath: appPaths.configFile,
          larkCliConfigDir: appPaths.larkCliConfigDir,
          larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
        },
        bridgeConfig,
        appPaths,
      });
      printed = log.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    ]);
    expect(printed).toContain('does not support the lark-channel source');
    expect(printed).toContain('lark-cli does not support `config bind --source lark-channel`.');
    expect(printed).not.toContain('Available Commands');
    expect(await readFile(appPaths.configFile, 'utf8')).toBe(originalRoot);
  });

  it('omits lark-cli update notices from bind failure diagnostics', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.exitCodes = [2];
    mocks.outputs = [
      JSON.stringify({
        ok: false,
        error: {
          type: 'lark-channel',
          message: 'permission denied while writing config',
        },
        _notice: {
          update: {
            current: '1.0.0',
            latest: '1.0.1',
            command: 'npm install -g @larksuite/cli',
          },
        },
      }),
    ];

    let printed = '';
    try {
      await preFlightChecks({
        larkChannel: {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          configPath: appPaths.configFile,
          larkCliConfigDir: appPaths.larkCliConfigDir,
          larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
        },
        bridgeConfig,
        appPaths,
      });
      printed = log.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(printed).toContain('permission denied while writing config');
    expect(printed).not.toContain('_notice');
    expect(printed).not.toContain('latest');
    expect(printed).not.toContain('npm install -g @larksuite/cli');
  });

  it('does not rebind when private target config already matches the current bridge profile', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await mkdir(join(appPaths.larkCliConfigDir, 'lark-channel'), { recursive: true });
    await writeFile(
      appPaths.larkCliTargetConfigFile,
      JSON.stringify({
        apps: [
          {
            appId: 'cli_codex',
            brand: 'feishu',
            defaultAs: 'bot',
            strictMode: 'bot',
            users: null,
          },
        ],
      }),
      { mode: 0o600 },
    );
    mocks.exitCodes = [0];

    await preFlightChecks({
      larkChannel: {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        configPath: appPaths.configFile,
        larkCliConfigDir: appPaths.larkCliConfigDir,
        larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
      },
      bridgeConfig,
      appPaths,
    });

    expect(mocks.calls.map((call) => call.args)).toEqual([
      ['config', 'show'],
    ]);
    expect(mocks.calls[0]?.env).toMatchObject({
      LARK_CHANNEL_CONFIG: appPaths.larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: appPaths.larkCliConfigDir,
    });
  });
});
