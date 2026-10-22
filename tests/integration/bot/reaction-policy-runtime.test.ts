import type { NormalizedMessage, ReactionEvent } from '@larksuite/channel';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { DEFAULT_REACTION_POLICY, parseReactionPolicy, type ReactionRule } from '../../../src/bot/reaction/policy.js';
import type { ReactionContext } from '../../../src/bot/reaction/types.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRuntimeChannel> | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: sdkMock.createLarkChannel,
}));

import { startChannel } from '../../../src/bot/channel.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
});

const completedStep: ReactionRule = {
  behavior: 'agent',
  semanticKey: 'user_step_completed',
  emojiDisplay: '步骤完成',
  emojiMeaning: '我已完成你要求的手动步骤，请从当前任务的断点继续。',
};

describe('reaction configuration in an already connected bridge', () => {
  it('reloads CheckMark and custom emoji meanings into the actual Agent prompt without reconnecting', async () => {
    const h = await createHarness();
    h.channel.addTarget('om_before');
    await h.react('om_before', 'CheckMark');
    await h.waitForRuns(1);
    const before = contexts(h.agent.runOptions[0]!.prompt)[0]!;
    expect(before.triggerReactions[0]?.semanticKey).toBe('approve_continue');

    const version = await h.configure({
      ...DEFAULT_REACTION_POLICY.rules,
      CheckMark: completedStep,
      MyStepDone: { ...completedStep, emojiDisplay: '自定义完成' },
    });
    h.channel.addTarget('om_after');
    await h.react('om_after', 'CheckMark');
    await h.waitForRuns(2);
    const after = contexts(h.agent.runOptions[1]!.prompt)[0]!;
    expect(after).toMatchObject({
      policyVersion: version,
      targetMessage: { available: true, messageId: 'om_after', content: '请完成手动步骤后继续。' },
      triggerReactions: [{ emojiType: 'CheckMark', ...completedStep, emojiMeaningSource: 'predefined' }],
      effectiveReactionSet: [{ emojiType: 'CheckMark', ...completedStep, emojiMeaningSource: 'predefined' }],
    });
    expect(after.policyVersion).not.toBe(before.policyVersion);

    h.channel.addTarget('om_custom');
    await h.react('om_custom', 'MyStepDone');
    await h.waitForRuns(3);
    expect(contexts(h.agent.runOptions[2]!.prompt)[0]?.triggerReactions).toEqual([
      expect.objectContaining({ emojiType: 'MyStepDone', semanticKey: 'user_step_completed', emojiMeaning: completedStep.emojiMeaning }),
    ]);
    expect(h.channel.connect).toHaveBeenCalledOnce();
    expect(sdkMock.createLarkChannel).toHaveBeenCalledOnce();
  }, 15_000);

  it('uses a hot-added passive rule before any target fetch or Agent work on add and remove', async () => {
    const h = await createHarness();
    await h.configure({
      MyHandled: { behavior: 'passive', semanticKey: 'handled', emojiMeaning: '仅作为已处理标记。' },
    });
    h.channel.addTarget('om_passive');
    const get = h.channel.rawClient.im.v1.message.get;
    get.mockClear();
    h.channel.fetchRawMessage.mockClear();
    h.channel.rawClient.im.v1.messageReaction.list.mockClear();

    await h.react('om_passive', 'MyHandled');
    await h.react('om_passive', 'MyHandled', 'removed');

    expect(get).not.toHaveBeenCalled();
    expect(h.channel.fetchRawMessage).not.toHaveBeenCalled();
    expect(h.channel.rawClient.im.v1.messageReaction.list).not.toHaveBeenCalled();
    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('routes a hot-added stop emoji to control and cancels a queued original task without running the Agent', async () => {
    const h = await createHarness();
    await h.configure({
      MyStop: { behavior: 'stop', semanticKey: 'stop_here', emojiMeaning: '立即停止当前任务。' },
    });
    h.channel.addTarget('om_original', 'ou_user', 'user');
    await h.channel.handlers.message!(message('om_original'));
    await h.react('om_original', 'MyStop');

    expect(h.channel.sent).toContainEqual(expect.objectContaining({
      content: { markdown: '已停止当前任务。' },
      options: { replyTo: 'om_original' },
    }));
    expect(h.channel.rawClient.im.v1.messageReaction.list).not.toHaveBeenCalled();
    expect(h.channel.fetchRawMessage).not.toHaveBeenCalled();
    // Let the normal intake debounce elapse: the stopped task must stay cancelled.
    await new Promise(resolve => setTimeout(resolve, 750));
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('keeps the last valid meanings for subsequent real events after an invalid runtime edit', async () => {
    const h = await createHarness();
    const version = await h.configure({ CheckMark: completedStep });
    h.channel.addTarget('om_valid');
    await h.react('om_valid', 'CheckMark');
    await h.waitForRuns(1);

    await writeFile(h.policyPath, '{"rules":');
    h.channel.addTarget('om_bad_edit');
    await h.react('om_bad_edit', 'CheckMark');
    await h.waitForRuns(2);
    expect(contexts(h.agent.runOptions[1]!.prompt)[0]).toMatchObject({
      policyVersion: version,
      triggerReactions: [{ emojiType: 'CheckMark', ...completedStep }],
    });
    expect(h.channel.connect).toHaveBeenCalledOnce();
  }, 10_000);

  it('moves continuation off GoGoGo while retaining author and registered-original guards end to end', async () => {
    const h = await createHarness();
    h.channel.addTarget('om_known_original', 'ou_user', 'user');
    await h.channel.handlers.message!(message('om_known_original'));
    await h.waitForRuns(1);

    await h.configure({
      MyResume: {
        behavior: 'continue', semanticKey: 'resume_original',
        emojiMeaning: '继续自己已经交给当前 Bot 的原任务，不重复已完成动作。',
      },
    });
    h.channel.addTarget('om_unknown_original', 'ou_user', 'user');
    // The old binding is now unmapped. Neither an unknown original nor another
    // operator may acquire continuation rights from the new configuration.
    await h.react('om_known_original', 'GoGoGo');
    await h.react('om_unknown_original', 'MyResume');
    await h.react('om_known_original', 'MyResume', 'added', 'ou_other');
    expect(h.channel.rawClient.im.v1.messageReaction.list).not.toHaveBeenCalled();
    expect(h.agent.runOptions).toHaveLength(1);

    await h.react('om_known_original', 'MyResume');
    await h.waitForRuns(2);
    expect(contexts(h.agent.runOptions[1]!.prompt)[0]).toMatchObject({
      operatorOpenId: 'ou_user',
      triggerReactions: [{ emojiType: 'MyResume', behavior: 'continue', semanticKey: 'resume_original' }],
      targetMessage: { messageId: 'om_known_original', senderId: 'ou_user', available: true },
    });
    expect(h.channel.connect).toHaveBeenCalledOnce();
  }, 10_000);
});

interface Handlers {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
  reaction?: (event: ReactionEvent) => Promise<void> | void;
}

interface RawTarget {
  message_id: string;
  chat_id: string;
  msg_type: 'text';
  sender: { id: string; sender_type: 'user' | 'app' };
  body: { content: string };
  create_time: string;
}

function createRuntimeChannel() {
  const base = createFakeChannel();
  const handlers: Handlers = {};
  const targets = new Map<string, RawTarget>();
  const reactions = new Map<string, Array<{
    reaction_id: string;
    operator: { operator_id: string; operator_type: 'user' };
    reaction_type: { emoji_type: string };
  }>>();
  return {
    ...base,
    handlers,
    targets,
    reactions,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    on: (next: Handlers) => { Object.assign(handlers, next); },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listChats: vi.fn(async () => []),
    addReaction: vi.fn(async () => 'bridge_typing'),
    removeReaction: vi.fn(async () => {}),
    getChatMode: async () => 'group' as const,
    getConnectionStatus: () => ({ state: 'connected' as const, reconnectAttempts: 0 }),
    fetchRawMessage: vi.fn(async (messageId: string) => {
      const target = targets.get(messageId);
      return target ? [target] : [];
    }),
    addTarget(messageId: string, senderId = 'ou_bot', senderType: 'app' | 'user' = 'app') {
      targets.set(messageId, {
        message_id: messageId, chat_id: 'oc_chat', msg_type: 'text',
        sender: { id: senderId, sender_type: senderType },
        body: { content: JSON.stringify({ text: '请完成手动步骤后继续。' }) },
        create_time: String(Date.now()),
      });
    },
    rawClient: {
      ...base.rawClient,
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: { v6: { application: {
        get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_user' } } } })),
      } } },
      im: { v1: {
        ...base.rawClient.im.v1,
        message: {
          ...base.rawClient.im.v1.message,
          get: vi.fn(async (params: { path: { message_id: string } }) => {
            const target = targets.get(params.path.message_id);
            return { data: { items: target ? [target] : [] } };
          }),
        },
        messageReaction: {
          create: vi.fn(async () => ({ data: { reaction_id: 'bridge_typing' } })),
          delete: vi.fn(async () => ({})),
          list: vi.fn(async (params: { path: { message_id: string } }) => ({
            data: { items: reactions.get(params.path.message_id) ?? [], has_more: false },
          })),
        },
      } },
    },
  };
}

async function createHarness() {
  const tmp = await createTmpProfile('reaction-policy-runtime-');
  cleanups.push(() => tmp.cleanup());
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: {
      allowedChats: ['oc_chat'], allowedUsers: ['ou_user', 'ou_other'],
      groupResponseMode: 'all-messages', requireMentionInGroup: false,
    },
  });
  profileConfig.workspaces.default = await realpath(tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ events: Array.from({ length: 5 }, () => [
    { type: 'done' as const, terminationReason: 'normal' as const },
  ]) });
  const channel = createRuntimeChannel();
  sdkMock.channel = channel;
  const controls: Controls = {
    profile: 'test', profileConfig, cfg: profileConfig,
    configPath: join(tmp.root, 'config.json'), processId: 'reaction_policy_test',
    ownerRefreshState: 'unknown', botOwnerId: 'ou_user',
    async refreshOwner() {}, async restart() {}, async exit() {},
  };
  await saveRootConfig(createRootConfig('test', profileConfig), controls.configPath);
  const bridge = await startChannel({
    cfg: profileConfig, agent, sessions, workspaces, controls,
    appPaths: {
      profileDir: tmp.profile, secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, '.keystore.salt'), mediaDir: join(tmp.profile, 'media'),
    },
  });
  cleanups.push(() => bridge.disconnect());
  // Self-registration runs in the background. Wait for its persisted result so
  // even the no-op passive test cannot remove the profile under that writer.
  await vi.waitFor(async () => {
    expect((await loadRootConfig(controls.configPath))?.botRegistry?.entries).toContainEqual({
      name: 'Bridge', aliases: [], appId: 'cli_test',
    });
  }, { timeout: 3000, interval: 20 });
  const policyPath = join(tmp.profile, 'reaction-semantics.json');
  let eventId = 0;
  return {
    agent, channel, policyPath,
    async configure(rules: Readonly<Record<string, Readonly<ReactionRule>>>) {
      const content = JSON.stringify({ schemaVersion: 1, rules });
      await writeFile(policyPath, content);
      return parseReactionPolicy(content).version;
    },
    async react(messageId: string, emojiType: string, action: 'added' | 'removed' = 'added', operatorId = 'ou_user') {
      const id = `reaction_event_${eventId++}`;
      channel.reactions.set(messageId, action === 'added' ? [{
        reaction_id: id, operator: { operator_id: operatorId, operator_type: 'user' },
        reaction_type: { emoji_type: emojiType },
      }] : []);
      await channel.handlers.reaction!({
        messageId, emojiType, action, operator: { openId: operatorId }, actionTime: Date.now(),
        raw: { operator_type: 'user', header: { event_id: id } },
      });
    },
    async waitForRuns(count: number) {
      await vi.waitFor(() => expect(agent.runOptions).toHaveLength(count), { timeout: 5000, interval: 20 });
    },
  };
}

function message(messageId: string): NormalizedMessage {
  return {
    messageId, chatId: 'oc_chat', chatType: 'group', senderId: 'ou_user', senderName: 'User',
    content: '请执行这条任务。', rawContentType: 'text', resources: [], mentions: [],
    mentionAll: false, mentionedBot: false, createTime: Date.now(),
    raw: { sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' }, message: { message_id: messageId } },
  } as unknown as NormalizedMessage;
}

function contexts(prompt: string): ReactionContext[] {
  const match = prompt.match(/<reaction_contexts>\n([\s\S]*?)\n<\/reaction_contexts>/u);
  if (!match) throw new Error('Agent prompt is missing reaction_contexts');
  return JSON.parse(match[1]!) as ReactionContext[];
}
