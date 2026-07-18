import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const RUN = process.env.RUN_AZU_GROUP_PROMPT_ACCEPTANCE === '1';
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURE_ROOT = join(REPO_ROOT, 'tests', 'fixtures', 'azu-group-prompt-router');
const roots: string[] = [];

describe.skipIf(!RUN)('阿祖群 Prompt isolated live-model acceptance', () => {
  afterEach(async () => {
    if (process.env.AZU_KEEP_ACCEPTANCE_ROOT === '1') return;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('runs the reviewed scenario matrix in a dedicated allowlisted worker environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'azu-group-prompt-acceptance-'));
    roots.push(root);
    if (process.env.AZU_KEEP_ACCEPTANCE_ROOT === '1') process.stderr.write(`acceptance root: ${root}\n`);
    const paths = {
      home: join(root, 'home'),
      codexHome: join(root, 'codex-home'),
      tmp: join(root, 'tmp'),
      xdgConfig: join(root, 'xdg-config'),
      xdgCache: join(root, 'xdg-cache'),
      larkHome: join(root, 'lark-channel'),
      larkConfig: join(root, 'lark-channel', 'profiles', 'acceptance', 'source', 'config.json'),
      larkCliConfig: join(root, 'lark-channel', 'profiles', 'acceptance', 'lark-cli'),
      gitConfig: join(root, 'gitconfig'),
      hooks: join(root, 'git-hooks'),
    };
    await Promise.all([
      mkdir(paths.home, { recursive: true, mode: 0o700 }),
      mkdir(paths.codexHome, { recursive: true, mode: 0o700 }),
      mkdir(paths.tmp, { recursive: true, mode: 0o700 }),
      mkdir(paths.xdgConfig, { recursive: true, mode: 0o700 }),
      mkdir(paths.xdgCache, { recursive: true, mode: 0o700 }),
      mkdir(dirname(paths.larkConfig), { recursive: true, mode: 0o700 }),
      mkdir(paths.larkCliConfig, { recursive: true, mode: 0o700 }),
      mkdir(paths.hooks, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(paths.larkConfig, '{}\n', { mode: 0o600 }),
      writeFile(paths.gitConfig, '[credential]\n\thelper =\n[core]\n\thooksPath = /dev/null\n', { mode: 0o600 }),
    ]);

    const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const sourceAuth = join(sourceCodexHome, 'auth.json');
    await stat(sourceAuth);
    const copiedAuth = join(paths.codexHome, 'auth.json');
    await copyFile(sourceAuth, copiedAuth);
    await chmod(copiedAuth, 0o600);

    const [realCodex, realGit] = await Promise.all([
      resolveCommand('codex'),
      resolveCommand('git'),
    ]);
    const fixtureBin = join(FIXTURE_ROOT, 'bin');
    const vitest = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const isolatedPath = [fixtureBin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
    // Codex executes shell tools through a login zsh. Pin PATH in the isolated HOME so
    // the login shell cannot bypass the fixture shims and reach a real lark-cli.
    await writeFile(join(paths.home, '.zprofile'), `export PATH=${JSON.stringify(isolatedPath)}\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      PATH: isolatedPath,
      HOME: paths.home,
      CODEX_HOME: paths.codexHome,
      TMPDIR: paths.tmp,
      XDG_CONFIG_HOME: paths.xdgConfig,
      XDG_CACHE_HOME: paths.xdgCache,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      GIT_CONFIG_GLOBAL: paths.gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LARK_CHANNEL: '1',
      LARK_CHANNEL_HOME: paths.larkHome,
      LARK_CHANNEL_PROFILE: 'acceptance',
      LARK_CHANNEL_CONFIG: paths.larkConfig,
      LARKSUITE_CLI_CONFIG_DIR: paths.larkCliConfig,
      AZU_ACCEPTANCE_WORKER: '1',
      AZU_ACCEPTANCE_ROOT: root,
      AZU_REPO_ROOT: REPO_ROOT,
      AZU_REAL_CODEX_BINARY: realCodex,
      AZU_REAL_GIT_BINARY: realGit,
      AZU_LIVE_MEMORYDATA_ROOT: '/Users/bytedance/repo/o/memory_workspace/MemoryData',
      ...(process.env.AZU_ACCEPTANCE_SCENARIOS
        ? { AZU_ACCEPTANCE_SCENARIOS: process.env.AZU_ACCEPTANCE_SCENARIOS }
        : {}),
    };

    const result = await run(process.execPath, [vitest, 'run', 'tests/acceptance/azu-group-prompt-router.worker.test.ts'], env);
    expect(result.code, result.output).toBe(0);
  }, 20 * 60_000);
});

async function resolveCommand(command: string): Promise<string> {
  const result = await run('/usr/bin/which', [command], process.env);
  if (result.code !== 0) throw new Error(`missing command ${command}: ${result.output}`);
  return realpath(result.output.trim());
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, output: Buffer.concat(chunks).toString('utf8') }));
  });
}
