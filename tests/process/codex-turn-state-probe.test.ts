import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexTurnStateProbe } from '../../src/agent/codex/turn-state-probe.js';

describe('Codex app-server turn state probe', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reads the latest persisted turn through thread/read', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const probe = createCodexTurnStateProbe({
      binary: fake.path,
      profileStateDir: fake.dir,
      timeoutMs: 3000,
    });

    await expect(probe('thread-1')).resolves.toEqual({
      id: 'turn-current',
      status: 'completed',
      finalText: 'persisted final answer',
    });
    const requests = JSON.parse(await readFile(fake.recordPath, 'utf8')) as Array<{
      method: string;
      params?: unknown;
    }>;
    expect(requests).toMatchObject([
      { method: 'initialize' },
      { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } },
    ]);
  });
});

async function createFakeAppServer(): Promise<{
  dir: string;
  path: string;
  recordPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-turn-probe-test-'));
  const path = join(dir, 'codex');
  const recordPath = join(dir, 'requests.json');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const requests = [];
const persist = () => writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(requests));
process.on('SIGTERM', () => { persist(); process.exit(0); });
process.on('exit', persist);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  requests.push({ method: request.method, params: request.params });
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
  }
  if (request.method === 'thread/read') {
    process.stdout.write(JSON.stringify({
      id: request.id,
      result: {
        thread: {
          turns: [
            { id: 'turn-before', status: 'completed' },
            {
              id: 'turn-current',
              status: 'completed',
              items: [
                { type: 'agentMessage', text: 'interim note', phase: 'commentary' },
                { type: 'agentMessage', text: 'superseded final answer', phase: 'final_answer' },
                { type: 'agentMessage', text: 'persisted final answer', phase: 'final_answer' }
              ]
            }
          ]
        }
      }
    }) + '\\n');
  }
});
`,
    'utf8',
  );
  await chmod(path, 0o755);
  return { dir, path, recordPath };
}
