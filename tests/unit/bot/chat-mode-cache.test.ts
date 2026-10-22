import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';

function fakeChannel(...responses: unknown[]) {
  const get = vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    get,
    channel: { rawClient: { im: { v1: { chat: { get } } } } } as unknown as LarkChannel,
  };
}

describe('ChatModeCache', () => {
  it.each([
    { metadata: { chat_mode: 'group', group_message_type: 'chat' }, mode: 'group' },
    { metadata: { chat_mode: 'group', group_message_type: 'thread' }, mode: 'topic' },
    { metadata: { chat_mode: 'group' }, mode: 'group' },
    { metadata: { chat_mode: 'topic' }, mode: 'topic' },
    { metadata: { chat_mode: 'p2p' }, mode: 'p2p' },
  ])('resolves and caches $metadata as $mode with one raw request', async ({ metadata, mode }) => {
    const cache = new ChatModeCache();
    const api = fakeChannel({ code: 0, data: metadata });

    await expect(cache.resolveKnown(api.channel, 'oc_chat')).resolves.toBe(mode);
    await expect(cache.resolve(api.channel, 'oc_chat')).resolves.toBe(mode);
    expect(api.get).toHaveBeenCalledOnce();
    expect(api.get).toHaveBeenCalledWith({ path: { chat_id: 'oc_chat' } });
  });

  it('re-probes after invalidation to detect group/thread conversion', async () => {
    const cache = new ChatModeCache();
    const api = fakeChannel(
      { data: { chat_mode: 'group', group_message_type: 'chat' } },
      { data: { chat_mode: 'group', group_message_type: 'thread' } },
    );

    await expect(cache.resolve(api.channel, 'oc_chat')).resolves.toBe('group');
    cache.invalidate('oc_chat');
    await expect(cache.resolveKnown(api.channel, 'oc_chat')).resolves.toBe('topic');
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: 'transport error', response: new Error('unavailable') },
    { label: 'API error', response: { code: 999, data: { chat_mode: 'group', group_message_type: 'chat' } } },
    { label: 'missing data', response: { data: {} } },
    { label: 'unknown chat mode', response: { data: { chat_mode: 'unexpected' } } },
    { label: 'unknown group message mode', response: { data: { chat_mode: 'group', group_message_type: 'future' } } },
  ])('preserves $label as unknown without poisoning the cache', async ({ response }) => {
    const cache = new ChatModeCache();
    const api = fakeChannel(response, { data: { chat_mode: 'group', group_message_type: 'thread' } });

    await expect(cache.resolveKnown(api.channel, 'oc_chat')).resolves.toBeUndefined();
    await expect(cache.resolveKnown(api.channel, 'oc_chat')).resolves.toBe('topic');
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('retains the existing group routing fallback without caching it', async () => {
    const cache = new ChatModeCache();
    const api = fakeChannel(new Error('unavailable'), { data: { chat_mode: 'topic' } });

    await expect(cache.resolve(api.channel, 'oc_chat')).resolves.toBe('group');
    await expect(cache.resolveKnown(api.channel, 'oc_chat')).resolves.toBe('topic');
  });
});
