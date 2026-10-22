import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

export type ChatMode = 'p2p' | 'group' | 'topic';

/**
 * In-memory cache for authoritative chat metadata.
 *
 * Why: chat mode (`p2p` / `group` / `topic`) doesn't change within a chat's
 * lifetime under normal use, and the SDK doesn't expose it on the message
 * event — so we cache by chatId to avoid an `im.v1.chat.get` round-trip per
 * message. Admins can still convert a regular group into a topic group: the
 * channel layer treats a message-level `threadId` as authoritative and calls
 * `invalidate(chatId)` whenever a cached non-topic answer is contradicted, so
 * the next resolve re-probes and a stale `group` entry can't outlive one
 * message.
 *
 * Read both chat_mode and group_message_type in one request: the SDK's
 * getChatMode only reads chat_mode and loses ordinary groups in thread mode.
 * resolveKnown preserves lookup failures for policy callers that must fail
 * closed; resolve retains the existing group fallback for routing callers.
 */
export class ChatModeCache {
  private readonly cache = new Map<string, ChatMode>();

  async resolve(channel: LarkChannel, chatId: string): Promise<ChatMode> {
    return await this.resolveKnown(channel, chatId) ?? 'group';
  }

  async resolveKnown(channel: LarkChannel, chatId: string): Promise<ChatMode | undefined> {
    const hit = this.cache.get(chatId);
    if (hit) return hit;
    try {
      const response = await channel.rawClient.im.v1.chat.get({ path: { chat_id: chatId } });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`chat.get returned code ${response.code}`);
      }
      const metadata = response.data;
      const rawMode = metadata?.chat_mode;
      if (rawMode !== 'p2p' && rawMode !== 'group' && rawMode !== 'topic') {
        throw new Error('chat.get returned no recognized chat_mode');
      }
      if (rawMode === 'group' && metadata?.group_message_type
        && metadata.group_message_type !== 'chat' && metadata.group_message_type !== 'thread') {
        throw new Error('chat.get returned an unrecognized group_message_type');
      }
      const mode: ChatMode = rawMode === 'group' && metadata?.group_message_type === 'thread'
        ? 'topic'
        : rawMode;
      this.cache.set(chatId, mode);
      log.info('chat', 'mode-resolved', { chatId, mode });
      return mode;
    } catch (err) {
      log.warn('chat', 'mode-resolve-failed', {
        chatId,
        err: err instanceof Error ? err.message : String(err),
      });
      // Don't poison the cache — next message gets another try.
      return undefined;
    }
  }

  invalidate(chatId: string): void {
    this.cache.delete(chatId);
  }
}
