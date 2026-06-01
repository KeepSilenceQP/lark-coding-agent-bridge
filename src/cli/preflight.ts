import * as p from '@clack/prompts';
import { readFile } from 'node:fs/promises';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../agent/lark-channel-env';
import type { AppPaths } from '../config/app-paths';
import type { AppConfig } from '../config/schema';
import { withLegacyLarkCliSourceOverlay } from '../lark-cli/legacy-source-overlay';
import { writeLarkCliSourceProjection } from '../lark-cli/profile-projection';
import { mergeProcessEnv, spawnProcess, spawnProcessSync } from '../platform/spawn';

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const BIND_TIMEOUT_MS = 30 * 1000;

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const MANUAL_INSTALL_HINT = [
  'Manual install command:',
  `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
  '',
  'Restart the current profile after installation; bridge will initialize lark-cli automatically.',
  '',
  'Docs: https://github.com/larksuite/cli',
].join('\n');

export interface PreFlightOptions {
  /** Skip lark-cli auto-install + bind. */
  skipCheckLarkCli?: boolean;
  larkChannel?: LarkChannelEnvContext;
  bridgeConfig?: AppConfig;
  appPaths?: AppPaths;
}

export async function preFlightChecks(opts: PreFlightOptions): Promise<void> {
  await checkLarkCli(opts);
}

async function checkLarkCli(opts: PreFlightOptions): Promise<void> {
  if (opts.skipCheckLarkCli) return;
  const bridgeConfig = opts.bridgeConfig;
  const appPaths = opts.appPaths;
  const privateBinding = bridgeConfig !== undefined && appPaths !== undefined && opts.larkChannel !== undefined;
  if (privateBinding) {
    await writeLarkCliSourceProjection(bridgeConfig, appPaths);
  }
  const larkChannelEnv = opts.larkChannel ? buildLarkChannelEnv(opts.larkChannel) : undefined;
  const profileArgs =
    privateBinding || !opts.larkChannel?.profile ? [] : ['--profile', opts.larkChannel.profile];

  if (!isLarkCliInstalled()) {
    console.log(
      [
        '',
        'lark-cli is not installed',
        '',
        'lark-cli is the Feishu/Lark command-line tool. After installation, the agent can:',
        '  - send interactive cards and forms',
        '  - query calendars, docs, tasks, OKRs, and attendance',
        '  - use 200+ Feishu/Lark API commands',
        '',
      ].join('\n'),
    );

    // Non-TTY (daemon / launchd / nohup / CI): don't auto-install — users
    // running headless typically don't expect a long network install to fire
    // under them. Print manual hint and continue startup.
    if (!process.stdin.isTTY) {
      console.log(`(non-interactive mode; skipping auto-install)\n\n${MANUAL_INSTALL_HINT}\n`);
      return;
    }

    p.intro('Setting up lark-cli');

    const sInstall = p.spinner();
    sInstall.start('Installing lark-cli');
    const installResult = await runCapture(
      'npm',
      ['install', '-g', '@larksuite/cli'],
      INSTALL_TIMEOUT_MS,
    );
    if (!installResult.success || !isLarkCliInstalled()) {
      sInstall.error('Install failed');
      if (installResult.output.trim()) {
        console.error(installResult.output);
      }
      p.outro('lark-cli installation did not complete');
      printInstallFailedWarning();
      return;
    }
    sInstall.stop('Installed');
  }

  if (!privateBinding || (await privateTargetMatches(appPaths, bridgeConfig))) {
    const showResult = await runCapture(
      'lark-cli',
      [...profileArgs, 'config', 'show'],
      BIND_TIMEOUT_MS,
      larkChannelEnv,
    );
    if (showResult.success) return;
  }

  const sBind = p.spinner();
  sBind.start('Initializing lark-cli configuration');
  const bindResult = await bindLarkCliWithCompatibility(
    profileArgs,
    larkChannelEnv,
    appPaths,
    privateBinding,
  );
  if (!bindResult.success) {
    sBind.error('lark-cli configuration failed');
    printBindFailedWarning(bindResult, appPaths);
    return;
  }
  sBind.stop('lark-cli configuration ready');
  p.outro('Done');
}

async function bindLarkCliWithCompatibility(
  profileArgs: string[],
  larkChannelEnv: NodeJS.ProcessEnv | undefined,
  appPaths: AppPaths | undefined,
  privateBinding: boolean,
): Promise<RunResult> {
  const directResult = await runCapture(
    'lark-cli',
    [...profileArgs, 'config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
    BIND_TIMEOUT_MS,
    larkChannelEnv,
  );
  if (directResult.success) return directResult;

  if (
    privateBinding &&
    appPaths &&
    shouldUseLegacyLarkChannelSourceOverlay(directResult.output, appPaths)
  ) {
    return withLegacyLarkCliSourceOverlay(
      appPaths.configFile,
      appPaths.larkCliSourceConfigFile,
      () =>
        runCapture(
          'lark-cli',
          [...profileArgs, 'config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only'],
          BIND_TIMEOUT_MS,
          larkChannelEnv,
        ),
    );
  }
  return directResult;
}

async function privateTargetMatches(appPaths: AppPaths, cfg: AppConfig): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
      }>;
    };
    const app = raw.apps?.[0];
    return (
      app?.appId === cfg.accounts.app.id &&
      app.brand === cfg.accounts.app.tenant &&
      app.defaultAs === 'bot' &&
      app.strictMode === 'bot'
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return false;
  }
}

function printInstallFailedWarning(): void {
  console.error(
    [
      '',
      `${BOLD}╔════════════════════════════════════════════════════════════════╗${RESET}`,
      `${BOLD}║  lark-cli auto-install failed                                 ║${RESET}`,
      `${BOLD}╚════════════════════════════════════════════════════════════════╝${RESET}`,
      '',
      'Possible causes: network unavailable, npm global install permission denied, or registry failure.',
      '',
      'Bridge will keep running, but the agent may be unable to use Feishu/Lark tools.',
      'Run manually:',
      '',
      `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
      '',
      'Docs: https://github.com/larksuite/cli',
      'After installation, restart bridge or rerun the current start command.',
      '',
    ].join('\n'),
  );
}

function printBindFailedWarning(result: RunResult, appPaths?: AppPaths): void {
  const profile = appPaths?.profile;
  const tooOld = isUnsupportedLarkChannelSource(result.output);
  const lines = tooOld
    ? [
        'The installed lark-cli does not support the lark-channel source required by bridge auto-configuration.',
        'Bridge will keep listening for messages, but the agent cannot use lark-cli to call Feishu/Lark APIs.',
        '',
        'Recovery:',
        '  1. Install a lark-cli build that supports the lark-channel source.',
        `  2. ${restartInstruction(profile)}`,
      ]
    : [
        'Bridge will keep listening for messages, but this profile did not finish lark-cli configuration.',
        'Impact: the agent may be unable to send messages, send cards, or call Feishu/Lark APIs through lark-cli.',
        '',
        'Recovery:',
        `  1. ${restartInstruction(profile)}`,
        '  2. If it still fails, check that this profile has a valid App Secret and that the lark-cli config directory is writable.',
      ];
  console.log(['', ...lines, '', 'Diagnostic details:', formatDiagnosticOutput(result.output), ''].join('\n'));
}

function restartInstruction(profile?: string): string {
  const suffix = profile ? ` --profile ${profile}` : '';
  return `Restart the current profile: lark-channel-bridge restart${suffix}; for foreground runs, press Ctrl+C and rerun lark-channel-bridge run${suffix}.`;
}

function shouldUseLegacyLarkChannelSourceOverlay(output: string, appPaths: AppPaths): boolean {
  if (isUnsupportedLarkChannelSource(output)) return false;
  if (!outputMentionsPath(output, appPaths.configFile)) return false;
  return (
    /accounts\.app\.id missing in /i.test(output) ||
    /cannot read .*config\.json/i.test(output) ||
    /no such file or directory/i.test(output)
  );
}

function outputMentionsPath(output: string, path: string): boolean {
  if (output.includes(path)) return true;
  return output.includes(JSON.stringify(path).slice(1, -1));
}

function isUnsupportedLarkChannelSource(output: string): boolean {
  return (
    /unknown flag:\s*--source/i.test(output) ||
    /unknown command ["']?bind["']?/i.test(output) ||
    /invalid --source[^-\n]*lark-channel/i.test(output) ||
    /unsupported source:\s*lark-channel/i.test(output) ||
    (/invalid --source[^-\n]*lark-channel/i.test(output) && /valid values:\s*\S+/i.test(output))
  );
}

function formatDiagnosticOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return '(lark-cli did not print error details)';
  if (/unknown flag:\s*--source/i.test(trimmed) || /unknown command ["']?bind["']?/i.test(trimmed)) {
    return 'lark-cli does not support `config bind --source lark-channel`.';
  }
  const parsed = parseJson(trimmed);
  if (parsed !== undefined) {
    return JSON.stringify(stripLarkCliNotices(parsed), null, 2);
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => !isLarkCliUpdateNoticeLine(line));
  return lines.join('\n').trim() || '(lark-cli did not print error details)';
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function stripLarkCliNotices(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLarkCliNotices);
  if (!value || typeof value !== 'object') return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '_notice') continue;
    cleaned[key] = stripLarkCliNotices(child);
  }
  return cleaned;
}

function isLarkCliUpdateNoticeLine(line: string): boolean {
  return (
    /_notice/i.test(line) ||
    (/lark-cli/i.test(line) && /(update|upgrade|latest|newer|npm\s+install)/i.test(line)) ||
    /\b(current|latest)\s+version\b/i.test(line)
  );
}

function isLarkCliInstalled(): boolean {
  try {
    const result = spawnProcessSync('lark-cli', ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

interface RunResult {
  success: boolean;
  /** Captured stdout + stderr from the child. Useful only on failure. */
  output: string;
}

/**
 * Run a child process, capture stdout/stderr to a buffer (keeps the
 * surrounding clack spinner UI clean), enforce a timeout. Used for the
 * npm install and lark-cli bind steps in the preflight check.
 */
async function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  let captured = '';
  let timedOut = false;

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawnProcess(cmd, args, {
      env: env ? mergeProcessEnv(process.env, env) : undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (b: Buffer) => {
      captured += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      captured += b.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  return { success: !timedOut && exitCode === 0, output: captured };
}
