import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { classifyTopicMessage, resolveTopicMessage } from '../../../src/bot/topic-message';

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_message', chatId: 'oc_chat', chatType: 'group',
    senderId: 'ou_user', content: 'text', rawContentType: 'text',
    mentions: [], mentionAll: false, mentionedBot: false, resources: [], createTime: 1000,
    ...overrides,
  };
}

function fakeChannel(items: unknown[] | Error = []) {
  const fetchRawMessage = vi.fn(async () => {
    if (items instanceof Error) throw items;
    return items;
  });
  return { fetchRawMessage, channel: { fetchRawMessage } as unknown as LarkChannel };
}

describe('topic message position', () => {
  it.each([
    { label: 'root fields omitted', fields: {}, expected: 'root' },
    { label: 'self root', fields: { rootId: 'om_message' }, expected: 'root' },
    { label: 'self root and parent', fields: { rootId: 'om_message', replyToMessageId: 'om_message' }, expected: 'root' },
    { label: 'topic reply', fields: { rootId: 'om_root', replyToMessageId: 'om_root' }, expected: 'reply' },
    { label: 'reply with missing root', fields: { replyToMessageId: 'om_parent' }, expected: 'reply' },
    { label: 'reply to non-root', fields: { rootId: 'om_root', replyToMessageId: 'om_parent' }, expected: 'reply' },
    { label: 'conflicting root and parent', fields: { rootId: 'om_message', replyToMessageId: 'om_parent' }, expected: 'unknown' },
    { label: 'conflicting reply and self parent', fields: { rootId: 'om_root', replyToMessageId: 'om_message' }, expected: 'unknown' },
  ])('classifies $label from message ids, independently of sessions', ({ fields, expected }) => {
    expect(classifyTopicMessage(message({ threadId: 'omt_topic', ...fields }), 'group')).toBe(expected);
  });

  it('does not treat ordinary group replies as topics or guess from an unknown chat mode', () => {
    const reply = message({ rootId: 'om_root', replyToMessageId: 'om_parent' });
    expect(classifyTopicMessage(reply, 'group')).toBe('not-topic');
    expect(classifyTopicMessage(reply, undefined)).toBe('unknown');
    expect(classifyTopicMessage(message({ chatType: 'p2p' }), undefined)).toBe('not-topic');
  });
});

describe('topic metadata recovery', () => {
  it('backfills thread and parent metadata in one read for a missing-thread event', async () => {
    const original = message();
    const api = fakeChannel([{
      message_id: original.messageId, chat_id: original.chatId,
      thread_id: 'omt_topic', root_id: 'om_root', parent_id: 'om_root',
    }]);
    const result = await resolveTopicMessage({
      channel: api.channel, message: original, chatMode: 'topic', requireClassification: true,
    });
    expect(result.classification).toBe('reply');
    expect(result.message).toMatchObject({ threadId: 'omt_topic', rootId: 'om_root', replyToMessageId: 'om_root' });
    expect(original.threadId).toBeUndefined();
    expect(api.fetchRawMessage).toHaveBeenCalledOnce();
    expect(api.fetchRawMessage).toHaveBeenCalledWith(original.messageId);
  });

  it('uses message thread metadata to recover from a failed chat lookup', async () => {
    const api = fakeChannel([{
      message_id: 'om_message', thread_id: 'omt_topic', root_id: 'om_root', parent_id: 'om_root',
    }]);
    const result = await resolveTopicMessage({
      channel: api.channel, message: message(), chatMode: undefined, requireClassification: true,
    });
    expect(result.classification).toBe('reply');
    expect(result.message.threadId).toBe('omt_topic');
  });

  it.each([
    { label: 'root', ancestry: {}, classification: 'root', rootId: undefined, parentId: undefined },
    { label: 'reply', ancestry: { root_id: 'om_root', parent_id: 'om_root' }, classification: 'reply', rootId: 'om_root', parentId: 'om_root' },
  ])('resolves contradictory event ancestry as authoritative $label', async ({ ancestry, classification, rootId, parentId }) => {
    const api = fakeChannel([{ message_id: 'om_message', thread_id: 'omt_topic', ...ancestry }]);
    const result = await resolveTopicMessage({
      channel: api.channel,
      message: message({ threadId: 'omt_topic', rootId: 'om_message', replyToMessageId: 'om_parent' }),
      chatMode: 'topic', requireClassification: true,
    });
    expect(result.classification).toBe(classification);
    expect(result.message.rootId).toBe(rootId);
    expect(result.message.replyToMessageId).toBe(parentId);
    expect(api.fetchRawMessage).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'unavailable', items: new Error('unavailable') },
    { label: 'empty', items: [] },
    { label: 'wrong message', items: [{ message_id: 'om_other', thread_id: 'omt_topic' }] },
    { label: 'wrong chat', items: [{ message_id: 'om_message', chat_id: 'oc_other', thread_id: 'omt_topic' }] },
    { label: 'missing thread', items: [{ message_id: 'om_message', root_id: 'om_root', parent_id: 'om_root' }] },
  ])('keeps $label metadata unknown for fail-closed intake', async ({ items }) => {
    const api = fakeChannel(items);
    const result = await resolveTopicMessage({
      channel: api.channel, message: message(), chatMode: 'topic', requireClassification: true,
    });
    expect(result.classification).toBe('unknown');
    expect(api.fetchRawMessage).toHaveBeenCalledOnce();
  });

  it('rejects a raw thread mismatch while resolving ambiguous ancestry', async () => {
    const api = fakeChannel([{ message_id: 'om_message', thread_id: 'omt_other' }]);
    const original = message({ threadId: 'omt_original', rootId: 'om_message', replyToMessageId: 'om_parent' });
    const result = await resolveTopicMessage({
      channel: api.channel, message: original, chatMode: 'topic', requireClassification: true,
    });
    expect(result).toEqual({ message: original, classification: 'unknown' });
  });

  it('does not infer an ordinary group from missing thread data after a failed chat lookup', async () => {
    const api = fakeChannel([{ message_id: 'om_message' }]);
    const result = await resolveTopicMessage({
      channel: api.channel, message: message(), chatMode: undefined, requireClassification: true,
    });
    expect(result.classification).toBe('unknown');
  });

  it('keeps ordinary group quoting untouched and performs no extra read', async () => {
    const api = fakeChannel();
    const original = message({ rootId: 'om_root', replyToMessageId: 'om_parent' });
    const result = await resolveTopicMessage({
      channel: api.channel, message: original, chatMode: 'group', requireClassification: true,
    });
    expect(result).toEqual({ message: original, classification: 'not-topic' });
    expect(result.message).toBe(original);
    expect(api.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('does not probe unknown routing solely for classification when the policy is disabled', async () => {
    const api = fakeChannel();
    const original = message();
    const result = await resolveTopicMessage({
      channel: api.channel, message: original, chatMode: undefined, requireClassification: false,
    });
    expect(result.message).toBe(original);
    expect(api.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('still backfills a known topic thread and preserves event ancestry when the policy is disabled', async () => {
    const api = fakeChannel([{ message_id: 'om_message', thread_id: 'omt_topic' }]);
    const result = await resolveTopicMessage({
      channel: api.channel, message: message({ rootId: 'om_root', replyToMessageId: 'om_root' }),
      chatMode: 'topic', requireClassification: false,
    });
    expect(result.message).toMatchObject({ threadId: 'omt_topic', rootId: 'om_root', replyToMessageId: 'om_root' });
    expect(api.fetchRawMessage).toHaveBeenCalledOnce();
  });
});
