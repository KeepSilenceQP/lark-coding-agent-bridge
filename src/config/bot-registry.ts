/**
 * Shared Bot Registry — RootConfig-level persistence contract.
 *
 * Types, validation, and NFC-exact matching for the shared bot registry that
 * lives in the installation-level Root Config.
 */

// ── Types ──

export interface BotRegistryEntry {
  /** Canonical display name (NFC-normalized for comparison). */
  name: string;
  /** Additional name variants for CLI input and live matching; may be empty. */
  aliases: string[];
  /** App ID (cli_xxx) used for inviting a bot not already in the chat. */
  appId: string;
}

export interface BotRegistry {
  entries: BotRegistryEntry[];
}

// ── Normalization ──

/**
 * Trim whitespace, remove leading `@` (one or more), then NFC-normalize.
 * Used for both registry name storage and command-line input before matching.
 */
export function normalizeRegistryName(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim().normalize('NFC');
}

/**
 * Parse an unknown input into a validated BotRegistry.
 *
 * Rules (Spec Target Configuration Contract):
 *  - `botRegistry` must be an object with an `entries` array if present.
 *  - Each entry: `name`, `aliases`, `appId` — all required, all trimmed + NFC'd.
 *  - name and each alias after trimming must be non-empty.
 *  - appId after trimming must be non-empty.
 *  - Canonical names must be unique across entries.
 *  - Aliases must be unique across entries (no alias may equal any canonical name
 *    or any other alias from a different entry).
 *  - appId must be unique across entries.
 *  - All comparison uses NFC-normalized form.
 *
 * Throws a descriptive Error on any violation (fail closed).
 */
export function validateBotRegistry(input: unknown): BotRegistry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('botRegistry must be a non-null object');
  }

  assertExactKeys(input, ['entries'], 'botRegistry');
  const raw = input as { entries?: unknown };
  if (!Array.isArray(raw.entries)) {
    throw new Error('botRegistry.entries must be an array');
  }

  const entries: BotRegistryEntry[] = [];
  const seenNames = new Map<string, number>();
  const seenAppIds = new Map<string, number>();

  for (let i = 0; i < raw.entries.length; i++) {
    const entry = raw.entries[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`botRegistry.entries[${i}] must be a non-null object`);
    }

    assertExactKeys(entry, ['name', 'aliases', 'appId'], `botRegistry.entries[${i}]`);
    const e = entry as { name?: unknown; aliases?: unknown; appId?: unknown };

    // name
    if (typeof e.name !== 'string') {
      throw new Error(`botRegistry.entries[${i}].name must be a string`);
    }
    const name = normalizeRegistryName(e.name);
    if (!name) {
      throw new Error(`botRegistry.entries[${i}].name is empty after trimming`);
    }

    // aliases
    if (!Array.isArray(e.aliases)) {
      throw new Error(`botRegistry.entries[${i}].aliases must be an array`);
    }
    const aliases: string[] = [];
    for (let j = 0; j < e.aliases.length; j++) {
      if (typeof e.aliases[j] !== 'string') {
        throw new Error(`botRegistry.entries[${i}].aliases[${j}] must be a string`);
      }
      const alias = normalizeRegistryName(e.aliases[j]);
      if (!alias) {
        throw new Error(`botRegistry.entries[${i}].aliases[${j}] is empty after trimming`);
      }
      if (aliases.includes(alias)) {
        throw new Error(
          `botRegistry.entries[${i}].aliases[${j}] "${alias}" is a duplicate within the same entry`,
        );
      }
      aliases.push(alias);
    }

    // appId
    if (typeof e.appId !== 'string') {
      throw new Error(`botRegistry.entries[${i}].appId must be a string`);
    }
    const appId = e.appId.trim();
    if (!appId) {
      throw new Error(`botRegistry.entries[${i}].appId is empty after trimming`);
    }

    const conflictingNameEntry = seenNames.get(name);
    if (conflictingNameEntry !== undefined && conflictingNameEntry !== i) {
      throw new Error(
        `botRegistry.entries[${i}].name "${name}" is already used by entry ${conflictingNameEntry}`,
      );
    }
    seenNames.set(name, i);

    for (const alias of aliases) {
      const conflictingAliasEntry = seenNames.get(alias);
      if (conflictingAliasEntry !== undefined && conflictingAliasEntry !== i) {
        throw new Error(
          `botRegistry.entries[${i}].aliases contains "${alias}" which is already used by entry ` +
            conflictingAliasEntry,
        );
      }
      seenNames.set(alias, i);
    }

    if (seenAppIds.has(appId)) {
      throw new Error(
        `botRegistry.entries[${i}].appId "${appId}" is already used by entry ${seenAppIds.get(appId)}`,
      );
    }
    seenAppIds.set(appId, i);

    entries.push({ name, aliases, appId });
  }

  return { entries };
}

function assertExactKeys(input: object, expected: string[], path: string): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path} contains unknown field "${unknown[0]}"`);
  }
}

// ── Matching ──

export type MatchResult =
  | { found: true; entry: BotRegistryEntry }
  | { found: false; reason: 'not_found' | 'ambiguous' };

/**
 * Match a name (NFC-normalized, trimmed, leading-@-stripped) against the
 * registry.  Returns the unique matching entry, or signals not_found/ambiguous.
 *
 * Matching: compares the input against each entry's `name` and every `alias`,
 * all NFC-normalized, exact equality only.  If exactly one entry matches,
 * returns it.  Zero matches → not_found.  Two or more entries match → ambiguous.
 */
export function matchRegistryEntry(registry: BotRegistry, rawName: string): MatchResult {
  const needle = normalizeRegistryName(rawName);
  const matched: BotRegistryEntry[] = [];

  for (const entry of registry.entries) {
    if (
      normalizeRegistryName(entry.name) === needle ||
      entry.aliases.some((alias) => normalizeRegistryName(alias) === needle)
    ) {
      matched.push(entry);
    }
  }

  if (matched.length === 1) {
    return { found: true, entry: matched[0]! };
  }
  if (matched.length === 0) {
    return { found: false, reason: 'not_found' };
  }
  return { found: false, reason: 'ambiguous' };
}

export type SelfRegistrationResult =
  | { kind: 'created'; registry: BotRegistry; entry: BotRegistryEntry }
  | { kind: 'noop'; registry: BotRegistry; entry: BotRegistryEntry }
  | { kind: 'conflict'; message: string };

/**
 * Add the current profile's bot identity without silently changing an existing
 * registry entry. The returned registry is a validated copy; the input is not
 * mutated.
 */
export function upsertSelfRegistration(
  registry: BotRegistry,
  identity: { name: string; appId: string },
): SelfRegistrationResult {
  const current = validateBotRegistry(registry);
  let candidate: BotRegistryEntry;
  try {
    candidate = validateBotRegistry({
      entries: [{ name: identity.name, aliases: [], appId: identity.appId }],
    }).entries[0]!;
  } catch (err) {
    return {
      kind: 'conflict',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const existingByAppId = current.entries.find((entry) => entry.appId === candidate.appId);

  if (existingByAppId) {
    if (existingByAppId.name === candidate.name) {
      return { kind: 'noop', registry: current, entry: existingByAppId };
    }
    return {
      kind: 'conflict',
      message:
        `appId "${candidate.appId}" is already registered as "${existingByAppId.name}" ` +
        'with different registry data',
    };
  }

  const existingByName = current.entries.find(
    (entry) => entry.name === candidate.name || entry.aliases.includes(candidate.name),
  );
  if (existingByName) {
    return {
      kind: 'conflict',
      message:
        `name "${candidate.name}" is already registered to appId "${existingByName.appId}"`,
    };
  }

  return {
    kind: 'created',
    registry: { entries: [...current.entries, candidate] },
    entry: candidate,
  };
}
