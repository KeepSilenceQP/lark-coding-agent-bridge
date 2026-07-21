import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability } from '../agent/capability';
import { DEFAULT_MODEL, normalizeModelSelection, supportedModels } from '../agent/models';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../card/account-cards';
import {
  configCancelledCard,
  configFailedCard,
  configFormCard,
  configSavedCard,
  groupMsgScopeGrantCard,
  groupMsgScopeGrantedCard,
} from '../card/config-card';
import { GROUP_MSG_SCOPE, hasGroupMsgScope } from '../bot/app-scope';
import { requestScopeGrantLink } from '../bot/wizard';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import { helpCard, resumeCard, statusCard, workspacesCard } from '../card/templates';
import type { AppConfig, AppPreferences, MessageReplyMode, TenantBrand } from '../config/schema';
import {
  getAgentStopGraceMs,
  getCotMessages,
  getGroupResponseMode,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  secretKeyForApp,
} from '../config/schema';
import type {
  GroupResponseMode,
  ProfileAccess,
  ProfileConfig,
} from '../config/profile-schema';
import { resolveAppPaths } from '../config/app-paths';
import { accessToClaudePermissionMode } from '../config/permissions';
import {
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../config/profile-store';
import {
  canRunAdminCommand,
  canRunBotAdminCommand,
  canUseDm,
  canUseGroup,
  isBotAdmin,
  type AccessDecision,
  type OwnerRefreshState,
  type RuntimeControls,
} from '../policy/access';
import {
  defaultRegistry,
  mergeRegistry,
  validateSlug,
  type BotRegistryEntry,
} from '../project/bot-registry';
import {
  createSdkLiveDiscovery,
  planBootstrap,
  type LiveBotMember,
} from '../project/dispatch';
import type { BootstrapResult } from '../project/bot-registry';
import { setSecret } from '../config/keystore';
import { buildEncryptedAccountConfig, saveConfig } from '../config/store';
import { log, reportMetric } from '../core/logger';
import { spawnProcess } from '../platform/spawn';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { formatRelTime, listRecentSessions, type SessionSummary } from '../session/history';
import {
  listCodexThreadHistory,
  type CodexThreadHistoryEntry,
  type ListCodexThreadHistoryOptions,
} from '../session/codex-history';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import type { SessionStore } from '../session/store';
import type { PromptSessionService } from '../session/prompt-session-service';
import { resolveWorkingDirectory } from '../policy/workspace';
import { evaluateRunPolicy } from '../policy/run-policy';
import type { ProcessPool } from '../bot/process-pool';
import type { RunExecutor } from '../runtime/run-executor';
import { RunRejected } from '../runtime/errors';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat, defaultChatName } from '../bot/group';
import { fetchKnownChats, type KnownChat } from '../bot/lark-info';
import { applyLarkCliIdentityPolicy, hasStructuredLarkCliUserAuth } from '../lark-cli/identity-policy';

export interface Controls {
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(channel?: LarkChannel): Promise<void>;
  /** Restart the bridge in-process: disconnect WS, kill claude runs, reload
   * config, reconnect with the new credentials. */
  restart(opts?: { wait?: boolean }): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
  /** Groups the bot currently belongs to, used to render and bulk-manage access. */
  knownChats?: KnownChat[];
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  promptSessionService?: PromptSessionService;
  sessionCatalogIdentity?: SessionCatalogIdentity;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  codexHistoryProvider?: (
    options: ListCodexThreadHistoryOptions,
  ) => Promise<CodexThreadHistoryEntry[]>;
  claudeHistoryProvider?: (cwd: string, limit: number) => Promise<SessionSummary[]>;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
  /** True when a card command callback carried a valid bridge_token. Unsigned
   * card commands still need the normal admin/botAdmin gate. */
  cardActionAuthorized?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

interface ResumeCandidate {
  scopeId: string;
  agentId: 'claude' | 'codex';
  cwdRealpath: string;
  policyFingerprint: string;
  sessionId?: string;
  threadId?: string;
  updatedAt: number;
  expiresAt: number;
}

const RESUME_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const resumeCandidates = new Map<string, ResumeCandidate>();
const AUDIT_SAFE_COMMAND_REPLY = '命令已处理。';
const RESUME_APPLIED_REPLY = '已完成，请继续发送下一条消息。';

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
  '/project': handleProject,
  '/resume': handleResume,
  '/status': handleStatus,
  '/help': handleHelp,
  '/account': handleAccount,
  '/config': handleConfig,
  '/stop': handleStop,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
  '/doc': handleDoc,
  '/invite': handleInvite,
  '/remove': handleRemove,
  '/botAdmin': handleBotAdmin,
};

/**
 * Commands requiring **human** admin (owner or admins[]).  botAdmins are
 * NOT allowed here — these commands manage credentials, roles, or
 * sensitive lifecycle state.
 */
const ADMIN_ONLY_COMMANDS = new Set([
  '/account',
  '/config',
  '/exit',
  '/reconnect',
  '/doctor',
  '/botAdmin',
]);

/**
 * Self-service commands available to any caller that has already passed the
 * chat-level allow policy. These do not change shared access, credentials, or
 * process-wide lifecycle state.
 */
const PUBLIC_COMMANDS = new Set([
  '/status',
  '/help',
  '/new',
  '/reset',
  '/resume',
  '/stop',
  '/timeout',
  '/doc',
]);

/**
 * Commands allowed for botAdmins in addition to human admins/owner.
 * These are project-operations commands: group join/leave, cwd,
 * project setup, process inspection, and role-limited group membership
 * management.  `/invite` and `/remove` are included here but further gated
 * inside their handlers: botAdmins may only use the `group` sub-kind, not
 * `user` or `admin`.
 */
const BOT_ADMIN_COMMANDS = new Set([
  '/cd',
  '/ws',
  '/project',
  '/invite',
  '/remove',
  '/ps',
]);

function isAdminOnlyCommand(cmd: string): boolean {
  return ADMIN_ONLY_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

function isBotAdminCommand(cmd: string): boolean {
  return BOT_ADMIN_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

function resolveCommandGate(
  cmd: string,
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  const c = cmd.startsWith('/') ? cmd : `/${cmd}`;
  if (PUBLIC_COMMANDS.has(c)) {
    return { ok: true, reason: 'allowed-public' };
  }
  if (ADMIN_ONLY_COMMANDS.has(c)) {
    return canRunAdminCommand(profile, controls, senderId);
  }
  if (BOT_ADMIN_COMMANDS.has(c)) {
    return canRunBotAdminCommand(profile, controls, senderId);
  }
  return { ok: true, reason: 'allowed-admin' };
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = commandContent(ctx.msg).trim();
  if (!trimmed.startsWith('/')) return false;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  const h = handlers[cmd];
  if (!h) return false;

  if (!ctx.fromCardAction || !ctx.cardActionAuthorized) {
    const gate = resolveCommandGate(
      cmd,
      ctx.controls.profileConfig,
      ctx.controls,
      ctx.msg.senderId,
    );
    if (!gate.ok) {
      log.info('command', 'admin-deny', {
        cmd,
        sender: ctx.msg.senderId.slice(-6),
        reason: gate.reason,
      });
      await reply(ctx, '❌ 此命令仅管理员可用。');
      return true;
    }
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
    reportMetric('command_fail', 1, { step: 'dispatch' });
  }
  return true;
}

function commandContent(msg: NormalizedMessage): string {
  const rawText = rawMessageText(msg);
  if (!rawText) return msg.content;

  const commandStart = rawText.search(/\/\S+/);
  if (commandStart < 0) return msg.content;
  const prefix = rawText.slice(0, commandStart).trim();
  if (!prefix) return rawText.slice(commandStart);

  let remaining = prefix;
  for (const mention of msg.mentions ?? []) {
    for (const candidate of mentionTextCandidates(mention)) {
      remaining = remaining.split(candidate).join('');
    }
  }
  return remaining.trim() ? msg.content : rawText.slice(commandStart);
}

function rawMessageText(msg: NormalizedMessage): string {
  const rawContent = (msg.raw as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return '';

  try {
    const parsed = JSON.parse(rawContent) as unknown;
    const text = textFromRawContent(parsed);
    return text || rawContent;
  } catch {
    return rawContent;
  }
}

function textFromRawContent(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('content' in value && Array.isArray(value.content)) {
    return value.content
      .map((line) => Array.isArray(line) ? line.map(textFromPostElement).join('') : '')
      .join('\n');
  }
  return '';
}

function textFromPostElement(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const element = value as { tag?: unknown; text?: unknown; user_name?: unknown };
  if (typeof element.text === 'string') return element.text;
  if (element.tag === 'at' && typeof element.user_name === 'string') return `@${element.user_name}`;
  return '';
}

function mentionTextCandidates(
  mention: NonNullable<NormalizedMessage['mentions']>[number],
): string[] {
  return [
    mention.key,
    mention.name ? `@${mention.name}` : undefined,
    mention.openId,
    mention.userId,
  ].filter((value): value is string => Boolean(value));
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const h = handlers[`/${name}`];
  if (!h) return false;

  if (!ctx.fromCardAction || !ctx.cardActionAuthorized) {
    const gate = resolveCommandGate(
      name,
      ctx.controls.profileConfig,
      ctx.controls,
      ctx.msg.senderId,
    );
    if (!gate.ok) {
      log.info('command', 'admin-deny', {
        cmd: name,
        sender: ctx.msg.senderId.slice(-6),
        via: 'card',
        reason: gate.reason,
      });
      return true;
    }
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: name });
    reportMetric('command_fail', 1, { step: 'handler' });
  }
  return true;
}

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, commandReplyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
    reportMetric('command_fail', 1, { step: 'reply' });
    if (!isMessageAuditReject(err) || markdown === AUDIT_SAFE_COMMAND_REPLY) return;
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { markdown: AUDIT_SAFE_COMMAND_REPLY },
        commandReplyOptions(ctx),
      );
    } catch (fallbackErr) {
      log.fail('command', fallbackErr, { step: 'reply-audit-fallback' });
      reportMetric('command_fail', 1, { step: 'reply-audit-fallback' });
    }
  }
}

function commandReplyOptions(ctx: CommandContext): { replyTo: string; replyInThread?: true } {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
  };
}

function isMessageAuditReject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  if (record.code === 230028) return true;
  const message = String(record.message ?? record.msg ?? '');
  return /not pass the audit/i.test(message);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

function isAbsoluteOrTilde(p: string): boolean {
  return isAbsolute(p) || p === '~' || p.startsWith('~/');
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  // Cancel both spawned runs and pool-waiting reservations before reset. An
  // activation reset may need to drain the admission owned by that work, so
  // awaiting reset first would deadlock the two lifecycle barriers.
  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  const resetReservation = ctx.activeRuns.reserve(ctx.scope);
  if (!resetReservation) {
    await reply(ctx, '当前会话仍在切换中，请稍后重试。');
    return;
  }
  let resetByPromptService = false;
  try {
    if (ctx.promptSessionService && ctx.sessionCatalogIdentity) {
      const reset = await ctx.promptSessionService.resetSession({
        identity: ctx.sessionCatalogIdentity,
        origin: {
          source: 'im',
          scopeId: ctx.scope,
          chatId: ctx.msg.chatId,
          chatType: ctx.msg.chatType,
          ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
        },
      });
      resetByPromptService = reset.kind === 'reset';
    }
    if (!resetByPromptService) {
      if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
        ctx.sessionCatalog.archiveActive({
          ...ctx.sessionCatalogIdentity,
          now: Date.now(),
        });
      }
      ctx.sessions.clear(ctx.scope);
    }
    await reply(ctx, wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。');
  } catch (err) {
    log.fail('session', err, { step: 'group-prompt-reset', scope: ctx.scope });
    await reply(ctx, '当前会话状态无法安全重置，请稍后重试或联系管理员检查配置。');
  } finally {
    resetReservation.release();
  }
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = effectiveWorkspaceCwd(ctx);
  const name = rawName || defaultChatName(ctx.agent.displayName);

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace; otherwise it'll fall back to $HOME.
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }

  // Welcome the user inside the new group with a hint about how to start.
  const welcome = sourceCwd
    ? `🎉 群已建好，cwd 继承自原群：\`${sourceCwd}\`\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(
    ctx,
    `✓ 已创建群 **${created.name}**，去新群里继续。`,
  );
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <绝对路径>` 或 `/cd ~/xxx`');
    return;
  }
  if (!isAbsoluteOrTilde(input)) {
    await reply(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }
  const absolute = expandTilde(input);
  const workspace = await resolveWorkingDirectory(absolute);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换 cwd 到 \`${workspace.cwdRealpath}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = listScopedWorkspaces(ctx);
  const currentCwd = effectiveWorkspaceCwd(ctx);
  const card = workspacesCard(
    currentCwd,
    named,
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前 chat 未设置 cwd，先用 `/cd` 设置再保存。');
    return;
  }
  ctx.workspaces.saveNamed(scopedWorkspaceName(ctx, name), cwd);
  await reply(ctx, `✓ 工作目录别名已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = getWorkspaceAlias(ctx, name);
  if (!cwd) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换到 \`${name}\` (${workspace.cwdRealpath})\n（session 已重置）`);
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!removeWorkspaceAlias(ctx, name)) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  await reply(ctx, `✓ 已删除工作目录别名：\`${name}\``);
}

// ────────────── /project — project workspace lifecycle ──────────────

const projectStartInFlight = new Set<string>();

function projectStartIdempotencyKey(scope: string, path: string): string {
  return `${scope}::${path}`;
}

async function handleProject(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();
  switch (sub) {
    case 'bootstrap':
      return handleProjectBootstrap(rest, ctx);
    default:
      await reply(ctx, '用法：`/project bootstrap <workspace> <小C|云上小C>`');
  }
}

// ────────────── /project bootstrap — multi-bot group startup ──────────────

interface ProjectBootstrapRequest {
  workspacePath: string;
  targetBot: string;
  slug: string;
}

const IMPLEMENTER_BOTS = new Set(['小C', '云上小C']);
const BOOTSTRAP_REQUIRED_BOTS = new Set(['云上C总']);
const BOOTSTRAP_INVITE_DISCOVERY_ATTEMPTS = 4;
const BOOTSTRAP_INVITE_DISCOVERY_DELAY_MS = 150;

function parseProjectBootstrapRequest(args: string): { ok: true; value: ProjectBootstrapRequest } | { ok: false; reason: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) {
    return {
      ok: false,
      reason: '用法：`/project bootstrap <workspace> <小C|云上小C>`',
    };
  }

  const workspaceInput = parts[0]!;
  const workspacePath = workspaceInput;
  const targetBot = normalizeBootstrapTarget(parts[1]!);
  if (!IMPLEMENTER_BOTS.has(targetBot)) {
    return {
      ok: false,
      reason: 'targetBot 只能是 `小C` 或 `云上小C`。',
    };
  }

  return {
    ok: true,
    value: {
      workspacePath,
      targetBot,
      slug: workspaceSlugFromPath(workspacePath),
    },
  };
}

function normalizeBootstrapTarget(input: string): string {
  return input.trim().replace(/^@+/, '');
}

function workspaceSlugFromPath(path: string): string {
  const raw = basename(path.replace(/\/+$/, '')) || 'workspace';
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'workspace';
}

function selectBootstrapTargetRegistry(registry: BotRegistryEntry[], targetBot: string): BotRegistryEntry[] {
  const normalized = targetBot.normalize('NFC');
  return registry.filter((entry) =>
    BOOTSTRAP_REQUIRED_BOTS.has(entry.canonicalName) ||
    entry.canonicalName.normalize('NFC') === normalized ||
    entry.aliases.some((alias) => alias.normalize('NFC') === normalized),
  );
}

function resolveCoordinatorBootstrapWorkspaceInput(
  workspacePath: string,
  registry: BotRegistryEntry[],
  coordinatorName: string,
): string {
  if (isAbsoluteOrTilde(workspacePath)) return expandTilde(workspacePath);

  const normalized = coordinatorName.normalize('NFC');
  const coordinator = registry.find((entry) =>
    entry.canonicalName.normalize('NFC') === normalized ||
    entry.aliases.some((alias) => alias.normalize('NFC') === normalized),
  );
  const localRoot = coordinator?.machines.find((machine) => machine.kind === 'local')?.root;
  return localRoot ? join(localRoot, workspacePath) : workspacePath;
}

async function maybeSwitchBootstrapCoordinatorWorkspace(
  ctx: CommandContext,
  workspacePath: string,
  registry: BotRegistryEntry[],
  coordinatorName: string,
): Promise<void> {
  const requested = resolveCoordinatorBootstrapWorkspaceInput(workspacePath, registry, coordinatorName);
  const workspace = await resolveWorkingDirectory(requested);
  if (!workspace.ok) {
    log.warn('project', 'bootstrap-coordinator-workspace-unresolved', {
      workspacePath,
      requested,
      reason: workspace.reason,
    });
    return;
  }

  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  log.info('project', 'bootstrap-coordinator-workspace-set', {
    workspacePath,
    cwdRealpath: workspace.cwdRealpath,
  });
}

async function inviteMissingBootstrapBots(
  chatId: string,
  registry: BotRegistryEntry[],
  liveMembers: LiveBotMember[],
  coordinatorName: string,
  larkCliEnv: NodeJS.ProcessEnv,
): Promise<{ inviteFailed: Map<string, BootstrapResult>; invitedAny: boolean }> {
  const inviteFailed = new Map<string, BootstrapResult>();
  let invitedAny = false;

  for (const entry of registry) {
    if (entry.canonicalName === coordinatorName) continue;
    if (findBootstrapLiveMember(entry, liveMembers)) continue;

    if (!entry.appId) {
      inviteFailed.set(entry.canonicalName, {
        botName: entry.canonicalName,
        status: 'blocked',
        blockedReason: 'app_id_unknown',
      });
      continue;
    }

    const invited = await inviteBotAppToChat(chatId, entry.appId, larkCliEnv);
    if (invited) {
      invitedAny = true;
    } else {
      inviteFailed.set(entry.canonicalName, {
        botName: entry.canonicalName,
        status: 'blocked',
        blockedReason: 'invite_failed',
      });
    }
  }

  return { inviteFailed, invitedAny };
}

function findBootstrapLiveMember(
  entry: BotRegistryEntry,
  liveMembers: LiveBotMember[],
): LiveBotMember | undefined {
  const names = [entry.canonicalName, ...entry.aliases].map((name) => name.normalize('NFC'));
  return liveMembers.find((member) => names.includes(member.name.normalize('NFC')));
}

async function inviteBotAppToChat(
  chatId: string,
  appId: string,
  larkCliEnv: NodeJS.ProcessEnv,
): Promise<boolean> {
  const output = await runBootstrapLarkCliJson([
    'im',
    'chat.members',
    'create',
    '--chat-id',
    chatId,
    '--member-id-type',
    'app_id',
    '--succeed-type',
    '1',
    '--data',
    JSON.stringify({ id_list: [appId] }),
    '--as',
    'user',
    '--format',
    'json',
  ], larkCliEnv).catch(() => undefined);
  if (!output) return false;

  try {
    const parsed = JSON.parse(output) as {
      ok?: boolean;
      code?: number;
      data?: {
        invalid_id_list?: unknown[];
        not_existed_id_list?: unknown[];
        pending_approval_id_list?: unknown[];
      };
    };
    if (parsed.code !== undefined && parsed.code !== 0) return false;
    if (parsed.ok === false) return false;
    const failedIds = [
      ...(parsed.data?.invalid_id_list ?? []),
      ...(parsed.data?.not_existed_id_list ?? []),
      ...(parsed.data?.pending_approval_id_list ?? []),
    ].map(String);
    return !failedIds.includes(appId);
  } catch {
    return false;
  }
}

function runBootstrapLarkCliJson(args: string[], larkCliEnv: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('lark-cli', args, {
      env: larkCliEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('lark-cli chat member invite timed out'));
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

function bootstrapLarkCliEnv(ctx: CommandContext): NodeJS.ProcessEnv {
  const appPaths = resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
  return {
    ...process.env,
    LARK_CHANNEL: '1',
    LARK_CHANNEL_HOME: appPaths.rootDir,
    LARK_CHANNEL_PROFILE: appPaths.profile,
    LARK_CHANNEL_CONFIG: appPaths.larkCliSourceConfigFile,
    LARKSUITE_CLI_CONFIG_DIR: appPaths.larkCliConfigDir,
  };
}

async function handleProjectBootstrap(args: string, ctx: CommandContext): Promise<void> {
  // /project bootstrap is human-admin gated.
  if (!canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ /project bootstrap 仅管理员可用。');
    return;
  }

  const parsed = parseProjectBootstrapRequest(args);
  if (!parsed.ok) {
    await reply(ctx, `❌ ${parsed.reason}`);
    return;
  }
  const { workspacePath, targetBot, slug } = parsed.value;
  const slugResult = validateSlug(slug);
  if (!slugResult.ok) {
    await reply(ctx, `❌ ${slugResult.reason}`);
    return;
  }

  if (ctx.chatMode === 'p2p') {
    await reply(ctx, '❌ /project bootstrap 只能在项目群里使用。');
    return;
  }

  const key = projectStartIdempotencyKey(ctx.scope, `${workspacePath}::${targetBot}`);
  if (projectStartInFlight.has(key)) {
    await reply(ctx, '⏳ 该项目的 bootstrap 已在执行中，请等待完成。');
    return;
  }
  projectStartInFlight.add(key);

  try {
    // B1: live discovery via typed seam
    const larkCliEnv = bootstrapLarkCliEnv(ctx);
    const discovery = createSdkLiveDiscovery((ctx.channel as { rawClient?: unknown }).rawClient, larkCliEnv);
    let liveMembers: LiveBotMember[];
    let discoveryFailed = false;
    try {
      liveMembers = await discovery.discoverBots(ctx.msg.chatId);
    } catch {
      discoveryFailed = true;
      liveMembers = [];
    }

    // If discovery itself failed, all bots are blocked(discovery_failed)
    if (discoveryFailed) {
      const mergedRegistry = mergeRegistry(
        defaultRegistry(),
        (ctx.controls.profileConfig as { botRegistry?: BotRegistryEntry[] }).botRegistry ?? [],
      );
      const registry = selectBootstrapTargetRegistry(mergedRegistry, targetBot);
      if (!registry.length) {
        await reply(ctx, `❌ 未找到实现方：\`${targetBot}\``);
        return;
      }
      log.warn('project', 'bootstrap-discovery-failed', {
        slug,
        bots: registry.map((e) => e.canonicalName),
      });
      await reply(ctx, '❌ /project bootstrap 无法读取群内 bot 列表，未派发任何命令。');
      return;
    }

    const mergedRegistry = mergeRegistry(
      defaultRegistry(),
      (ctx.controls.profileConfig as { botRegistry?: BotRegistryEntry[] }).botRegistry ?? [],
    );
    const registry = selectBootstrapTargetRegistry(mergedRegistry, targetBot);
    if (!registry.length) {
      await reply(ctx, `❌ 未找到实现方：\`${targetBot}\``);
      return;
    }
    const coordinatorName = (ctx.channel as { botIdentity?: { name?: string } }).botIdentity?.name ?? '小P';
    const coordinatorOpenId = (ctx.channel as { botIdentity?: { openId?: string } }).botIdentity?.openId ?? ctx.msg.senderId;

    await maybeSwitchBootstrapCoordinatorWorkspace(ctx, workspacePath, mergedRegistry, coordinatorName);
    await ensureBootstrapCoordinatorAllowedChat(ctx);

    const inviteState = await inviteMissingBootstrapBots(
      ctx.msg.chatId,
      registry,
      liveMembers,
      coordinatorName,
      larkCliEnv,
    );
    if (inviteState.invitedAny) {
      try {
        liveMembers = await rediscoverBootstrapBotsAfterInvite(
          discovery,
          ctx.msg.chatId,
          registry,
          coordinatorName,
        );
      } catch {
        // Keep the original discovery result; remaining missing bots will be
        // reported as not in group, while explicit invite failures are kept.
      }
    }

    const plan = planBootstrap({
      slug,
      workspacePath,
      chatId: ctx.msg.chatId,
      coordinatorName,
      coordinatorOpenId,
      dispatcherProfile: ctx.controls.profile,
      liveMembers,
      registry,
      pinned: new Map(),
      participants: registry.map((e) => e.canonicalName),
    });

    // B3: dispatch with proper send tracking — sent only on success
    const dispatchResults = new Map<string, BootstrapResult>();
    for (const r of plan.results) dispatchResults.set(r.botName, { ...r });

    for (const instr of plan.instructions) {
      if (instr.kind === 'cd-and-invite') {
        // The target bot must allowlist this group before later operational
        // commands in the same bootstrap flow can pass intake.
        const inviteSent = await ctx.channel.send(ctx.msg.chatId, {
          text: `<at user_id="${instr.targetOpenId}">${instr.targetName}</at> /invite group`,
        }).then(() => true).catch(() => false);

        const cdSent = await ctx.channel.send(ctx.msg.chatId, {
          text: `<at user_id="${instr.targetOpenId}">${instr.targetName}</at> /cd ${instr.workspacePath}`,
        }).then(() => true).catch(() => false);

        if (inviteSent && cdSent) {
          dispatchResults.set(instr.targetName, {
            botName: instr.targetName,
            status: 'sent',
          });
        } else {
          dispatchResults.set(instr.targetName, {
            botName: instr.targetName,
            status: 'blocked',
            blockedReason: 'dispatch_failed',
          });
        }
      }
    }

    // Merge dispatch results into plan results
    const finalResults = plan.results.map((r) => {
      const inviteFailure = inviteState.inviteFailed.get(r.botName);
      if (inviteFailure) return inviteFailure;
      return dispatchResults.get(r.botName) ?? r;
    });

    log.info('project', 'bootstrap-dispatched', {
      slug,
      instructions: plan.instructions.length,
      results: finalResults.length,
      blocked: finalResults.filter((r) => r.status === 'blocked').length,
    });
  } finally {
    projectStartInFlight.delete(key);
  }
}

async function ensureBootstrapCoordinatorAllowedChat(ctx: CommandContext): Promise<void> {
  const chatId = ctx.msg.chatId;
  await saveAccessConfig(ctx, (current) => {
    if (current.allowedChats.includes(chatId)) return current;
    return {
      ...current,
      allowedChats: [...current.allowedChats, chatId],
    };
  });
}

async function rediscoverBootstrapBotsAfterInvite(
  discovery: ReturnType<typeof createSdkLiveDiscovery>,
  chatId: string,
  registry: BotRegistryEntry[],
  coordinatorName: string,
): Promise<LiveBotMember[]> {
  let latest: LiveBotMember[] = [];
  for (let attempt = 0; attempt < BOOTSTRAP_INVITE_DISCOVERY_ATTEMPTS; attempt += 1) {
    latest = await discovery.discoverBots(chatId);
    if (bootstrapRegistryPresent(registry, latest, coordinatorName)) {
      return latest;
    }
    if (attempt < BOOTSTRAP_INVITE_DISCOVERY_ATTEMPTS - 1) {
      await sleep(BOOTSTRAP_INVITE_DISCOVERY_DELAY_MS);
    }
  }
  return latest;
}

function bootstrapRegistryPresent(
  registry: BotRegistryEntry[],
  liveMembers: LiveBotMember[],
  coordinatorName: string,
): boolean {
  return registry.every((entry) =>
    entry.canonicalName === coordinatorName || Boolean(findBootstrapLiveMember(entry, liveMembers)),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleDoc(args: string, ctx: CommandContext): Promise<void> {
  void args;
  await reply(ctx, '云文档评论现在不需要绑定工作区；在支持的文档评论里 @bot 即可触发回复。');
}

const WORKSPACE_NAME_SEPARATOR = '\u001f';

function scopedWorkspaceName(ctx: CommandContext, name: string): string {
  return [
    ctx.controls.profile,
    ctx.controls.botOwnerId ?? 'owner-unknown',
    ctx.scope,
    name,
  ].join(WORKSPACE_NAME_SEPARATOR);
}

function workspaceAliasKeys(ctx: CommandContext, name: string): string[] {
  return [scopedWorkspaceName(ctx, name), name];
}

function getWorkspaceAlias(ctx: CommandContext, name: string): string | undefined {
  for (const key of workspaceAliasKeys(ctx, name)) {
    const cwd = ctx.workspaces.getNamed(key);
    if (cwd) return cwd;
  }
  return undefined;
}

function removeWorkspaceAlias(ctx: CommandContext, name: string): boolean {
  const scopedKey = scopedWorkspaceName(ctx, name);
  if (ctx.workspaces.removeNamed(scopedKey)) return true;
  return ctx.workspaces.removeNamed(name);
}

function isLegacyWorkspaceAlias(key: string): boolean {
  return key !== '' && !key.includes(WORKSPACE_NAME_SEPARATOR);
}

function listScopedWorkspaces(ctx: CommandContext): Record<string, string> {
  const prefix = scopedWorkspaceName(ctx, '');
  const named = ctx.workspaces.listNamed();
  const scoped: Record<string, string> = {};
  for (const [key, cwd] of Object.entries(named)) {
    if (!key.startsWith(prefix)) continue;
    const displayName = key.slice(prefix.length);
    if (displayName) scoped[displayName] = cwd;
  }
  for (const [key, cwd] of Object.entries(named)) {
    if (isLegacyWorkspaceAlias(key) && scoped[key] === undefined) scoped[key] = cwd;
  }
  return scoped;
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return applyResume(rest, ctx);
  }

  // Default: list recent sessions
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }

  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '群聊中不展示历史会话详情。请私聊 bot 使用 `/resume` 查看和选择历史会话。');
    return;
  }

  if (ctx.controls.profileConfig.agentKind === 'codex') {
    const identity = ctx.sessionCatalogIdentity;
    const entry =
      ctx.sessionCatalog && identity
        ? ctx.sessionCatalog.activeFor(identity)
        : undefined;
    const history = identity ? await listCodexResumeHistory(ctx, cwd, limit) : [];
    const visibleHistory =
      identity && ctx.promptSessionService
        ? history.filter((thread) =>
            ctx.promptSessionService!.canManualResume({
              identity,
              origin: commandPromptOrigin(ctx),
              agentSessionId: thread.threadId,
              updatedAt: thread.updatedAtMs,
            }),
          )
        : history;
    if (visibleHistory.length > 0 && identity) {
      const entries = visibleHistory.map((thread) => {
        const nonce = issueResumeCandidate(identity, {
          threadId: thread.threadId,
          updatedAt: thread.updatedAtMs,
        });
        return {
          sessionId: nonce,
          preview: thread.name || thread.preview,
          relTime: formatRelTime(thread.updatedAtMs),
          detail: `Codex · ${thread.source}`,
          current: thread.threadId === entry?.threadId,
        };
      });
      const card = resumeCard(cwd, entries);
      await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
      return;
    }
    if (entry?.threadId && identity) {
      if (
        ctx.promptSessionService &&
        !ctx.promptSessionService.canManualResume({
          identity,
          origin: commandPromptOrigin(ctx),
          agentSessionId: entry.threadId,
          updatedAt: entry.updatedAt,
        })
      ) {
        const card = resumeCard(cwd, []);
        await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
        return;
      }
      const nonce = issueResumeCandidate(identity, {
        threadId: entry.threadId,
        updatedAt: entry.updatedAt,
      });
      await reply(
        ctx,
        `当前 Codex thread 可恢复。\n使用 \`/resume use ${nonce}\` 恢复（10 分钟内有效）。`,
      );
      return;
    }
    const card = resumeCard(cwd, []);
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }

  const sessions = await listClaudeResumeHistory(ctx, cwd, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope);
  const identity = ctx.sessionCatalogIdentity;
  const visibleSessions =
    identity && ctx.promptSessionService
      ? sessions.filter((session) =>
          ctx.promptSessionService!.canManualResume({
            identity,
            origin: commandPromptOrigin(ctx),
            agentSessionId: session.sessionId,
            updatedAt: session.mtime,
          }),
        )
      : sessions;
  const entries = visibleSessions.map((s) => ({
    sessionId: identity
      ? issueResumeCandidate(identity, { sessionId: s.sessionId, updatedAt: s.mtime })
      : s.sessionId,
    displayId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId,
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    const entry = ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity);
    const resolved = consumeResumeCandidate(sessionId, ctx.sessionCatalogIdentity);
    if (resolved) {
      if (ctx.promptSessionService) {
        try {
          const applied = await ctx.promptSessionService.applyManualResume({
            identity: ctx.sessionCatalogIdentity,
            origin: commandPromptOrigin(ctx),
            agentSessionId: (resolved.sessionId ?? resolved.threadId)!,
            updatedAt: resolved.updatedAt,
          });
          if (applied === 'applied') {
            ctx.activeRuns.interrupt(ctx.scope);
            await reply(ctx, RESUME_APPLIED_REPLY);
            return;
          }
        } catch {
          await reply(ctx, '当前上下文不可恢复这个会话，请重新选择可用会话。');
          return;
        }
      }
      ctx.activeRuns.interrupt(ctx.scope);
      if (ctx.sessionCatalogIdentity.agentId === 'codex') {
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: 'codex',
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          threadId: resolved.threadId!,
        });
      } else {
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: 'claude',
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          sessionId: resolved.sessionId!,
        });
        ctx.sessions.set(ctx.scope, resolved.sessionId!, ctx.sessionCatalogIdentity.cwdRealpath);
      }
      await reply(ctx, RESUME_APPLIED_REPLY);
      return;
    }
    if (ctx.sessionCatalogIdentity.agentId === 'codex') {
      await reply(ctx, '当前上下文不可恢复这个会话，请先用 `/resume` 重新生成恢复候选。');
      return;
    }
    const expected = entry?.sessionId;
    if (expected !== sessionId) {
      await reply(ctx, '当前上下文不可恢复这个会话，请重新选择当前工作区和权限策略下的会话。');
      return;
    }
    ctx.activeRuns.interrupt(ctx.scope);
    if (ctx.sessionCatalogIdentity.agentId === 'claude') {
      ctx.sessions.set(ctx.scope, sessionId, ctx.sessionCatalogIdentity.cwdRealpath);
    }
    await reply(ctx, RESUME_APPLIED_REPLY);
    return;
  }

  if (ctx.controls.profileConfig.agentKind === 'codex') {
    await reply(ctx, '当前上下文没有可恢复的 Codex thread，请先在当前工作区完成一次运行。');
    return;
  }

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  await reply(ctx, RESUME_APPLIED_REPLY);
}

function issueResumeCandidate(
  identity: SessionCatalogIdentity,
  target: ({ sessionId: string } | { threadId: string }) & { updatedAt: number },
): string {
  pruneResumeCandidates();
  let nonce = randomUUID().slice(0, 12);
  while (resumeCandidates.has(nonce)) nonce = randomUUID().slice(0, 12);
  resumeCandidates.set(nonce, {
    scopeId: identity.scopeId,
    agentId: identity.agentId,
    cwdRealpath: identity.cwdRealpath,
    policyFingerprint: identity.policyFingerprint,
    ...target,
    expiresAt: Date.now() + RESUME_CANDIDATE_TTL_MS,
  });
  return nonce;
}

function commandPromptOrigin(ctx: CommandContext) {
  return {
    source: 'im' as const,
    scopeId: ctx.scope,
    chatId: ctx.msg.chatId,
    chatType: 'p2p' as const,
  };
}

function consumeResumeCandidate(
  nonce: string,
  identity: SessionCatalogIdentity,
): ResumeCandidate | undefined {
  pruneResumeCandidates();
  const candidate = resumeCandidates.get(nonce);
  if (!candidate) return undefined;
  resumeCandidates.delete(nonce);
  if (
    candidate.scopeId !== identity.scopeId ||
    candidate.agentId !== identity.agentId ||
    candidate.cwdRealpath !== identity.cwdRealpath ||
    candidate.policyFingerprint !== identity.policyFingerprint ||
    (identity.agentId === 'claude' && !candidate.sessionId) ||
    (identity.agentId === 'codex' && !candidate.threadId)
  ) {
    return undefined;
  }
  return candidate;
}

function pruneResumeCandidates(now = Date.now()): void {
  for (const [nonce, candidate] of resumeCandidates.entries()) {
    if (candidate.expiresAt <= now) resumeCandidates.delete(nonce);
  }
}

async function listClaudeResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<SessionSummary[]> {
  const provider = ctx.claudeHistoryProvider ?? listRecentSessions;
  return provider(cwd, limit);
}

async function listCodexResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<CodexThreadHistoryEntry[]> {
  const codex = ctx.controls.profileConfig.codex;
  const binary = codex?.binaryPath;
  if (!binary) return [];

  const provider = ctx.codexHistoryProvider ?? listCodexThreadHistory;
  try {
    return await provider({
      binary,
      cwd,
      limit,
      profileStateDir: commandProfilePaths(ctx).profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      ...(codex.inheritCodexHome !== undefined
        ? { inheritCodexHome: codex.inheritCodexHome }
        : {}),
    });
  } catch (err) {
    log.warn('session', 'codex-history-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function effectiveWorkspaceCwd(ctx: CommandContext): string | undefined {
  return ctx.workspaces.cwdFor(ctx.scope) ?? ctx.controls.profileConfig.workspaces.default;
}

function selectedResumeCwd(ctx: CommandContext): string | undefined {
  return effectiveWorkspaceCwd(ctx);
}

function runtimeAccessStatus(
  profileConfig: ProfileConfig,
): { label: string; value: string } {
  if (profileConfig.agentKind === 'claude') {
    return {
      label: 'permission',
      value: accessToClaudePermissionMode(
        profileConfig.permissions.defaultAccess,
        profileConfig.permissions,
      ),
    };
  }
  return {
    label: 'sandbox',
    value: `${profileConfig.sandbox.defaultMode}/${profileConfig.sandbox.maxMode}`,
  };
}

async function larkCliStatus(ctx: CommandContext): Promise<'app' | 'user-ready' | 'user-missing' | 'check-failed'> {
  const appPaths = commandProfilePaths(ctx);
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === ctx.controls.profileConfig.accounts.app.id &&
        candidate.brand === ctx.controls.profileConfig.accounts.app.tenant,
    );
    if (app?.defaultAs === 'auto' && app.strictMode === 'off' && hasStructuredLarkCliUserAuth(app.users)) {
      return 'user-ready';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'check-failed';
  }
  if (
    ctx.controls.profileConfig.larkCli.identityPreset === 'user-default' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    return 'user-missing';
  }
  return 'app';
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx);
  const sess = ctx.sessions.getRaw(ctx.scope);
  const isCodex = ctx.controls.profileConfig.agentKind === 'codex';
  const catalogEntry =
    isCodex && ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const card = statusCard({
    profileName: ctx.controls.profile,
    cwd,
    sessionId: isCodex ? catalogEntry?.threadId : sess?.sessionId,
    emptySessionText: isCodex ? '(未建立)' : undefined,
    sessionStale: !isCodex && Boolean(cwd && sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    runtimeAccess: runtimeAccessStatus(ctx.controls.profileConfig),
    larkCliStatus: await larkCliStatus(ctx),
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    activeScopes: ctx.activeRuns.scopes().filter((scope) => !scope.startsWith('comment:')),
    activeCommentScopes: ctx.activeRuns.scopes().filter((scope) => scope.startsWith('comment:')),
    queue: ctx.processPool?.snapshot(),
    ownerState: formatOwnerState(ctx),
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

function formatOwnerState(ctx: CommandContext): string {
  const state = ctx.controls.ownerRefreshState;
  const owner = ctx.controls.botOwnerId ? 'present' : 'missing';
  const refreshed = ctx.controls.ownerRefreshedAt
    ? ` refreshed=${new Date(ctx.controls.ownerRefreshedAt).toISOString()}`
    : '';
  return `${state} owner=${owner}${refreshed}`;
}

async function handleStop(args: string, ctx: CommandContext): Promise<void> {
  const targetScope = args.trim();
  if (targetScope && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 指定 scope 停止任务仅管理员可用。');
    return;
  }
  const scope = targetScope || ctx.scope;
  const ok = ctx.activeRuns.interrupt(scope);
  log.info('command', 'stop', {
    scope,
    targeted: Boolean(targetScope),
    interrupted: ok,
  });
  if (targetScope) {
    await reply(
      ctx,
      ok
        ? `已请求停止 \`${scope}\`。`
        : `未找到正在运行的任务：\`${scope}\`。`,
    );
  }
  // No reply for the current IM scope: if there was a run, its in-flight
  // render loop will mark the card as interrupted and re-render.
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const parsed = parseTimeoutTarget(trimmed, ctx.scope);
  if (
    parsed.targeted &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    await reply(ctx, '❌ 指定 scope 设置 timeout 仅管理员可用。');
    return;
  }
  const scope = parsed.scope;
  const value = parsed.value;
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!value) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 session 设 15 分钟\n- `/timeout off` 当前 session 关闭探活\n- `/timeout default` 清除 session 覆盖,回退全局\n- `/timeout comment:<scopeHash> 15` 管理员设置 comment scope\n\n_注:`/new` 会清掉当前 session 的覆盖,回到全局_';
    const scopeLabel = parsed.targeted ? ` (${scope})` : '';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:${effective}\n全局默认:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:跟随全局(${formatGlobal()})${usage}`);
    return;
  }

  if (value === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(scope);
    log.info('command', 'timeout-clear', { scope, cleared, targeted: parsed.targeted });
    await reply(
      ctx,
      cleared
        ? `✅ 已清除 session 覆盖,回退到全局(${formatGlobal()})。`
        : `当前 session 本来就没设过覆盖,跟随全局(${formatGlobal()})。`,
    );
    return;
  }

  if (value === 'off' || value === '0') {
    ctx.sessions.setIdleTimeoutMinutes(scope, 0);
    log.info('command', 'timeout-off', { scope, targeted: parsed.targeted });
    await reply(ctx, '✅ 已关闭当前 session 的探活。');
    return;
  }

  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(scope, n);
  log.info('command', 'timeout-set', { scope, minutes: n, targeted: parsed.targeted });
  await reply(ctx, `✅ 当前 session 探活已设为 ${n} 分钟。`);
}

function parseTimeoutTarget(input: string, currentScope: string): {
  scope: string;
  value: string;
  targeted: boolean;
} {
  const parts = input.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (first.startsWith('comment:')) {
    return {
      scope: first,
      value: parts.slice(1).join(' '),
      targeted: true,
    };
  }
  return {
    scope: currentScope,
    value: input,
    targeted: false,
  };
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

async function handleReconnect(args: string, ctx: CommandContext): Promise<void> {
  const wait = args.trim().split(/\s+/).filter(Boolean).includes('--wait');
  log.info('command', 'reconnect', { wait });
  await reply(ctx, wait ? '⏳ 将在当前运行结束后重连…' : '⏳ 正在停止当前运行并重连…');
  let resumeNewRuns: (() => void) | undefined;
  try {
    resumeNewRuns = ctx.activeRuns.pauseNewRuns('reconnect-in-progress');
    if (wait) {
      await ctx.activeRuns.waitForAll();
    } else {
      await ctx.activeRuns.stopAll();
    }
    await ctx.controls.restart({ wait });
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    reportMetric('command_fail', 1, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  } finally {
    resumeNewRuns?.();
  }
}

const DOCTOR_ECHO_PROMPT =
  'Bridge doctor agent echo check. Do not inspect files, do not use history, and reply exactly: OK';
const DOCTOR_RATE_LIMIT_MS = 30_000;
const doctorInFlightProfiles = new Set<string>();
const doctorLastByOperator = new Map<string, number>();

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });

  const rateKey = `${ctx.controls.profile}:${ctx.controls.configPath}:${ctx.msg.senderId}`;
  const now = Date.now();
  const last = doctorLastByOperator.get(rateKey);
  if (last !== undefined && now - last < DOCTOR_RATE_LIMIT_MS) {
    await reply(ctx, 'doctor rate limited: 同一用户 30 秒内只能触发一次。');
    return;
  }

  const requestedCwd = effectiveWorkspaceCwd(ctx);
  if (!requestedCwd) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck:
          '未设置工作目录。先用 `/cd <path>` 或 `/ws use <name>` 选择工作目录后再运行 agent echo check。',
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `${workspace.userVisible} 工作目录不可用时只执行 self-check，不启动 agent。`,
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  if (!ctx.runExecutor) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: 'run executor unavailable',
      }),
    );
    return;
  }

  const profileKey = ctx.controls.profile;
  if (doctorInFlightProfiles.has(profileKey)) {
    await reply(ctx, 'doctor in-flight: 当前 profile 已有诊断运行中。');
    return;
  }
  doctorLastByOperator.set(rateKey, now);

  const capability =
    ctx.controls.profileConfig.agentKind === 'codex'
      ? codexCapability(ctx.controls.profileConfig)
      : claudeCapability(ctx.controls.profileConfig);
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: ctx.msg.chatId,
      actorId: ctx.msg.senderId,
      ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    },
    attachments: [],
    prompt: DOCTOR_ECHO_PROMPT,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId),
    capability,
    profileConfig: ctx.controls.profileConfig,
    now,
    ttlMs: 60_000,
  });
  if (!policy.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: policy.rejectReason.userVisible,
      }),
    );
    return;
  }
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const doctorReport = (echoCheck: string): string =>
    buildDoctorReport(ctx, {
      workspaceCheck: `ok (${workspace.cwdRealpath})`,
      policyCheck:
        runtimeAccess.label === 'sandbox'
          ? `ok sandbox=${policy.sandbox}`
          : `ok ${runtimeAccess.label}=${policy.permissionMode}`,
      echoCheck,
    });

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  doctorInFlightProfiles.add(profileKey);
  let execution: Awaited<ReturnType<RunExecutor['submit']>>;
  try {
    execution = await ctx.runExecutor.submit({
      scopeId: `${ctx.scope}:doctor`,
      policy,
      nowait: true,
      stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
      observability: {
        profile: ctx.controls.profile,
        agent: capability.agentId,
        source: 'doctor',
        stage: 'agent-probe',
      },
    });
  } catch (err) {
    doctorInFlightProfiles.delete(profileKey);
    if (err instanceof RunRejected && err.code === 'pool-full') {
      await reply(ctx, doctorReport('pool-full'));
      return;
    }
    log.fail('command', err, { step: 'doctor.submit' });
    reportMetric('command_fail', 1, { step: 'doctor.submit' });
    await reply(ctx, doctorReport('failed'));
    return;
  }

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(withDoctorReport(initialState, doctorReport('pending'))),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              let echoText = '';
              const echoStatus = (): string => formatDoctorEchoStatus(echoText, state);
              const flush = (): Promise<void> =>
                ctrl.update(renderCard(withDoctorReport(state, doctorReport(echoStatus()))));
              for await (const evt of execution.subscribe()) {
                if (execution.handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  continue;
                }
                if (evt.type === 'text') echoText += evt.delta;
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some claude versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group / topic: buffer to completion, then DM the final card to the
      // operator. No live streaming — the group should see nothing past the
      // ack reply above.
      let state: RunState = initialState;
      let echoText = '';
      for await (const evt of execution.subscribe()) {
        if (execution.handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          continue;
        }
        if (evt.type === 'text') echoText += evt.delta;
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.send(ctx.msg.senderId, {
        card: renderCard(
          withDoctorReport(state, doctorReport(formatDoctorEchoStatus(echoText, state))),
        ),
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
    reportMetric('command_fail', 1, { step: 'doctor' });
  } finally {
    doctorInFlightProfiles.delete(profileKey);
  }
}

function buildDoctorReport(
  ctx: CommandContext,
  opts: {
    workspaceCheck?: string;
    policyCheck?: string;
    echoCheck?: string;
  } = {},
): string {
  const queue = ctx.processPool?.snapshot();
  const queueLine = queue
    ? `${queue.active}/${queue.cap} active, ${queue.waiting} waiting`
    : 'unknown';
  const cwd = effectiveWorkspaceCwd(ctx);
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const access =
    ctx.msg.chatType === 'p2p'
      ? canUseDm(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId)
      : canUseGroup(
          ctx.controls.profileConfig,
          ctx.controls,
          ctx.msg.chatId,
          ctx.msg.senderId,
        );
  return [
    'self-check: ok',
    `profile: ${ctx.controls.profile}`,
    `agent: ${ctx.agent.displayName} (${ctx.controls.profileConfig.agentKind})`,
    `workspace: ${cwd ?? '(未设置)'}`,
    `workspace default: ${ctx.controls.profileConfig.workspaces.default ? 'set' : 'missing'}`,
    `${runtimeAccess.label}: ${runtimeAccess.value}`,
    `access: ${access.ok ? 'ok' : 'denied'} (${access.reason})`,
    `owner API: ${formatOwnerState(ctx)}`,
    `queue: ${queueLine}`,
    `run executor: ${ctx.runExecutor ? 'available' : 'unavailable'}`,
    ...(opts.workspaceCheck ? [`workspace check: ${opts.workspaceCheck}`] : []),
    ...(opts.policyCheck ? [`policy check: ${opts.policyCheck}`] : []),
    ...(opts.echoCheck ? [`agent echo check: ${opts.echoCheck}`] : []),
  ].join('\n');
}

function withDoctorReport(state: RunState, report: string): RunState {
  return {
    ...state,
    blocks: [{ kind: 'text', content: report, streaming: false }, ...state.blocks],
  };
}

function formatDoctorEchoStatus(echoText: string, state: RunState): string {
  const trimmed = echoText.trim();
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  if (state.terminal === 'running') return 'pending';
  if (state.terminal === 'done') return 'empty';
  return state.terminal;
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard(ctx.agent.displayName);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

// ─── /account ─────────────────────────────────────────────────────────────

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showCurrent(ctx);
    case 'change':
      return showForm(ctx);
    case 'submit':
      return submitAccount(ctx);
    case 'cancel':
      return cancelAccount(ctx);
    default:
      await reply(ctx, '用法：`/account` 或 `/account change`');
  }
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  // Current-status card has only a [更换凭据] button — never updated in-place,
  // so an inline card is sufficient (and avoids creating a managed card we'd
  // never re-touch).
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  // Cancel = remove the form card. No follow-up message.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

// Lark's client holds a local "form just submitted" state for a short
// window after the click that overrides any cardkit.card.update we issue.
// We always wait at least this long before flipping the form card to its
// terminal (success/failure) state. Empirically ~1s is enough; less than
// that and the update gets reverted to the form's pre-submit state.
const FORM_SETTLE_MS = 1000;

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const restart = ctx.controls.restart;
  const retryReplyOptions = commandReplyOptions(ctx);

  // CRITICAL: detach the work from the cardAction handler. Lark's client
  // keeps the form locked while the handler is pending — if we await the
  // 2s settle window inline, the lock holds, and the moment we return the
  // client snaps the card back to its cached form state (overwriting any
  // update we made). Returning immediately lets the lock release; the
  // delayed updateManagedCard then sticks.
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // Success path: in-place update. The card never accepts another submit
    // (success card has no form), so this is fine.
    const finishSuccess = async (card: object): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, card).catch((err) =>
        console.warn('[account] form update failed:', err),
      );
      forgetManagedCard(formMsgId);
    };

    // Failure path: leave the old form card as a static "❌ 校验失败" record
    // (in-place update to a non-form card so it stops responding to clicks),
    // then post a fresh managed form card below for retry. We can't reuse
    // the original card_id for the retry form because Lark's client locks
    // form interactions on it once submitted — even a re-rendered form on
    // the same card_id no longer fires cardActions.
    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
        .catch((err) => console.warn('[account] mark old form failed:', err));
      forgetManagedCard(formMsgId);
      // Don't prefill the secret on retry — pre-filled secrets can get
      // echoed back into the card payload and may persist in Lark's
      // server-side card cache. Keep appId prefilled (non-sensitive).
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId,
      });
      await sendManagedCard(channel, chatId, retry, retryReplyOptions).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure('App ID 或 App Secret 为空');
      return;
    }

    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? 'unknown');
      return;
    }

    // Encrypted-at-rest path: store the plaintext secret in the AES keystore,
    // and write config.json with an exec-provider SecretRef instead of the
    // raw secret. lark-cli's `config bind --source lark-channel` reads the
    // same SecretRef and goes through the exec protocol to retrieve the
    // plaintext into its own OS keychain — no plaintext on disk.
    try {
      const appPaths = commandProfilePaths(ctx);
      const newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
        appPaths,
      );
      await saveAccountConfig(ctx, newCfg, appSecret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`保存凭据失败：${msg}`);
      return;
    }

    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));

    // Give the user 1.5s to read the success state before we tear down the
    // WS and reconnect with new credentials.
    setTimeout(() => {
      void restart().catch((err) => {
        console.error('[account] restart failed:', err);
        process.exit(1);
      });
    }, 1500);
  })();
}

async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.recallMessage(messageId);
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

// ────────────── /invite and /remove — access lists ──────────────

async function handleInvite(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());

  // owner-default group — precise grammar, must be exactly ['owner-default', 'group'].
  // Intercept before the legacy 'all group' branch so /invite all owner-default group
  // does NOT fall through to the old allowedChats path.
  if (tokens.includes('owner-default')) {
    if (tokens.length !== 2 || tokens[0] !== 'owner-default' || tokens[1] !== 'group') {
      await reply(
        ctx,
        '用法：\n' +
          '• `/invite owner-default group` — 把当前群加入**本 Bot** 的 owner 免 @ 名单\n' +
          '（需要 @ 当前 Bot）',
      );
      return;
    }
    // p2p intercept before mentionedBot guard
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/invite owner-default group` 只能在目标群中 @ 当前 Bot 执行，私聊里无法指定群。');
      return;
    }
    // Command-layer @ guard
    if (!ctx.msg.mentionedBot) {
      await reply(ctx, '❌ 请 @ 当前 Bot 执行该命令。');
      return;
    }
    // Permission gate
    const perm = canRunBotAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId);
    if (!perm.ok) {
      await reply(ctx, '❌ 你没有权限执行该命令。需要应用 owner、人类管理员或 Bot 管理员权限。');
      return;
    }
    const chatId = ctx.msg.chatId;
    const currentMode = ctx.controls.profileConfig.access.groupResponseMode;
    let already = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.ownerNoMentionChats);
      already = list.has(chatId);
      if (!already) list.add(chatId);
      return {
        ...current,
        ownerNoMentionChats: [...list],
      };
    });
    const modeHint =
      currentMode !== 'owner-allowlist'
        ? '\n_名单已保存。当前群消息响应方式不是「仅在指定群响应 owner 无 @ 消息」，切换到该模式后生效。_'
        : '';
    if (already) {
      await reply(ctx, `✅ 当前群已在**本 Bot** 的 owner 免 @ 名单中，无需重复添加。${modeHint}`);
      return;
    }
    await reply(ctx, `✅ 已把当前群加入**本 Bot** 的 owner 免 @ 名单。${modeHint}`);
    return;
  }

  if (tokens.includes('all') && tokens.includes('group')) {
    const list = new Set(ctx.controls.profileConfig.access.allowedChats);
    let knownChats = ctx.controls.knownChats ?? [];
    if (knownChats.length === 0) {
      knownChats = await fetchKnownChats(ctx.channel);
      ctx.controls.knownChats = knownChats;
    }
    let added = 0;
    let total = list.size;
    await saveAccessConfig(ctx, (current) => {
      list.clear();
      for (const chatId of current.allowedChats) list.add(chatId);
      added = 0;
      for (const chat of knownChats) {
        if (!list.has(chat.id)) {
          list.add(chat.id);
          added += 1;
        }
      }
      total = list.size;
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (knownChats.length === 0) {
      await reply(ctx, '当前 bot 还不在任何群里，没有可加入的群。');
    } else {
      await reply(ctx, `✅ 已把 bot 所在的 ${added} 个群加入响应群名单（共 ${total} 个）。`);
    }
    return;
  }

  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/invite user @某人` — 加入允许私聊\n' +
        '• `/invite admin @某人` — 加入管理员\n' +
        '• `/invite group` — 把当前群加入响应群名单\n' +
        '• `/invite all group` — 把 bot 所在的所有群一键加入\n' +
        '• `/invite owner-default group` — 把当前群加入 owner 免 @ 名单（需 @ 当前 Bot）',
    );
    return;
  }

  // botAdmin may only use /invite group, not user or admin
  if (kind !== 'group' && isBotAdmin(ctx.controls.profileConfig, ctx.msg.senderId)) {
    await reply(ctx, '❌ Bot 管理员只能使用 `/invite group`，不能管理用户或人类管理员。');
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/invite group` 只能在群里发，在私聊里没有 chat_id 可以加。');
      return;
    }
    const chatId = ctx.msg.chatId;
    let already = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      already = list.has(chatId);
      if (!already) list.add(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (already) {
      await reply(ctx, '✅ 当前群已在白名单里，无需重复添加。');
      return;
    }
    await reply(ctx, `✅ 已把当前群（\`${chatId}\`）加入响应群名单。`);
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(
      ctx,
      `❌ 没检测到 @ 的用户。请像这样发：\`/invite ${kind} @某人\`（注意 @ 用户不是 @ bot）。`,
    );
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const added: string[] = [];
  const already: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    added.length = 0;
    already.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        already.push(target.name ?? target.openId);
      } else {
        list.add(target.openId);
        added.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (added.length > 0) parts.push(`✅ 已把 ${added.join('、')} 加入${label}。`);
  if (already.length > 0) parts.push(`_${already.join('、')} 已经在${label}里，跳过。_`);
  await reply(ctx, parts.join('\n'));
}

async function handleRemove(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());

  // owner-default group — precise grammar, mirror of handleInvite
  if (tokens.includes('owner-default')) {
    if (tokens.length !== 2 || tokens[0] !== 'owner-default' || tokens[1] !== 'group') {
      await reply(
        ctx,
        '用法：\n' +
          '• `/remove owner-default group` — 把当前群移出**本 Bot** 的 owner 免 @ 名单\n' +
          '（需要 @ 当前 Bot）',
      );
      return;
    }
    // p2p intercept before mentionedBot guard
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/remove owner-default group` 只能在目标群中 @ 当前 Bot 执行，私聊里无法指定群。');
      return;
    }
    // Command-layer @ guard
    if (!ctx.msg.mentionedBot) {
      await reply(ctx, '❌ 请 @ 当前 Bot 执行该命令。');
      return;
    }
    // Permission gate
    const perm = canRunBotAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId);
    if (!perm.ok) {
      await reply(ctx, '❌ 你没有权限执行该命令。需要应用 owner、人类管理员或 Bot 管理员权限。');
      return;
    }
    const chatId = ctx.msg.chatId;
    const currentMode = ctx.controls.profileConfig.access.groupResponseMode;
    let missing = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.ownerNoMentionChats);
      missing = !list.has(chatId);
      list.delete(chatId);
      return {
        ...current,
        ownerNoMentionChats: [...list],
      };
    });
    const modeHint =
      currentMode !== 'owner-allowlist'
        ? '\n_名单已保存。当前群消息响应方式不是「仅在指定群响应 owner 无 @ 消息」，切换到该模式后生效。_'
        : '';
    if (missing) {
      await reply(ctx, `✅ 当前群本来就不在**本 Bot** 的 owner 免 @ 名单里，无需移除。${modeHint}`);
      return;
    }
    await reply(ctx, `✅ 已把当前群移出**本 Bot** 的 owner 免 @ 名单。${modeHint}`);
    return;
  }

  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/remove user @某人` — 移出用户白名单\n' +
        '• `/remove admin @某人` — 移出管理员\n' +
        '• `/remove group` — 把当前群移出响应群名单\n' +
        '• `/remove owner-default group` — 把当前群移出 owner 免 @ 名单（需 @ 当前 Bot）',
    );
    return;
  }

  // botAdmin may only use /remove group, not user or admin
  if (kind !== 'group' && isBotAdmin(ctx.controls.profileConfig, ctx.msg.senderId)) {
    await reply(ctx, '❌ Bot 管理员只能使用 `/remove group`，不能管理用户或人类管理员。');
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '`/remove group` 请在要移除的群里发，私聊里没有可移除的群。');
      return;
    }
    const chatId = ctx.msg.chatId;
    let missing = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      missing = !list.has(chatId);
      list.delete(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (missing) {
      await reply(ctx, '✅ 当前群本来就不在响应名单里，无需移除。');
      return;
    }
    await reply(ctx, '✅ 已把当前群移出响应群名单。');
    return;
  }

  // Anti-lockout: prevent removing the last human admin
  if (kind === 'admin') {
    const targets = mentionTargets(ctx);
    if (targets.length === 0) {
      await reply(ctx, `请 @ 上要移除的人，例如：\`/remove admin @某人\`。`);
      return;
    }
    const remaining = new Set(ctx.controls.profileConfig.access.admins);
    for (const t of targets) remaining.delete(t.openId);
    if (remaining.size === 0) {
      await reply(ctx, '❌ 不能移除最后一位管理员。请先添加其他管理员再操作，否则将无法管理 bot。');
      return;
    }
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(ctx, `请 @ 上要移除的人，例如：\`/remove ${kind} @某人\`。`);
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const removed: string[] = [];
  const notThere: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    removed.length = 0;
    notThere.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        list.delete(target.openId);
        removed.push(target.name ?? target.openId);
      } else {
        notThere.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (removed.length > 0) parts.push(`✅ 已把 ${removed.join('、')} 移出${label}。`);
  if (notThere.length > 0) parts.push(`${notThere.join('、')} 本来就不在${label}里，无需移除。`);
  await reply(ctx, parts.join('\n'));
}

// ────────────── /botAdmin — manage bot admins (human-admin gated) ──────────────

async function handleBotAdmin(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  switch (sub) {
    case 'add':
      return handleBotAdminAdd(args, ctx);
    case 'remove':
    case 'rm':
      return handleBotAdminRemove(args, ctx);
    case 'list':
    case 'ls':
      return handleBotAdminList(ctx);
    default:
      await reply(
        ctx,
        '用法：\n' +
          '• `/botAdmin add Bot名` — 添加 Bot 管理员\n' +
          '• `/botAdmin remove Bot名` — 移除 Bot 管理员\n' +
          '• `/botAdmin list` — 查看 Bot 管理员列表',
      );
  }
}

async function handleBotAdminAdd(args: string, ctx: CommandContext): Promise<void> {
  const resolved = await botAdminTargets(args, ctx);
  if (resolved.targets.length === 0) {
    await reply(ctx, botAdminNoTargetsMessage('add', resolved));
    return;
  }
  const added: string[] = [];
  const already: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current.botAdmins);
    added.length = 0;
    already.length = 0;
    for (const target of resolved.targets) {
      if (list.has(target.openId)) {
        already.push(target.name ?? target.openId);
      } else {
        list.add(target.openId);
        added.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      botAdmins: [...list],
    };
  });
  log.info('command', 'botAdmin-added', {
    added: added.map((n) => n.slice(-6)),
    subject: ctx.msg.senderId.slice(-6),
  });
  const result: string[] = [];
  if (added.length > 0) result.push(`✅ 已把 ${added.join('、')} 加入 Bot 管理员。`);
  if (already.length > 0) result.push(`_${already.join('、')} 已经在 Bot 管理员里，跳过。_`);
  await reply(ctx, result.join('\n'));
}

async function handleBotAdminRemove(args: string, ctx: CommandContext): Promise<void> {
  const resolved = await botAdminTargets(args, ctx);
  if (resolved.targets.length === 0) {
    await reply(ctx, botAdminNoTargetsMessage('remove', resolved));
    return;
  }
  const removed: string[] = [];
  const notThere: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current.botAdmins);
    removed.length = 0;
    notThere.length = 0;
    for (const target of resolved.targets) {
      if (list.has(target.openId)) {
        list.delete(target.openId);
        removed.push(target.name ?? target.openId);
      } else {
        notThere.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      botAdmins: [...list],
    };
  });
  log.info('command', 'botAdmin-removed', {
    removed: removed.map((n) => n.slice(-6)),
    subject: ctx.msg.senderId.slice(-6),
  });
  const result: string[] = [];
  if (removed.length > 0) result.push(`✅ 已把 ${removed.join('、')} 移出 Bot 管理员。`);
  if (notThere.length > 0) result.push(`${notThere.join('、')} 本来就不在 Bot 管理员里，无需移除。`);
  await reply(ctx, result.join('\n'));
}

async function handleBotAdminList(ctx: CommandContext): Promise<void> {
  const { botAdmins } = ctx.controls.profileConfig.access;
  if (botAdmins.length === 0) {
    await reply(ctx, '当前无 Bot 管理员。');
    return;
  }
  const lines = botAdmins.map(
    (id, i) => `${i + 1}. <at user_id="${id}">${id}</at>（...${id.slice(-6)}）`,
  );
  await reply(ctx, `**Bot 管理员**（共 ${botAdmins.length} 个）：\n${lines.join('\n')}`);
}

function mentionTargets(ctx: CommandContext): Array<{ openId: string; name?: string }> {
  return (ctx.msg.mentions ?? [])
    .filter((mention) => !mention.isBot && typeof mention.openId === 'string' && mention.openId)
    .map((mention) => ({
      openId: mention.openId as string,
      ...(mention.name ? { name: mention.name } : {}),
    }));
}

async function botAdminTargets(
  args: string,
  ctx: CommandContext,
): Promise<{
  targets: Array<{ openId: string; name?: string }>;
  targetNames: string[];
  discoveryFailed: boolean;
}> {
  const targetText = args.trim().split(/\s+/).slice(1).join(' ');
  if (!targetText) return { targets: [], targetNames: [], discoveryFailed: false };

  const targetNames = botAdminTargetNames(targetText);
  if (targetNames.length === 0) return { targets: [], targetNames, discoveryFailed: false };
  const liveBots = await discoverBotAdminLiveMembers(ctx);
  if (!liveBots) {
    return { targets: [], targetNames, discoveryFailed: ctx.chatMode !== 'p2p' };
  }

  const byOpenId = new Map(liveBots.map((member) => [member.openId, member]));
  const byName = new Map(liveBots.map((member) => [member.name.normalize('NFC'), member]));
  const resolved = new Map<string, { openId: string; name?: string }>();
  for (const name of targetNames) {
    const live = byName.get(name.normalize('NFC')) ?? byOpenId.get(name);
    if (!live || resolved.has(live.openId)) continue;
    resolved.set(live.openId, { openId: live.openId, name: live.name });
  }
  return { targets: [...resolved.values()], targetNames, discoveryFailed: false };
}

function botAdminNoTargetsMessage(
  action: 'add' | 'remove',
  resolved: { targetNames: string[]; discoveryFailed: boolean },
): string {
  if (resolved.discoveryFailed) {
    const names = resolved.targetNames.length > 0 ? `：${resolved.targetNames.join('、')}` : '';
    return `❌ 无法读取当前群内 Bot 列表，无法按名称解析 Bot${names}。请确认当前 Bot 的应用权限包含群成员读取 scope 后重试。`;
  }
  return `❌ 没检测到 ${action} 后面的 Bot 名称。请写 \`/botAdmin ${action} Bot名\`。`;
}

function botAdminTargetNames(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of text.split(/[\s,，、]+/)) {
    const name = part.trim().normalize('NFC');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

async function discoverBotAdminLiveMembers(ctx: CommandContext): Promise<LiveBotMember[] | undefined> {
  if (ctx.chatMode === 'p2p') return undefined;
  try {
    const output = await runBootstrapLarkCliJson([
      'im',
      'chat.members',
      'bots',
      '--params',
      JSON.stringify({ chat_id: ctx.msg.chatId }),
      '--as',
      'bot',
      '--format',
      'json',
    ], bootstrapLarkCliEnv(ctx));
    const parsed = JSON.parse(output) as {
      ok?: boolean;
      code?: number;
      msg?: string;
      data?: {
        items?: Array<{ bot_id?: string; bot_name?: string; member_id?: string; name?: string }>;
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
  } catch (err) {
    log.warn('command', 'bot-admin-target-discovery-failed', { err: String(err) });
    return undefined;
  }
}

async function saveAccessConfig(
  ctx: CommandContext,
  mutate: (access: ProfileAccess) => ProfileAccess,
): Promise<ProfileAccess> {
  try {
    return await withConfigFileLock(ctx.controls.configPath, async () => {
      const root = await loadRootConfig(ctx.controls.configPath);
      if (!root) {
        const access = mutate(ctx.controls.profileConfig.access);
        ctx.controls.profileConfig = {
          ...ctx.controls.profileConfig,
          access,
        };
        ctx.controls.cfg.preferences = {
          ...(ctx.controls.cfg.preferences ?? {}),
          access: {
            allowedUsers: access.allowedUsers,
            allowedChats: access.allowedChats,
            admins: access.admins,
            botAdmins: access.botAdmins,
            ownerNoMentionChats: access.ownerNoMentionChats,
          },
          requireMentionInGroup: access.requireMentionInGroup,
        };
        await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
        return access;
      }

      const profile = root.profiles[ctx.controls.profile];
      if (!profile) throw new Error(`profile not found: ${ctx.controls.profile}`);
      const access = mutate(profile.access);
      root.profiles[ctx.controls.profile] = {
        ...profile,
        access,
      };
      await saveRootConfig(root, ctx.controls.configPath);
      ctx.controls.profileConfig = root.profiles[ctx.controls.profile]!;
      ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
      log.info('command', 'access-mutated', {
        allowedUsers: access.allowedUsers.length,
        allowedChats: access.allowedChats.length,
        admins: access.admins.length,
        botAdmins: access.botAdmins.length,
        ownerNoMentionChats: access.ownerNoMentionChats.length,
      });
      return access;
    });
  } catch (err) {
    reportMetric('command_fail', 1, { step: 'access.save' });
    throw err;
  }
}

// ────────────── /config — preferences form ──────────────

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showConfigForm(ctx);
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法:`/config`');
  }
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  await Promise.all([
    ctx.controls.refreshOwner(ctx.channel).catch(() => {}),
    fetchKnownChats(ctx.channel)
      .then((chats) => {
        if (chats.length > 0) ctx.controls.knownChats = chats;
      })
      .catch(() => {}),
  ]);

  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.profileConfig.access;
  const card = configFormCard({
    agentKind: ctx.controls.profileConfig.agentKind,
    model: normalizeModelSelection(
      ctx.controls.profileConfig.agentKind,
      ctx.controls.cfg.preferences?.model,
    ),
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    cotMessages: getCotMessages(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    groupResponseMode: access.groupResponseMode,
    larkCliIdentity: ctx.controls.profileConfig.larkCli.identityPreset,
    allowedUsers: access.allowedUsers,
    allowedChats: access.allowedChats,
    admins: access.admins,
    botAdmins: access.botAdmins,
    knownChats: ctx.controls.knownChats ?? [],
    ownerNoMentionChats: access.ownerNoMentionChats,
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function showResultCardInPlace(
  ctx: CommandContext,
  formMsgId: string,
  card: object,
): Promise<void> {
  try {
    await updateManagedCard(ctx.channel, formMsgId, card);
  } catch (err) {
    log.warn('command', 'config-card-update-fallback', { err: String(err) });
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx)).catch((fallbackErr) =>
      log.warn('command', 'config-card-fallback-send-failed', {
        err: String(fallbackErr),
      }),
    );
  }
  forgetManagedCard(formMsgId);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await showResultCardInPlace(ctx, formMsgId, configCancelledCard());
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : getMessageReplyMode(ctx.controls.cfg);
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  // Parse the model picker. Unexpected / empty values keep the current
  // selection. Store `undefined` for the "default" sentinel to keep config
  // tidy (resolveModelArg treats both the same way).
  const agentKind = ctx.controls.profileConfig.agentKind;
  const rawModel = String(fv.model ?? '').trim();
  const modelValid = rawModel !== '' && supportedModels(agentKind).some((m) => m.value === rawModel);
  const modelSelection = modelValid
    ? rawModel
    : normalizeModelSelection(agentKind, ctx.controls.cfg.preferences?.model);
  const model = modelSelection === DEFAULT_MODEL ? undefined : modelSelection;
  const rawCotMessages = String(fv.cot_messages ?? '').trim();
  const cotMessages =
    rawCotMessages === 'brief'
      ? 'brief'
      : rawCotMessages === 'detailed' || rawCotMessages === 'on'
        ? 'detailed'
        : rawCotMessages === 'off'
          ? 'off'
          : getCotMessages(ctx.controls.cfg);
  // Parse max_concurrent_runs; invalid input falls back to current value.
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  // Parse run_idle_timeout_minutes. 0 disables; otherwise clamp 1-120.
  // Empty string keeps current value.
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  // Canonical tri-state field wins. Continue accepting the legacy boolean
  // field so an already-rendered pre-upgrade config card can still submit.
  const rawGroupResponseMode = String(fv.group_response_mode ?? '').trim();
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let groupResponseMode: GroupResponseMode;
  if (
    rawGroupResponseMode === 'mention-only' ||
    rawGroupResponseMode === 'owner-default' ||
    rawGroupResponseMode === 'all-messages' ||
    rawGroupResponseMode === 'owner-allowlist'
  ) {
    groupResponseMode = rawGroupResponseMode;
  } else if (rawRequireMention === 'yes') {
    groupResponseMode = 'mention-only';
  } else if (rawRequireMention === 'no') {
    groupResponseMode = 'all-messages';
  } else {
    groupResponseMode = getGroupResponseMode(ctx.controls.cfg);
  }
  const requireMentionInGroup = groupResponseMode !== 'all-messages';
  const rawLarkCliIdentity = String(fv.lark_cli_identity ?? '').trim();
  const larkCliIdentity =
    rawLarkCliIdentity === 'user-default' || rawLarkCliIdentity === 'bot-only'
      ? rawLarkCliIdentity
      : ctx.controls.profileConfig.larkCli.identityPreset;
  const previousLarkCliIdentity = ctx.controls.profileConfig.larkCli.identityPreset;
  const larkCliIdentityChanged = larkCliIdentity !== previousLarkCliIdentity;

  const formMsgId = ctx.msg.messageId;
  const access = ctx.controls.profileConfig.access;

  // Detach: same reason as account submit — Lark's client locks the form
  // while the cardAction handler is running. Wait out FORM_SETTLE_MS *after*
  // returning so the in-place card update sticks.
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    const nextPreferences: AppPreferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      model,
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
    };

    let failureStep = 'config.save';
    let larkCliPolicyApplied = false;
    try {
      if (larkCliIdentityChanged) {
        failureStep = 'config.lark-cli-policy';
        const applied = await applyConfigLarkCliIdentityPolicy(ctx, larkCliIdentity);
        if (!applied) {
          throw new Error('lark-cli identity policy apply failed');
        }
        larkCliPolicyApplied = true;
        failureStep = 'config.save';
      }
      await savePreferencesConfig(ctx, nextPreferences, groupResponseMode, larkCliIdentity);
    } catch (err) {
      let rollbackFailed = false;
      if (larkCliIdentityChanged) {
        const rolledBack = await applyConfigLarkCliIdentityPolicy(ctx, previousLarkCliIdentity);
        if (!rolledBack) {
          rollbackFailed = true;
          log.warn('command', 'lark-cli-identity-policy-rollback-failed', {
            profile: ctx.controls.profile,
            identity: previousLarkCliIdentity,
          });
        }
      }
      log.fail('command', err, { step: failureStep });
      reportMetric('command_fail', 1, { step: failureStep });
      await waitForSettle();
      await showResultCardInPlace(
        ctx,
        formMsgId,
        configFailedCard(configFailureMessage(failureStep, rollbackFailed, larkCliPolicyApplied)),
      );
      return;
    }

    log.info('command', 'config-saved', {
      messageReply,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      groupResponseMode,
      requireMentionInGroup,
      larkCliIdentity,
      allowedUsersCount: access.allowedUsers.length,
      allowedChatsCount: access.allowedChats.length,
      adminsCount: access.admins.length,
      botAdminsCount: access.botAdmins.length,
    });
    await waitForSettle();
    await showResultCardInPlace(
      ctx,
      formMsgId,
      configSavedCard({
        agentKind,
        model: modelSelection,
        messageReply,
        showToolCalls,
        cotMessages,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        groupResponseMode,
        larkCliIdentity,
        allowedUsers: access.allowedUsers,
        allowedChats: access.allowedChats,
        admins: access.admins,
        botAdmins: access.botAdmins,
        knownChats: ctx.controls.knownChats ?? [],
        ownerNoMentionChats: access.ownerNoMentionChats,
      }),
    );

    // Non-mention modes only work if the app can actually receive non-@
    // group messages (`im:message.group_msg`). When the user opts in, verify
    // the scope and, if missing, push a one-click re-authorization link.
    if (groupResponseMode !== 'mention-only') {
      await promptGroupMsgScopeIfMissing(ctx);
    }
  })();
}

/**
 * When the user enables a non-mention response mode, confirm the app holds the
 * `im:message.group_msg` scope. If it's missing, generate an incremental
 * authorization link and push a guidance card; once the user finishes
 * authorizing, swap the card to a success state in place. Best-effort — any
 * failure here is logged and swallowed (the saved-config card already showed).
 */
async function promptGroupMsgScopeIfMissing(ctx: CommandContext): Promise<void> {
  const appId = ctx.controls.cfg.accounts.app.id;
  // `false` = confirmed missing; `null` = lookup failed → don't nag.
  const has = await hasGroupMsgScope(ctx.channel, appId);
  if (has !== false) return;
  log.info('command', 'group-msg-scope-missing', { appId });

  let link;
  try {
    link = await requestScopeGrantLink({ appId, tenantScopes: [GROUP_MSG_SCOPE] });
  } catch (err) {
    log.warn('command', 'scope-grant-link-failed', { err: String(err) });
    return;
  }

  const expireMins = Math.max(1, Math.round(link.expireIn / 60));
  let sent;
  try {
    sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      groupMsgScopeGrantCard(link.url, expireMins),
    );
  } catch (err) {
    log.warn('command', 'scope-grant-card-send-failed', { err: String(err) });
    return;
  }

  // Detached: flip the card to "授权成功" once the user authorizes (or just
  // clean up the managed-card mapping if the link expires / is aborted).
  void link.completion.then(
    async () => {
      log.info('command', 'group-msg-scope-granted', { appId });
      await updateManagedCard(ctx.channel, sent.messageId, groupMsgScopeGrantedCard()).catch(
        () => {},
      );
      forgetManagedCard(sent.messageId);
    },
    (err) => {
      log.info('command', 'scope-grant-not-completed', { err: String(err) });
      forgetManagedCard(sent.messageId);
    },
  );
}

function configFailureMessage(step: string, rollbackFailed: boolean, larkCliPolicyApplied: boolean): string {
  if (rollbackFailed) {
    return '保存失败，且 lark-cli 身份策略回滚失败。请执行 /status 检查当前状态。';
  }
  if (larkCliPolicyApplied && step === 'config.save') {
    return '保存失败，lark-cli 身份策略已回滚。请重新打开 /config 确认当前状态。';
  }
  if (step === 'config.lark-cli-policy') {
    return 'lark-cli 身份策略未生效，未做任何修改。';
  }
  return '配置未写入，未做任何修改。';
}

function commandProfilePaths(ctx: CommandContext) {
  return resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
}

async function applyConfigLarkCliIdentityPolicy(
  ctx: CommandContext,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<boolean> {
  const appPaths = commandProfilePaths(ctx);
  const ok = await applyLarkCliIdentityPolicy({
    profile: appPaths.profile,
    rootDir: appPaths.rootDir,
    configPath: ctx.controls.configPath,
    larkCliConfigDir: appPaths.larkCliConfigDir,
    larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
  }, larkCliIdentity).catch(() => false);
  if (!ok) {
    log.warn('command', 'lark-cli-identity-policy-apply-failed', {
      profile: appPaths.profile,
      identity: larkCliIdentity,
    });
  }
  return ok;
}

async function saveAccountConfig(
  ctx: CommandContext,
  newCfg: AppConfig,
  plaintextSecret: string,
): Promise<void> {
  const appPaths = commandProfilePaths(ctx);
  await setSecret(secretKeyForApp(newCfg.accounts.app.id), plaintextSecret, appPaths);

  const root = await loadRootConfig(ctx.controls.configPath);
  if (!root) {
    await saveConfig(newCfg, ctx.controls.configPath);
    ctx.controls.cfg = newCfg;
    return;
  }

  const profile = root.profiles[ctx.controls.profile];
  if (!profile) throw new Error(`profile not found: ${ctx.controls.profile}`);
  root.profiles[ctx.controls.profile] = {
    ...profile,
    accounts: newCfg.accounts,
  };
  if (newCfg.secrets) root.secrets = newCfg.secrets;
  await saveRootConfig(root, ctx.controls.configPath);
  ctx.controls.profileConfig = root.profiles[ctx.controls.profile]!;
  ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
}

async function savePreferencesConfig(
  ctx: CommandContext,
  preferences: AppPreferences,
  groupResponseMode: GroupResponseMode,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<void> {
  const requireMentionInGroup = groupResponseMode !== 'all-messages';
  const larkCli = {
    identityPreset: larkCliIdentity,
    localUserImport: {
      status: 'not-needed' as const,
      attemptedAt: new Date().toISOString(),
      reason: larkCliIdentity === 'user-default' ? 'manual-user-default' : 'manual-bot-only',
    },
  };
  await withConfigFileLock(ctx.controls.configPath, async () => {
    const root = await loadRootConfig(ctx.controls.configPath);
    if (!root) {
      ctx.controls.cfg.preferences = preferences;
      ctx.controls.profileConfig.larkCli = larkCli;
      await saveConfig(ctx.controls.cfg, ctx.controls.configPath);
      return;
    }

    const profile = root.profiles[ctx.controls.profile];
    if (!profile) throw new Error(`profile not found: ${ctx.controls.profile}`);
    const { requireMentionInGroup: _requireMention, access: _access, ...profilePreferences } = preferences;
    root.profiles[ctx.controls.profile] = {
      ...profile,
      preferences: {
        ...profile.preferences,
        ...profilePreferences,
      },
      access: {
        ...profile.access,
        groupResponseMode,
        requireMentionInGroup,
      },
      larkCli,
    };
    await saveRootConfig(root, ctx.controls.configPath);
    ctx.controls.profileConfig = root.profiles[ctx.controls.profile]!;
    ctx.controls.cfg = runtimeProfileConfig(root, ctx.controls.profile);
  });
}
