import { describe, expect, it } from 'vitest';
import {
  planBootstrap,
  type LiveBotMember,
} from '../../../src/project/dispatch';
import type { BotRegistryEntry } from '../../../src/project/bot-registry';

describe('bootstrap planning', () => {
  const implementer: BotRegistryEntry = {
    name: 'Implementer Bot',
    aliases: ['Implementation Alias'],
    appId: 'cli_test_implementer',
  };
  const planner: BotRegistryEntry = {
    name: 'Planner Bot',
    aliases: [],
    appId: 'cli_test_planner',
  };
  const baseInput = {
    slug: 'test-project',
    workspacePath: './workspace with spaces/$HOME',
    coordinatorOpenId: 'ou_coordinator',
  };

  it('marks targets as blocked when no live members exist', () => {
    const plan = planBootstrap({
      ...baseInput,
      liveMembers: [],
      registry: [implementer, planner],
    });

    expect(plan.results).toEqual([
      {
        botName: 'Implementer Bot',
        status: 'blocked',
        blockedReason: 'bot_not_in_group',
      },
      {
        botName: 'Planner Bot',
        status: 'blocked',
        blockedReason: 'bot_not_in_group',
      },
    ]);
    expect(plan.instructions).toHaveLength(0);
  });

  it('matches canonical names and passes the original workspace text through', () => {
    const liveMembers: LiveBotMember[] = [
      { openId: 'ou_implementer', name: 'Implementer Bot' },
    ];
    const plan = planBootstrap({
      ...baseInput,
      liveMembers,
      registry: [implementer],
    });

    expect(plan.results).toEqual([
      { botName: 'Implementer Bot', status: 'sent' },
    ]);
    expect(plan.instructions).toEqual([
      {
        targetName: 'Implementer Bot',
        targetOpenId: 'ou_implementer',
        kind: 'cd-and-invite',
        workspacePath: './workspace with spaces/$HOME',
      },
    ]);
  });

  it('matches aliases using NFC exact equality', () => {
    const plan = planBootstrap({
      ...baseInput,
      liveMembers: [{ openId: 'ou_implementer', name: 'Implementation Alias' }],
      registry: [implementer],
    });

    expect(plan.results[0]?.status).toBe('sent');
    expect(plan.instructions[0]?.targetOpenId).toBe('ou_implementer');
  });

  it('skips the Coordinator instead of dispatching to itself', () => {
    const plan = planBootstrap({
      ...baseInput,
      liveMembers: [
        { openId: 'ou_coordinator', name: 'Implementer Bot' },
        { openId: 'ou_planner', name: 'Planner Bot' },
      ],
      registry: [implementer, planner],
    });

    expect(plan.results.map((result) => result.botName)).toEqual(['Planner Bot']);
    expect(plan.instructions.map((instruction) => instruction.targetName)).toEqual(['Planner Bot']);
  });

  it('blocks duplicate canonical live matches without guessing an open_id', () => {
    const plan = planBootstrap({
      ...baseInput,
      liveMembers: [
        { openId: 'ou_first', name: 'Implementer Bot' },
        { openId: 'ou_second', name: 'Implementer Bot' },
      ],
      registry: [implementer],
    });

    expect(plan.results).toEqual([
      {
        botName: 'Implementer Bot',
        status: 'blocked',
        blockedReason: 'ambiguous_name',
      },
    ]);
    expect(plan.instructions).toHaveLength(0);
  });

  it('blocks when canonical and alias each match a different live Bot', () => {
    const plan = planBootstrap({
      ...baseInput,
      liveMembers: [
        { openId: 'ou_first', name: 'Implementer Bot' },
        { openId: 'ou_second', name: 'Implementation Alias' },
      ],
      registry: [implementer],
    });

    expect(plan.results[0]?.blockedReason).toBe('ambiguous_name');
    expect(plan.instructions).toHaveLength(0);
  });
});
