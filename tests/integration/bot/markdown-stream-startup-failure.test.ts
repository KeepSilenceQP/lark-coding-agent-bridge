import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { requestDeferredServiceRestart } from '../../../src/runtime/deferred-service-restart.js';
import { readRouteLease } from '../../../src/runtime/route-lease.js';
import { makeReactionKey } from '../../../src/bot/reaction/types.js';
import { WorkChainStore } from '../../../src/bot/reaction/work-chain.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { CotClient } from '../../../src/bot/cot.js';
import { withReactionTurnId } from '../../../src/bot/reaction/turn-message.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import {
  hasTurnMetaForTurnId,
  setReactionTurnMeta,
  startChannel,
} from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        chat: { get: ReturnType<typeof vi.fn> };
        message: {
          get: ReturnType<typeof vi.fn>;
          create: ReturnType<typeof vi.fn>;
          reply: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
    cardkit: {
      v1: {
        card: {
          create: ReturnType<typeof vi.fn>;
          update: ReturnType<typeof vi.fn>;
          settings: ReturnType<typeof vi.fn>;
        };
        cardElement: {
          content: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<unknown>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<unknown>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it.each([
    { cotFails: false, streamFails: true, mode: 'markdown' as const },
    { cotFails: false, streamFails: true, mode: 'card' as const },
    { cotFails: true, streamFails: false, mode: 'markdown' as const },
    { cotFails: true, streamFails: true, mode: 'markdown' as const },
  ])('acknowledges startup display failures before the agent finishes: $cotFails/$streamFails/$mode', async ({ cotFails, streamFails, mode }) => {
    const streamed: string[] = [];
    const h = await createHarness({
      stream: async (_chatId, input) => {
        if (streamFails) throw new Error('CardKit create timed out');
        const producer = (input as {
          markdown: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer({ setContent: async (markdown) => { streamed.push(markdown); } });
        return { messageId: 'om_stream' };
      },
    });
    h.profileConfig.preferences.messageReply = mode;
    h.profileConfig.preferences.cotMessages = cotFails ? 'brief' : 'off';
    h.profileConfig.access.allowedChats.push('oc_topic');
    if (cotFails) vi.spyOn(CotClient.prototype, 'create').mockRejectedValue(new Error('CoT create timed out'));
    const releaseAgent = holdFirstAgentRun(h.agent);
    await startTestBridge(h);

    try {
      await h.channel.handlers.message?.({
        ...message('om_startup_failure', 'create document'),
        chatId: 'oc_topic',
        chatType: 'group',
        mentionedBot: true,
        threadId: 'omt_topic',
      } as NormalizedMessage);
      await waitFor(() => h.agent.runOptions.length === 1);
      await waitFor(() => startupNotices(h.channel).length === 1);
      expect(h.agent.runs[0]?.stopped).toBe(false);
      expect(startupNotices(h.channel)[0]).toMatchObject({
        chatId: 'oc_topic',
        content: { markdown: '请求已收到。进度展示暂时不可用，请以最终回复为准。' },
        options: { replyTo: 'om_startup_failure', replyInThread: true },
      });
      expect(JSON.stringify(h.channel.sent)).not.toContain('完成文档');
    } finally {
      releaseAgent();
    }

    await waitFor(() => JSON.stringify([...h.channel.sent, ...streamed]).includes('完成文档'));
    expect(startupNotices(h.channel)).toHaveLength(1);
  });

  it.each(['reject', 'hang'] as const)('preserves the final reply and queued follow-up when the startup notice send %s', async (noticeFailure) => {
    const h = await createHarness({ stream: async () => { throw new Error('CardKit create timed out'); } });
    const releaseAgent = holdFirstAgentRun(h.agent);
    const send = h.channel.send.bind(h.channel);
    const delayedNotice = deferred<void>();
    let noticeAttempts = 0;
    vi.spyOn(h.channel, 'send').mockImplementation(async (chatId, content, options) => {
      if ((content as { markdown?: string }).markdown?.includes('进度展示暂时不可用')) {
        noticeAttempts++;
        if (noticeFailure === 'reject') throw new Error('IM unavailable');
        await delayedNotice.promise;
      }
      return send(chatId, content, options);
    });
    await startTestBridge(h);

    try {
      await h.channel.handlers.message?.(message('om_first', 'first'));
      await waitFor(() => noticeAttempts === 1);
      await h.channel.handlers.message?.(message('om_second', 'second'));
      expect(h.agent.runOptions).toHaveLength(1);
    } finally {
      releaseAgent();
    }

    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.channel.sent.filter((entry) => JSON.stringify(entry.content).includes('完成文档'))).toHaveLength(1);
    expect(h.agent.runs[0]?.stopped).toBe(false);
    delayedNotice.resolve();
  });

  it('notifies a mid-run CoT update failure immediately in the originating topic, only once', async () => {
    const h = await createHarness();
    h.profileConfig.preferences.messageReply = 'text';
    h.profileConfig.preferences.messageReplyMigrated = true;
    h.profileConfig.preferences.cotMessages = 'brief';
    h.profileConfig.access.allowedChats.push('oc_topic');
    vi.spyOn(CotClient.prototype, 'create').mockResolvedValue({ cot_id: 'cot_test', message_id: 'om_cot' });
    const update = vi.spyOn(CotClient.prototype, 'update').mockRejectedValue(new Error('fetch failed'));
    vi.spyOn(CotClient.prototype, 'complete').mockResolvedValue(undefined);
    const registeredOutbound = vi.spyOn(WorkChainStore.prototype, 'registerOutbound');
    const send = h.channel.send.bind(h.channel);
    vi.spyOn(h.channel, 'send').mockImplementation(async (chatId, content, options) => {
      await send(chatId, content, options);
      return { messageId: 'om_cot_degraded_notice' };
    });
    const releaseAgent = holdFirstAgentRun(h.agent);
    await startTestBridge(h);

    try {
      await h.channel.handlers.message?.({
        ...message('om_cot_update_failure', 'create document'),
        chatId: 'oc_topic',
        chatType: 'group',
        mentionedBot: true,
        threadId: 'omt_topic',
      } as NormalizedMessage);
      await waitFor(() => update.mock.calls.length === 1);
      await waitFor(() => cotDegradedNotices(h.channel).length === 1);
      expect(h.agent.runs[0]?.stopped).toBe(false);
      expect(cotDegradedNotices(h.channel)[0]).toMatchObject({
        chatId: 'oc_topic',
        content: { markdown: '进度消息更新失败，已停止展示过程；任务状态请以最终回复为准。' },
        options: { replyTo: 'om_cot_update_failure', replyInThread: true },
      });
      expect(registeredOutbound).toHaveBeenCalledWith(expect.any(String), 'om_cot_degraded_notice');
      expect(JSON.stringify(h.channel.sent)).not.toContain('完成文档');
    } finally {
      releaseAgent();
    }

    await waitFor(() => JSON.stringify(h.channel.sent).includes('完成文档'));
    expect(cotDegradedNotices(h.channel)).toHaveLength(1);
  });

  it.each(['reject', 'hang'] as const)('preserves the final reply and queued follow-up when the CoT degraded notice send %s', async (noticeFailure) => {
    const h = await createHarness();
    h.profileConfig.preferences.messageReply = 'text';
    h.profileConfig.preferences.messageReplyMigrated = true;
    h.profileConfig.preferences.cotMessages = 'brief';
    vi.spyOn(CotClient.prototype, 'create').mockResolvedValue({ cot_id: 'cot_test', message_id: 'om_cot' });
    vi.spyOn(CotClient.prototype, 'update').mockRejectedValue(new Error('fetch failed'));
    vi.spyOn(CotClient.prototype, 'complete').mockResolvedValue(undefined);
    const releaseAgent = holdFirstAgentRun(h.agent);
    const send = h.channel.send.bind(h.channel);
    const delayedNotice = deferred<void>();
    let noticeAttempts = 0;
    vi.spyOn(h.channel, 'send').mockImplementation(async (chatId, content, options) => {
      if ((content as { markdown?: string }).markdown?.includes('进度消息更新失败')) {
        noticeAttempts++;
        if (noticeFailure === 'reject') throw new Error('IM unavailable');
        await delayedNotice.promise;
      }
      return send(chatId, content, options);
    });
    await startTestBridge(h);

    try {
      await h.channel.handlers.message?.(message('om_first', 'first'));
      await waitFor(() => noticeAttempts === 1);
      await h.channel.handlers.message?.(message('om_second', 'second'));
      expect(h.agent.runOptions).toHaveLength(1);
    } finally {
      releaseAgent();
    }

    try {
      await waitFor(() => h.agent.runOptions.length === 2);
      expect(h.channel.sent.filter((entry) => JSON.stringify(entry.content).includes('完成文档'))).toHaveLength(1);
      expect(h.agent.runs[0]?.stopped).toBe(false);
    } finally {
      delayedNotice.resolve();
    }
  });

  it('routes a Reaction-triggered restart receipt back to the real target message', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    const scope = 'oc_dm';
    const operatorId = 'ou_user';
    const targetMessageId = 'om_reaction_target';
    const reactionKey = makeReactionKey(scope, operatorId, targetMessageId);
    const turnId = `${reactionKey}:1`;
    setReactionTurnMeta(reactionKey, targetMessageId, scope, 'wc-receipt-route', 1, turnId);

    const reactionMessage = withReactionTurnId(
      {
        ...message(targetMessageId, '[reaction] GoGoGo'),
        rawContentType: 'reaction' as never,
      },
      turnId,
    );
    await h.channel.handlers.message?.(reactionMessage);
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => !hasTurnMetaForTurnId(turnId));

    const routeId = h.agent.runOptions[0]?.routeId;
    expect(routeId).toBeTypeOf('string');
    const lease = await readRouteLease(h.tmp.profile, routeId!);
    expect(lease?.replyTo).toBe(targetMessageId);
    expect(h.channel.rawClient.im.v1.messageReaction.create).toHaveBeenCalledWith({
      path: { message_id: targetMessageId },
      data: { reaction_type: { emoji_type: 'Typing' } },
    });
  });

  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('agent 失败');
    expect(lastMarkdown(h.channel)).toContain('codex exited with code 1');
  });

  it('launches a deferred self-restart only after the terminal reply is rendered', async () => {
    const contents: string[] = [];
    const launchDeferredRestart = vi.fn();
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) return;
        await producer({
          setContent: async (markdown: string) => {
            contents.push(markdown);
          },
        });
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: '重启前的最终回复。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    await requestDeferredServiceRestart(h.tmp.profile, {
      profile: 'codex',
      bridgePid: process.pid,
      requestedAt: new Date().toISOString(),
    });
    await startTestBridge(h, launchDeferredRestart);

    await h.channel.handlers.message?.(message('om_restart', 'restart'));
    await waitFor(() => launchDeferredRestart.mock.calls.length === 1);

    expect(contents.at(-1)).toContain('重启前的最终回复。');
    expect(launchDeferredRestart).toHaveBeenCalledWith('codex');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(lastMarkdown(h.channel)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);

  it('falls back when the markdown stream fails after the agent render completes', async () => {
    const streamFailure = deferred<void>();
    let producerCompleted = false;
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          await producer({ setContent: vi.fn(async () => {}) });
          producerCompleted = true;
        }
        await streamFailure.promise;
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: '最终答案。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => producerCompleted);
    streamFailure.reject(new Error('CardKit stream recovery failed code=300500'));

    await waitFor(() => h.channel.sent.length > 0);
    expect(lastMarkdown(h.channel)).toContain('最终答案。');
  });

  it('preserves running footer in live markdown stream updates', async () => {
    const contents: string[] = [];
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) return;
        await producer({
          setContent: async (markdown: string) => {
            contents.push(markdown);
          },
        });
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: '处理完成。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);

    expect(contents.length).toBeGreaterThan(0);
    expect(contents.some((content) => content.includes('正在输出'))).toBe(true);
    expect(contents.at(-1)).toContain('处理完成。');
  });

  it('does not fallback when CardKit readback rewrites markdown text', async () => {
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) return { messageId: 'om_stream' };
        await producer({ setContent: async () => {} });
        return { messageId: 'om_stream' };
      },
    });
    h.agent.setEvents([
      { type: 'tool_use', id: 'tool_1', name: 'command_execution', input: 'git status' },
      { type: 'tool_result', id: 'tool_1', output: 'ok', isError: false },
      { type: 'text', delta: '最终答案。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    h.channel.rawClient.im.v1.message.get.mockResolvedValue({
      data: {
        items: [
          {
            body: {
              content: streamingCardContent(
                '> ✅ **command_****execution** — git status\n\n最终答案。',
              ),
            },
          },
        ],
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);

    expect(h.channel.rawClient.im.v1.message.get).toHaveBeenCalledWith({
      path: { message_id: 'om_stream' },
      params: { card_msg_content_type: 'user_card_content' },
    });
    expect(h.channel.rawClient.cardkit.v1.card.update).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(0);
  });

  it('repairs a confirmed stale final readback by updating the same CardKit card', async () => {
    let sequence = 0;
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const raw = sdkMock.channel!.rawClient;
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        const created = await raw.cardkit.v1.card.create({
          data: { type: 'card_json', data: streamingCardContent('...') },
        });
        const cardId = created.data.card_id as string;
        const sent = await raw.im.v1.message.reply({
          path: { message_id: 'om_first' },
          data: {
            msg_type: 'interactive',
            content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
          },
        });
        if (producer) {
          await producer({
            setContent: async (markdown: string) => {
              await raw.cardkit.v1.cardElement.content({
                path: { card_id: cardId, element_id: 'stream_md' },
                data: { content: markdown, sequence: ++sequence, uuid: `u_${sequence}` },
              });
            },
          });
        }
        await raw.cardkit.v1.card.settings({
          path: { card_id: cardId },
          data: {
            settings: JSON.stringify({ config: { streaming_mode: false } }),
            sequence: ++sequence,
            uuid: `u_${sequence}`,
          },
        });
        return { messageId: sent.data.message_id };
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: '真正的最终答案。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    h.channel.rawClient.im.v1.message.get.mockImplementation(async () => ({
      data: {
        items: [
          {
            body: {
              content: streamingCardContent(
                h.channel.rawClient.cardkit.v1.card.update.mock.calls.length > 0
                  ? '真正的最终答案。'
                  : '旧的执行中内容\n\n---\n\n🧠 正在思考…',
              ),
            },
          },
        ],
      },
    }));
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);

    expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledTimes(1);
    expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledWith({
      path: { card_id: 'card_stream' },
      data: expect.objectContaining({ sequence: sequence + 1 }),
    });
    const updateRequest = h.channel.rawClient.cardkit.v1.card.update.mock.calls[0]?.[0] as {
      data?: { card?: { data?: string } };
    };
    expect(updateRequest.data?.card?.data).toContain('真正的最终答案。');
    expect(h.channel.sent).toHaveLength(0);
  });

  it.each([
    ['SQL', "SELECT revision\nFROM ProactiveStateRevision\nWHERE collection = 'goal';", false],
    ['SQL after CoT progress', "SELECT revision\nFROM ProactiveStateRevision\nWHERE collection = 'goal';", true],
    ['text also present in card metadata', 'markdown\nstream_md', false],
  ] as const)('repairs missing middle fenced code with an intact final tail: %s', async (_label, code, cotEnabled) => {
    const tail = '后续说明保持完整。'.repeat(90);
    const codeBlock = `\`\`\`sql\n${code}\n\`\`\``;
    const finalText = cotEnabled
      ? `2. **Agent 每轮启动时读版本号**\n   相当于执行：\n\n${codeBlock.split('\n').map(line => `   ${line}`).join('\n')}\n\n3. **与上次上下文的版本比较**\n\n${tail}`
      : `相当于执行：\n\n${codeBlock}\n\n${tail}`;
    const streamed: string[] = [];
    const h = await createHarness({ stream: trackedMarkdownStream(streamed) });
    const info = vi.spyOn(log, 'info');
    if (cotEnabled) {
      h.profileConfig.preferences.cotMessages = 'brief';
      vi.spyOn(CotClient.prototype, 'create').mockResolvedValue({ cot_id: 'cot_test', message_id: 'om_cot' });
      vi.spyOn(CotClient.prototype, 'update').mockResolvedValue(undefined);
      vi.spyOn(CotClient.prototype, 'complete').mockResolvedValue(undefined);
    }
    h.agent.setEvents([
      { type: 'text', delta: finalText },
      { type: 'done', terminationReason: 'normal' },
    ]);
    h.channel.rawClient.im.v1.message.get.mockImplementation(async () => ({
      data: { items: [{ body: {
        content: streamingCardContent(
          h.channel.rawClient.cardkit.v1.card.update.mock.calls.length > 0
            ? streamed.at(-1)!
            : `相当于执行：\n\n${tail}`,
        ),
      } }] },
    }));
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => info.mock.calls.some(([phase, event]) => phase === 'flush' && event === 'end'));

    expect(h.channel.rawClient.im.v1.message.get).toHaveBeenCalledTimes(3);
    expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledTimes(1);
    const request = h.channel.rawClient.cardkit.v1.card.update.mock.calls[0]?.[0] as {
      path: { card_id: string };
      data: { card: { data: string } };
    };
    expect(request.path.card_id).toBe('card_stream');
    const repaired = JSON.parse(request.data.card.data);
    expect(repaired.body.elements[0].content).toBe(streamed.at(-1));
    expect(repaired.body.elements[0].content).toContain(code);
    if (cotEnabled) {
      expect(repaired.body.elements[0].content).toContain(`\n${codeBlock}\n`);
    }
    expect(h.channel.sent).toHaveLength(0);
  });

  it('accepts visible fenced code despite CardKit whitespace and fence rewrites', async () => {
    const tail = '后续说明保持完整。'.repeat(90);
    const h = await createHarness({ stream: trackedMarkdownStream([]) });
    h.agent.setEvents([
      { type: 'text', delta: `相当于执行：\n\n\`\`\`sql\nSELECT revision\nFROM ProactiveStateRevision\nWHERE collection = 'goal';\n\`\`\`\n\n${tail}` },
      { type: 'done', terminationReason: 'normal' },
    ]);
    h.channel.rawClient.im.v1.message.get.mockResolvedValue({
      data: { items: [{ body: {
        content: streamingCardContent(`相当于执行：\n\`\`\`\nSELECT   revision\n\nFROM ProactiveStateRevision\n\nWHERE collection = 'goal';\n\n\`\`\`\n${tail}`),
      } }] },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);

    expect(h.channel.rawClient.im.v1.message.get).toHaveBeenCalledTimes(1);
    expect(h.channel.rawClient.cardkit.v1.card.update).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(0);
  });

  it('does not require earlier fenced code in a rollover tail card', async () => {
    const tail = '后续说明保持完整。'.repeat(90);
    const h = await createHarness({
      stream: trackedMarkdownStream([], { messageId: 'om_head', chunkIds: ['om_tail'] }),
    });
    h.agent.setEvents([
      { type: 'text', delta: `\`\`\`sql\nSELECT revision;\n\`\`\`\n\n${tail}` },
      { type: 'done', terminationReason: 'normal' },
    ]);
    h.channel.rawClient.im.v1.message.get.mockResolvedValue({
      data: { items: [{ body: { content: streamingCardContent(tail) } }] },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);

    expect(h.channel.rawClient.im.v1.message.get).toHaveBeenCalledWith({
      path: { message_id: 'om_tail' },
      params: { card_msg_content_type: 'user_card_content' },
    });
    expect(h.channel.rawClient.cardkit.v1.card.update).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(0);
  });

  it('skips readback for likely markdown rollover when stream returns no chunk ids', async () => {
    const finalText = '最终答案。'.repeat(9000);
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) return { messageId: 'om_head' };
        await producer({ setContent: async () => {} });
        return { messageId: 'om_head' };
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: finalText },
      { type: 'done', terminationReason: 'normal' },
    ]);
    h.channel.rawClient.im.v1.message.get.mockResolvedValue({
      data: { items: [{ body: { content: streamingCardContent('旧的 head 内容') } }] },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);

    expect(h.channel.rawClient.im.v1.message.get).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(0);
  });

  it('does not fallback when interactive readback only returns downgraded card content', async () => {
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) return { messageId: 'om_stream' };
        await producer({ setContent: async () => {} });
        return { messageId: 'om_stream' };
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: '最终答案。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    h.channel.rawClient.im.v1.message.get.mockResolvedValue({
      data: {
        items: [
          {
            body: {
              content: JSON.stringify({
                title: null,
                elements: [[{ tag: 'text', text: '请升级至最新版本客户端，以查看内容' }]],
              }),
            },
          },
        ],
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);

    expect(h.channel.sent).toHaveLength(0);
  });

  it('normalizes readback whitespace before matching final markdown', async () => {
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) return { messageId: 'om_stream' };
        await producer({ setContent: async () => {} });
        return { messageId: 'om_stream' };
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: '第一段\n\n第二段' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    h.channel.rawClient.im.v1.message.get.mockResolvedValue({
      data: { items: [{ body: { content: streamingCardContent('第一段\n第二段') } }] },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);

    expect(h.channel.sent).toHaveLength(0);
  });

  it('does not fallback when final markdown stream readback fails', async () => {
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) return { messageId: 'om_stream' };
        await producer({ setContent: async () => {} });
        return { messageId: 'om_stream' };
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: '最终答案。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    h.channel.rawClient.im.v1.message.get.mockRejectedValue(new Error('readback failed'));
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);

    expect(h.channel.sent).toHaveLength(0);
  });
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  tmp: TmpProfile;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}, launchDeferredRestart?: (profile: string) => void): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    appPaths: {
      secretsFile: join(h.tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(h.tmp.profile, '.keystore.salt'),
      mediaDir: join(h.tmp.profile, 'media'),
      profileDir: h.tmp.profile,
    },
    launchDeferredRestart,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          chat: {
            get: vi.fn(async () => ({ data: { chat_mode: 'group', group_message_type: 'chat' } })),
          },
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
            create: vi.fn(async () => ({ data: { message_id: 'om_stream' } })),
            reply: vi.fn(async () => ({ data: { message_id: 'om_stream' } })),
          },
          messageReaction: {
            create: vi.fn(options.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
            delete: vi.fn(async () => ({})),
          },
        },
      },
      cardkit: {
        v1: {
          card: {
            create: vi.fn(async () => ({ data: { card_id: 'card_stream' } })),
            update: vi.fn(async () => ({ code: 0, data: {} })),
            settings: vi.fn(async () => ({ code: 0, data: {} })),
          },
          cardElement: {
            content: vi.fn(async () => ({ code: 0, data: {} })),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
    },
    stream: options.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function holdFirstAgentRun(agent: FakeAgentAdapter): () => void {
  const gate = deferred<void>();
  const runAgent = agent.run.bind(agent);
  vi.spyOn(agent, 'run').mockImplementationOnce((opts) => {
    const run = runAgent(opts);
    const events: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'tool_use', id: 'tool_pending', name: 'write_document', input: {} };
        await gate.promise;
        yield { type: 'tool_result', id: 'tool_pending', output: 'written', isError: false };
        yield { type: 'text', delta: '完成文档。' };
        yield { type: 'done', terminationReason: 'normal' };
      },
    };
    return {
      runId: run.runId,
      events,
      stop: async () => { gate.resolve(); await run.stop(); },
      waitForExit: (timeoutMs) => run.waitForExit(timeoutMs),
    };
  });
  return () => gate.resolve();
}

function startupNotices(channel: FakeLarkChannel): FakeLarkChannel['sent'] {
  return channel.sent.filter((entry) =>
    (entry.content as { markdown?: string }).markdown?.includes('进度展示暂时不可用'),
  );
}

function cotDegradedNotices(channel: FakeLarkChannel): FakeLarkChannel['sent'] {
  return channel.sent.filter((entry) =>
    (entry.content as { markdown?: string }).markdown?.includes('进度消息更新失败'),
  );
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

function trackedMarkdownStream(
  contents: string[],
  result?: { messageId: string; chunkIds: string[] },
): StreamFn {
  return async (_chatId, input) => {
    const raw = sdkMock.channel!.rawClient;
    const created = await raw.cardkit.v1.card.create({
      data: { type: 'card_json', data: streamingCardContent('...') },
    });
    const sent = await raw.im.v1.message.reply({
      path: { message_id: 'om_first' },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: created.data.card_id } }),
      },
    });
    const producer = (input as {
      markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
    }).markdown;
    await producer?.({ setContent: async (markdown) => { contents.push(markdown); } });
    return result ?? { messageId: sent.data.message_id };
  };
}

function streamingCardContent(markdown: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { streaming_mode: true },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: 'stream_md',
          content: markdown,
        },
      ],
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
