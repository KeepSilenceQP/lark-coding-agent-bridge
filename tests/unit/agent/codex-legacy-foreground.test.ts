import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readLegacyForegroundMetadata } from '../../../src/agent/codex/legacy-foreground';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(options: { background?: unknown; turn?: string; headerId?: string; returned?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-foreground-metadata-'));
  dirs.push(dir);
  const path = join(dir, 'rollout-fixture-parent.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id: options.headerId ?? 'parent' } },
    { type: 'history_mutation', payload: { version: 1, operation: 'append', turn_id: options.turn ?? 'current',
      items: [{ type: 'function_call', name: 'Agent', call_id: 'call', arguments: 'private-test-prompt' }] } },
    { type: 'event_msg', payload: { type: 'collab_agent_spawn_end', sender_thread_id: 'parent',
      call_id: 'call', new_thread_id: 'child', run_in_background: options.background ?? false, status: 'pending_init' } },
    ...(options.returned ? [{ type: 'history_mutation', payload: { turn_id: 'current',
      items: [{ type: 'function_call_output', call_id: 'call', output: 'private-test-output' }] } }] : []),
  ];
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, path };
}

describe('bounded legacy foreground metadata', () => {
  it('uses an explicit foreground spawn in the current parent turn without retaining content', async () => {
    const { path } = await fixture();
    const state = await readLegacyForegroundMetadata(path, 'parent', 'current', ['child']);
    expect(state).toEqual({ childThreadIds: ['child'], completedCallIds: [], reason: 'verified' });
    expect(JSON.stringify(state)).not.toContain('private-test-');
  });

  it.each(['background', 'unknown-flag', 'different-turn', 'unrelated-child', 'identity'])(
    'does not trust %s', async (kind) => {
      const { path } = await fixture({ background: kind === 'background' ? true : kind === 'unknown-flag' ? 'false' : false,
        turn: kind === 'different-turn' ? 'previous' : 'current', headerId: kind === 'identity' ? 'other' : 'parent' });
      const state = await readLegacyForegroundMetadata(path, 'parent', 'current', kind === 'unrelated-child' ? ['other'] : ['child']);
      expect(state.childThreadIds).toEqual([]);
    },
  );

  it('recognizes the matching returned result without reading its body into activity state', async () => {
    const { path } = await fixture({ returned: true });
    expect(await readLegacyForegroundMetadata(path, 'parent', 'current', ['child'])).toEqual({
      childThreadIds: [], completedCallIds: ['call'], reason: 'verified',
    });
  });

  it('accepts lifecycle metadata from a large call record within the bounded window', async () => {
    const { path } = await fixture();
    const { readFile } = await import('node:fs/promises');
    const text = (await readFile(path, 'utf8')).replace('private-test-prompt', 'x'.repeat(300 * 1024));
    await writeFile(path, text);
    expect((await readLegacyForegroundMetadata(path, 'parent', 'current', ['child'])).childThreadIds).toEqual(['child']);
  });

  it('rejects unrelated filenames and symlinked rollout paths', async () => {
    const { dir, path } = await fixture();
    expect((await readLegacyForegroundMetadata(join(dir, 'config.json'), 'parent', 'current', ['child'])).reason).toBe('untrusted-path');
    const link = join(dir, 'rollout-symlink-parent.jsonl');
    await symlink(path, link);
    expect((await readLegacyForegroundMetadata(link, 'parent', 'current', ['child'])).childThreadIds).toEqual([]);
  });

  it('does not scan an older spawn beyond the bounded tail window', async () => {
    const { path } = await fixture();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, ' '.repeat(2 * 1024 * 1024 + 1) + '\n');
    expect((await readLegacyForegroundMetadata(path, 'parent', 'current', ['child'])).childThreadIds).toEqual([]);
  });
});
