import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import { processAgentStream } from '../../src/bot/channel';

// Contract replay: completed exec spawn plus TraeX 0.213.1 thread/read fields.
// The incident's raw exec bytes were not retained; this is not a live-model test.
describe('foreground child activity after a completed spawn', () => {
  it.each([
    { progressing: true, resumed: false },
    { progressing: false, resumed: false },
    { progressing: true, resumed: true },
  ])('handles progress=$progressing resumed=$resumed', async ({ progressing, resumed }) => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-foreground-child-'));
    const binary = join(dir, 'fake-codex.mjs');
    const progressFile = join(dir, 'progress.json');
    await writeFile(progressFile, '0');
    await writeFile(binary, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const progressFile = ${JSON.stringify(progressFile)};
const emit = (value) => console.log(JSON.stringify(value));
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 0.165.0');
} else if (args[0] === 'debug' && args[1] === 'prompt-input') {
  emit([
    { role: 'developer', content: [{ type: 'input_text', text:
      JSON.parse(args[args.indexOf('-c') + 1].slice('developer_instructions='.length)) }] },
    { role: 'user', content: [{ type: 'input_text', text: args.at(-1) }] },
  ]);
} else if (args[0] === 'app-server') {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') emit({ id: request.id, result: {} });
    if (request.method !== 'thread/read') return;
    const count = Number(readFileSync(progressFile, 'utf8'));
    const parent = request.params.threadId === 'parent';
    const items = parent ? [{ type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent',
      status: 'completed', senderThreadId: 'parent', receiverThreadIds: ['child'],
      agentsStates: { child: { status: 'running' } }, runInBackground: false }]
      : Array.from({ length: count }, (_, i) => ({ type: 'commandExecution', id: 'cmd-' + i, status: 'completed' }));
    emit({ id: request.id, result: { thread: { id: parent ? 'parent' : 'child',
      parentThreadId: parent ? null : 'parent', turns: [{ id: parent ? (count ? 'parent-turn' : 'previous') : 'child-turn',
      status: count ? 'inProgress' : 'completed', items }] } } });
  });
} else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    let count = 1;
    writeFileSync(progressFile, String(count));
    emit({ type: 'thread.started', thread_id: 'parent' });
    const item = { id: 'spawn', type: 'collab_tool_call', tool: 'spawn_agent' };
    emit({ type: 'item.started', item: { ...item, status: 'in_progress' } });
    emit({ type: 'item.completed', item: { ...item, status: 'completed' } });
    const timer = setInterval(() => {
      if (${progressing}) writeFileSync(progressFile, String(++count));
    }, 100);
    setTimeout(() => { clearInterval(timer); emit({ type: 'turn.completed' }); }, 3200);
  });
}
`, 'utf8');
    await chmod(binary, 0o755);
    const adapter = new CodexAdapter({ binary, profileStateDir: dir, stdoutIdleProbeMs: 100 });
    const options = {
      runId: 'foreground-child', prompt: 'protocol replay', cwd: await realpath(dir),
      ...(resumed ? { threadId: 'parent' } : {}),
    };
    if (resumed) await adapter.prepareRun(options);
    const run = adapter.run(options);
    const stop = vi.spyOn(run, 'stop');
    try {
      const result = await processAgentStream(
        { run, interrupted: false }, run.events, 'foreground-child', 1000, undefined,
        vi.fn(), vi.fn(async () => {}),
      );
      expect(result.terminal).toBe(progressing ? 'done' : 'idle_timeout');
      if (progressing) expect(stop).not.toHaveBeenCalled();
      else expect(stop).toHaveBeenCalled();
    } finally {
      await run.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
