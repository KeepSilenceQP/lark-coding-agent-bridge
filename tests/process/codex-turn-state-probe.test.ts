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
      itemCount: 3,
    });
    const requests = (await readFile(fake.recordPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        method: string;
        params?: unknown;
      });
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
import { appendFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(
    ${JSON.stringify(recordPath)},
    JSON.stringify({ method: request.method, params: request.params }) + '\\n',
  );
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
