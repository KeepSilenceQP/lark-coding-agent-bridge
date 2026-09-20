import type { ApiMessageItem, NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import {
  EditedMessageRestartRegistry,
  fingerprintEditedMessageText,
} from '../../../src/bot/edited-message-restart';
import { normalizeFetchedEditableMessage } from '../../../src/bot/quote';

function message(id: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: id,
    chatId: 'oc_chat',
    chatType: 'group',
    threadId: 'omt_topic',
    senderId: 'ou_author',
    senderType: 'user',
    content: 'original text',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1,
    ...overrides,
  };
}

function active(runId: string) {
  const activeRuns = new ActiveRuns();
  const reservation = activeRuns.reserve('oc_chat:omt_topic')!;
  const run: AgentRun = {
    runId,
    events: { async *[Symbol.asyncIterator]() {} },
    stop: vi.fn(async () => {}),
    waitForExit: vi.fn(async () => true),
  };
  const handle = activeRuns.register('oc_chat:omt_topic', run, reservation);
  reservation.release();
  return { activeRuns, handle };
}

describe('EditedMessageRestartRegistry', () => {
  it('makes only one attachment-free human text/post trigger eligible', () => {
    const registry = new EditedMessageRestartRegistry();
    const first = active('run-1');
    registry.registerRun({
      scope: 'oc_chat:omt_topic',
      chatId: 'oc_chat',
      chatType: 'group',
      threadId: 'omt_topic',
      messages: [message('om_text', { raw: { message: { content: 'raw body' } } })],
      handle: first.handle,
      cwdRealpath: '/repo',
      policyFingerprint: 'policy',
      codexThreadId: 'thread-1',
      workChainId: 'chain-1',
      lifecycleUnitId: 'unit-1',
    });
    expect(registry.get('om_text')).toMatchObject({
      state: 'active',
      eligibility: 'eligible',
      deliveredFingerprint: fingerprintEditedMessageText('original text'),
      codexThreadId: 'thread-1',
      toolStartedEver: false,
    });
    expect(registry.get('om_text')?.originalMessage.raw).toBeUndefined();

    const batch = active('run-2');
    registry.registerRun({
      scope: 'oc_chat:omt_topic',
      chatId: 'oc_chat',
      chatType: 'group',
      threadId: 'omt_topic',
      messages: [message('om_a'), message('om_b', { rawContentType: 'post' })],
      handle: batch.handle,
      cwdRealpath: '/repo',
      policyFingerprint: 'policy',
      codexThreadId: 'thread-2',
      workChainId: 'chain-2',
      lifecycleUnitId: 'unit-2',
    });
    expect(registry.get('om_a')).toMatchObject({ eligibility: 'not-sole-trigger' });
    expect(registry.get('om_b')).toMatchObject({ eligibility: 'not-sole-trigger' });

    const unsupported = active('run-3');
    registry.registerRun({
      scope: 'oc_chat:omt_topic',
      chatId: 'oc_chat',
      chatType: 'group',
      threadId: 'omt_topic',
      messages: [message('om_file', { resources: [{ type: 'file', fileKey: 'fk' }] })],
      handle: unsupported.handle,
      cwdRealpath: '/repo',
      policyFingerprint: 'policy',
      codexThreadId: 'thread-3',
      workChainId: 'chain-3',
      lifecycleUnitId: 'unit-3',
    });
    expect(registry.get('om_file')).toMatchObject({ eligibility: 'unsupported-original' });
  });

  it('promotes thread readiness, keeps toolStartedEver monotonic, and uses exact cleanup identity', () => {
    const registry = new EditedMessageRestartRegistry();
    const old = active('run-old');
    registry.registerRun({
      scope: 'oc_chat:omt_topic', chatId: 'oc_chat', chatType: 'group', threadId: 'omt_topic',
      messages: [message('om_same')], handle: old.handle, cwdRealpath: '/repo',
      policyFingerprint: 'policy', workChainId: 'chain', lifecycleUnitId: 'old-unit',
    });
    expect(registry.get('om_same')).toMatchObject({ eligibility: 'thread-not-ready' });
    expect(registry.markThreadDurable(old.handle, 'thread-old')).toBe(true);
    registry.markToolStarted(old.handle);
    registry.markToolStarted(old.handle);
    expect(registry.get('om_same')).toMatchObject({
      eligibility: 'eligible', codexThreadId: 'thread-old', toolStartedEver: true,
    });

    const newer = active('run-new');
    registry.registerRun({
      scope: 'oc_chat:omt_topic', chatId: 'oc_chat', chatType: 'group', threadId: 'omt_topic',
      messages: [message('om_same', { content: 'new text' })], handle: newer.handle,
      cwdRealpath: '/repo', policyFingerprint: 'policy', codexThreadId: 'thread-old',
      workChainId: 'chain', lifecycleUnitId: 'new-unit',
    });
    registry.markTerminal(old.handle);
    expect(registry.get('om_same')).toMatchObject({
      state: 'active', handle: newer.handle, lifecycleUnitId: 'new-unit',
    });
    registry.markTerminal(newer.handle);
    expect(registry.get('om_same')).toMatchObject({ state: 'ended' });
  });

  it('bounds ended tombstones and consumed correction keys', () => {
    const registry = new EditedMessageRestartRegistry({ maxRetained: 8 });
    for (let index = 0; index < 12; index++) {
      const current = active(`run-${index}`);
      registry.registerRun({
        scope: `scope-${index}`, chatId: 'oc_chat', chatType: 'group',
        messages: [message(`om_${index}`, { threadId: undefined })], handle: current.handle,
        cwdRealpath: '/repo', policyFingerprint: 'policy', codexThreadId: `thread-${index}`,
        workChainId: `chain-${index}`, lifecycleUnitId: `unit-${index}`,
      });
      registry.markTerminal(current.handle);
      registry.consume(`key-${index}`);
    }
    expect(registry.get('om_0')).toBeUndefined();
    expect(registry.get('om_4')).toMatchObject({ state: 'ended' });
    expect(registry.isConsumed('key-0')).toBe(false);
    expect(registry.isConsumed('key-4')).toBe(true);
  });
});

describe('normalizeFetchedEditableMessage', () => {
  const channel = { botIdentity: { openId: 'ou_bot', name: 'Bot' } };

  it('normalizes an already-fetched text item without another API request', async () => {
    const item = {
      message_id: 'om_text', msg_type: 'text', chat_id: 'oc_chat', thread_id: 'omt_topic',
      update_time: '200', sender: { id: 'ou_author', sender_type: 'user' },
      body: { content: JSON.stringify({ text: '@_user_1 corrected text' }) },
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' }],
    } as ApiMessageItem;

    await expect(normalizeFetchedEditableMessage(channel, [item], {
      messageId: 'om_text', chatId: 'oc_chat', threadId: 'omt_topic', authorId: 'ou_author',
    })).resolves.toMatchObject({
      ok: true,
      snapshot: {
        messageId: 'om_text', text: 'corrected text', revision: '200',
        rawContentType: 'text', resources: [],
      },
    });
  });

  it('normalizes the full body of an already-fetched post item', async () => {
    const item = {
      message_id: 'om_post', msg_type: 'post', chat_id: 'oc_chat', thread_id: 'omt_topic',
      update_time: '201', sender: { id: 'ou_author', sender_type: 'user' },
      body: { content: JSON.stringify({
        zh_cn: {
          title: '修正标题',
          content: [[{ tag: 'text', text: '第一段' }], [{ tag: 'text', text: '第二段' }]],
        },
      }) },
    } as ApiMessageItem;

    const result = await normalizeFetchedEditableMessage(channel, [item], {
      messageId: 'om_post', chatId: 'oc_chat', threadId: 'omt_topic', authorId: 'ou_author',
    });
    expect(result).toMatchObject({ ok: true, snapshot: { rawContentType: 'post', revision: '201' } });
    if (result.ok) {
      expect(result.snapshot.text).toContain('修正标题');
      expect(result.snapshot.text).toContain('第一段');
      expect(result.snapshot.text).toContain('第二段');
    }
  });

  it('rejects deleted, malformed, wrong-route, unsupported, and attachment-bearing snapshots', async () => {
    const base = {
      message_id: 'om_text', msg_type: 'text', chat_id: 'oc_chat', thread_id: 'omt_topic',
      update_time: '200', sender: { id: 'ou_author', sender_type: 'user' },
      body: { content: JSON.stringify({ text: 'corrected' }) },
    };
    const expected = {
      messageId: 'om_text', chatId: 'oc_chat', threadId: 'omt_topic', authorId: 'ou_author',
    };
    await expect(normalizeFetchedEditableMessage(channel, [{ ...base, deleted: true } as never], expected))
      .resolves.toMatchObject({ ok: false, reason: 'deleted' });
    await expect(normalizeFetchedEditableMessage(channel, [] as ApiMessageItem[], expected))
      .resolves.toMatchObject({ ok: false, reason: 'malformed' });
    await expect(normalizeFetchedEditableMessage(channel, [{ ...base, chat_id: 'other' } as never], expected))
      .resolves.toMatchObject({ ok: false, reason: 'route-mismatch' });
    await expect(normalizeFetchedEditableMessage(channel, [{ ...base, msg_type: 'interactive' } as never], expected))
      .resolves.toMatchObject({ ok: false, reason: 'unsupported-type' });
    const image = { ...base, msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img' }) } };
    await expect(normalizeFetchedEditableMessage(channel, [image as never], expected))
      .resolves.toMatchObject({ ok: false, reason: 'unsupported-type' });
    const postWithImage = {
      ...base,
      msg_type: 'post',
      body: { content: JSON.stringify({
        zh_cn: { title: '', content: [[{ tag: 'img', image_key: 'img-key' }]] },
      }) },
    };
    await expect(normalizeFetchedEditableMessage(channel, [postWithImage as never], expected))
      .resolves.toMatchObject({ ok: false, reason: 'unsupported-type' });
  });
});
