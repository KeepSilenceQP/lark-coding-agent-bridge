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
    coordinatorName: '小P',
    coordinatorOpenId: 'ou_cc7a2bbc1be9e7f6054282ae918b9249',
    dispatcherProfile: 'claude',
    pinned: new Map(),
    participants: ['小C', '云上C总'],
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
      { openId: 'ou_c', name: '小C' },
      { openId: 'ou_z', name: '云上C总' },
    ];
    const registry: BotRegistryEntry[] = [
      {
        canonicalName: '小C',
        aliases: [],
        role: 'bridge',
        machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
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
    expect(plan.instructions[0]!.workspacePath).toBe('/Users/bytedance/repo/test-project');
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
        machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
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
      { openId: 'ou_c', name: '小C' },
    ];
    const registry: BotRegistryEntry[] = [
      defaultRegistry().find((e) => e.canonicalName === '小C')!,
      defaultRegistry().find((e) => e.canonicalName === '云上C总')!,
    ];
    const plan = planBootstrap({
      ...baseInput,
      liveMembers,
      registry,
    });
    const yunshangCz = plan.results.find((r) => r.botName === '云上C总');
    expect(yunshangCz!.status).toBe('blocked');
    expect(yunshangCz!.blockedReason).toBe('bot_not_in_group');
  });

  it('skips the coordinator bot instead of dispatching to itself', () => {
    const liveMembers: LiveBotMember[] = [
      { openId: baseInput.coordinatorOpenId, name: '小P' },
      { openId: 'ou_c', name: '小C' },
    ];
    const registry: BotRegistryEntry[] = [
      defaultRegistry().find((e) => e.canonicalName === '小P')!,
      defaultRegistry().find((e) => e.canonicalName === '小C')!,
    ];

    const plan = planBootstrap({
      ...baseInput,
      liveMembers,
      registry,
    });

    expect(plan.results.map((r) => r.botName)).toEqual(['小C']);
    expect(plan.instructions.map((i) => i.targetName)).toEqual(['小C']);
  });

  it('detects identity changes via pinned bindings', () => {
    const pinned = new Map();
    pinned.set('小C', { openId: 'ou_old', dispatcherProfile: 'claude', verifiedAt: 1000 });
    const liveMembers: LiveBotMember[] = [
      { openId: 'ou_new', name: '小C' },
    ];
    const registry: BotRegistryEntry[] = [
      {
        canonicalName: '小C',
        aliases: [],
        role: 'bridge',
        machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
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
      { openId: 'ou_a', name: '小C' },
      { openId: 'ou_b', name: '小C' },  // duplicate!
    ];
    const registry: BotRegistryEntry[] = [
      {
        canonicalName: '小C',
        aliases: [],
        role: 'bridge',
        machines: [{ kind: 'local', root: '/Users/bytedance/repo' }],
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
