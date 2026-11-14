import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';

/** Coalesce independent legacy-profile helpers at the service action boundary. */
export async function withSupervisorRestartLock<T>(rootDir: string, action: () => Promise<T>): Promise<T> {
  const dir = join(rootDir, 'restart-coordinator');
  await mkdir(dir, { recursive: true });
  const target = join(dir, 'supervisor');
  await writeFile(target, '', { flag: 'a', mode: 0o600 });
  const release = await lockfile.lock(target, {
    realpath: false, stale: 30_000, update: 10_000,
    retries: { retries: 180, factor: 1, minTimeout: 500, maxTimeout: 500 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}
