import { describe, expect, it } from 'vitest';
import {
  normalizeRegistryName,
  validateBotRegistry,
  matchRegistryEntry,
  upsertSelfRegistration,
  type BotRegistry,
} from '../../../src/config/bot-registry';

// ── normalizeRegistryName ──

describe('normalizeRegistryName', () => {
  it('trims whitespace', () => {
    expect(normalizeRegistryName('  Hello Bot  ')).toBe('Hello Bot');
  });

  it('removes leading @', () => {
    expect(normalizeRegistryName('@Planner')).toBe('Planner');
  });

  it('removes multiple leading @', () => {
    expect(normalizeRegistryName('@@@Implementer')).toBe('Implementer');
  });

  it('handles @ with spaces', () => {
    expect(normalizeRegistryName('  @ Planner Bot  ')).toBe('Planner Bot');
  });

  it('NFC-normalizes', () => {
    const composed = 'é';  // é composed
    const decomposed = 'é';  // é decomposed (e + combining acute)
    expect(normalizeRegistryName(decomposed)).toBe(composed);
    expect(normalizeRegistryName(`@${decomposed}`)).toBe(composed);
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeRegistryName('   ')).toBe('');
  });

  it('returns empty string for pure @ input', () => {
    expect(normalizeRegistryName('@@')).toBe('');
  });
});

// ── validateBotRegistry ──

describe('validateBotRegistry', () => {
  const validEntry = { name: 'Planner Bot', aliases: ['Planner'], appId: 'cli_a' };

  it('accepts valid registry with one entry', () => {
    const result = validateBotRegistry({ entries: [validEntry] });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.name).toBe('Planner Bot');
    expect(result.entries[0]!.aliases).toEqual(['Planner']);
    expect(result.entries[0]!.appId).toBe('cli_a');
  });

  it('accepts empty entries', () => {
    const result = validateBotRegistry({ entries: [] });
    expect(result.entries).toHaveLength(0);
  });

  it('accepts entries with empty aliases array', () => {
    const entry = { name: 'Solo Bot', aliases: [], appId: 'cli_solo' };
    const result = validateBotRegistry({ entries: [entry] });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.aliases).toEqual([]);
  });

  it('rejects null input', () => {
    expect(() => validateBotRegistry(null)).toThrow('botRegistry must be a non-null object');
  });

  it('rejects non-object input', () => {
    expect(() => validateBotRegistry('string')).toThrow('botRegistry must be a non-null object');
    expect(() => validateBotRegistry(42)).toThrow('botRegistry must be a non-null object');
    expect(() => validateBotRegistry(undefined)).toThrow('botRegistry must be a non-null object');
  });

  it('rejects array input', () => {
    expect(() => validateBotRegistry([])).toThrow('botRegistry must be a non-null object');
  });

  it('rejects missing entries field', () => {
    expect(() => validateBotRegistry({})).toThrow('botRegistry.entries must be an array');
  });

  it('rejects non-array entries', () => {
    expect(() => validateBotRegistry({ entries: 'not-array' })).toThrow('botRegistry.entries must be an array');
  });

  it('rejects unknown registry fields', () => {
    expect(() => validateBotRegistry({ entries: [], future: true })).toThrow(
      'botRegistry contains unknown field "future"',
    );
  });

  it('rejects non-object entry', () => {
    expect(() => validateBotRegistry({ entries: ['string'] })).toThrow('botRegistry.entries[0] must be a non-null object');
    expect(() => validateBotRegistry({ entries: [null] })).toThrow('botRegistry.entries[0] must be a non-null object');
  });

  it('rejects unknown entry fields', () => {
    expect(() =>
      validateBotRegistry({
        entries: [{ name: 'Bot', aliases: [], appId: 'cli_a', role: 'planner' }],
      }),
    ).toThrow('botRegistry.entries[0] contains unknown field "role"');
  });

  it('rejects missing name', () => {
    expect(() => validateBotRegistry({ entries: [{ aliases: [], appId: 'cli_a' }] })).toThrow(
      'botRegistry.entries[0].name must be a string',
    );
  });

  it('rejects non-string name', () => {
    expect(() => validateBotRegistry({ entries: [{ name: 42, aliases: [], appId: 'cli_a' }] })).toThrow(
      'botRegistry.entries[0].name must be a string',
    );
  });

  it('rejects empty name after trimming', () => {
    expect(() => validateBotRegistry({ entries: [{ name: '  ', aliases: [], appId: 'cli_a' }] })).toThrow(
      'botRegistry.entries[0].name is empty after trimming',
    );
  });

  it('rejects missing aliases', () => {
    expect(() => validateBotRegistry({ entries: [{ name: 'Bot', appId: 'cli_a' }] })).toThrow(
      'botRegistry.entries[0].aliases must be an array',
    );
  });

  it('rejects non-array aliases', () => {
    expect(() => validateBotRegistry({ entries: [{ name: 'Bot', aliases: 'not-array', appId: 'cli_a' }] })).toThrow(
      'botRegistry.entries[0].aliases must be an array',
    );
  });

  it('rejects non-string alias', () => {
    expect(() => validateBotRegistry({ entries: [{ name: 'Bot', aliases: [42], appId: 'cli_a' }] })).toThrow(
      'botRegistry.entries[0].aliases[0] must be a string',
    );
  });

  it('rejects empty alias after trimming', () => {
    expect(() => validateBotRegistry({ entries: [{ name: 'Bot', aliases: ['  '], appId: 'cli_a' }] })).toThrow(
      'botRegistry.entries[0].aliases[0] is empty after trimming',
    );
  });

  it('rejects duplicate alias within same entry', () => {
    expect(() =>
      validateBotRegistry({
        entries: [{ name: 'Bot', aliases: ['dup', 'dup'], appId: 'cli_a' }],
      }),
    ).toThrow('duplicate within the same entry');
  });

  it('rejects missing appId', () => {
    expect(() => validateBotRegistry({ entries: [{ name: 'Bot', aliases: [] }] })).toThrow(
      'botRegistry.entries[0].appId must be a string',
    );
  });

  it('rejects non-string appId', () => {
    expect(() => validateBotRegistry({ entries: [{ name: 'Bot', aliases: [], appId: 42 }] })).toThrow(
      'botRegistry.entries[0].appId must be a string',
    );
  });

  it('rejects empty appId after trimming', () => {
    expect(() => validateBotRegistry({ entries: [{ name: 'Bot', aliases: [], appId: '  ' }] })).toThrow(
      'botRegistry.entries[0].appId is empty after trimming',
    );
  });

  it('rejects duplicate canonical name', () => {
    expect(() =>
      validateBotRegistry({
        entries: [
          { name: 'Dupe Bot', aliases: [], appId: 'cli_a' },
          { name: 'Dupe Bot', aliases: [], appId: 'cli_b' },
        ],
      }),
    ).toThrow(/is already used by entry/);
  });

  it('rejects alias that duplicates another canonical name', () => {
    expect(() =>
      validateBotRegistry({
        entries: [
          { name: 'Planner', aliases: [], appId: 'cli_a' },
          { name: 'Other', aliases: ['Planner'], appId: 'cli_b' },
        ],
      }),
    ).toThrow(/is already used by entry/);
  });

  it('rejects canonical name that duplicates an earlier alias', () => {
    expect(() =>
      validateBotRegistry({
        entries: [
          { name: 'Planner Bot', aliases: ['Planner'], appId: 'cli_a' },
          { name: 'Planner', aliases: [], appId: 'cli_b' },
        ],
      }),
    ).toThrow(/is already used by entry/);
  });

  it('rejects an alias shared by different entries', () => {
    expect(() =>
      validateBotRegistry({
        entries: [
          { name: 'Planner Bot', aliases: ['Shared'], appId: 'cli_a' },
          { name: 'Implementer Bot', aliases: ['Shared'], appId: 'cli_b' },
        ],
      }),
    ).toThrow(/is already used by entry/);
  });

  it('rejects duplicate appId', () => {
    expect(() =>
      validateBotRegistry({
        entries: [
          { name: 'Bot A', aliases: [], appId: 'cli_same' },
          { name: 'Bot B', aliases: [], appId: 'cli_same' },
        ],
      }),
    ).toThrow(/is already used by entry/);
  });

  it('rejects appIds that collide after trimming', () => {
    expect(() =>
      validateBotRegistry({
        entries: [
          { name: 'Bot A', aliases: [], appId: 'cli_same' },
          { name: 'Bot B', aliases: [], appId: ' cli_same ' },
        ],
      }),
    ).toThrow(/is already used by entry/);
  });

  it('NFC-normalizes names during validation', () => {
    const composed = 'é';
    const decomposed = 'é';
    const result = validateBotRegistry({
      entries: [
        { name: composed, aliases: [decomposed], appId: 'cli_a' },
      ],
    });
    // The decomposed alias NFC-normalizes to match the composed name
    expect(result.entries[0]!.aliases).toEqual([composed]);
  });

  it('accepts multiple valid entries with distinct names and appIds', () => {
    const result = validateBotRegistry({
      entries: [
        { name: 'Bot A', aliases: ['Alpha'], appId: 'cli_a' },
        { name: 'Bot B', aliases: ['Beta'], appId: 'cli_b' },
      ],
    });
    expect(result.entries).toHaveLength(2);
  });

  it('returns normalized persisted values without mutating the input', () => {
    const input = {
      entries: [{ name: ' @Planner Bot ', aliases: [' @Planner '], appId: ' cli_a ' }],
    };
    const result = validateBotRegistry(input);
    expect(result).toEqual({
      entries: [{ name: 'Planner Bot', aliases: ['Planner'], appId: 'cli_a' }],
    });
    expect(input.entries[0]).toEqual({
      name: ' @Planner Bot ',
      aliases: [' @Planner '],
      appId: ' cli_a ',
    });
  });
});

// ── matchRegistryEntry ──

describe('matchRegistryEntry', () => {
  const registry: BotRegistry = {
    entries: [
      { name: 'Planner Bot', aliases: ['Planner'], appId: 'cli_plan' },
      { name: 'Implementer Bot', aliases: ['Coder'], appId: 'cli_code' },
    ],
  };

  it('finds by canonical name', () => {
    const result = matchRegistryEntry(registry, 'Planner Bot');
    expect(result.found).toBe(true);
    if (result.found) expect(result.entry.appId).toBe('cli_plan');
  });

  it('finds by alias', () => {
    const result = matchRegistryEntry(registry, 'Planner');
    expect(result.found).toBe(true);
    if (result.found) expect(result.entry.appId).toBe('cli_plan');
  });

  it('finds by @-prefixed name', () => {
    const result = matchRegistryEntry(registry, '@Planner Bot');
    expect(result.found).toBe(true);
    if (result.found) expect(result.entry.name).toBe('Planner Bot');
  });

  it('returns not_found for unknown name', () => {
    const result = matchRegistryEntry(registry, 'Unknown Bot');
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toBe('not_found');
  });

  it('returns not_found for empty string', () => {
    const result = matchRegistryEntry(registry, '');
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toBe('not_found');
  });

  it('returns ambiguous when alias matches multiple entries', () => {
    const ambigRegistry: BotRegistry = {
      entries: [
        { name: 'Bot A', aliases: ['Shared'], appId: 'cli_a' },
        { name: 'Bot B', aliases: ['Shared'], appId: 'cli_b' },
      ],
    };
    const result = matchRegistryEntry(ambigRegistry, 'Shared');
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toBe('ambiguous');
  });

  it('returns ambiguous when canonical name matches multiple entries (should not happen in valid registry)', () => {
    // Manually constructed with duplicate names (bypassing validation)
    const badRegistry: BotRegistry = {
      entries: [
        { name: 'Same', aliases: [], appId: 'cli_a' },
        { name: 'Same', aliases: [], appId: 'cli_b' },
      ],
    };
    const result = matchRegistryEntry(badRegistry, 'Same');
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toBe('ambiguous');
  });

  it('trims whitespace before matching', () => {
    const result = matchRegistryEntry(registry, '  Planner Bot  ');
    expect(result.found).toBe(true);
  });

  it('NFC-normalizes both sides', () => {
    const composed = 'é';
    const decomposed = 'é';
    const nfcRegistry: BotRegistry = {
      entries: [{ name: composed, aliases: [], appId: 'cli_e' }],
    };
    const result = matchRegistryEntry(nfcRegistry, decomposed);
    expect(result.found).toBe(true);
  });

  it('normalizes unvalidated registry-side values before exact matching', () => {
    const rawRegistry: BotRegistry = {
      entries: [{ name: ' Planner Bot ', aliases: [' Planner '], appId: 'cli_a' }],
    };
    expect(matchRegistryEntry(rawRegistry, '@Planner').found).toBe(true);
  });

  it('does not do substring or prefix matching', () => {
    const result = matchRegistryEntry(registry, 'Plan');
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toBe('not_found');
  });

  it('does not do case-insensitive matching (NFC only)', () => {
    const result = matchRegistryEntry(registry, 'planner bot');
    expect(result.found).toBe(false);
  });
});

describe('upsertSelfRegistration', () => {
  it('creates a normalized entry without mutating the input registry', () => {
    const registry: BotRegistry = { entries: [] };
    const result = upsertSelfRegistration(registry, {
      name: ' @Bridge Bot ',
      appId: ' cli_bridge ',
    });

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.registry.entries).toEqual([
      { name: 'Bridge Bot', aliases: [], appId: 'cli_bridge' },
    ]);
    expect(registry.entries).toEqual([]);
  });

  it('returns noop for the same appId and canonical name while preserving aliases', () => {
    const registry: BotRegistry = {
      entries: [{ name: 'Bridge Bot', aliases: ['Bridge'], appId: 'cli_bridge' }],
    };

    const result = upsertSelfRegistration(registry, {
      name: 'Bridge Bot',
      appId: 'cli_bridge',
    });

    expect(result.kind).toBe('noop');
    if (result.kind !== 'noop') return;
    expect(result.registry).toEqual(registry);
    expect(result.registry).not.toBe(registry);
  });

  it('returns conflict when the appId is registered under another canonical name', () => {
    const renamed = upsertSelfRegistration(
      {
        entries: [{ name: 'Original Bot', aliases: [], appId: 'cli_bridge' }],
      },
      { name: 'Renamed Bot', appId: 'cli_bridge' },
    );

    expect(renamed).toMatchObject({ kind: 'conflict' });
  });

  it('returns conflict when the name is another entry canonical name or alias', () => {
    const registry: BotRegistry = {
      entries: [
        { name: 'Planner Bot', aliases: ['Planner'], appId: 'cli_planner' },
      ],
    };

    expect(
      upsertSelfRegistration(registry, { name: 'Planner Bot', appId: 'cli_new' }),
    ).toMatchObject({ kind: 'conflict' });
    expect(
      upsertSelfRegistration(registry, { name: 'Planner', appId: 'cli_new' }),
    ).toMatchObject({ kind: 'conflict' });
  });

  it('returns conflict for an invalid candidate', () => {
    expect(
      upsertSelfRegistration({ entries: [] }, { name: '  ', appId: 'cli_new' }),
    ).toMatchObject({ kind: 'conflict' });
    expect(
      upsertSelfRegistration({ entries: [] }, { name: 'Bridge Bot', appId: '  ' }),
    ).toMatchObject({ kind: 'conflict' });
  });
});
