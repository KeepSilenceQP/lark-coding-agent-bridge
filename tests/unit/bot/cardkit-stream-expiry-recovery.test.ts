import { createLarkChannel, type LarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { installCardkitStreamDiagnostics } from '../../../src/bot/channel.js';

describe('CardKit stream expiry recovery', () => {
  it('replaces an auto-closed streaming card with the same content and sequence', async () => {
    const content = vi.fn(async () => ({
      code: 300309,
      msg: 'ErrMsg: streaming mode is closed;',
      data: {},
    }));
    const update = vi.fn(async (_request: unknown) => ({ code: 0, msg: 'success', data: {} }));
    const channel = fakeChannel(content, update);
    installCardkitStreamDiagnostics(channel);

    const result = await channel.rawClient.cardkit.v1.cardElement.content({
      path: { card_id: 'card_1', element_id: 'stream_md' },
      data: {
        content: '最终内容',
        sequence: 43,
        uuid: 'c_card_1_43',
      },
    });

    expect(result).toMatchObject({ code: 0 });
    expect(content).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    const updateRequest = update.mock.calls[0]?.[0] as {
      path?: { card_id?: string };
      data?: { sequence?: number; uuid?: string; card?: { data?: string } };
    };
    expect(updateRequest).toMatchObject({
      path: { card_id: 'card_1' },
      data: { sequence: 43, uuid: 'u_card_1_43' },
    });
    const card = JSON.parse(updateRequest.data?.card?.data ?? '{}') as {
      config?: { streaming_mode?: boolean; summary?: { content?: string } };
      body?: { elements?: Array<{ element_id?: string; content?: string }> };
    };
    expect(card.config?.streaming_mode).toBe(false);
    expect(card.config?.summary?.content).toBe('最终内容');
    expect(card.body?.elements).toContainEqual(
      expect.objectContaining({ element_id: 'stream_md', content: '最终内容' }),
    );
  });

  it('keeps the original 300309 result when full-card recovery is rejected', async () => {
    const expired = {
      code: 300309,
      msg: 'ErrMsg: streaming mode is closed;',
      data: {},
    };
    const content = vi.fn(async () => expired);
    const update = vi.fn(async (_request: unknown) => ({
      code: 300500,
      msg: 'final update rejected',
      data: {},
    }));
    const channel = fakeChannel(content, update);
    installCardkitStreamDiagnostics(channel);

    const result = await channel.rawClient.cardkit.v1.cardElement.content({
      path: { card_id: 'card_1', element_id: 'stream_md' },
      data: { content: '最终内容', sequence: 43, uuid: 'c_card_1_43' },
    });

    expect(result).toBe(expired);
    expect(update).toHaveBeenCalledOnce();
  });

  it('rejects the real markdown stream when full-card recovery remains rejected', async () => {
    const content = vi.fn(async () => ({
      code: 300309,
      msg: 'ErrMsg: streaming mode is closed;',
      data: {},
    }));
    const update = vi.fn(async (_request: unknown) => ({
      code: 300500,
      msg: 'final update rejected',
      data: {},
    }));
    const channel = realStreamingChannel(content, update);
    installCardkitStreamDiagnostics(channel);

    await expect(
      channel.stream(
        'oc_test',
        {
          markdown: async (controller) => {
            await controller.setContent('最终内容');
          },
        },
        { replyTo: 'om_parent' },
      ),
    ).rejects.toThrow(/CardKit stream recovery failed.*300500/);
  });

  it('does not use full-card recovery for successful streaming updates', async () => {
    const success = { code: 0, msg: 'success', data: {} };
    const content = vi.fn(async () => success);
    const update = vi.fn(async (_request: unknown) => undefined);
    const channel = fakeChannel(content, update);
    installCardkitStreamDiagnostics(channel);

    const result = await channel.rawClient.cardkit.v1.cardElement.content({
      path: { card_id: 'card_1', element_id: 'stream_md' },
      data: { content: '流式内容', sequence: 42, uuid: 'c_card_1_42' },
    });

    expect(result).toBe(success);
    expect(update).not.toHaveBeenCalled();
  });

  it('recovers the documented 200850 streaming timeout response', async () => {
    const content = vi.fn(async () => ({
      code: 200850,
      msg: 'Card streaming timeout',
      data: {},
    }));
    const update = vi.fn(async (_request: unknown) => ({ code: 0, msg: 'success', data: {} }));
    const channel = fakeChannel(content, update);
    installCardkitStreamDiagnostics(channel);

    const result = await channel.rawClient.cardkit.v1.cardElement.content({
      path: { card_id: 'card_1', element_id: 'stream_md' },
      data: { content: '最终内容', sequence: 43, uuid: 'c_card_1_43' },
    });

    expect(result).toMatchObject({ code: 0 });
    expect(update).toHaveBeenCalledOnce();
  });

  it('sends later snapshots directly through full-card updates after expiry', async () => {
    const content = vi.fn(async () => ({
      code: 300309,
      msg: 'ErrMsg: streaming mode is closed;',
      data: {},
    }));
    const update = vi.fn(async (_request: unknown) => ({ code: 0, msg: 'success', data: {} }));
    const channel = realStreamingChannel(content, update);
    installCardkitStreamDiagnostics(channel);

    await channel.stream(
      'oc_test',
      {
        markdown: async (controller) => {
          await controller.setContent('第一版');
          await new Promise((resolve) => setTimeout(resolve, 10));
          await controller.setContent('最终内容');
        },
      },
      { replyTo: 'om_parent' },
    );

    expect(content).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
    const finalRequest = update.mock.calls[1]?.[0] as {
      data?: { card?: { data?: string } };
    };
    const finalCard = JSON.parse(finalRequest.data?.card?.data ?? '{}') as {
      body?: { elements?: Array<{ content?: string }> };
    };
    expect(finalCard.body?.elements?.[0]?.content).toBe('最终内容');
  });

  it('rejects the stream when the recovery response has no success code', async () => {
    const content = vi.fn(async () => ({
      code: 300309,
      msg: 'ErrMsg: streaming mode is closed;',
      data: {},
    }));
    const update = vi.fn(async (_request: unknown) => ({ msg: 'missing business code', data: {} }));
    const channel = realStreamingChannel(content, update);
    installCardkitStreamDiagnostics(channel);

    await expect(
      channel.stream(
        'oc_test',
        {
          markdown: async (controller) => {
            await controller.setContent('最终内容');
          },
        },
        { replyTo: 'om_parent' },
      ),
    ).rejects.toThrow(/CardKit stream recovery failed.*code=missing/);
  });

  it('clears a transient recovery failure after a later full-card update succeeds', async () => {
    const content = vi.fn(async () => ({
      code: 300309,
      msg: 'ErrMsg: streaming mode is closed;',
      data: {},
    }));
    const update = vi
      .fn<(request: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({ code: 300500, msg: 'temporary failure', data: {} })
      .mockResolvedValueOnce({ code: 0, msg: 'success', data: {} });
    const channel = realStreamingChannel(content, update);
    installCardkitStreamDiagnostics(channel);

    await expect(
      channel.stream(
        'oc_test',
        {
          markdown: async (controller) => {
            await controller.setContent('第一版');
            await new Promise((resolve) => setTimeout(resolve, 10));
            await controller.setContent('最终内容');
          },
        },
        { replyTo: 'om_parent' },
      ),
    ).resolves.toMatchObject({ messageId: 'message_1' });
    expect(content).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
  });
});

function fakeChannel(
  content: (request: unknown) => Promise<unknown>,
  update: (request: unknown) => Promise<unknown>,
): LarkChannel {
  return {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: vi.fn(),
            update,
            settings: vi.fn(),
          },
          cardElement: { content },
        },
      },
      im: {
        v1: {
          message: {
            create: vi.fn(),
            reply: vi.fn(),
          },
        },
      },
    },
  } as unknown as LarkChannel;
}

function realStreamingChannel(
  content: (request: unknown) => Promise<unknown>,
  update: (request: unknown) => Promise<unknown>,
): LarkChannel {
  const channel = createLarkChannel({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
    outbound: { streamThrottleMs: 1 },
  });
  const raw = channel.rawClient as unknown as {
    cardkit: {
      v1: {
        card: {
          create: (request: unknown) => Promise<unknown>;
          update: (request: unknown) => Promise<unknown>;
          settings: (request: unknown) => Promise<unknown>;
        };
        cardElement: { content: (request: unknown) => Promise<unknown> };
      };
    };
    im: {
      v1: {
        message: { reply: (request: unknown) => Promise<unknown> };
      };
    };
  };
  raw.cardkit.v1.card.create = vi.fn(async () => ({
    code: 0,
    msg: 'success',
    data: { card_id: 'card_1' },
  }));
  raw.im.v1.message.reply = vi.fn(async () => ({
    code: 0,
    msg: 'success',
    data: { message_id: 'message_1' },
  }));
  raw.cardkit.v1.cardElement.content = content;
  raw.cardkit.v1.card.update = update;
  raw.cardkit.v1.card.settings = vi.fn(async () => ({ code: 0, msg: 'success', data: {} }));
  return channel;
}
