/**
 * Phase 2 bot registry — identity matching, workspace metadata, and slug
 * validation for `/project bootstrap` task ids.
 *
 * Key rules (from spec review v2):
 *  - Live discovery first: open_ids come from `chat.members bots`, not the
 *    static registry.
 *  - Static registry stores only role, machine, and workspace metadata.
 *  - Matching uses canonical_name + aliases[] with NFC-normalised exact
 *    equality.  No substring or fuzzy matching.
 *  - Pin-on-first-verify: first successful verified receipt persists the
 *    live open_id as a pinned binding (dispatcher-profile scoped).
 *  - Identity-change detection: if a future name match resolves to a
 *    different open_id than the pinned binding, mark blocked(identity_changed).
 *  - Ambiguous names (0 or >1 matches) → blocked(ambiguous_name).
 */

// ── types ──

export type BotRole = 'bridge' | 'non-bridge';

export interface MachineWorkspace {
  kind: 'local' | 'devbox';
  root: string;
}

export interface BotRegistryEntry {
  /** Primary display name used as the NFC match key. */
  canonicalName: string;
  /** Additional name variants that map to the same bot (NFC-matched). */
  aliases: string[];
  /** App ID (cli_xxx) used only for inviting a bot that is not in the chat yet. */
  appId?: string;
  role: BotRole;
  machines: MachineWorkspace[];
  /** Repository root appended to a machine.root to form the workspace path. */
  projectRoot: string;
}

export interface PinnedBinding {
  openId: string;
  /** Profile name that produced this binding. */
  dispatcherProfile: string;
  verifiedAt: number;
}

export type BlockedReason =
  | 'ambiguous_name'
  | 'identity_changed'
  | 'not_in_registry'
  | 'bot_not_in_group'
  | 'open_id_unknown'
  | 'app_id_unknown'
  | 'invite_failed'
  | 'dispatch_failed'
  | 'discovery_failed'
  | 'denied'
  | 'invalid_slug';

export type BootstrapStatus = 'sent' | 'acknowledged' | 'verified' | 'blocked';

export interface BootstrapResult {
  botName: string;
  status: BootstrapStatus;
  blockedReason?: BlockedReason;
  messageId?: string;
  pinnedOpenId?: string;
}

// ── task-id slug validation ──

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** Validate a task-id slug against the allowlist. */
export function validateSlug(slug: string): { ok: true; slug: string } | { ok: false; reason: string } {
  const trimmed = slug.trim();
  if (!trimmed) return { ok: false, reason: 'task-id slug 不能为空。' };
  if (!SLUG_RE.test(trimmed)) {
    return {
      ok: false,
      reason:
        `task-id slug 格式无效："${trimmed}"。只允许 [A-Za-z0-9._-]。`,
    };
  }
  return { ok: true, slug: trimmed };
}

// ── NFC matching ──

/**
 * Match a live-discovery bot name against the registry.
 * Returns the entry if exactly one matches (canonicalName or any alias),
 * or a status indicator for zero / multiple matches.
 */
export function matchRegistry(
  liveName: string,
  registry: BotRegistryEntry[],
): { entry: BotRegistryEntry } | { ambiguous: true; matches: BotRegistryEntry[] } | { notFound: true } {
  const normalised = liveName.normalize('NFC');
  const matches = registry.filter(
    (entry) =>
      entry.canonicalName.normalize('NFC') === normalised ||
      entry.aliases.some((alias) => alias.normalize('NFC') === normalised),
  );

  if (matches.length === 0) return { notFound: true };
  if (matches.length > 1) return { ambiguous: true, matches };
  return { entry: matches[0]! };
}

// ── workspace path resolution ──

/** Resolve the workspace path for a registry entry, preferring local. */
export function resolveWorkspacePath(entry: BotRegistryEntry): { path: string; kind: MachineWorkspace['kind'] } | undefined {
  const local = entry.machines.find((m) => m.kind === 'local');
  if (local) return { path: `${local.root}/${entry.projectRoot}`, kind: 'local' };

  const devbox = entry.machines.find((m) => m.kind === 'devbox');
  if (devbox) return { path: `${devbox.root}/${entry.projectRoot}`, kind: 'devbox' };

  return undefined;
}

// ── pin-on-first-verify ──

/** Try to resolve a pinned open_id binding. Returns undefined if no pin exists. */
export function getPinnedBinding(
  canonicalName: string,
  pinned: Map<string, PinnedBinding>,
): PinnedBinding | undefined {
  return pinned.get(canonicalName);
}

/**
 * Check whether a live open_id matches a pinned binding.
 * Returns the pinned binding on match, or undefined if no pin exists.
 * Returns a mismatch indicator when the live open_id differs from the pin.
 */
export function checkPinnedIdentity(
  canonicalName: string,
  liveOpenId: string,
  pinned: Map<string, PinnedBinding>,
): { ok: true; binding: PinnedBinding } | { ok: false; reason: 'no_pin' | 'identity_changed'; pinned?: PinnedBinding } {
  const existing = pinned.get(canonicalName);
  if (!existing) return { ok: false, reason: 'no_pin' };
  if (existing.openId !== liveOpenId) return { ok: false, reason: 'identity_changed', pinned: existing };
  return { ok: true, binding: existing };
}

/** Persist a pinned binding after first verified dispatch. */
export function pinBinding(
  canonicalName: string,
  openId: string,
  dispatcherProfile: string,
  pinned: Map<string, PinnedBinding>,
): void {
  pinned.set(canonicalName, {
    openId,
    dispatcherProfile,
    verifiedAt: Date.now(),
  });
}

// ── default R&D registry (hardcoded from context pack) ──

export function defaultRegistry(): BotRegistryEntry[] {
  return [
    {
      canonicalName: '小C',
      aliases: [],
      appId: 'cli_aaae59d6c77c1be1',
      role: 'bridge',
      machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
      projectRoot: 'lark-channel-bridge-fork',
    },
    {
      canonicalName: '云上C总',
      aliases: [],
      appId: 'cli_aaa25ec0fae19bd8',
      role: 'bridge',
      machines: [{ kind: 'devbox', root: '/home/qinpeng.bobo/repo' }],
      projectRoot: 'lark-coding-agent-bridge',
    },
    {
      canonicalName: '云上小C',
      aliases: [],
      appId: 'cli_aaa24ddce3389ccc',
      role: 'bridge',
      machines: [{ kind: 'devbox', root: '/home/qinpeng.bobo/repo' }],
      projectRoot: 'lark-coding-agent-bridge',
    },
    {
      canonicalName: '小P',
      aliases: [],
      appId: 'cli_aaae59657e781bd8',
      role: 'bridge',
      machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
      projectRoot: 'lark-channel-bridge-fork',
    },
  ];
}

/** Merge a user-provided registry override into the default. */
export function mergeRegistry(
  base: BotRegistryEntry[],
  overrides: BotRegistryEntry[],
): BotRegistryEntry[] {
  const map = new Map<string, BotRegistryEntry>();
  for (const entry of base) map.set(entry.canonicalName, entry);
  for (const entry of overrides) map.set(entry.canonicalName, entry);
  return [...map.values()];
}
