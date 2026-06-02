import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCodexBinaryPin,
  verifyCodexBinaryPin,
} from '../../../src/agent/codex/binary.js';
import { AgentPreflightError } from '../../../src/agent/preflight.js';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import {
  writeVersionExecutable,
  writeVersionExecutableFile,
} from '../../helpers/fake-executable.js';

const cleanups: Array<() => Promise<void>> = [];

describe('Codex binary pinning', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('records binary realpath, version, owner, mode, and sha256', async () => {
    const binary = await writeBinary('codex-version-1');

    const pin = await createCodexBinaryPin(binary, {
      readVersion: async () => 'codex 1.2.3',
    });

    expect(pin).toMatchObject({
      binaryPath: binary,
      realpath: await realpath(binary),
      version: 'codex 1.2.3',
      sha256: await sha256(binary),
    });
    expect(pin.owner).toBeTypeOf('number');
    expect(pin.mode).toBeTypeOf('number');
  });

  it('rejects realpath drift', async () => {
    const first = await writeBinary('first');
    const second = await writeBinary('second');
    const pin = await createCodexBinaryPin(first, {
      readVersion: async () => 'codex 1.2.3',
    });

    await expect(
      verifyCodexBinaryPin(pin, second, { readVersion: async () => 'codex 1.2.3' }),
    ).rejects.toThrow(/realpath/i);
  });

  it('rejects version drift', async () => {
    const binary = await writeBinary('codex-version-1');
    const pin = await createCodexBinaryPin(binary, {
      readVersion: async () => 'codex 1.2.3',
    });

    await expect(
      verifyCodexBinaryPin(pin, binary, { readVersion: async () => 'codex 2.0.0' }),
    ).rejects.toThrow(/version/i);
  });

  it('rejects hash drift', async () => {
    const binary = await writeBinary('codex-version-1');
    const pin = await createCodexBinaryPin(binary, {
      readVersion: async () => 'codex 1.2.3',
    });
    await writeFile(binary, 'changed bytes\n', 'utf8');

    await expect(
      verifyCodexBinaryPin(pin, binary, { readVersion: async () => 'codex 1.2.3' }),
    ).rejects.toThrow(/sha256/i);
  });

  it('maps hash drift to a stable SpawnFailed code before spawning Codex', async () => {
    const binary = await writeBinary('codex 1.2.3');
    const pin = await createCodexBinaryPin(binary, {
      readVersion: async () => 'codex 1.2.3',
    });
    await writeVersionExecutableFile(binary, 'codex 1.2.3', 'same version, different bytes');
    const adapter = new CodexAdapter({
      binary,
      binaryPin: pin,
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });

    await expect(adapter.prepareRun()).rejects.toMatchObject({ code: 'binary-hash-mismatch' });
  });

  it('allows verification when owner and mode are unavailable on the stored pin', async () => {
    const binary = await writeBinary('codex-version-1');
    const pin = await createCodexBinaryPin(binary, {
      readVersion: async () => 'codex 1.2.3',
    });

    await expect(
      verifyCodexBinaryPin(
        { ...pin, owner: undefined, mode: undefined },
        binary,
        { readVersion: async () => 'codex 1.2.3' },
      ),
    ).resolves.toBeUndefined();
  });

  it('uses the cross-platform spawn wrapper for version checks', async () => {
    const source = await readFile(
      new URL('../../../src/agent/preflight.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain("from '../platform/spawn'");
    expect(source).not.toContain("from 'node:child_process'");
  });

  it('reports signaled version checks with an agent preflight diagnostic', async () => {
    const binary = await writeRawBinary('binary bytes\n');
    const error = new AgentPreflightError({
      code: 'agent-version-check-signaled',
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: 'codex',
      binaryPath: binary,
      realpath: await realpath(binary),
      args: ['--version'],
      exitCode: null,
      signal: 'SIGTERM',
    });

    await expect(createCodexBinaryPin(binary, { readVersion: async () => { throw error; } })).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-version-check-signaled',
        agentId: 'codex',
        agentName: 'Codex CLI',
        command: 'codex',
        binaryPath: binary,
        args: ['--version'],
        exitCode: null,
        signal: 'SIGTERM',
      },
    });
    await expect(createCodexBinaryPin(binary)).rejects.toBeInstanceOf(AgentPreflightError);
  });
});

async function writeBinary(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-binary-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return writeVersionExecutable(dir, 'codex', label);
}

async function writeRawBinary(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-binary-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'codex');
  await writeFile(binary, content, { mode: 0o755 });
  return binary;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
