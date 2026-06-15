import { describe, expect, it } from 'vitest';
import { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';

describe('ChatModeCache', () => {
  it('does not cache regular group mode so topic conversions can be detected', async () => {
    const cache = new ChatModeCache();
    const channel = new FakeModeChannel(['group', 'topic']);

    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('group');
    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('topic');
    expect(channel.calls).toBe(2);
  });

  it('caches topic mode once resolved', async () => {
    const cache = new ChatModeCache();
    const channel = new FakeModeChannel(['topic', 'group']);

    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('topic');
    await expect(cache.resolve(channel as never, 'oc_chat')).resolves.toBe('topic');
    expect(channel.calls).toBe(1);
  });
});

class FakeModeChannel {
  calls = 0;
  private readonly modes: Array<'group' | 'topic'>;

  constructor(modes: Array<'group' | 'topic'>) {
    this.modes = [...modes];
  }

  async getChatMode(): Promise<'group' | 'topic'> {
    this.calls++;
    return this.modes.shift() ?? 'group';
  }
}
