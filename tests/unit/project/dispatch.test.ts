import { describe, expect, it } from 'vitest';
import {
  planBootstrap,
  type LiveBotMember,
} from '../../../src/project/dispatch';
import {
  defaultRegistry,
  type BotRegistryEntry,
} from '../../../src/project/bot-registry';

describe('bootstrap planning', () => {
  const baseInput = {
    slug: 'lark-channel-bridge-fork',
    chatId: 'oc_test',
    coordinatorName: 'HistoryRedactedBot4',
    coordinatorOpenId: 'ou_cc7a2bbc1be9e7f6054282ae918b9249',
    dispatcherProfile: 'claude',
    pinned: new Map(),
    participants: ['HistoryRedactedBot1', 'HistoryRedactedBot2'],
  };

  it('marks all registry bots as blocked when no live members', () => {
    const plan = planBootstrap({
      ...baseInput,
      liveMembers: [],
      registry: defaultRegistry(),
    });
    expect(plan.results.every((r) => r.status === 'blocked')).toBe(true);
    expect(plan.instructions).toHaveLength(0);
  });

  it('matches live members and generates instructions for bridge bots', () => {
    const liveMembers: LiveBotMember[] = [
      { openId: 'ou_c', name: 'HistoryRedactedBot1' },
      { openId: 'ou_z', name: 'HistoryRedactedBot2' },
    ];
    const registry: BotRegistryEntry[] = [
      {
        canonicalName: 'HistoryRedactedBot1',
        aliases: [],
        role: 'bridge',
        machines: [{ kind: 'local', root: '/redacted/history/machine-1' }],
        projectRoot: 'test-project',
      },
    ];
    const plan = planBootstrap({
      ...baseInput,
      liveMembers,
      registry,
    });
    expect(plan.results).toHaveLength(1);
    expect(plan.results[0]!.status).toBe('sent');
    expect(plan.instructions).toHaveLength(1);
    expect(plan.instructions[0]!.kind).toBe('cd-and-invite');
    expect(plan.instructions[0]!.workspacePath).toBe('/redacted/history/machine-1/test-project');
  });

  it('blocks non-bridge bots because bootstrap only sends bridge slash commands', () => {
    const liveMembers: LiveBotMember[] = [
      { openId: 'ou_a', name: 'ContextBot' },
    ];
    const registry: BotRegistryEntry[] = [
      {
        canonicalName: 'ContextBot',
        aliases: [],
        role: 'non-bridge',
        machines: [{ kind: 'local', root: '/redacted/history/machine-1' }],
        projectRoot: 'test-project',
      },
    ];
    const plan = planBootstrap({
      ...baseInput,
      liveMembers,
      registry,
    });
    expect(plan.results[0]!.status).toBe('blocked');
    expect(plan.results[0]!.blockedReason).toBe('denied');
    expect(plan.instructions).toHaveLength(0);
  });

  it('blocks bots not found in live members', () => {
    const liveMembers: LiveBotMember[] = [
      { openId: 'ou_c', name: 'HistoryRedactedBot1' },
    ];
    const registry: BotRegistryEntry[] = [
      defaultRegistry().find((e) => e.canonicalName === 'HistoryRedactedBot1')!,
      defaultRegistry().find((e) => e.canonicalName === 'HistoryRedactedBot2')!,
    ];
    const plan = planBootstrap({
      ...baseInput,
      liveMembers,
      registry,
    });
    const yunshangCz = plan.results.find((r) => r.botName === 'HistoryRedactedBot2');
    expect(yunshangCz!.status).toBe('blocked');
    expect(yunshangCz!.blockedReason).toBe('bot_not_in_group');
  });

  it('skips the coordinator bot instead of dispatching to itself', () => {
    const liveMembers: LiveBotMember[] = [
      { openId: baseInput.coordinatorOpenId, name: 'HistoryRedactedBot4' },
      { openId: 'ou_c', name: 'HistoryRedactedBot1' },
    ];
    const registry: BotRegistryEntry[] = [
      defaultRegistry().find((e) => e.canonicalName === 'HistoryRedactedBot4')!,
      defaultRegistry().find((e) => e.canonicalName === 'HistoryRedactedBot1')!,
    ];

    const plan = planBootstrap({
      ...baseInput,
      liveMembers,
      registry,
    });

    expect(plan.results.map((r) => r.botName)).toEqual(['HistoryRedactedBot1']);
    expect(plan.instructions.map((i) => i.targetName)).toEqual(['HistoryRedactedBot1']);
  });

  it('detects identity changes via pinned bindings', () => {
    const pinned = new Map();
    pinned.set('HistoryRedactedBot1', { openId: 'ou_old', dispatcherProfile: 'claude', verifiedAt: 1000 });
    const liveMembers: LiveBotMember[] = [
      { openId: 'ou_new', name: 'HistoryRedactedBot1' },
    ];
    const registry: BotRegistryEntry[] = [
      {
        canonicalName: 'HistoryRedactedBot1',
        aliases: [],
        role: 'bridge',
        machines: [{ kind: 'local', root: '/redacted/history/machine-1' }],
        projectRoot: 'test-project',
      },
    ];
    const plan = planBootstrap({
      ...baseInput,
      liveMembers,
      registry,
      pinned,
    });
    expect(plan.results[0]!.status).toBe('blocked');
    expect(plan.results[0]!.blockedReason).toBe('identity_changed');
  });

  it('blocks ambiguous names when live members have duplicate NFC-normalised names', () => {
    const liveMembers: LiveBotMember[] = [
      { openId: 'ou_a', name: 'HistoryRedactedBot1' },
      { openId: 'ou_b', name: 'HistoryRedactedBot1' },  // duplicate!
    ];
    const registry: BotRegistryEntry[] = [
      {
        canonicalName: 'HistoryRedactedBot1',
        aliases: [],
        role: 'bridge',
        machines: [{ kind: 'local', root: '/redacted/history/machine-1' }],
        projectRoot: 'test',
      },
    ];
    const plan = planBootstrap({
      ...baseInput,
      liveMembers,
      registry,
    });
    expect(plan.results[0]!.status).toBe('blocked');
    expect(plan.results[0]!.blockedReason).toBe('ambiguous_name');
    expect(plan.instructions).toHaveLength(0);
  });

});
