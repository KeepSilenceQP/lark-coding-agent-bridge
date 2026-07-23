import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const RUN = process.env.RUN_AZU_GROUP_PROMPT_ACCEPTANCE === '1';
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURE_ROOT = join(REPO_ROOT, 'tests', 'fixtures', 'azu-group-prompt-router');
const SENSITIVE_ACCEPTANCE_COPIES = ['codex-home/auth.json'] as const;
const roots: string[] = [];
const scrubbedRetainedRoots = new Set<string>();

describe('retained acceptance root credential scrub', () => {
  it('removes copied auth while preserving synthetic acceptance evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'azu-group-prompt-acceptance-scrub-'));
    try {
      const syntheticFiles = [
        join(root, 'scenarios', 'fixture', 'audit.json'),
        join(root, 'scenarios', 'fixture', 'last-message.json'),
        join(root, 'scenarios', 'fixture', '.acceptance', 'shim.jsonl'),
        join(root, 'scenarios', 'fixture', 'scenario.json'),
      ];
      await Promise.all([
        mkdir(join(root, 'codex-home'), { recursive: true, mode: 0o700 }),
        ...syntheticFiles.map((path) => mkdir(dirname(path), { recursive: true, mode: 0o700 })),
      ]);
      await Promise.all([
        writeFile(join(root, 'codex-home', 'auth.json'), 'fixture credential: never print\n', { mode: 0o600 }),
        ...syntheticFiles.map((path) => writeFile(path, '{}\n', { mode: 0o600 })),
      ]);

      await scrubAcceptanceRoot(root);

      await expect(stat(join(root, 'codex-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const path of syntheticFiles) expect((await stat(path)).isFile(), path).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes the entire root when pre-retention scrub fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'azu-group-prompt-acceptance-scrub-fail-'));
    await writeFile(join(root, 'synthetic-audit.json'), '{}\n', { mode: 0o600 });

    await expect(prepareAcceptanceRootRetention(root, async () => {
      throw new Error('injected scrub failure');
    })).rejects.toThrow(/scrub failed; root removed/u);
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a non-acceptance root before scrub and preserves its sentinel', async () => {
    const container = await mkdtemp(join(tmpdir(), 'azu-group-prompt-acceptance-path-guard-'));
    const unrelatedRoot = join(container, 'unrelated-temp-root');
    const sentinel = join(unrelatedRoot, 'synthetic-sentinel.json');
    let scrubCalled = false;
    try {
      await mkdir(unrelatedRoot, { recursive: true, mode: 0o700 });
      await writeFile(sentinel, '{}\n', { mode: 0o600 });

      await expect(prepareAcceptanceRootRetention(unrelatedRoot, async () => {
        scrubCalled = true;
        throw new Error('must not run');
      })).rejects.toThrow(/refusing to scrub a non-acceptance temp root/u);
      expect(scrubCalled).toBe(false);
      expect((await stat(sentinel)).isFile()).toBe(true);
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!RUN)('阿祖群 Prompt isolated live-model acceptance', () => {
  afterEach(async () => {
    const pendingRoots = roots.splice(0);
    if (process.env.AZU_KEEP_ACCEPTANCE_ROOT === '1') {
      for (const root of pendingRoots) {
        if (scrubbedRetainedRoots.has(root)) continue;
        await prepareAcceptanceRootRetention(root);
        scrubbedRetainedRoots.add(root);
        process.stderr.write(`scrubbed acceptance root retained after early exit: ${root}\n`);
      }
      return;
    }
    await Promise.all(pendingRoots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it('runs the reviewed scenario matrix in a dedicated allowlisted worker environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'azu-group-prompt-acceptance-'));
    roots.push(root);
    if (process.env.AZU_KEEP_ACCEPTANCE_ROOT === '1') process.stderr.write(`acceptance root created: ${root}\n`);
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
      ...(Object.hasOwn(process.env, 'AZU_ACCEPTANCE_SCENARIOS')
        ? { AZU_ACCEPTANCE_SCENARIOS: process.env.AZU_ACCEPTANCE_SCENARIOS }
        : {}),
    };

    const result = await run(process.execPath, [vitest, 'run', 'tests/acceptance/azu-group-prompt-router.worker.test.ts'], env);
    const retainRoot = process.env.AZU_KEEP_ACCEPTANCE_ROOT === '1' || result.code !== 0;
    if (retainRoot) {
      await prepareAcceptanceRootRetention(root);
      scrubbedRetainedRoots.add(root);
      process.stderr.write(`scrubbed acceptance root retained: ${root}\n`);
    }
    if (result.code !== 0 && process.env.AZU_KEEP_ACCEPTANCE_ROOT !== '1') {
      const index = roots.indexOf(root);
      if (index >= 0) roots.splice(index, 1);
    }
    expect(result.code, result.output).toBe(0);
  }, 20 * 60_000);
});

async function scrubAcceptanceRoot(root: string): Promise<void> {
  assertAcceptanceTempRoot(root);
  for (const relative of SENSITIVE_ACCEPTANCE_COPIES) {
    const path = join(root, relative);
    await rm(path, { force: true });
    try {
      await stat(path);
      throw new Error('sensitive acceptance copy still exists after scrub');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function prepareAcceptanceRootRetention(
  root: string,
  scrub: (root: string) => Promise<void> = scrubAcceptanceRoot,
): Promise<void> {
  assertAcceptanceTempRoot(root);
  try {
    await scrub(root);
  } catch {
    try {
      await rm(root, { recursive: true, force: true });
      await stat(root);
      throw new Error('fail-closed cleanup left acceptance root behind');
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('acceptance retention scrub failed; fail-closed root cleanup also failed');
      }
    }
    throw new Error('acceptance retention scrub failed; root removed');
  }
}

function assertAcceptanceTempRoot(root: string): void {
  const resolvedRoot = resolve(root);
  if (
    dirname(resolvedRoot) !== resolve(tmpdir())
    || !basename(resolvedRoot).startsWith('azu-group-prompt-acceptance-')
  ) {
    throw new Error('refusing to scrub a non-acceptance temp root');
  }
}

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
