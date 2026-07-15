import type { AgentCapabilityId } from '../agent/capability';
import { getRunIdleTimeoutMs, type AppConfig } from '../config/schema';

// CardKit streaming cards expire after ten minutes. Five minutes leaves
// enough time to stop a Codex child that never gets past startup and publish
// a terminal card while the original streaming card is still writable.
export const DEFAULT_CODEX_RUN_STARTUP_TIMEOUT_MS = 5 * 60_000;

export function resolveRunIdleTimeoutMs(
  cfg: AppConfig,
  scopeOverrideMinutes: number | undefined,
  agent: AgentCapabilityId,
): number | undefined {
  if (scopeOverrideMinutes !== undefined) {
    return scopeOverrideMinutes > 0 ? scopeOverrideMinutes * 60_000 : undefined;
  }
  return getRunIdleTimeoutMs(cfg);
}

export function resolveRunStartupTimeoutMs(agent: AgentCapabilityId): number | undefined {
  return agent === 'codex' ? DEFAULT_CODEX_RUN_STARTUP_TIMEOUT_MS : undefined;
}
