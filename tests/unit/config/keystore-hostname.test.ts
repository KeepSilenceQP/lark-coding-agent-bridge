import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockHostname = vi.hoisted(() => vi.fn(() => 'host-a'));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    hostname: mockHostname,
    userInfo: vi.fn(() => ({
      uid: 501,
      gid: 20,
      username: 'penn',
      homedir: '/Users/penn',
      shell: '/bin/zsh',
    })),
  };
});

import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  clearKeystoreDerivedKeyCache,
  getSecret,
  setSecret,
} from '../../../src/config/keystore';

const roots: string[] = [];

afterEach(async () => {
  mockHostname.mockReturnValue('host-a');
  clearKeystoreDerivedKeyCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('keystore host portability', () => {
  it('keeps a newly stored secret readable after the hostname changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-keystore-hostname-'));
    roots.push(root);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });

    mockHostname.mockReturnValue('host-a');
    await setSecret('app-cli_test', 'test-secret', appPaths);

    clearKeystoreDerivedKeyCache();
    mockHostname.mockReturnValue('host-b');

    await expect(getSecret('app-cli_test', appPaths)).resolves.toBe('test-secret');
  });

  it('migrates a readable hostname-bound v1 store before the hostname changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-keystore-legacy-'));
    roots.push(root);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await writeLegacyStore(appPaths.profileDir, 'app-cli_legacy', 'legacy-secret', 'host-a|penn');

    mockHostname.mockReturnValue('host-a');
    await expect(getSecret('app-cli_legacy', appPaths)).resolves.toBe('legacy-secret');

    const migrated = JSON.parse(await readFile(appPaths.secretsFile, 'utf8')) as { version: number };
    expect(migrated.version).toBe(2);

    clearKeystoreDerivedKeyCache();
    mockHostname.mockReturnValue('host-b');
    await expect(getSecret('app-cli_legacy', appPaths)).resolves.toBe('legacy-secret');
  });

  it('leaves an unreadable v1 store untouched and reports hostname drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-keystore-unreadable-'));
    roots.push(root);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    await writeLegacyStore(appPaths.profileDir, 'app-cli_legacy', 'legacy-secret', 'host-a|penn');
    const before = await readFile(appPaths.secretsFile, 'utf8');

    mockHostname.mockReturnValue('host-b');
    await expect(getSecret('app-cli_legacy', appPaths)).rejects.toThrow(
      /legacy keystore.*hostname/i,
    );

    await expect(readFile(appPaths.secretsFile, 'utf8')).resolves.toBe(before);
  });
});

async function writeLegacyStore(
  profileDir: string,
  id: string,
  plaintext: string,
  seed: string,
): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  const salt = randomBytes(32);
  const key = pbkdf2Sync(seed, salt, 100_000, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const store = {
    version: 1,
    entries: {
      [id]: {
        iv: iv.toString('base64'),
        data: data.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      },
    },
  };
  await writeFile(join(profileDir, '.keystore.salt'), salt, { mode: 0o600 });
  await writeFile(join(profileDir, 'secrets.enc'), `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
}
