import { join } from 'node:path';

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  bridgePid?: number;
  configPath?: string;
  larkCliConfigDir?: string;
  larkCliSourceConfigFile?: string;
  /** Opaque route ID for deferred self-restart. Only routeId goes to env — never chatId. */
  routeId?: string;
}

export function buildLarkChannelEnv(context?: LarkChannelEnvContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LARK_CHANNEL: '1',
  };
  const profile = nonEmpty(context?.profile);
  if (profile) env.LARK_CHANNEL_PROFILE = profile;

  if (context?.bridgePid && context.bridgePid > 0) {
    env.LARK_CHANNEL_BRIDGE_PID = String(context.bridgePid);
  }

  const routeId = nonEmpty(context?.routeId);
  if (routeId) env.LARK_CHANNEL_ROUTE_ID = routeId;

  const rootDir = nonEmpty(context?.rootDir);
  if (rootDir) env.LARK_CHANNEL_HOME = rootDir;

  const configPath =
    nonEmpty(context?.larkCliSourceConfigFile) ??
    nonEmpty(context?.configPath) ??
    (rootDir ? join(rootDir, 'config.json') : undefined);
  if (configPath) env.LARK_CHANNEL_CONFIG = configPath;

  const larkCliConfigDir = nonEmpty(context?.larkCliConfigDir);
  if (larkCliConfigDir) {
    env.LARKSUITE_CLI_CONFIG_DIR = larkCliConfigDir;
  } else if (context && Object.prototype.hasOwnProperty.call(context, 'larkCliConfigDir')) {
    env.LARKSUITE_CLI_CONFIG_DIR = undefined;
  }

  return env;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
