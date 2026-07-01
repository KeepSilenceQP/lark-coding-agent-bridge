import { describe, expect, it } from 'vitest';
import {
  validateSlug,
  matchRegistry,
  resolveWorkspacePath,
  checkPinnedIdentity,
  pinBinding,
  defaultRegistry,
  mergeRegistry,
  type BotRegistryEntry,
  type MachineWorkspace,
} from '../../../src/project/bot-registry';

describe('slug validation', () => {
  it('accepts valid workspace slugs', () => {
    expect(validateSlug('lark-bridge').ok).toBe(true);
    expect(validateSlug('LARK_BRIDGE').ok).toBe(true);
    expect(validateSlug('v1.2.3-rc4').ok).toBe(true);
    expect(validateSlug('my_project').ok).toBe(true);
    expect(validateSlug('test.repo').ok).toBe(true);
  });

  it('rejects invalid slugs', () => {
    expect(validateSlug('../etc').ok).toBe(false);
    expect(validateSlug('my project').ok).toBe(false);
    expect(validateSlug('a|b').ok).toBe(false);
    expect(validateSlug('rm -rf').ok).toBe(false);
    expect(validateSlug('a/b').ok).toBe(false);
    expect(validateSlug('a;b').ok).toBe(false);
    expect(validateSlug('${foo}').ok).toBe(false);
    expect(validateSlug('').ok).toBe(false);
    expect(validateSlug('   ').ok).toBe(false);
  });

  it('trims whitespace before validation', () => {
    expect(validateSlug('  lark-bridge  ')).toEqual({ ok: true, slug: 'lark-bridge' });
  });
});

describe('registry matching', () => {
  const registry = defaultRegistry();

  it('matches by canonical name (NFC exact)', () => {
    const result = matchRegistry('小C', registry);
    expect('entry' in result).toBe(true);
    if ('entry' in result) {
      expect(result.entry.canonicalName).toBe('小C');
      expect(result.entry.role).toBe('bridge');
    }
  });

  it('does not include excluded non-R&D bots in the default registry', () => {
    const xiaoA = matchRegistry('小 A', registry);
    const xiaoXiaoP = matchRegistry('小小 P', registry);
    expect('notFound' in xiaoA).toBe(true);
    expect('notFound' in xiaoXiaoP).toBe(true);
  });

  it('returns notFound for unknown name', () => {
    const result = matchRegistry('UnknownBot', registry);
    expect('notFound' in result).toBe(true);
  });

  it('prefers canonical over alias match', () => {
    // "小P" is canonical; should match directly
    const result = matchRegistry('小P', registry);
    expect('entry' in result).toBe(true);
    if ('entry' in result) {
      expect(result.entry.canonicalName).toBe('小P');
    }
  });

  it('uses the current fork repository name for local bridge bots', () => {
    const xiaoC = registry.find((entry) => entry.canonicalName === '小C');
    const xiaoP = registry.find((entry) => entry.canonicalName === '小P');

    expect(xiaoC?.projectRoot).toBe('lark-coding-agent-bridge');
    expect(xiaoP?.projectRoot).toBe('lark-coding-agent-bridge');
  });
});

describe('workspace path resolution', () => {
  it('prefers local machine over devbox', () => {
    const entry: BotRegistryEntry = {
      canonicalName: 'TestBot',
      aliases: [],
      role: 'bridge',
      machines: [
        { kind: 'local', root: '/Users/test/repo' },
        { kind: 'devbox', root: '/home/test/repo' },
      ],
      projectRoot: 'my-project',
    };
    const ws = resolveWorkspacePath(entry);
    expect(ws).toBeDefined();
    expect(ws!.path).toBe('/Users/test/repo/my-project');
    expect(ws!.kind).toBe('local');
  });

  it('falls back to devbox when no local machine', () => {
    const entry: BotRegistryEntry = {
      canonicalName: 'DevboxBot',
      aliases: [],
      role: 'bridge',
      machines: [{ kind: 'devbox', root: '/home/qinpeng.bobo/repo' }],
      projectRoot: 'my-project',
    };
    const ws = resolveWorkspacePath(entry);
    expect(ws).toBeDefined();
    expect(ws!.path).toBe('/home/qinpeng.bobo/repo/my-project');
    expect(ws!.kind).toBe('devbox');
  });

  it('returns undefined when no machines configured', () => {
    const entry: BotRegistryEntry = {
      canonicalName: 'EmptyBot',
      aliases: [],
      role: 'bridge',
      machines: [],
      projectRoot: 'p',
    };
    expect(resolveWorkspacePath(entry)).toBeUndefined();
  });
});

describe('pin-on-first-verify', () => {
  const pins = new Map();

  it('returns no_pin when no binding exists', () => {
    const result = checkPinnedIdentity('小C', 'ou_abc', pins);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_pin');
  });

  it('returns ok when live openId matches pinned', () => {
    pinBinding('小C', 'ou_abc', 'profile-1', pins);
    const result = checkPinnedIdentity('小C', 'ou_abc', pins);
    expect(result.ok).toBe(true);
  });

  it('returns identity_changed when live openId differs from pinned', () => {
    pinBinding('小C', 'ou_abc', 'profile-1', pins);
    const result = checkPinnedIdentity('小C', 'ou_xyz', pins);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('identity_changed');
      expect(result.pinned?.openId).toBe('ou_abc');
    }
  });

  it('pins with profile and timestamp', () => {
    const fresh = new Map<string, { openId: string; dispatcherProfile: string; verifiedAt: number }>();
    pinBinding('TestBot', 'ou_new', 'my-profile', fresh);
    const pinned = fresh.get('TestBot');
    expect(pinned).toBeDefined();
    expect(pinned!.openId).toBe('ou_new');
    expect(pinned!.dispatcherProfile).toBe('my-profile');
    expect(pinned!.verifiedAt).toBeGreaterThan(0);
  });
});

describe('merge registry', () => {
  it('overrides default entry by canonicalName', () => {
    const overrides: BotRegistryEntry[] = [{
      canonicalName: '小C',
      aliases: ['C-bot'],
      role: 'bridge',
      machines: [{ kind: 'local', root: '/custom/repo' }],
      projectRoot: 'custom-project',
    }];
    const merged = mergeRegistry(defaultRegistry(), overrides);
    const entry = merged.find((e) => e.canonicalName === '小C');
    expect(entry!.projectRoot).toBe('custom-project');
    expect(entry!.aliases).toContain('C-bot');
  });

  it('preserves non-overridden entries', () => {
    const overrides: BotRegistryEntry[] = [];
    const merged = mergeRegistry(defaultRegistry(), overrides);
    expect(merged.length).toBe(defaultRegistry().length);
  });
});
