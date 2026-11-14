import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import type { AgentEvent, AgentRun } from '../../src/agent/types';
import { processAgentStream } from '../../src/bot/channel';

// Wire shapes follow codex-rs/exec/src/exec_events.rs at rust-v0.165.0.
// This is a subprocess contract replay, not a live model/Feishu test.
describe('Codex stdout through the bridge idle watchdog', () => {
  it.each(['collab_tool_call', 'mcp_tool_call'])(
    'waits for a real subprocess %s result beyond the ordinary idle interval', async (type) => {
      const dir = await mkdtemp(join(tmpdir(), 'bridge-tool-watchdog-'));
      let run: AgentRun | undefined;
      try {
        const binary = join(dir, 'fake-codex.mjs');
        const item = type === 'collab_tool_call'
          ? {
              id: 'foreground', type, tool: 'wait', sender_thread_id: 'parent',
              receiver_thread_ids: ['child'], prompt: null, agents_states: {},
            }
          : {
              id: 'foreground', type, server: 'test-server', tool: 'slow-read',
              arguments: {}, result: null, error: null,
            };
        await writeFile(binary, [
          '#!/usr/bin/env node',
          `const item = ${JSON.stringify(item)};`,
          'const emit = (event) => console.log(JSON.stringify(event));',
          'process.stdin.resume();',
          'process.stdin.on("end", () => {',
          '  emit({type: "item.started", item: {...item, status: "in_progress"}});',
          '  setTimeout(() => {',
          '    emit({type: "item.completed", item: {...item, status: "completed"}});',
          '    emit({type: "turn.completed"});',
          '  }, 600);',
          '});',
        ].join('\n'), 'utf8');
        await chmod(binary, 0o755);
        run = new CodexAdapter({ binary, profileStateDir: dir, stdoutIdleProbeMs: 0 }).run({
          runId: `replay-${type}`, prompt: 'protocol replay', cwd: await realpath(dir),
        });
        const iterator = run.events[Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.value).toMatchObject({ type: 'tool_use', id: 'foreground' });
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          try {
            yield first.value!;
            for (;;) {
              const next = await iterator.next();
              if (next.done) break;
              yield next.value;
            }
          } finally {
            await iterator.return?.();
          }
        })();
        const stop = vi.spyOn(run, 'stop');
        const state = await processAgentStream(
          { run, interrupted: false }, events, `replay-${type}`,
          100, undefined, vi.fn(), vi.fn(async () => {}),
        );
        expect(state).toMatchObject({ terminal: 'done' });
        expect(state.blocks).toContainEqual(expect.objectContaining({
          kind: 'tool', tool: expect.objectContaining({ id: 'foreground', status: 'done' }),
        }));
        expect(stop).not.toHaveBeenCalled();
      } finally {
        await run?.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
