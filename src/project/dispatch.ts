/**
 * Project bootstrap dispatch planning.
 *
 * The Registry supplies stable names and app IDs. Live open_ids always come
 * from the current chat membership snapshot.
 */

import type {
  BootstrapResult,
  BotRegistryEntry,
} from './bot-registry';
import { spawnProcess } from '../platform/spawn';

export interface LiveBotMember {
  openId: string;
  name: string;
}

export interface LiveDiscovery {
  discoverBots(chatId: string): Promise<LiveBotMember[]>;
}

export function createSdkLiveDiscovery(
  rawClient: unknown,
  larkCliEnv: NodeJS.ProcessEnv = process.env,
): LiveDiscovery {
  return {
    async discoverBots(chatId: string): Promise<LiveBotMember[]> {
      let injected: LiveBotMember[] | undefined;
      try {
        injected = await discoverViaInjectedRawClient(rawClient, chatId);
      } catch {
        injected = undefined;
      }
      if (injected) return injected;
      return discoverViaLarkCli(chatId, larkCliEnv);
    },
  };
}

async function discoverViaInjectedRawClient(
  rawClient: unknown,
  chatId: string,
): Promise<LiveBotMember[] | undefined> {
  const rc = rawClient as {
    im?: {
      v1?: {
        chatMembers?: {
          bots?: (opts: {
            path: { chat_id: string };
            params?: { member_id_type?: string };
          }) => Promise<{ data?: { items?: Array<{ member_id_type?: string; member_id?: string; name?: string }> } }>;
        };
      };
    };
  };
  const bots = rc?.im?.v1?.chatMembers?.bots;
  if (!bots) return undefined;
  const result = await bots({
    path: { chat_id: chatId },
    params: { member_id_type: 'bot' },
  });
  const items = result?.data?.items ?? [];
  return items
    .filter((item) => item.member_id_type === 'bot' && item.member_id)
    .map((item) => ({ openId: item.member_id!, name: item.name ?? item.member_id! }));
}

async function discoverViaLarkCli(chatId: string, larkCliEnv: NodeJS.ProcessEnv): Promise<LiveBotMember[]> {
  const output = await runLarkCliJson([
    'im',
    'chat.members',
    'bots',
    '--params',
    JSON.stringify({ chat_id: chatId }),
    '--as',
    'user',
    '--format',
    'json',
  ], larkCliEnv);

  const parsed = JSON.parse(output) as {
    ok?: boolean;
    code?: number;
    msg?: string;
    data?: {
      items?: Array<{
        bot_id?: string;
        bot_name?: string;
        member_id?: string;
        name?: string;
      }>;
    };
  };
  if (parsed.code !== undefined && parsed.code !== 0) {
    throw new Error(parsed.msg || `lark-cli bot discovery failed: code ${parsed.code}`);
  }
  if (parsed.ok === false) {
    throw new Error(parsed.msg || 'lark-cli bot discovery failed');
  }
  return (parsed.data?.items ?? [])
    .map((item) => ({
      openId: item.bot_id ?? item.member_id ?? '',
      name: item.bot_name ?? item.name ?? item.bot_id ?? item.member_id ?? '',
    }))
    .filter((item) => item.openId && item.name);
}

function runLarkCliJson(args: string[], larkCliEnv: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('lark-cli', args, {
      env: larkCliEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('lark-cli bot discovery timed out'));
    }, 20_000);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `lark-cli exited with ${code ?? 'unknown status'}`));
      }
    });
  });
}

export type DispatchKind = 'cd-and-invite';

export interface DispatchInstruction {
  targetName: string;
  targetOpenId: string;
  kind: DispatchKind;
  workspacePath: string;
}

export interface BootstrapPlanInput {
  slug: string;
  workspacePath: string;
  coordinatorOpenId: string;
  liveMembers: LiveBotMember[];
  registry: BotRegistryEntry[];
}

export interface BootstrapPlan {
  slug: string;
  instructions: DispatchInstruction[];
  results: BootstrapResult[];
}

export function planBootstrap(input: BootstrapPlanInput): BootstrapPlan {
  const results: BootstrapResult[] = [];
  const instructions: DispatchInstruction[] = [];

  for (const entry of input.registry) {
    const matches = findLiveMembers(entry, input.liveMembers);
    if (matches.length === 1 && matches[0]!.openId === input.coordinatorOpenId) {
      continue;
    }
    if (matches.length > 1) {
      results.push({
        botName: entry.name,
        status: 'blocked',
        blockedReason: 'ambiguous_name',
      });
      continue;
    }
    const live = matches[0];
    if (!live) {
      results.push({
        botName: entry.name,
        status: 'blocked',
        blockedReason: 'bot_not_in_group',
      });
      continue;
    }

    results.push({ botName: entry.name, status: 'sent' });
    instructions.push({
      targetName: entry.name,
      targetOpenId: live.openId,
      kind: 'cd-and-invite',
      workspacePath: input.workspacePath,
    });
  }

  return { slug: input.slug, instructions, results };
}

function findLiveMembers(
  entry: BotRegistryEntry,
  liveMembers: LiveBotMember[],
): LiveBotMember[] {
  const names = new Set(
    [entry.name, ...entry.aliases].map((name) => name.normalize('NFC')),
  );
  return liveMembers.filter((member) => names.has(member.name.normalize('NFC')));
}
