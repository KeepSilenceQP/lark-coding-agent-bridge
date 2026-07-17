import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBridgeSystemPrompt } from '../../../src/agent/bridge-system-prompt';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { processAgentStream } from '../../../src/bot/channel';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Codex startup retry prompt contract', () => {
  it('replays the same dynamic stdin and developer instructions through the real timeout recovery path', async () => {
    const fake = await writeRetryingCodex();
    const turnStateProbe = vi
      .fn()
      .mockResolvedValueOnce({ id: 'turn-before', status: 'completed', itemCount: 1 })
      .mockResolvedValue({
        id: 'turn-empty-interrupted',
        status: 'interrupted',
        itemCount: 0,
      });
    const adapter = new CodexAdapter({
      binary: fake.binary,
      profileStateDir: fake.dir,
      turnStateProbe,
      stdoutIdleProbeMs: 20,
    });
    const executor = new RunExecutor({
      agent: adapter,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: (() => {
        let next = 0;
        return () => `run-${++next}`;
      })(),
      postDoneExitGraceMs: 100,
    });
    const input = {
      scopeId: 'scope-retry',
      policy: policy(fake.dir),
      threadId: 'thread-retry',
    };
    let execution = await executor.submit(input);

    const state = await processAgentStream(
      execution.handle,
      execution.subscribe(),
      input.scopeId,
      undefined,
      150,
      () => {},
      async () => {},
      async () => {
        await execution.stop();
        if (!(await execution.run.canRetryAfterNoOutput?.())) return undefined;
        execution = await executor.submit(input);
        return { handle: execution.handle, events: execution.subscribe() };
      },
    );

    expect(state.terminal).toBe('done');
    const records = (await readFile(fake.recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; stdin: string });
    const execs = records.filter(({ argv }) => argv[0] === 'exec');
    expect(execs).toHaveLength(2);
    expect(execs.map(({ stdin }) => stdin)).toEqual(['dynamic envelope', 'dynamic envelope']);
    expect(execs.map(({ argv }) => readDeveloperInstructions(argv))).toEqual([
      buildBridgeSystemPrompt(undefined),
      buildBridgeSystemPrompt(undefined),
    ]);
  }, 10_000);
});

function policy(cwd: string): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'dynamic envelope',
    requestedCwd: cwd,
    cwdRealpath: cwd,
    accessMode: 'read-only',
    sandbox: 'read-only',
    permissionMode: 'plan',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: Date.now() + 60_000,
  };
}

function readDeveloperInstructions(argv: string[]): string {
  const override = argv.find((arg) => arg.startsWith('developer_instructions='));
  if (!override) throw new Error('missing developer_instructions override');
  return JSON.parse(override.slice('developer_instructions='.length)) as string;
}

async function writeRetryingCodex(): Promise<{
  dir: string;
  binary: string;
  recordPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-startup-retry-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'codex');
  const recordPath = join(dir, 'invocations.jsonl');
  const countPath = join(dir, 'exec-count');
  const script = `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex 1.2.3');
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'prompt-input') {
  const config = args[args.indexOf('-c') + 1] ?? '';
  const developerText = JSON.parse(config.slice('developer_instructions='.length));
  const userText = args.at(-1) ?? '';
  console.log(JSON.stringify([
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: developerText }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] },
  ]));
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: args, stdin }) + '\\n');
  const count = existsSync(${JSON.stringify(countPath)})
    ? Number(readFileSync(${JSON.stringify(countPath)}, 'utf8')) + 1
    : 1;
  writeFileSync(${JSON.stringify(countPath)}, String(count));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-retry' }));
  if (count === 1) {
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  } else {
    console.log(JSON.stringify({ type: 'agent_message', message: 'recovered' }));
    console.log(JSON.stringify({ type: 'turn.completed' }));
    process.exit(0);
  }
});
`;
  await writeFile(binary, script, { mode: 0o755 });
  await chmod(binary, 0o755);
  return { dir, binary, recordPath };
}
