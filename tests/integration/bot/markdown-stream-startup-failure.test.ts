import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { requestDeferredServiceRestart } from '../../../src/runtime/deferred-service-restart.js';
import type { AgentEvent } from '../../../src/agent/types.js';
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

import { startChannel } from '../../../src/bot/channel.js';

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
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<unknown>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];
type SendFn = FakeLarkChannel['send'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
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
    expect(h.channel.sent).toHaveLength(1);
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
    expect(h.channel.sent).toHaveLength(1);
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
    expect(h.channel.sent).toHaveLength(1);
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

    expect(h.channel.sent).toHaveLength(1);
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

    expect(h.channel.sent).toHaveLength(1);
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

    expect(h.channel.sent).toHaveLength(1);
  });

  it('sends one dedicated non-streaming final reply after Codex progress completes', async () => {
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
        return { messageId: 'om_progress' };
      },
    });
    h.channel.rawClient.im.v1.message.get.mockResolvedValue({
      data: { items: [{ body: { content: streamingCardContent('progress update') } }] },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(visibleProgress.some((markdown) => markdown.includes('progress update'))).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_SENTINEL');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_final' });
  });

  it('still sends the Codex final reply when the progress stream fails at completion', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_AFTER_STREAM_FAILURE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
        throw new Error('progress stream failed');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stream_fail', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toContain('FINAL_AFTER_STREAM_FAILURE');
    expect(
      fail.mock.calls.some(
        (call) =>
          call[0] === 'stream' &&
          call[1] instanceof Error &&
          call[1].message === 'progress stream failed',
      ),
    ).toBe(true);
  });

  it('does not record delivery when the Codex final send has no message receipt', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_WITHOUT_RECEIPT' },
        { type: 'done', terminationReason: 'normal' },
      ],
      send: async () => ({ messageId: '' }),
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
        return { messageId: 'om_progress' };
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_receipt', 'run'));
    await waitFor(() =>
      fail.mock.calls.some(
        (call) => call[1] instanceof Error && call[1].message.includes('missing message receipt'),
      ),
    );

    expect(
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'sent'),
    ).toBe(false);
  });
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
  events?: readonly AgentEvent[];
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
    events: options.events ?? [
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
  send?: SendFn;
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
    send: options.send ?? (async (chatId, content, sendOptions) => {
      sent.push({ chatId, content, options: sendOptions });
      return { messageId: `om_sent_${sent.length}` };
    }),
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
