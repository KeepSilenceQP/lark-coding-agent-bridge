import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REACTION_POLICY,
  parseReactionPolicy,
  ReactionPolicyStore,
  type ReactionRule,
} from '../../../src/bot/reaction/policy';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-reaction-policy-'));
  roots.push(root);
  return join(root, 'profile');
}

function rule(overrides: Partial<ReactionRule> = {}): ReactionRule {
  return {
    behavior: 'agent',
    semanticKey: 'user_step_completed',
    emojiMeaning: '用户已完成手动步骤，继续当前任务。',
    ...overrides,
  };
}

function config(rules: Record<string, unknown> = { Get: rule() }): string {
  return JSON.stringify({ schemaVersion: 1, rules });
}

describe('reaction policy defaults and parsing', () => {
  it('ships all current behaviors as deeply immutable configuration data', () => {
    const policy = DEFAULT_REACTION_POLICY;
    expect(Object.keys(policy.rules)).toHaveLength(13);
    expect(Object.values(policy.rules).filter((entry) => entry.behavior === 'agent')).toHaveLength(7);
    expect(Object.values(policy.rules).filter((entry) => entry.behavior === 'stop')).toHaveLength(3);
    expect(policy.rules.DONE?.behavior).toBe('passive');
    expect(policy.rules.GoGoGo?.behavior).toBe('continue');
    expect(policy.rules.Loudspeaker?.behavior).toBe('restart');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.rules)).toBe(true);
    expect(Object.values(policy.rules).every(Object.isFrozen)).toBe(true);
    expect(Object.getPrototypeOf(policy.rules)).toBeNull();
  });

  it('accepts custom semantic keys without adding built-in code and permits an empty mapping', () => {
    expect(parseReactionPolicy(config()).rules.Get).toEqual(rule());
    expect(Object.keys(parseReactionPolicy(config({})).rules)).toEqual([]);
  });

  it('versions semantic content consistently across whitespace and property order', () => {
    const first = parseReactionPolicy(config({ Get: rule(), Custom: rule({ behavior: 'passive' }) }));
    const second = parseReactionPolicy(JSON.stringify({
      rules: {
        Custom: { emojiMeaning: rule().emojiMeaning, semanticKey: 'user_step_completed', behavior: 'passive' },
        Get: { emojiMeaning: rule().emojiMeaning, semanticKey: 'user_step_completed', behavior: 'agent' },
      },
      schemaVersion: 1,
    }, null, 4));
    expect(second.version).toBe(first.version);
    expect(first.version).toMatch(/^[a-f0-9]{64}$/u);
    expect(parseReactionPolicy(config({ Get: rule({ emojiMeaning: '已完成另一项步骤。' }) })).version)
      .not.toBe(parseReactionPolicy(config()).version);
  });

  it.each([
    ['malformed JSON', '{"private-data":'],
    ['array root', '[]'],
    ['unknown schema', JSON.stringify({ schemaVersion: 2, rules: {} })],
    ['missing schema', JSON.stringify({ rules: {} })],
    ['unknown root field', JSON.stringify({ schemaVersion: 1, rules: {}, unknown: true })],
    ['array rules', JSON.stringify({ schemaVersion: 1, rules: [] })],
    ['null rule', config({ Get: null })],
    ['array rule', config({ Get: [] })],
    ['unknown rule field', config({ Get: { ...rule(), unknown: true } })],
    ['unknown behavior', config({ Get: { ...rule(), behavior: 'execute_arbitrary_code' } })],
    ['missing behavior', config({ Get: { semanticKey: 'complete', emojiMeaning: 'Complete' } })],
    ['empty semantic key', config({ Get: { ...rule(), semanticKey: '' } })],
    ['invalid semantic key', config({ Get: { ...rule(), semanticKey: 'has space' } })],
    ['empty meaning', config({ Get: { ...rule(), emojiMeaning: '  ' } })],
    ['non-string meaning', config({ Get: { ...rule(), emojiMeaning: 1 } })],
    ['control characters', config({ Get: { ...rule(), emojiMeaning: 'text\u0000text' } })],
    ['empty optional display', config({ Get: { ...rule(), emojiDisplay: '' } })],
    ['null optional display', config({ Get: { ...rule(), emojiDisplay: null } })],
    ['empty emoji type', config({ '': rule() })],
    ['whitespace emoji type', config({ ' Get': rule() })],
    ['reserved constructor', config({ constructor: rule() })],
    ['reserved prototype', config({ prototype: rule() })],
    ['reserved proto', `{"schemaVersion":1,"rules":{"__proto__":${JSON.stringify(rule())}}}`],
    ['reserved nested proto', `{"schemaVersion":1,"rules":{"Get":{${JSON.stringify(rule()).slice(1, -1)},"__proto__":{}}}}`],
    ['reserved Typing', config({ Typing: rule() })],
    ['oversized emoji type', config({ ['A'.repeat(129)]: rule() })],
    ['oversized semantic key', config({ Get: { ...rule(), semanticKey: 'a'.repeat(129) } })],
    ['oversized meaning', config({ Get: { ...rule(), emojiMeaning: 'a'.repeat(4097) } })],
    ['oversized display', config({ Get: { ...rule(), emojiDisplay: 'a'.repeat(129) } })],
    ['oversized rule count', config(Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`Key${index}`, rule()])))],
    ['oversized file', `${config()}${' '.repeat(128 * 1024)}`],
  ])('rejects %s', (_label, content) => {
    expect(() => parseReactionPolicy(content)).toThrow('Invalid reaction policy:');
  });
});

describe('ReactionPolicyStore', () => {
  it('creates the default file once, including a new profile directory', async () => {
    const profile = await tempProfile();
    const store = new ReactionPolicyStore(profile);
    expect(store.filePath).toBe(join(profile, 'reaction-semantics.json'));
    expect(() => store.snapshot()).toThrow('must be initialized');
    await store.initialize();
    const saved = await readFile(store.filePath, 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ schemaVersion: 1 });
    expect(store.snapshot()).toEqual(DEFAULT_REACTION_POLICY);
    expect(parseReactionPolicy(saved)).toEqual(DEFAULT_REACTION_POLICY);
  });

  it('initializes from an existing full config without overwriting or merging defaults', async () => {
    const profile = await tempProfile();
    await mkdir(profile);
    const store = new ReactionPolicyStore(profile);
    const saved = `${config()}\n`;
    await writeFile(store.filePath, saved);
    await store.initialize();
    expect(await readFile(store.filePath, 'utf8')).toBe(saved);
    expect(store.snapshot().rules.Get?.semanticKey).toBe('user_step_completed');
    expect(store.snapshot().rules.OK).toBeUndefined();
  });

  it('fails startup for an invalid existing config and does not overwrite it or expose its content', async () => {
    const profile = await tempProfile();
    await mkdir(profile);
    const store = new ReactionPolicyStore(profile);
    const privateContent = '{"secret-private-content":';
    await writeFile(store.filePath, privateContent);
    await expect(store.initialize()).rejects.toThrow('malformed JSON');
    await expect(store.initialize()).rejects.not.toThrow('secret-private-content');
    expect(await readFile(store.filePath, 'utf8')).toBe(privateContent);
    expect(() => store.snapshot()).toThrow('must be initialized');
  });

  it('hot reloads meanings and behaviors while previous snapshots remain immutable', async () => {
    const store = new ReactionPolicyStore(await tempProfile());
    await store.initialize();
    const initial = store.snapshot();
    await writeFile(store.filePath, config({ DONE: rule() }));
    const next = store.snapshot();
    expect(next.version).not.toBe(initial.version);
    expect(next.rules.DONE).toEqual(rule());
    expect(initial.rules.DONE?.behavior).toBe('passive');
    expect(Object.isFrozen(next.rules.DONE)).toBe(true);
    expect(store.snapshot()).toBe(next);
  });

  it('detects same-length edits immediately and removes deleted rules without default fallback', async () => {
    const store = new ReactionPolicyStore(await tempProfile());
    await store.initialize();
    await writeFile(store.filePath, config({ Get: rule({ emojiMeaning: 'first' }) }));
    const first = store.snapshot();
    await writeFile(store.filePath, config({ Get: rule({ emojiMeaning: 'other' }) }));
    expect(store.snapshot().rules.Get?.emojiMeaning).toBe('other');
    expect(store.snapshot().version).not.toBe(first.version);
    await writeFile(store.filePath, config({}));
    expect(Object.keys(store.snapshot().rules)).toEqual([]);
  });

  it('detects atomic rename used by editors', async () => {
    const store = new ReactionPolicyStore(await tempProfile());
    await store.initialize();
    const nextPath = `${store.filePath}.next`;
    await writeFile(nextPath, config());
    await rename(nextPath, store.filePath);
    expect(store.snapshot().rules.Get).toEqual(rule());
    expect(store.snapshot().rules.DONE).toBeUndefined();
  });

  it('keeps the last valid snapshot and deduplicates invalid-content warnings, then recovers', async () => {
    const warning = vi.fn();
    const store = new ReactionPolicyStore(await tempProfile(), warning);
    await store.initialize();
    const initial = store.snapshot();
    await writeFile(store.filePath, '{"secret-private-content":');
    expect(store.snapshot()).toBe(initial);
    expect(store.snapshot()).toBe(initial);
    await writeFile(store.filePath, '{"another-bad-value":');
    expect(store.snapshot()).toBe(initial);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).not.toContain('secret-private-content');
    expect(warning.mock.calls[0]?.[0]).not.toContain('another-bad-value');
    await writeFile(store.filePath, config({ Get: { ...rule(), behavior: 'bad' } }));
    expect(store.snapshot()).toBe(initial);
    expect(warning).toHaveBeenCalledTimes(2);
    await writeFile(store.filePath, config());
    expect(store.snapshot().rules.Get).toEqual(rule());
    await writeFile(store.filePath, '{');
    expect(store.snapshot().rules.Get).toEqual(rule());
    expect(warning).toHaveBeenCalledTimes(3);
  });

  it('keeps the last valid snapshot when deleted and resumes after restoring identical content', async () => {
    const warning = vi.fn();
    const store = new ReactionPolicyStore(await tempProfile(), warning);
    await store.initialize();
    const saved = await readFile(store.filePath, 'utf8');
    const initial = store.snapshot();
    await rm(store.filePath);
    expect(store.snapshot()).toBe(initial);
    expect(store.snapshot()).toBe(initial);
    expect(warning).toHaveBeenCalledTimes(1);
    await writeFile(store.filePath, saved);
    expect(store.snapshot()).toBe(initial);
    await rm(store.filePath);
    expect(store.snapshot()).toBe(initial);
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized files, invalid UTF-8, and non-file paths without dropping current rules', async () => {
    const warning = vi.fn();
    const store = new ReactionPolicyStore(await tempProfile(), warning);
    await store.initialize();
    const initial = store.snapshot();
    await writeFile(store.filePath, ' '.repeat(128 * 1024 + 1));
    expect(store.snapshot()).toBe(initial);
    await writeFile(store.filePath, Buffer.from([0xff, 0xfe]));
    expect(store.snapshot()).toBe(initial);
    await rm(store.filePath);
    await mkdir(store.filePath);
    expect(store.snapshot()).toBe(initial);
    expect(warning).toHaveBeenCalledTimes(3);
  });

  it('isolates profiles and independent store snapshots', async () => {
    const first = new ReactionPolicyStore(await tempProfile());
    const second = new ReactionPolicyStore(await tempProfile());
    await Promise.all([first.initialize(), second.initialize()]);
    await writeFile(first.filePath, config());
    expect(first.snapshot().rules.Get).toEqual(rule());
    expect(second.snapshot()).toEqual(DEFAULT_REACTION_POLICY);
  });
});
