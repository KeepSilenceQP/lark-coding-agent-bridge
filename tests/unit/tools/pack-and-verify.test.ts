import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const runner = resolve('tools/pack-and-verify.mjs');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('pack-and-verify runner', () => {
  it('fails closed when protected input is missing', () => {
    const result = spawnSync(process.execPath, [runner], {
      encoding: 'utf8',
      env: {},
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('privacy denylist input is required');
  });

  it('packs, scans, and clean-installs the same real tarball', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'source');
    const output = join(root, 'verified.tgz');
    const patternFile = join(root, 'patterns.json');
    await mkdir(join(source, 'dist'), { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'fictional-package-fixture',
      version: '1.2.3',
      type: 'module',
      files: ['dist'],
    }), 'utf8');
    await writeFile(join(source, 'dist/index.js'), 'export const ready = true;\n', 'utf8');
    await writeFile(patternFile, JSON.stringify(fictionalPatterns()), 'utf8');

    const result = spawnSync(process.execPath, [
      runner,
      '--source',
      source,
      '--patterns-file',
      patternFile,
      '--output',
      output,
    ], {
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.status, result.stderr).toBe(0);
    await expect(stat(output)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(result.stdout).toContain('verified package artifact written');
    expect(await readFile(output)).not.toHaveLength(0);
  }, 60_000);
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pack-and-verify-test-'));
  temporaryRoots.push(root);
  return root;
}

function fictionalPatterns() {
  return {
    appIds: ['fixture_app_1', 'fixture_app_2', 'fixture_app_3', 'fixture_app_4'],
    machineRoots: ['fixture_root_1', 'fixture_root_2'],
    botNames: ['fixture_bot_1', 'fixture_bot_2', 'fixture_bot_3', 'fixture_bot_4'],
  };
}
