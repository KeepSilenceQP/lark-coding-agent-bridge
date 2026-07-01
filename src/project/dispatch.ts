/**
 * Phase 2 dispatch strategy — generates per-bot instructions from live
 * discovery results + registry metadata.
 *
 * This module is a pure-data planning layer. The command handler sends
 * native mention slash commands to bridge bots: `/invite group`, then `/cd`.
 */

import type {
  BlockedReason,
  BootstrapResult,
  BotRegistryEntry,
} from './bot-registry';
import {
  matchRegistry,
  resolveWorkspacePath,
  checkPinnedIdentity,
  type PinnedBinding,
} from './bot-registry';
import { spawnProcess } from '../platform/spawn';

// ── live discovery seam ──

export interface LiveBotMember {
  openId: string;
  name: string;
}

export interface LiveDiscovery {
  discoverBots(chatId: string): Promise<LiveBotMember[]>;
}

/**
 * Live bot discovery. The public OpenAPI SDK exposes chatMembers.get, but that
 * endpoint explicitly filters out bots. In bridge-bound runtime we use the
 * lark-cli bot-list wrapper, while keeping an injected raw method for tests.
 */
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

// ── dispatch instruction ──

export type DispatchKind = 'cd-and-invite';

export interface DispatchInstruction {
  targetName: string;
  targetOpenId: string;
  kind: DispatchKind;
  /** For bridge bots: workspace path for /cd. */
  workspacePath?: string;
}

// ── bootstrap planning ──

export interface BootstrapPlanInput {
  slug: string;
  workspacePath?: string;
  chatId: string;
  coordinatorName: string;
  coordinatorOpenId: string;
  dispatcherProfile: string;
  liveMembers: LiveBotMember[];
  registry: BotRegistryEntry[];
  pinned: Map<string, PinnedBinding>;
  participants: string[];
}

export interface BootstrapPlan {
  slug: string;
  instructions: DispatchInstruction[];
  results: BootstrapResult[];
}

/**
 * Build the full bootstrap plan from live discovery + registry.
 *
 * For each registry entry:
 *  1. Match live members by canonicalName / aliases (NFC exact).
 *  2. If no live match → blocked(bot_not_in_group).
 *  3. If ambiguous → blocked(ambiguous_name).
 *  4. Check pinned identity → blocked(identity_changed) on mismatch.
 *  5. For bridge bots: resolve workspace path → cd-and-invite instruction.
 *  6. Non-bridge entries are blocked; project bootstrap only sends bridge
 *     slash commands.
 */
export function planBootstrap(input: BootstrapPlanInput): BootstrapPlan {
  const results: BootstrapResult[] = [];
  const instructions: DispatchInstruction[] = [];

  // Detect duplicate live names (same NFC-normalised name from multiple open_ids)
  const seenNames = new Map<string, LiveBotMember[]>();
  for (const m of input.liveMembers) {
    const nfc = m.name.normalize('NFC');
    const list = seenNames.get(nfc) ?? [];
    list.push(m);
    seenNames.set(nfc, list);
  }
  const duplicateNames = new Set(
    [...seenNames.entries()].filter(([, list]) => list.length > 1).map(([n]) => n),
  );
  const liveMap = new Map<string, LiveBotMember>();
  for (const [nfc, list] of seenNames) {
    if (list.length === 1) liveMap.set(nfc, list[0]!);
    // Duplicates are not in liveMap → will trigger blocked(ambiguous_name) below
  }

  for (const entry of input.registry) {
    const live = findLiveMember(entry, liveMap);
    if (live?.openId === input.coordinatorOpenId) continue;

    const result = planBot(entry, input, liveMap, duplicateNames);
    results.push(result);

    if (result.status !== 'blocked') {
      const instr = buildInstruction(entry, input, liveMap);
      if (instr) instructions.push(instr);
    }
  }

  return { slug: input.slug, instructions, results };
}

function planBot(
  entry: BotRegistryEntry,
  input: BootstrapPlanInput,
  liveMap: Map<string, LiveBotMember>,
  duplicateNames: Set<string>,
): BootstrapResult {
  // Match live members by name
  const normalised = entry.canonicalName.normalize('NFC');
  const live = findLiveMember(entry, liveMap);

  // B3: duplicate live names → blocked(ambiguous_name)
  if (!live && duplicateNames.has(normalised)) {
    return {
      botName: entry.canonicalName,
      status: 'blocked',
      blockedReason: 'ambiguous_name',
    };
  }
  if (live && duplicateNames.has(live.name.normalize('NFC'))) {
    return {
      botName: entry.canonicalName,
      status: 'blocked',
      blockedReason: 'ambiguous_name',
    };
  }

  if (!live) {
    return {
      botName: entry.canonicalName,
      status: 'blocked',
      blockedReason: 'bot_not_in_group',
    };
  }

  // Check for ambiguous matches (same NFC name maps to multiple registry entries)
  const allMatches = input.registry.filter(
    (e) => e.canonicalName.normalize('NFC') === normalised ||
      e.aliases.some((a) => a.normalize('NFC') === normalised),
  );
  if (allMatches.length > 1) {
    // Check if the LIVE name matches multiple entries' canonical/alias names
    // This is rare but possible when aliases overlap
    const liveMatches = input.registry.filter(
      (e) =>
        e.canonicalName.normalize('NFC') === live.name.normalize('NFC') ||
        e.aliases.some((a) => a.normalize('NFC') === live.name.normalize('NFC')),
    );
    if (liveMatches.length > 1) {
      return {
        botName: entry.canonicalName,
        status: 'blocked',
        blockedReason: 'ambiguous_name',
      };
    }
  }

  // Check pinned identity
  const pinCheck = checkPinnedIdentity(
    entry.canonicalName,
    live.openId,
    input.pinned,
  );
  if (pinCheck.ok === false && pinCheck.reason === 'identity_changed') {
    return {
      botName: entry.canonicalName,
      status: 'blocked',
      blockedReason: 'identity_changed',
      pinnedOpenId: pinCheck.pinned?.openId,
    };
  }

  if (entry.role !== 'bridge') {
    return {
      botName: entry.canonicalName,
      status: 'blocked',
      blockedReason: 'denied',
    };
  }

  // Resolve workspace path
  const ws = resolveBootstrapWorkspace(input, entry);
  if (!ws) {
    return {
      botName: entry.canonicalName,
      status: 'blocked',
      blockedReason: 'not_in_registry',
    };
  }

  return {
    botName: entry.canonicalName,
    status: 'sent',
    pinnedOpenId: pinCheck.ok ? pinCheck.binding.openId : undefined,
  };
}

function buildInstruction(
  entry: BotRegistryEntry,
  input: BootstrapPlanInput,
  liveMap: Map<string, LiveBotMember>,
): DispatchInstruction | undefined {
  const live = findLiveMember(entry, liveMap);

  if (!live) return undefined;

  if (entry.role === 'bridge') {
    const ws = resolveBootstrapWorkspace(input, entry);
    if (!ws) return undefined;
    return {
      targetName: entry.canonicalName,
      targetOpenId: live.openId,
      kind: 'cd-and-invite',
      workspacePath: ws.path,
    };
  }
  return undefined;
}

function resolveBootstrapWorkspace(
  input: BootstrapPlanInput,
  entry: BotRegistryEntry,
): { path: string } | undefined {
  return input.workspacePath ? { path: input.workspacePath } : resolveWorkspacePath(entry);
}

function findLiveMember(
  entry: BotRegistryEntry,
  liveMap: Map<string, LiveBotMember>,
): LiveBotMember | undefined {
  return liveMap.get(entry.canonicalName.normalize('NFC')) ??
    entry.aliases
      .map((a) => liveMap.get(a.normalize('NFC')))
      .find((m): m is LiveBotMember => !!m);
}
