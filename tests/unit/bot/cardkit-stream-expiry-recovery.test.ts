import type { LarkChannel } from '@larksuite/channel';
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
