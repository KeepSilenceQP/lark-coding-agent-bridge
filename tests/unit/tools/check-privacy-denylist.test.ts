import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const tool = resolve('tools/check-privacy-denylist.mjs');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('privacy denylist scanner', () => {
  it('fails closed when protected input is missing', async () => {
    const root = await temporaryRoot();
    const result = runTool(['--tree', '--root', root], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('privacy denylist input is required');
  });

  it('scans tracked historical documentation without path exemptions', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.root, 'docs'), { recursive: true });
    await writeFile(join(fixture.root, 'docs/history.md'), 'fixture_app_alpha\n', 'utf8');
    git(fixture.root, ['init', '-q']);
    git(fixture.root, ['add', 'docs/history.md']);

    const result = runTool([
      '--tree',
      '--root',
      fixture.root,
      '--patterns-file',
      fixture.patternFile,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('docs/history.md (appIds[1])');
    expect(result.stderr).not.toContain('fixture_app_alpha');
  });

  it('allows explicit fictional placeholders that are not protected patterns', async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.root, 'README.md'),
      'Planner Bot cli_example_planner /redacted/local-root\n',
      'utf8',
    );
    git(fixture.root, ['init', '-q']);
    git(fixture.root, ['add', 'README.md']);

    const result = runTool([
      '--tree',
      '--root',
      fixture.root,
      '--patterns-file',
      fixture.patternFile,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 findings');
  });

  it('detects protected content in dist', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.root, 'dist'), { recursive: true });
    await writeFile(join(fixture.root, 'dist/index.js'), 'fixture_machine_local\n', 'utf8');

    const result = runTool([
      '--dist',
      '--root',
      fixture.root,
      '--patterns-file',
      fixture.patternFile,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dist/index.js (machineRoots[1])');
    expect(result.stderr).not.toContain('fixture_machine_local');
  });

  it('enumerates tar entries and detects protected content without echoing it', async () => {
    const fixture = await createFixture();
    const tarball = join(fixture.root, 'fixture.tgz');
    await writeFile(
      tarball,
      gzipSync(singleFileTar('package/history.txt', 'fixture_bot_gamma\n')),
    );

    const result = runTool([
      '--tarball',
      tarball,
      '--patterns-file',
      fixture.patternFile,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tarball:package/history.txt (botNames[3])');
    expect(result.stderr).not.toContain('fixture_bot_gamma');
  });

  it('rejects an incomplete protected input instead of weakening the gate', async () => {
    const fixture = await createFixture();
    const parsed = JSON.parse(await readFile(fixture.patternFile, 'utf8')) as {
      appIds: string[];
    };
    parsed.appIds.pop();
    await writeFile(fixture.patternFile, JSON.stringify(parsed), 'utf8');

    const result = runTool([
      '--tree',
      '--root',
      fixture.root,
      '--patterns-file',
      fixture.patternFile,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exactly 4 patterns');
  });
});

async function createFixture(): Promise<{ root: string; patternFile: string }> {
  const root = await temporaryRoot();
  const patternFile = join(await temporaryRoot(), 'patterns.json');
  await writeFile(patternFile, JSON.stringify({
    appIds: [
      'fixture_app_alpha',
      'fixture_app_beta',
      'fixture_app_gamma',
      'fixture_app_delta',
    ],
    machineRoots: [
      'fixture_machine_local',
      'fixture_machine_remote',
    ],
    botNames: [
      'fixture_bot_alpha',
      'fixture_bot_beta',
      'fixture_bot_gamma',
      'fixture_bot_delta',
    ],
  }), 'utf8');
  return { root, patternFile };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'privacy-denylist-test-'));
  temporaryRoots.push(root);
  return root;
}

function runTool(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [tool, ...args], {
    encoding: 'utf8',
    env,
  });
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function singleFileTar(name: string, content: string): Buffer {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000777\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  const paddedBody = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(paddedBody);
  return Buffer.concat([header, paddedBody, Buffer.alloc(1024)]);
}
