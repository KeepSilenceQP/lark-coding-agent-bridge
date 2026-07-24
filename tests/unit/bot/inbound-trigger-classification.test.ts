import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { shouldRegisterInboundTrigger } from '../../../src/bot/channel';

function message(senderType?: 'user' | 'bot' | 'system'): NormalizedMessage {
  return {
    messageId: 'om_input',
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_sender',
    ...(senderType ? { senderType } : {}),
    content: 'trigger',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  };
}

describe('inbound trigger classification', () => {
  it('registers only trusted human inbound messages', () => {
    expect(shouldRegisterInboundTrigger(message('user'))).toBe(true);
    expect(shouldRegisterInboundTrigger(message('bot'))).toBe(false);
    expect(shouldRegisterInboundTrigger(message('system'))).toBe(false);
    expect(shouldRegisterInboundTrigger(message())).toBe(false);
  });

  it('supports legacy raw sender_type while remaining fail closed for unknown values', () => {
    expect(shouldRegisterInboundTrigger({
      ...message(),
      raw: { sender: { sender_type: 'user' } },
    })).toBe(true);
    expect(shouldRegisterInboundTrigger({
      ...message(),
      raw: { sender: { sender_type: 'app' } },
    })).toBe(false);
  });
});
