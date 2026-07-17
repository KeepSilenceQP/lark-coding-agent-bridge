import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import { DEFAULT_CODEX_PROMPT_INPUT_TIMEOUT_MS } from '../../../src/agent/codex/prompt-input-capability.js';
import {
  writeCodexPromptInputExecutable,
  writeVersionExecutable,
} from '../../helpers/fake-executable.js';

const cleanups: Array<() => Promise<void>> = [];

describe('CodexAdapter prepareRun', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('allows a 15 second default window for the local prompt inspector', () => {
    expect(DEFAULT_CODEX_PROMPT_INPUT_TIMEOUT_MS).toBe(15_000);
  });

  it('allows a run when the configured Codex binary returns a version without stored metadata', async () => {
    const binary = await writeCodexBinary('codex 1.2.3');
    const adapter = new CodexAdapter({
      binary,
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });

    await expect(adapter.prepareRun()).resolves.toBeUndefined();
  });

  it('reports a preflight diagnostic when the configured Codex binary is missing', async () => {
    const adapter = new CodexAdapter({
      binary: join(tmpdir(), 'missing-codex'),
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });

    await expect(adapter.prepareRun()).rejects.toMatchObject({
      code: 'agent-binary-not-found',
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'codex',
        agentName: 'Codex CLI',
      },
    });
  });

  it('proves developer and user role separation before the first run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-prompt-input-test-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const recordPath = join(dir, 'invocations.jsonl');
    const binary = await writeCodexPromptInputExecutable(
      dir,
      'codex',
      'codex 1.2.3',
      recordPath,
    );
    const adapter = new CodexAdapter({ binary, profileStateDir: dir });

    await adapter.prepareRun({
      runId: 'run-first-probe',
      prompt: 'hello',
      cwd: dir,
    });

    const invocations = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(invocations.some(({ args }) => args[0] === 'debug' && args[1] === 'prompt-input')).toBe(
      true,
    );
  });

  it('shares one successful capability probe for concurrent and sequential runs in the same context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-prompt-input-cache-test-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const recordPath = join(dir, 'invocations.jsonl');
    const binary = await writeCodexPromptInputExecutable(
      dir,
      'codex',
      'codex 1.2.3',
      recordPath,
    );
    const adapter = new CodexAdapter({ binary, profileStateDir: dir });
    const options = (runId: string) => ({ runId, prompt: 'hello', cwd: dir });

    await Promise.all([
      adapter.prepareRun(options('run-cache-1')),
      adapter.prepareRun(options('run-cache-2')),
    ]);
    await adapter.prepareRun(options('run-cache-3'));

    const invocations = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] });
    const probes = invocations.filter(
      ({ args }) => args[0] === 'debug' && args[1] === 'prompt-input',
    );
    expect(probes).toHaveLength(1);
  });

  it('fails closed with a stable diagnostic when prompt roles do not match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-prompt-input-role-test-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const binary = await writeCodexPromptInputExecutable(
      dir,
      'codex',
      'codex 1.2.3',
      join(dir, 'invocations.jsonl'),
      'wrong-role',
    );
    const adapter = new CodexAdapter({ binary, profileStateDir: dir });

    const options = (runId: string) => ({ runId, prompt: 'hello', cwd: dir });
    await expect(adapter.prepareRun(options('run-wrong-role-1'))).rejects.toMatchObject({
      code: 'codex-developer-instructions-unsupported',
    });
    await expect(adapter.prepareRun(options('run-wrong-role-2'))).rejects.toMatchObject({
      code: 'codex-developer-instructions-unsupported',
    });
    const invocations = (await readFile(join(dir, 'invocations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(
      invocations.filter(({ args }) => args[0] === 'debug' && args[1] === 'prompt-input'),
    ).toHaveLength(2);
    expect(invocations.some(({ args }) => args[0] === 'exec')).toBe(false);
  });

  it('terminates and rejects a capability probe that exceeds its timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-prompt-input-timeout-test-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const recordPath = join(dir, 'invocations.jsonl');
    const binary = await writeCodexPromptInputExecutable(
      dir,
      'codex',
      'codex 1.2.3',
      recordPath,
      'delayed-valid',
    );
    const adapter = new CodexAdapter({
      binary,
      profileStateDir: dir,
      promptCapabilityProbeTimeoutMs: 200,
    } as ConstructorParameters<typeof CodexAdapter>[0]);

    await expect(
      adapter.prepareRun({ runId: 'run-timeout', prompt: 'hello', cwd: dir }),
    ).rejects.toMatchObject({ code: 'codex-developer-instructions-unsupported' });
    const record = await readFile(recordPath, 'utf8');
    expect(record).toContain('SIGTERM');
  });

  it('probes a different resolved cwd independently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-prompt-input-cwd-test-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const cwdAPath = join(dir, 'a');
    const cwdBPath = join(dir, 'b');
    await Promise.all([mkdir(cwdAPath), mkdir(cwdBPath)]);
    const [cwdA, cwdB] = await Promise.all([realpath(cwdAPath), realpath(cwdBPath)]);
    const recordPath = join(dir, 'invocations.jsonl');
    const binary = await writeCodexPromptInputExecutable(
      dir,
      'codex',
      'codex 1.2.3',
      recordPath,
    );
    const adapter = new CodexAdapter({ binary, profileStateDir: dir });

    await adapter.prepareRun({ runId: 'run-cwd-a', prompt: 'a', cwd: cwdA });
    await adapter.prepareRun({ runId: 'run-cwd-b', prompt: 'b', cwd: cwdB });

    const invocations = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
    const probes = invocations.filter(
      ({ args }) => args[0] === 'debug' && args[1] === 'prompt-input',
    );
    expect(probes.map(({ cwd }) => cwd)).toEqual([cwdA, cwdB]);
  });

  it.each(['malformed', 'nonzero', 'duplicate'] as const)(
    'fails closed for %s prompt-input output',
    async (mode) => {
      const dir = await mkdtemp(join(tmpdir(), `codex-prompt-input-${mode}-test-`));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const binary = await writeCodexPromptInputExecutable(
        dir,
        'codex',
        'codex 1.2.3',
        join(dir, 'invocations.jsonl'),
        mode,
      );
      const adapter = new CodexAdapter({ binary, profileStateDir: dir });

      await expect(
        adapter.prepareRun({ runId: `run-${mode}`, prompt: 'hello', cwd: dir }),
      ).rejects.toMatchObject({ code: 'codex-developer-instructions-unsupported' });
    },
  );

  it.each([
    { mode: 'overflow' as const, maxOutputBytes: 128 },
    { mode: 'ignore-term' as const, maxOutputBytes: undefined },
  ])('terminates and reaps a $mode capability probe', async ({ mode, maxOutputBytes }) => {
    const dir = await mkdtemp(join(tmpdir(), `codex-prompt-input-${mode}-test-`));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const recordPath = join(dir, 'invocations.jsonl');
    const binary = await writeCodexPromptInputExecutable(
      dir,
      'codex',
      'codex 1.2.3',
      recordPath,
      mode,
    );
    const adapter = new CodexAdapter({
      binary,
      profileStateDir: dir,
      promptCapabilityProbeTimeoutMs: mode === 'ignore-term' ? 200 : 2000,
      promptCapabilityProbeMaxOutputBytes: maxOutputBytes,
      promptCapabilityProbeKillGraceMs: 25,
    });

    await expect(
      adapter.prepareRun({ runId: `run-${mode}`, prompt: 'hello', cwd: dir }),
    ).rejects.toMatchObject({ code: 'codex-developer-instructions-unsupported' });
    const record = await readFile(recordPath, 'utf8');
    expect(record).toContain('SIGTERM');
  });
});

async function writeCodexBinary(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-prepare-run-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return writeVersionExecutable(dir, 'codex', version);
}
