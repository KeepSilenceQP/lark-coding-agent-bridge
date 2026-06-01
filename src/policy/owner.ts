import type { RuntimeControls } from './access';
import { log } from '../core/logger';

export const OWNER_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export interface OwnerRawClient {
  application?: {
    v6?: {
      application?: {
        get(payload: {
          params: {
            lang: 'zh_cn' | 'en_us' | 'ja_jp';
            user_id_type: 'open_id';
          };
          path: {
            app_id: string;
          };
        }): Promise<{
          data?: {
            app?: {
              owner?: {
                owner_id?: string;
              };
            };
          };
        }>;
      };
    };
  };
}

export interface OwnerRefreshControllerOptions {
  controls: RuntimeControls;
  rawClient: OwnerRawClient;
  appId: string;
  intervalMs?: number;
}

export interface OwnerRefreshController {
  start(): Promise<void>;
  stop(): void;
}

export async function refreshOwnerControls(
  controls: RuntimeControls,
  rawClient: OwnerRawClient,
  appId: string,
): Promise<void> {
  try {
    const ownerId = await fetchOwnerId(rawClient, appId);
    controls.botOwnerId = ownerId;
    controls.ownerRefreshState = 'ok';
    controls.ownerRefreshedAt = Date.now();
    delete controls.ownerRefreshError;
  } catch (err) {
    controls.ownerRefreshState = 'failed';
    controls.ownerRefreshedAt = Date.now();
    controls.ownerRefreshError = err instanceof Error ? err.message : String(err);
    log.warn('access', 'owner_refresh_failed', {
      appId,
      error: controls.ownerRefreshError,
    });
  }
}

export function createOwnerRefreshController(
  opts: OwnerRefreshControllerOptions,
): OwnerRefreshController {
  let timer: ReturnType<typeof setInterval> | undefined;
  const intervalMs = opts.intervalMs ?? OWNER_REFRESH_INTERVAL_MS;

  return {
    async start(): Promise<void> {
      await refreshOwnerControls(opts.controls, opts.rawClient, opts.appId);
      timer = setInterval(() => {
        void refreshOwnerControls(opts.controls, opts.rawClient, opts.appId);
      }, intervalMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

async function fetchOwnerId(rawClient: OwnerRawClient, appId: string): Promise<string> {
  const get = rawClient.application?.v6?.application?.get;
  if (!get) throw new Error('application owner API unavailable');

  const result = await get({
    params: {
      lang: 'zh_cn',
      user_id_type: 'open_id',
    },
    path: {
      app_id: appId,
    },
  });
  const ownerId = result.data?.app?.owner?.owner_id;
  if (!ownerId) throw new Error('application owner missing from API response');
  return ownerId;
}
