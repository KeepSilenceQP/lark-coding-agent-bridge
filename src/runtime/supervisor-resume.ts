import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { writeFileAtomic } from '../platform/atomic-write';
import { isAlive } from './registry';

interface RestartProfiles {
  oldPid: number;
  profiles: string[];
  createdAt: string;
}

const resumePath = (rootDir: string) => join(rootDir, 'restart-coordinator', 'supervisor-resume.json');

/** Snapshot online profiles without changing the user's default profile. */
export async function saveSupervisorRestartProfiles(rootDir: string, oldPid: number, profiles: string[]): Promise<void> {
  const state: RestartProfiles = { oldPid, profiles: [...new Set(profiles)], createdAt: new Date().toISOString() };
  await writeFileAtomic(resumePath(rootDir), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

/** Restore the pre-restart fleet; retain the snapshot if any profile fails. */
export async function startSupervisorProfiles(options: {
  rootDir: string;
  defaultProfile: string;
  startProfile(profile: string): Promise<void>;
  onError(profile: string, error: unknown): void;
}): Promise<void> {
  const { rootDir, defaultProfile, startProfile, onError } = options;
  let state: RestartProfiles | undefined;
  try {
    const parsed = JSON.parse(await readFile(resumePath(rootDir), 'utf8')) as RestartProfiles;
    if (Number.isSafeInteger(parsed.oldPid) && parsed.oldPid > 0 &&
        Array.isArray(parsed.profiles) && parsed.profiles.length > 0 &&
        parsed.profiles.every((profile) => typeof profile === 'string' &&
          resolveAppPaths({ rootDir, profile }).profile === profile) &&
        Date.now() - Date.parse(parsed.createdAt) >= 0 &&
        Date.now() - Date.parse(parsed.createdAt) < 10 * 60_000 && !isAlive(parsed.oldPid)) {
      state = parsed;
    }
  } catch { /* No valid resume snapshot: normal default-profile startup. */ }
  const profiles = [...new Set([...(state?.profiles ?? []), defaultProfile])];
  let complete = true;
  for (const profile of profiles) {
    try {
      await startProfile(profile);
    } catch (error) {
      complete = false;
      onError(profile, error);
    }
  }
  if (state && complete) await rm(resumePath(rootDir), { force: true });
}
