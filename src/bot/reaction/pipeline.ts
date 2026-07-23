import type { ReactionEvent } from '@larksuite/channel';

// ── Reaction turn types (shared across pipeline modules) ──

export interface ReactionGuardDeps {
  botOpenId?: string;
  appId?: string;
}

export type ReactionGuardDenyReason =
  | 'self-operator'
  | 'not-own-message'
  | 'access-dm'
  | 'access-group'
  | 'group-response';

export interface ReactionGuardResult {
  ok: boolean;
  reason?: ReactionGuardDenyReason;
}

/** Deny reason constants — stable keys for tests and logging. */
export const GUARD_DENY_SELF_OPERATOR: ReactionGuardDenyReason = 'self-operator';
export const GUARD_DENY_NOT_OWN_MESSAGE: ReactionGuardDenyReason = 'not-own-message';
export const GUARD_DENY_ACCESS_DM: ReactionGuardDenyReason = 'access-dm';
export const GUARD_DENY_ACCESS_GROUP: ReactionGuardDenyReason = 'access-group';
export const GUARD_DENY_GROUP_RESPONSE: ReactionGuardDenyReason = 'group-response';

// ── Self-operator guard ──

/**
 * Returns true when the reaction operator IS the current bot/app itself.
 * This MUST run before any side effect (permission check, snapshot update,
 * queue push, interrupt, or reply).
 *
 * Checks (any match → self):
 * 1. `evt.operator.openId === botOpenId`
 * 2. `evt.operator.openId === appId`
 * 3. `evt.raw?.operator_type === 'app'` (SDK normalizeReaction drops this field)
 */
export function isSelfOperator(
  evt: ReactionEvent,
  deps: ReactionGuardDeps,
): boolean {
  if (deps.botOpenId && evt.operator.openId === deps.botOpenId) return true;
  if (deps.appId && evt.operator.openId === deps.appId) return true;
  const raw = evt.raw as Record<string, unknown> | undefined;
  if (raw?.operator_type === 'app') return true;
  return false;
}

// ── Own-message check ──

/**
 * Returns true when the target message sender IS the current bot.
 * This is the routing precondition — only reactions on THIS bot's messages
 * are forwarded to the agent.
 */
export function isOwnMessage(
  messageSenderId: string | undefined,
  deps: ReactionGuardDeps,
): boolean {
  if (!messageSenderId) return false;
  if (deps.botOpenId && messageSenderId === deps.botOpenId) return true;
  if (deps.appId && messageSenderId === deps.appId) return true;
  return false;
}
