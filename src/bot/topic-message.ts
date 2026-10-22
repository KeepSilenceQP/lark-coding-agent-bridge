import type { ApiMessageItem, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';
import type { ChatMode } from './chat-mode-cache';

export type TopicMessageClassification = 'root' | 'reply' | 'not-topic' | 'unknown';

type MessageRoute = Pick<NormalizedMessage,
  'messageId' | 'chatType' | 'threadId' | 'rootId' | 'replyToMessageId'>;

/** Classify the message itself, independently of any Bot session/history. */
export function classifyTopicMessage(
  message: MessageRoute,
  chatMode: ChatMode | undefined,
): TopicMessageClassification {
  if (message.chatType === 'p2p') return 'not-topic';
  if (!message.threadId && chatMode !== 'topic') {
    return chatMode === undefined ? 'unknown' : 'not-topic';
  }
  const rootId = message.rootId || undefined;
  const parentId = message.replyToMessageId || undefined;
  if (rootId) {
    if (rootId === message.messageId) {
      return parentId && parentId !== message.messageId ? 'unknown' : 'root';
    }
    return parentId === message.messageId ? 'unknown' : 'reply';
  }
  // The API omits root_id/parent_id on root messages; some events identify
  // the root with its own id. A parent pointing elsewhere always means reply.
  return parentId && parentId !== message.messageId ? 'reply' : 'root';
}

type RawTopicMessage = ApiMessageItem & {
  chat_id?: string;
  thread_id?: string;
  root_id?: string;
  parent_id?: string;
};

export interface ResolvedTopicMessage {
  message: NormalizedMessage;
  classification: TopicMessageClassification;
}

/**
 * Backfill topic routing and classify root/reply using the same raw read.
 * When classification is required, an unreadable or incomplete topic route
 * stays unknown so intake can reject it without starting a task.
 */
export async function resolveTopicMessage(input: {
  channel: LarkChannel;
  message: NormalizedMessage;
  chatMode: ChatMode | undefined;
  requireClassification: boolean;
}): Promise<ResolvedTopicMessage> {
  const { channel, message, chatMode, requireClassification } = input;
  const classification = classifyTopicMessage(message, chatMode);
  const needsThread = chatMode === 'topic' && !message.threadId;
  if (!needsThread && !(requireClassification && classification === 'unknown')) {
    return { message, classification };
  }

  try {
    const items = await channel.fetchRawMessage(message.messageId);
    const raw = items.find(item => item.message_id === message.messageId) as RawTopicMessage | undefined;
    if (!raw || (raw.chat_id && raw.chat_id !== message.chatId)
      || (raw.thread_id && message.threadId && raw.thread_id !== message.threadId)) {
      return { message, classification: 'unknown' };
    }
    const enhanced: NormalizedMessage = {
      ...message,
      threadId: raw.thread_id || message.threadId,
      // In a classification read, absent ancestry is meaningful: root
      // messages omit these fields. Do not retain contradictory event ids.
      rootId: requireClassification ? raw.root_id || undefined : raw.root_id || message.rootId,
      replyToMessageId: requireClassification ? raw.parent_id || undefined : raw.parent_id || message.replyToMessageId,
    };
    const result = classifyTopicMessage(enhanced, chatMode);
    // A known topic with no recoverable thread id cannot be safely routed to
    // its own scope. Unknown chat metadata also remains unknown unless the
    // message itself proves topic membership through thread_id.
    return {
      message: enhanced,
      classification: requireClassification && chatMode === 'topic' && !enhanced.threadId
        ? 'unknown'
        : result,
    };
  } catch (err) {
    log.warn('thread', 'topic-message-lookup-failed', {
      messageId: message.messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { message, classification: 'unknown' };
  }
}
