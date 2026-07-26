export type { BotRegistryEntry } from '../config/bot-registry';

export type BlockedReason =
  | 'ambiguous_name'
  | 'bot_not_in_group'
  | 'invite_failed'
  | 'dispatch_failed';

export type BootstrapStatus = 'sent' | 'blocked';

export interface BootstrapResult {
  botName: string;
  status: BootstrapStatus;
  blockedReason?: BlockedReason;
}

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** Validate a bootstrap slug against the allowlist. */
export function validateSlug(slug: string): { ok: true; slug: string } | { ok: false; reason: string } {
  const trimmed = slug.trim();
  if (!trimmed) return { ok: false, reason: 'bootstrap slug 不能为空。' };
  if (!SLUG_RE.test(trimmed)) {
    return {
      ok: false,
      reason:
        `bootstrap slug 格式无效："${trimmed}"。只允许 [A-Za-z0-9._-]。`,
    };
  }
  return { ok: true, slug: trimmed };
}
