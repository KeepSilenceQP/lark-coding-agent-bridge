import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveSupervisorRestartProfiles, startSupervisorProfiles } from '../../../src/runtime/supervisor-resume';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'supervisor-resume-'));
  roots.push(rootDir);
  const path = join(rootDir, 'restart-coordinator', 'supervisor-resume.json');
  const startProfile = vi.fn(async (_profile: string) => {});
  const onError = vi.fn();
  return { rootDir, path, startProfile, onError, defaultProfile: 'codex' };
}

describe('supervisor fleet after a service restart', () => {
  it('restores the requesting non-default bot and all previously online bots exactly once', async () => {
    const h = await fixture();
    await saveSupervisorRestartProfiles(h.rootDir, 2147483000, ['trae-cli', 'codex', 'trae-cli']);
    await startSupervisorProfiles(h);
    expect(h.startProfile.mock.calls.map(([profile]) => profile)).toEqual(['trae-cli', 'codex']);
    expect(h.onError).not.toHaveBeenCalled();
    await expect(readFile(h.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('starts other bots after one fails and retains the snapshot for a startup retry', async () => {
    const h = await fixture();
    await saveSupervisorRestartProfiles(h.rootDir, 2147483000, ['trae-cli', 'codex']);
    h.startProfile.mockImplementation(async (profile) => { if (profile === 'trae-cli') throw new Error('fixture'); });
    await startSupervisorProfiles(h);
    expect(h.startProfile.mock.calls.map(([profile]) => profile)).toEqual(['trae-cli', 'codex']);
    expect(h.onError).toHaveBeenCalledWith('trae-cli', expect.any(Error));
    expect(JSON.parse(await readFile(h.path, 'utf8')).profiles).toEqual(['trae-cli', 'codex']);
  });

  it.each(['old process alive', 'expired', 'unsafe name', 'bad timestamp', 'future timestamp'])('ignores an invalid resume snapshot: %s', async (reason) => {
    const h = await fixture();
    await saveSupervisorRestartProfiles(h.rootDir, reason === 'old process alive' ? process.pid : 2147483000, ['trae-cli']);
    const state = JSON.parse(await readFile(h.path, 'utf8'));
    if (reason === 'expired') state.createdAt = new Date(Date.now() - 11 * 60_000).toISOString();
    if (reason === 'unsafe name') state.profiles = ['../other'];
    if (reason === 'bad timestamp') state.createdAt = 'invalid';
    if (reason === 'future timestamp') state.createdAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(h.path, JSON.stringify(state));
    await startSupervisorProfiles(h);
    expect(h.startProfile.mock.calls.map(([profile]) => profile)).toEqual(['codex']);
  });
});
