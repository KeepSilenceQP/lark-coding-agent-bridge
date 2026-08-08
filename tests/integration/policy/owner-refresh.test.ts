import { describe, expect, it } from 'vitest';
import {
  refreshOwnerControls,
  type AppInfoSource,
} from '../../../src/policy/owner';
import { isCreator, type RuntimeControls } from '../../../src/policy/access';

describe('owner refresh', () => {
  it('refreshes bot owner from the application API', async () => {
    const controls: RuntimeControls = { ownerRefreshState: 'unknown' };
    const source = fakeAppInfoSource(['ou_owner']);

    await refreshOwnerControls(controls, source, 'cli_test');

    expect(controls).toMatchObject({
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'ok',
    });
    expect(controls.ownerRefreshedAt).toBeTypeOf('number');
    expect(source.calls).toBe(1);
  });

  it('keeps cached owner available when a refresh fails', async () => {
    const controls: RuntimeControls = {
      botOwnerId: 'ou_previous',
      ownerRefreshState: 'ok',
      ownerRefreshedAt: 123,
    };
    const source = fakeAppInfoSource([new Error('permission denied')]);

    await refreshOwnerControls(controls, source, 'cli_test');

    expect(controls.botOwnerId).toBe('ou_previous');
    expect(controls.ownerRefreshState).toBe('ok');
    expect(controls.ownerRefreshedAt).toBe(123);
    expect(controls.ownerRefreshError).toContain('permission denied');
    expect(isCreator(controls, 'ou_previous')).toBe(true);
  });

  it('fails closed when owner refresh fails without a cached owner', async () => {
    const controls: RuntimeControls = { ownerRefreshState: 'unknown' };
    const source = fakeAppInfoSource([new Error('permission denied')]);

    await refreshOwnerControls(controls, source, 'cli_test');

    expect(controls.botOwnerId).toBeUndefined();
    expect(controls.ownerRefreshState).toBe('failed');
    expect(controls.ownerRefreshError).toContain('permission denied');
    expect(isCreator(controls, 'ou_previous')).toBe(false);
  });

});

function fakeAppInfoSource(results: Array<string | Error>): AppInfoSource & { calls: number } {
  return {
    calls: 0,
    async getAppInfo() {
      this.calls += 1;
      const next = results.shift();
      if (next instanceof Error) throw next;
      return { ownerId: next };
    },
  };
}
