import { describe, expect, it } from 'vitest';
import {
  validateSlug,
  type BotRegistryEntry,
} from '../../../src/project/bot-registry';
import * as projectRegistry from '../../../src/project/bot-registry';

describe('project bot registry boundary', () => {
  it('uses the shared three-field Registry entry contract', () => {
    const entry: BotRegistryEntry = {
      name: 'Implementer Bot',
      aliases: ['Implementation Alias'],
      appId: 'cli_test_implementer',
    };

    expect(entry).toEqual({
      name: 'Implementer Bot',
      aliases: ['Implementation Alias'],
      appId: 'cli_test_implementer',
    });
  });

  it('does not retain default, workspace fallback, or pinning runtime helpers', () => {
    expect(projectRegistry).not.toHaveProperty('defaultRegistry');
    expect(projectRegistry).not.toHaveProperty('mergeRegistry');
    expect(projectRegistry).not.toHaveProperty('resolveWorkspacePath');
    expect(projectRegistry).not.toHaveProperty('checkPinnedIdentity');
    expect(projectRegistry).not.toHaveProperty('pinBinding');
  });
});

describe('slug validation', () => {
  it.each([
    'project-bridge',
    'PROJECT_BRIDGE',
    'v1.2.3-rc4',
    'my_project',
    'test.repo',
  ])('accepts %s', (slug) => {
    expect(validateSlug(slug)).toEqual({ ok: true, slug });
  });

  it.each([
    '../etc',
    'my project',
    'a|b',
    'rm -rf',
    'a/b',
    'a;b',
    '${foo}',
    '',
    '   ',
  ])('rejects %j', (slug) => {
    expect(validateSlug(slug).ok).toBe(false);
  });

  it('trims whitespace before validation', () => {
    expect(validateSlug('  project-bridge  ')).toEqual({
      ok: true,
      slug: 'project-bridge',
    });
  });
});
