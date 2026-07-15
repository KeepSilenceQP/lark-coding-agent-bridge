import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema';
import {
  DEFAULT_CODEX_RUN_STARTUP_TIMEOUT_MS,
  resolveRunIdleTimeoutMs,
  resolveRunStartupTimeoutMs,
} from '../../../src/bot/run-idle-timeout';

const cfg = (runIdleTimeoutMinutes?: number): AppConfig => ({
  accounts: {
    app: {
      id: 'cli_test',
      secret: '${APP_SECRET}',
      tenant: 'feishu',
    },
  },
  preferences:
    runIdleTimeoutMinutes === undefined ? {} : { runIdleTimeoutMinutes },
});

describe('run idle timeout resolution', () => {
  it('defaults only Codex startup to a timeout before the ten-minute CardKit expiry', () => {
    expect(resolveRunStartupTimeoutMs('codex')).toBe(DEFAULT_CODEX_RUN_STARTUP_TIMEOUT_MS);
    expect(resolveRunStartupTimeoutMs('claude')).toBeUndefined();
    expect(DEFAULT_CODEX_RUN_STARTUP_TIMEOUT_MS).toBeLessThan(10 * 60_000);
    expect(resolveRunIdleTimeoutMs(cfg(), undefined, 'codex')).toBeUndefined();
  });

  it('keeps Claude opt-in and honors explicit global or scope settings', () => {
    expect(resolveRunIdleTimeoutMs(cfg(), undefined, 'claude')).toBeUndefined();
    expect(resolveRunIdleTimeoutMs(cfg(7), undefined, 'codex')).toBe(7 * 60_000);
    expect(resolveRunIdleTimeoutMs(cfg(0), undefined, 'codex')).toBeUndefined();
    expect(resolveRunIdleTimeoutMs(cfg(), 2, 'codex')).toBe(2 * 60_000);
    expect(resolveRunIdleTimeoutMs(cfg(), 0, 'codex')).toBeUndefined();
  });
});
