import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import { buildCodexArgs } from '../../src/agent/codex/argv.js';
import { buildBridgeSystemPrompt } from '../../src/agent/bridge-system-prompt.js';
import { log } from '../../src/core/logger.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('CodexAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldCodexHome = process.env.CODEX_HOME;
  const oldAppSecret = process.env.APP_SECRET;

  afterEach(async () => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    if (oldAppSecret === undefined) {
      delete process.env.APP_SECRET;
    } else {
      process.env.APP_SECRET = oldAppSecret;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh JSON run with prompt on stdin and inherits the user Codex home by default', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    process.env.APP_SECRET = 'inherited-secret';
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-fresh' },
        { type: 'agent_message', message: 'hello user' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-fresh' },
      { type: 'text', delta: 'hello user' },
      { type: 'done', threadId: 'thread-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(
      buildCodexArgs({
        cwd,
        sandbox: 'read-only',
        developerInstructions: buildBridgeSystemPrompt(undefined),
      }),
    );
    expect(record.argv).not.toContain('--ignore-user-config');
    expect(record.argv).toContain('--skip-git-repo-check');
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toBe('hello from lark');
    const developerInstructions = readDeveloperInstructions(record.argv);
    expect(developerInstructions).toBe(buildBridgeSystemPrompt(undefined));
    expect(developerInstructions).toContain('__bridge_cb');
    expect(developerInstructions).toContain('lark-cli auth login');
    expect(developerInstructions).toContain('LARK_CHANNEL_PROFILE');
    expect(developerInstructions).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(developerInstructions).not.toContain('lark-cli config bind --source lark-channel');
    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      CODEX_HOME: '/outer/codex-home',
    });
    expect(record.env.APP_SECRET).toBe('inherited-secret');
  });

  it('injects the active bridge profile env while preserving Codex env overrides', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'codex-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'codex-dev', 'lark-cli-source', 'config.json');

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      larkChannel: {
        profile: 'codex-dev',
        rootDir,
        configPath,
        larkCliConfigDir,
        larkCliSourceConfigFile,
      },
    }).run({
      runId: 'run-profile-env',
      prompt: 'profile',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
      CODEX_HOME: '/outer/codex-home',
    });
  });

  it('leaves CODEX_HOME unset by default so Codex can use the user login under ~/.codex', async () => {
    delete process.env.CODEX_HOME;
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({
      runId: 'run-default-home',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBeUndefined();
  });

  it('passes image paths and resume thread through the Codex argv contract', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(fake.dir, 'image.png');

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'workspace-write',
    }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      threadId: 'thread-old',
      images: [image],
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildCodexArgs({
        cwd,
        sandbox: 'workspace-write',
        threadId: 'thread-old',
        images: [image],
        developerInstructions: buildBridgeSystemPrompt(undefined),
      }),
    );
    expect(record.stdin).toBe('continue');
    expect(readDeveloperInstructions(record.argv)).toBe(buildBridgeSystemPrompt(undefined));
  });

  it('lets per-run policy sandbox override the adapter default', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'danger-full-access',
    }).run({
      runId: 'run-policy-sandbox',
      prompt: 'policy sandbox',
      cwd,
      sandbox: 'read-only',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildCodexArgs({
        cwd,
        sandbox: 'read-only',
        developerInstructions: buildBridgeSystemPrompt(undefined),
      }),
    );
  });

  it('honors a profile-configured Codex home', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const codexHome = join(fake.dir, 'custom-codex-home');

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      codexHome,
    }).run({
      runId: 'run-home',
      prompt: 'home',
      cwd,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBe(codexHome);
  });

  it('uses a profile-local Codex home only when inheritance is explicitly disabled', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: false,
    }).run({
      runId: 'run-profile-local-home',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBe(join(fake.dir, 'codex-home'));
  });

  it('passes configured Codex ignore flags through the argv builder', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreUserConfig: false,
      ignoreRules: false,
    }).run({
      runId: 'run-flags',
      prompt: 'flags',
      cwd,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).not.toContain('--ignore-user-config');
    expect(record.argv).not.toContain('--ignore-rules');
  });

  it('can explicitly isolate Codex from the user config', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreUserConfig: true,
    }).run({
      runId: 'run-ignore-user-config',
      prompt: 'flags',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--ignore-user-config');
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'agent_message', message: 'before failure' }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'codex exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('redacts dynamic and developer prompt bodies from stderr logs and error events', async () => {
    const dynamicPrompt = 'dynamic-prompt-secret-7c66';
    const developerInstructions = buildBridgeSystemPrompt(undefined);
    const developerArg = `developer_instructions=${JSON.stringify(developerInstructions)}`;
    const fake = await createFakeCodex({
      lines: [],
      stderr: `${dynamicPrompt}\n${developerArg}\n`,
      exitCode: 42,
    });
    cleanup.push(fake.dir);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-redacted-fail',
      prompt: dynamicPrompt,
      cwd: await realpath(fake.dir),
    });

    const events = await collect(run.events);
    expect(JSON.stringify(events)).not.toContain(dynamicPrompt);
    expect(JSON.stringify(events)).not.toContain(developerInstructions);
    expect(JSON.stringify(events)).not.toContain(developerArg);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(dynamicPrompt);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(developerInstructions);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(developerArg);
    expect(JSON.stringify(events)).toContain('[REDACTED_PROMPT]');
    warn.mockRestore();
  });

  it('continues after retryable raw error events and waits for the terminal turn event', async () => {
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-retry' },
        {
          type: 'error',
          error: { message: 'Reconnecting... 2/5 (timeout waiting for child process to exit)' },
        },
        { type: 'agent_message', message: 'after retry' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-retry',
      prompt: 'retry',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-retry' },
      { type: 'text', delta: 'after retry' },
      { type: 'done', threadId: 'thread-retry', terminationReason: 'normal' },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<CodexAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakeCodex({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
      });
      cleanup.push(fake.dir);
      run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: await realpath(fake.dir),
      });
    } else {
      const missing = join(tmpdir(), `missing-codex-${Date.now()}`);
      run = new CodexAdapter({ binary: missing, profileStateDir: tmpdir() }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn codex|spawn returned no pid|codex exited with code/,
    );
  });

  it('reports interrupted termination when stopped before a Codex terminal event', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'thread.started', thread_id: 'thread-stop' }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
    }).run({
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', threadId: 'thread-stop' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', threadId: 'thread-stop', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('logs stdout idle while the Codex child stays alive without new lines', async () => {
    const fake = await createFakeCodex({
      lines: [],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
      stdoutIdleProbeMs: 20,
    }).run({
      runId: 'run-stdout-idle',
      prompt: 'idle',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();
    const next = iterator.next();

    await waitFor(() =>
      warn.mock.calls.some(
        (call) =>
          call[0] === 'agent' &&
          call[1] === 'stdout-idle' &&
          (call[2] as { childExitCode?: unknown; childSignalCode?: unknown } | undefined)
            ?.childExitCode === null &&
          (call[2] as { childExitCode?: unknown; childSignalCode?: unknown } | undefined)
            ?.childSignalCode === null,
      ),
    );

    await run.stop();
    expect(await next).toEqual({
      done: false,
      value: { type: 'done', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('finishes a resumed run when Codex persists a new completed turn but stdout loses its terminal event', async () => {
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-terminal-probe' },
        { type: 'agent_message', message: 'final answer already persisted' },
      ],
      exitDelayMs: 200,
    });
    cleanup.push(fake.dir);
    const turnStateProbe = vi
      .fn()
      .mockResolvedValueOnce({ id: 'turn-before-run', status: 'completed' })
      .mockResolvedValueOnce({
        id: 'turn-current',
        status: 'completed',
        finalText: 'persisted final answer',
      });
    const adapter = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
      stdoutIdleProbeMs: 20,
      turnStateProbe,
    } as ConstructorParameters<typeof CodexAdapter>[0]);
    const options = {
      runId: 'run-terminal-probe',
      prompt: 'resume after a lost terminal event',
      cwd: await realpath(fake.dir),
      threadId: 'thread-terminal-probe',
    };

    await adapter.prepareRun(options);
    const run = adapter.run(options);

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-terminal-probe' },
      { type: 'text', delta: 'final answer already persisted' },
      { type: 'text', delta: 'persisted final answer' },
      { type: 'done', threadId: 'thread-terminal-probe', terminationReason: 'normal' },
    ]);
    await run.stop();
    expect(turnStateProbe).toHaveBeenCalledTimes(2);
  });

  it('does not finish a resumed run from the pre-run baseline turn or an in-progress turn', async () => {
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-still-running' },
        { type: 'agent_message', message: 'work is still continuing' },
      ],
      exitDelayMs: 180,
    });
    cleanup.push(fake.dir);
    const turnStateProbe = vi
      .fn()
      .mockResolvedValueOnce({ id: 'turn-before-run', status: 'completed' })
      .mockResolvedValueOnce({ id: 'turn-before-run', status: 'completed' })
      .mockResolvedValue({ id: 'turn-current', status: 'inProgress' });
    const adapter = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stdoutIdleProbeMs: 20,
      turnStateProbe,
    } as ConstructorParameters<typeof CodexAdapter>[0]);
    const options = {
      runId: 'run-still-running',
      prompt: 'keep working',
      cwd: await realpath(fake.dir),
      threadId: 'thread-still-running',
    };

    await adapter.prepareRun(options);
    const run = adapter.run(options);
    const events = await collect(run.events);

    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'codex stream ended before a terminal event',
      terminationReason: 'failed',
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'done', terminationReason: 'normal' }),
    );
  });

  it('does not synthesize a terminal event from a persisted interrupted turn', async () => {
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-persisted-interrupted' },
        { type: 'agent_message', message: 'work had started' },
      ],
      exitDelayMs: 180,
    });
    cleanup.push(fake.dir);
    const turnStateProbe = vi
      .fn()
      .mockResolvedValueOnce({ id: 'turn-before-run', status: 'completed', itemCount: 1 })
      .mockResolvedValue({ id: 'turn-current', status: 'interrupted', itemCount: 2 });
    const adapter = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stdoutIdleProbeMs: 20,
      turnStateProbe,
    } as ConstructorParameters<typeof CodexAdapter>[0]);
    const options = {
      runId: 'run-persisted-interrupted',
      prompt: 'keep working despite a stale interrupted status',
      cwd: await realpath(fake.dir),
      threadId: 'thread-persisted-interrupted',
    };

    await adapter.prepareRun(options);
    const events = await collect(adapter.run(options).events);

    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'codex stream ended before a terminal event',
      terminationReason: 'failed',
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'done', terminationReason: 'interrupted' }),
    );
  });

  it('does not probe persisted terminal state while a Codex tool is still in flight', async () => {
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-long-tool' },
        {
          type: 'item.started',
          item: {
            id: 'tool-long',
            type: 'command_execution',
            command: './gradlew compile',
          },
        },
      ],
      exitDelayMs: 180,
    });
    cleanup.push(fake.dir);
    const turnStateProbe = vi
      .fn()
      .mockResolvedValueOnce({ id: 'turn-before-run', status: 'completed', itemCount: 1 })
      .mockResolvedValue({
        id: 'turn-current',
        status: 'completed',
        itemCount: 3,
        finalText: 'must not be recovered while the tool is running',
      });
    const adapter = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stdoutIdleProbeMs: 20,
      turnStateProbe,
    } as ConstructorParameters<typeof CodexAdapter>[0]);
    const options = {
      runId: 'run-long-tool',
      prompt: 'run a long build',
      cwd: await realpath(fake.dir),
      threadId: 'thread-long-tool',
    };

    await adapter.prepareRun(options);
    const events = await collect(adapter.run(options).events);

    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use', id: 'tool-long' }));
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'text', delta: 'must not be recovered while the tool is running' }),
    );
    expect(turnStateProbe).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a persisted final answer that stdout already delivered', async () => {
    const finalText = 'the complete answer';
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-final-dedup' },
        { type: 'agent_message', message: finalText },
      ],
      exitDelayMs: 200,
    });
    cleanup.push(fake.dir);
    const turnStateProbe = vi
      .fn()
      .mockResolvedValueOnce({ id: 'turn-before-run', status: 'completed' })
      .mockResolvedValueOnce({
        id: 'turn-current',
        status: 'completed',
        finalText,
      });
    const adapter = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
      stdoutIdleProbeMs: 20,
      turnStateProbe,
    } as ConstructorParameters<typeof CodexAdapter>[0]);
    const options = {
      runId: 'run-final-dedup',
      prompt: 'resume after a lost terminal event',
      cwd: await realpath(fake.dir),
      threadId: 'thread-final-dedup',
    };

    await adapter.prepareRun(options);
    const run = adapter.run(options);

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-final-dedup' },
      { type: 'text', delta: finalText },
      { type: 'done', threadId: 'thread-final-dedup', terminationReason: 'normal' },
    ]);
    await run.stop();
  });

  it('allows one replay only when the stopped Codex turn is new, terminal, and has zero items', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'thread.started', thread_id: 'thread-empty-turn' }],
      exitDelayMs: 500,
    });
    cleanup.push(fake.dir);
    const turnStateProbe = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'turn-before-run',
        status: 'completed',
        itemCount: 1,
      })
      .mockResolvedValueOnce({
        id: 'turn-empty-interrupted',
        status: 'interrupted',
        itemCount: 0,
      });
    const adapter = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
      turnStateProbe,
    } as ConstructorParameters<typeof CodexAdapter>[0]);
    const options = {
      runId: 'run-empty-turn',
      prompt: 'retry this prompt',
      cwd: await realpath(fake.dir),
      threadId: 'thread-empty-turn',
    };

    await adapter.prepareRun(options);
    const run = adapter.run(options);
    await run.stop();

    await expect(run.canRetryAfterNoOutput?.()).resolves.toBe(true);
  });

  it('fails closed when the interrupted Codex turn contains any persisted item', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'thread.started', thread_id: 'thread-with-item' }],
      exitDelayMs: 500,
    });
    cleanup.push(fake.dir);
    const turnStateProbe = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'turn-before-run',
        status: 'completed',
        itemCount: 1,
      })
      .mockResolvedValueOnce({
        id: 'turn-with-user-message',
        status: 'interrupted',
        itemCount: 1,
      });
    const adapter = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
      turnStateProbe,
    } as ConstructorParameters<typeof CodexAdapter>[0]);
    const options = {
      runId: 'run-with-item',
      prompt: 'must not replay',
      cwd: await realpath(fake.dir),
      threadId: 'thread-with-item',
    };

    await adapter.prepareRun(options);
    const run = adapter.run(options);
    await run.stop();

    await expect(run.canRetryAfterNoOutput?.()).resolves.toBe(false);
  });

  it('fails closed while the latest Codex turn is still in progress even with zero items', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'thread.started', thread_id: 'thread-in-progress' }],
      exitDelayMs: 500,
    });
    cleanup.push(fake.dir);
    const turnStateProbe = vi
      .fn()
      .mockResolvedValueOnce({ id: 'turn-before-run', status: 'completed', itemCount: 1 })
      .mockResolvedValueOnce({ id: 'turn-in-progress', status: 'inProgress', itemCount: 0 });
    const adapter = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
      turnStateProbe,
    } as ConstructorParameters<typeof CodexAdapter>[0]);
    const options = {
      runId: 'run-in-progress',
      prompt: 'must not overlap',
      cwd: await realpath(fake.dir),
      threadId: 'thread-in-progress',
    };

    await adapter.prepareRun(options);
    const run = adapter.run(options);
    await run.stop();

    await expect(run.canRetryAfterNoOutput?.()).resolves.toBe(false);
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new CodexAdapter({ binary: 'unused', profileStateDir: tmpdir() }).run({
        runId: 'run-no-cwd',
        prompt: 'hi',
      }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function readDeveloperInstructions(argv: string[]): string {
  const override = argv.find((arg) => arg.startsWith('developer_instructions='));
  if (!override) throw new Error('missing developer_instructions override');
  return JSON.parse(override.slice('developer_instructions='.length)) as string;
}

async function createFakeCodex(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-adapter-test-'));
  const path = join(dir, 'fake-codex.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'const args = process.argv.slice(2);',
      'if (args[0] === "debug" && args[1] === "prompt-input") {',
      '  const configIndex = args.indexOf("-c");',
      '  const config = configIndex >= 0 ? args[configIndex + 1] : "";',
      '  const prefix = "developer_instructions=";',
      '  const developerText = JSON.parse(config.slice(prefix.length));',
      '  const userText = args.at(-1) ?? "";',
      '  console.log(JSON.stringify([',
      '    { role: "developer", content: [{ type: "input_text", text: developerText }] },',
      '    { role: "user", content: [{ type: "input_text", text: userText }] },',
      '  ]));',
      '  process.exit(0);',
      '}',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { stdin += chunk; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv: process.argv.slice(2),',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '      CODEX_HOME: process.env.CODEX_HOME,',
      '      APP_SECRET: process.env.APP_SECRET,',
      '      PATH: process.env.PATH,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '});',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  cwd: string;
  stdin: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
    CODEX_HOME?: string;
    APP_SECRET?: string;
    PATH?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    cwd: string;
    stdin: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
      CODEX_HOME?: string;
      APP_SECRET?: string;
      PATH?: string;
    };
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
