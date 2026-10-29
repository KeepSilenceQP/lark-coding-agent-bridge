import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const fixture = vi.hoisted(() => ({
  channel: undefined as LarkChannel | undefined,
  message: undefined as ((msg: NormalizedMessage) => Promise<void> | void) | undefined,
  state: 'connected',
  connections: 0,
  failConnections: 0,
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: (opts: ConstructorParameters<typeof actual.LarkChannel>[0]) => {
      // Keep the real SDK channel, its watchdog, and its reconnect lifecycle.
      // Only the socket handshake and outbound Feishu calls are replaced.
      const channel = new actual.LarkChannel(opts);
      fixture.channel = channel;
      const transport = channel as unknown as { connectWebSocket(timeoutMs: number): Promise<void> };
      vi.spyOn(transport, 'connectWebSocket').mockImplementation(async () => {
        fixture.connections++;
        fixture.state = 'reconnecting';
        channel.rawWsClient = {
          close: vi.fn(() => { fixture.state = 'closed'; }),
          getConnectionStatus: () => ({ state: fixture.state, reconnectAttempts: 0 }),
        } as unknown as NonNullable<LarkChannel['rawWsClient']>;
        if (fixture.failConnections > 0) {
          fixture.failConnections--;
          throw new Error('simulated handshake failure');
        }
        fixture.state = 'connected';
      });
      vi.spyOn(channel.rawClient, 'request').mockResolvedValue({ bot: { open_id: 'ou_bot', app_name: 'Bridge' } });
      vi.spyOn(channel.rawClient.im.v1.chat, 'get').mockResolvedValue({ data: { chat_mode: 'group', group_message_type: 'chat' } });
      vi.spyOn(channel, 'listChats').mockResolvedValue([]);
      vi.spyOn(channel, 'getChatMode').mockResolvedValue('group');
      vi.spyOn(channel, 'send').mockResolvedValue({ messageId: 'om_final' });
      vi.spyOn(channel, 'addReaction').mockResolvedValue('reaction_1');
      vi.spyOn(channel, 'removeReaction').mockResolvedValue(undefined);
      const on = channel.on.bind(channel);
      vi.spyOn(channel, 'on').mockImplementation((handlers) => {
        if (handlers.message) fixture.message = handlers.message;
        return on(handlers);
      });
      return channel;
    },
  };
});

import { startChannel } from '../../../src/bot/channel.js';

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
  fixture.connections = 0;
  fixture.failConnections = 0;
  fixture.state = 'connected';
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fixture.channel = undefined;
  fixture.message = undefined;
});

describe('automatic keepalive preserves bridge work', () => {
  it('reconnects the socket while the active run and its queued follow-up complete', async () => {
    const h = await harness();
    await fixture.message!(message('om_first', 'first'));
    await vi.waitFor(() => expect(h.agent.runs).toHaveLength(1));
    await fixture.message!(message('om_followup', 'follow up'));
    fixture.state = 'reconnecting';

    await vi.advanceTimersByTimeAsync(45_000);

    expect(h.controls.restart).not.toHaveBeenCalled();
    expect(fixture.connections).toBe(2);
    expect(h.agent.runs[0]?.stopped).toBe(false);
    expect(h.agent.runs).toHaveLength(1);
    h.release();
    await vi.waitFor(() => expect(h.agent.runs).toHaveLength(2));
    await vi.waitFor(() => expect(fixture.channel!.send).toHaveBeenCalledTimes(3));
    expect(fixture.channel!.send).toHaveBeenNthCalledWith(1, 'oc_dm',
      { markdown: expect.stringContaining('已收到并排队') },
      expect.objectContaining({ replyTo: 'om_followup' }));
    expect(fixture.channel!.send).toHaveBeenNthCalledWith(2, 'oc_dm',
      { markdown: expect.stringContaining('first complete') },
      expect.objectContaining({ replyTo: 'om_first' }));
    expect(fixture.channel!.send).toHaveBeenNthCalledWith(3, 'oc_dm',
      { markdown: expect.stringContaining('follow-up complete') },
      expect.objectContaining({ replyTo: 'om_followup' }));
    expect(h.agent.runs.every((run) => !run.stopped)).toBe(true);
  });

  it('keeps the active run alive across a failed handshake and a later retry', async () => {
    const h = await harness();
    await fixture.message!(message('om_first', 'first'));
    await vi.waitFor(() => expect(h.agent.runs).toHaveLength(1));
    fixture.state = 'reconnecting';
    fixture.failConnections = 1;

    await vi.advanceTimersByTimeAsync(45_000);
    expect(fixture.connections).toBe(2);
    expect(h.agent.runs[0]?.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(fixture.connections).toBe(3);
    expect(h.controls.restart).not.toHaveBeenCalled();
    expect(h.agent.runs[0]?.stopped).toBe(false);
    h.release();
    await vi.waitFor(() => expect(fixture.channel!.send).toHaveBeenCalledTimes(1));
  });

  it('still stops active runs and the watchdog during explicit bridge shutdown', async () => {
    const h = await harness();
    await fixture.message!(message('om_first', 'first'));
    await vi.waitFor(() => expect(h.agent.runs).toHaveLength(1));

    await h.bridge.disconnect();

    expect(h.agent.runs[0]?.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.connections).toBe(1);
    expect(h.controls.restart).not.toHaveBeenCalled();
  });

  it('does not reconnect after shutdown while an HTTP health probe is in flight', async () => {
    const h = await harness();
    fixture.state = 'reconnecting';
    await vi.advanceTimersByTimeAsync(30_000);
    let finishProbe!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finishProbe = resolve;
    }));
    await vi.advanceTimersByTimeAsync(15_000);

    await h.bridge.disconnect();
    finishProbe({ status: 200 } as Response);
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.connections).toBe(1);
    expect(h.controls.restart).not.toHaveBeenCalled();
  });

  it('does not force another reconnect when the socket recovers during the probe', async () => {
    const h = await harness();
    fixture.state = 'reconnecting';
    await vi.advanceTimersByTimeAsync(30_000);
    let finishProbe!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finishProbe = resolve;
    }));
    await vi.advanceTimersByTimeAsync(15_000);

    fixture.state = 'connected';
    finishProbe({ status: 200 } as Response);
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.connections).toBe(1);
    expect(h.controls.restart).not.toHaveBeenCalled();
  });
});

async function harness() {
  const tmp = await createTmpProfile('keepalive-run-continuity-');
  cleanups.push(() => tmp.cleanup());
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    codex: { binaryPath: '/usr/local/bin/codex' },
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
  });
  profileConfig.workspaces.default = tmp.workspace;
  profileConfig.preferences.messageReply = 'text';
  profileConfig.preferences.messageReplyMigrated = true;
  profileConfig.preferences.cotMessages = 'off';
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ id: 'codex', events: [
    [{ type: 'text', delta: 'first complete' }, { type: 'done', terminationReason: 'normal' }],
    [{ type: 'text', delta: 'follow-up complete' }, { type: 'done', terminationReason: 'normal' }],
  ] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runAgent = agent.run.bind(agent);
  vi.spyOn(agent, 'run').mockImplementationOnce((opts) => {
    const run = runAgent(opts);
    return {
      runId: run.runId,
      events: {
        async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
          yield { type: 'tool_use', id: 'tool_pending', name: 'long_work', input: {} };
          await gate;
          yield* run.events;
        },
      },
      stop: async () => { await run.stop(); release(); },
      waitForExit: (timeoutMs) => run.waitForExit(timeoutMs),
    };
  });
  const controls = {
    profile: 'codex', profileConfig, cfg: profileConfig,
    configPath: join(tmp.profile, 'config.json'), processId: 'proc_test',
    ownerRefreshState: 'unknown' as const, async refreshOwner() {},
    restart: vi.fn(async () => {}), async exit() {},
  };
  const bridge = await startChannel({ cfg: profileConfig, agent, sessions, workspaces, controls });
  cleanups.push(async () => { release(); await bridge.disconnect(); });
  return { agent, controls, bridge, release };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId, chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_user', content,
    rawContentType: 'text', resources: [], mentionedBot: false, createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}
