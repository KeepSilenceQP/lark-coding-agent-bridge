import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

export interface KnownChat {
  id: string;
  name: string;
}

export async function fetchKnownChats(channel: LarkChannel): Promise<KnownChat[]> {
  const chats: KnownChat[] = [];
  const maxPages = 5;
  let pageToken: string | undefined;
  let pages = 0;
  try {
    do {
      const params = new URLSearchParams({ page_size: '100' });
      if (pageToken) params.set('page_token', pageToken);
      const resp = await channel.rawClient.request({
        method: 'GET',
        url: `/open-apis/im/v1/chats?${params.toString()}`,
      });
      const data = (
        resp as {
          data?: {
            items?: Array<{ chat_id?: string; name?: string }>;
            has_more?: boolean;
            page_token?: string;
          };
        }
      )?.data;
      for (const item of data?.items ?? []) {
        if (item.chat_id) chats.push({ id: item.chat_id, name: item.name ?? '(无名)' });
      }
      pageToken = data?.has_more ? data.page_token : undefined;
      pages += 1;
    } while (pageToken && pages < maxPages);
    log.info('lark-info', 'chats-fetched', {
      count: chats.length,
      pages,
      truncated: Boolean(pageToken),
    });
    return chats;
  } catch (err) {
    log.warn('lark-info', 'chats-fetch-failed', {
      err: err instanceof Error ? err.message : String(err),
      partialCount: chats.length,
    });
    return chats;
  }
}
