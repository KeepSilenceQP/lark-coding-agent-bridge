import type { RuntimeControls } from './access';
import { log } from '../core/logger';
import type { ProfileConfig } from '../config/profile-schema';
import {
  loadRootConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../config/profile-store';

export interface AppInfoSource {
  getAppInfo(opts?: {
    lang?: 'zh_cn' | 'en_us' | 'ja_jp';
    userIdType?: 'open_id' | 'user_id' | 'union_id';
  }): Promise<{ ownerId?: string }>;
}

export async function refreshOwnerControls(
  controls: RuntimeControls,
  source: AppInfoSource,
  appId: string,
): Promise<string | undefined> {
  try {
    const ownerId = await fetchOwnerId(source);
    controls.botOwnerId = ownerId;
    controls.ownerRefreshState = 'ok';
    controls.ownerRefreshedAt = Date.now();
    delete controls.ownerRefreshError;
    return ownerId;
  } catch (err) {
    // A persisted owner is stable configuration. A transient API failure must
    // not revoke its access; only fail closed when no owner has ever been
    // resolved for this app.
    controls.ownerRefreshState = controls.botOwnerId ? 'ok' : 'failed';
    controls.ownerRefreshError = err instanceof Error ? err.message : String(err);
    log.warn('access', 'owner_refresh_failed', {
      appId,
      error: controls.ownerRefreshError,
    });
    return undefined;
  }
}

export function configuredOwnerId(
  profile: Pick<ProfileConfig, 'access'>,
  appId: string,
): string | undefined {
  const owner = profile.access.owner;
  return owner?.appId === appId ? owner.openId : undefined;
}

export async function persistOwnerIdentity(opts: {
  configPath: string;
  profile: string;
  appId: string;
  openId: string;
}): Promise<boolean> {
  return withConfigFileLock(opts.configPath, async () => {
    const root = await loadRootConfig(opts.configPath);
    if (!root) throw new Error(`RootConfig not found or invalid: ${opts.configPath}`);
    const profile = root.profiles[opts.profile];
    if (!profile) throw new Error(`profile not found: ${opts.profile}`);

    // Credentials may have changed while the API request was in flight. Never
    // attach an old application's owner to the new application.
    if (profile.accounts.app.id !== opts.appId) return false;
    if (
      profile.access.owner?.appId === opts.appId &&
      profile.access.owner.openId === opts.openId
    ) {
      return true;
    }
    profile.access.owner = { appId: opts.appId, openId: opts.openId };
    await saveRootConfig(root, opts.configPath);
    return true;
  });
}

async function fetchOwnerId(source: AppInfoSource): Promise<string> {
  const { ownerId } = await source.getAppInfo({
    lang: 'zh_cn',
    userIdType: 'open_id',
  });
  if (!ownerId) throw new Error('application owner missing from API response');
  return ownerId;
}
