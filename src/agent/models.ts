import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MutableProfileState } from '../config/config-ops';
import type { AppPreferences } from '../config/schema';
import type { AgentKind } from '../config/profile-schema';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model. Add new ids here when a generation ships;
 * `opusplan` is kept as the one alias with no versioned equivalent (it runs
 * Opus for planning and Sonnet for execution).
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** Codex CLI models. Forwarded to `codex exec --model`. */
const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'o3', label: 'o3' },
];

/** Resolve the same home directory used by CodexAdapter, including isolated profiles. */
export function modelCatalogHome(state: MutableProfileState): string {
  const codex = state.profileConfig.codex;
  if (codex?.codexHome) return codex.codexHome;
  if (codex?.inheritCodexHome === false) {
    return join(dirname(state.configPath), 'profiles', state.profile, 'codex-home');
  }
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** Cached CLI discovery is advisory; model availability is checked by the agent. */
export function supportedModels(
  agentKind: AgentKind,
  current?: string,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
): ModelOption[] {
  let options = [...(agentKind === 'codex' ? CODEX_MODELS : CLAUDE_MODELS)];
  if (agentKind === 'codex') {
    try {
      const cache = JSON.parse(readFileSync(join(codexHome, 'models_cache.json'), 'utf8'));
      if (Array.isArray(cache.models)) {
        const discovered: ModelOption[] = [];
        for (const entry of cache.models as unknown[]) {
          if (!entry || typeof entry !== 'object') continue;
          const m = entry as Record<string, unknown>;
          if (m.visibility !== 'list' || !isValidModelId(m.slug) || m.slug === DEFAULT_MODEL) continue;
          discovered.push({ value: m.slug, label: typeof m.display_name === 'string' ? m.display_name : m.slug });
        }
        if (discovered.length) options = [options[0]!, ...discovered];
      }
    } catch {
      // Missing, old or partially written caches must not block settings.
    }
  }
  const selection = normalizeModelSelection(agentKind, current);
  if (selection !== DEFAULT_MODEL && !options.some((m) => m.value === selection)) {
    options.push({ value: selection, label: selection });
  }
  return [...new Map(options.map((m) => [m.value, m])).values()];
}

/** Accept provider-qualified IDs without maintaining a model-name allowlist. */
export function isValidModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(value);
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/** Preserve explicit model IDs independently of the current discovery cache. */
export function normalizeModelSelection(
  _agentKind: AgentKind,
  value: string | undefined,
): string {
  const trimmed = value?.trim();
  return isValidModelId(trimmed) ? trimmed : DEFAULT_MODEL;
}

/** Resolve the explicit model argument; only the default sentinel omits it. */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return supportedModels(agentKind).find((m) => m.value === normalized)?.label ?? normalized;
}


export const REASONING_OPTIONS: ModelOption[] = [
  { value: 'default', label: '跟随 CLI 默认' },
  { value: 'none', label: '无推理（none）' },
  { value: 'minimal', label: '最低（minimal）' },
  { value: 'low', label: '低（low）' },
  { value: 'medium', label: '中（medium）' },
  { value: 'high', label: '高（high）' },
  { value: 'xhigh', label: '更高（xhigh）' },
  { value: 'max', label: '最大（max）' },
  { value: 'ultra', label: '极高（ultra）' },
];
export const FAST_MODE_OPTIONS: ModelOption[] = [
  { value: 'default', label: '跟随 CLI 默认' },
  { value: 'on', label: '开启（更快，增加用量）' },
  { value: 'off', label: '关闭（标准速度）' },
];

/** Shared validation for Feishu cards and the web console. Omitted fields preserve preferences. */
export function parseRunTuning(
  agentKind: AgentKind,
  current: AppPreferences,
  effort: unknown,
  fast: unknown,
): Pick<AppPreferences, 'reasoningEffort' | 'fastMode'> {
  if (agentKind !== 'codex') return { reasoningEffort: current.reasoningEffort, fastMode: current.fastMode };
  const reasoningEffort = effort === undefined ? current.reasoningEffort : effort;
  const fastMode = fast === undefined ? current.fastMode : fast;
  if (reasoningEffort !== undefined && !REASONING_OPTIONS.some((m) => m.value === reasoningEffort)) {
    throw new Error('无效的推理强度，请重新选择。');
  }
  if (fastMode !== undefined && !FAST_MODE_OPTIONS.some((m) => m.value === fastMode)) {
    throw new Error('无效的快速模式，请重新选择。');
  }
  return {
    reasoningEffort: reasoningEffort === 'default' ? undefined : reasoningEffort as string | undefined,
    fastMode: fastMode === 'default' ? undefined : fastMode as 'on' | 'off' | undefined,
  };
}

/** Only Codex receives these overrides; undefined leaves all CLI defaults intact. */
export function resolveRunTuning(agentKind: AgentKind, preferences: AppPreferences): {
  reasoningEffort?: string;
  serviceTier?: 'fast' | 'default';
} {
  if (agentKind !== 'codex') return {};
  const tuning = parseRunTuning(agentKind, preferences, undefined, undefined);
  return {
    reasoningEffort: tuning.reasoningEffort,
    serviceTier: tuning.fastMode === 'on' ? 'fast' : tuning.fastMode === 'off' ? 'default' : undefined,
  };
}
