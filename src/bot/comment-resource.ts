import { createHash } from 'node:crypto';
import type { CommentEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

export interface ResolvedCommentTarget {
  fileToken: string;
  fileType: 'doc' | 'docx' | 'sheet' | 'file';
}

const SUPPORTED_FILE_TYPES = new Set(['doc', 'docx', 'sheet', 'file']);

export function commentTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function commentDocumentScopeId(fileToken: string): string {
  return `comment-doc:${commentTokenDigest(fileToken)}`;
}

export function commentScopeId(fileToken: string, commentId: string): string {
  return `comment:${commentTokenDigest(`${fileToken}:${commentId}`)}`;
}

export async function resolveCommentTarget(
  channel: LarkChannel,
  evt: CommentEvent,
): Promise<ResolvedCommentTarget | null> {
  if (!SUPPORTED_FILE_TYPES.has(evt.fileType)) return null;
  const passthrough: ResolvedCommentTarget = {
    fileToken: evt.fileToken,
    fileType: evt.fileType as ResolvedCommentTarget['fileType'],
  };

  try {
    const r = (await channel.rawClient.wiki.v2.space.getNode({
      params: { token: evt.fileToken },
    })) as {
      data?: { node?: { obj_token?: string; obj_type?: string; space_id?: string } };
    };
    const node = r?.data?.node;
    if (!node?.obj_token || !node.obj_type || !SUPPORTED_FILE_TYPES.has(node.obj_type)) {
      return passthrough;
    }
    log.info('comment', 'wiki-resolved', {
      objDigest: commentTokenDigest(node.obj_token),
      objType: node.obj_type,
      spaceDigest: node.space_id ? commentTokenDigest(node.space_id) : undefined,
    });
    return {
      fileToken: node.obj_token,
      fileType: node.obj_type as ResolvedCommentTarget['fileType'],
    };
  } catch {
    return passthrough;
  }
}
