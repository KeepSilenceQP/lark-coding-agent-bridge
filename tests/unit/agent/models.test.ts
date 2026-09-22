import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MODEL,
  isDefaultModel,
  modelLabel,
  modelCatalogHome,
  parseRunTuning,
  resolveRunTuning,
  normalizeModelSelection,
  resolveModelArg,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'model-catalog-'));
    vi.stubEnv('CODEX_HOME', home);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it('preserves omitted tuning, clears defaults and keeps Fast independent from effort', () => {
    const current = { reasoningEffort: 'high', fastMode: 'on' as const };
    expect(parseRunTuning('codex', current, undefined, undefined)).toEqual(current);
    expect(resolveRunTuning('codex', current)).toEqual({ reasoningEffort: 'high', serviceTier: 'fast' });
    const standard = parseRunTuning('codex', current, 'ultra', 'off');
    expect(resolveRunTuning('codex', standard)).toEqual({ reasoningEffort: 'ultra', serviceTier: 'default' });
    expect(parseRunTuning('codex', current, 'default', 'default')).toEqual({ reasoningEffort: undefined, fastMode: undefined });
    expect(resolveRunTuning('claude', current)).toEqual({});
    expect(() => parseRunTuning('codex', {}, 'invented', 'on')).toThrow();
    expect(() => parseRunTuning('codex', {}, 'high', true)).toThrow();
  });

  it('uses the configured or isolated profile home without reading another profile catalog', () => {
    const state = { configPath: '/bridge/config.json', profile: 'work',
      profileConfig: { codex: { inheritCodexHome: false } } } as Parameters<typeof modelCatalogHome>[0];
    expect(modelCatalogHome(state)).toBe('/bridge/profiles/work/codex-home');
    state.profileConfig.codex!.codexHome = '/custom/home';
    expect(modelCatalogHome(state)).toBe('/custom/home');
    delete state.profileConfig.codex!.codexHome;
    state.profileConfig.codex!.inheritCodexHome = true;
    expect(modelCatalogHome(state)).toBe(home);
  });

  it('discovers visible CLI models and preserves a selected model missing from the cache', () => {
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'next-codex', display_name: 'Next Codex', visibility: 'list' },
      { slug: 'internal-model', visibility: 'hide' },
      { slug: 'next-codex', visibility: 'list' },
      { slug: '--bad', visibility: 'list' },
    ] }));
    const models = supportedModels('codex', 'provider/custom-v2');
    expect(models.map((m) => m.value)).toEqual(['default', 'next-codex', 'provider/custom-v2']);
    expect(resolveModelArg('codex', 'provider/custom-v2')).toBe('provider/custom-v2');
  });

  it('falls back when the cache is corrupt without losing explicit selections', () => {
    writeFileSync(join(home, 'models_cache.json'), '{');
    expect(supportedModels('codex', 'new-model').map((m) => m.value)).toContain('new-model');
    expect(resolveModelArg('codex', 'new-model')).toBe('new-model');
  });

  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-5-codex');
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('preserves explicit IDs and defaults only unset selections', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeModelSelection('claude', 'provider/custom-model')).toBe('provider/custom-model');
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    expect(resolveModelArg('codex', 'provider/model-v9')).toBe('provider/model-v9');
    expect(resolveModelArg('codex', '--bad value')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8（最新）');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });
});
