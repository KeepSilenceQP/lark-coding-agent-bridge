import { describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { shouldBypassDeniedChatForInviteGroup } from '../../../src/bot/channel';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('channel intake command bypass', () => {
  it('lets botAdmins run mentioned /invite group before the group is allowlisted', () => {
    const controls = createControls(['ou-bot-admin']);

    expect(
      shouldBypassDeniedChatForInviteGroup(
        message('@小C /invite group', {
          senderId: 'ou-bot-admin',
          mentionedBot: true,
        }),
        controls,
      ),
    ).toBe(true);
  });

  it('keeps the denied-chat bypass narrow', () => {
    const controls = createControls(['ou-bot-admin']);

    expect(
      shouldBypassDeniedChatForInviteGroup(
        message('@小C /cd /tmp', {
          senderId: 'ou-bot-admin',
          mentionedBot: true,
        }),
        controls,
      ),
    ).toBe(false);
    expect(
      shouldBypassDeniedChatForInviteGroup(
        message('/invite group', {
          senderId: 'ou-bot-admin',
          mentionedBot: false,
        }),
        controls,
      ),
    ).toBe(false);
    expect(
      shouldBypassDeniedChatForInviteGroup(
        message('@小C /invite group', {
          senderId: 'ou-stranger',
          mentionedBot: true,
        }),
        controls,
      ),
    ).toBe(false);
    expect(
      shouldBypassDeniedChatForInviteGroup(
        message('@小C /invite group please', {
          senderId: 'ou-bot-admin',
          mentionedBot: true,
        }),
        controls,
      ),
    ).toBe(false);
    expect(
      shouldBypassDeniedChatForInviteGroup(
        message('@小C /invite group\n/cd /tmp', {
          senderId: 'ou-bot-admin',
          mentionedBot: true,
        }),
        controls,
      ),
    ).toBe(false);
  });
});

function createControls(botAdmins: string[]): Controls {
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli-test', secret: 'test-secret', tenant: 'feishu' } },
  });
  profileConfig.access.botAdmins = botAdmins;
  return {
    profile: 'claude',
    profileConfig,
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: '/tmp/lark-channel/config.json',
    cfg: profileConfig,
    processId: 'proc-test',
  };
}

function message(
  content: string,
  opts: {
    senderId: string;
    mentionedBot: boolean;
  },
): NormalizedMessage {
  return {
    messageId: 'om-test',
    chatId: 'oc-test',
    chatType: 'group',
    senderId: opts.senderId,
    senderName: 'Sender',
    content,
    resources: [],
    mentions: [],
    mentionedBot: opts.mentionedBot,
  } as unknown as NormalizedMessage;
}
