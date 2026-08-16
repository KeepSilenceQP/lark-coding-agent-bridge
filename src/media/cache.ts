import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel, ResourceDescriptor, ResourceType } from '@larksuite/channel';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import {
  normalizeAttachments,
  safeExtensionForMime,
  type AttachmentCandidate,
  type AttachmentKind,
  type AttachmentPolicyOptions,
  type NormalizedAttachment,
} from './attachment';

export type LocalAttachment = NormalizedAttachment;

export interface MediaResolveOptions extends Partial<AttachmentPolicyOptions> {
  cacheMaxBytes?: number;
}

export interface ResourceRequest {
  messageId: string;
  resource: ResourceDescriptor;
}

export interface DriveImageRequest {
  sourceId: string;
  fileToken: string;
}

export interface DriveImageResolveResult {
  attachments: LocalAttachment[];
  failedCount: number;
}

interface ResourceFileDownloader {
  downloadResourceToFile(
    messageId: string,
    fileKey: string,
    type: ResourceType,
    destPath: string,
  ): Promise<{ contentType?: string }>;
}

export class MediaCache {
  private readonly channel: LarkChannel;
  private readonly rootDir: string;

  constructor(channel: LarkChannel, rootDir: string = paths.mediaDir) {
    this.channel = channel;
    this.rootDir = rootDir;
  }

  async resolve(
    items: ResourceRequest[],
    options: MediaResolveOptions = {},
  ): Promise<LocalAttachment[]> {
    if (items.length === 0) return [];
    await mkdir(this.rootDir, { recursive: true });

    const candidates: AttachmentCandidate[] = [];
    for (const item of items) {
      try {
        const file = await this.resolveOne(item);
        if (file) candidates.push(file);
      } catch (err) {
        log.fail('media', err, { fileKey: item.resource.fileKey });
      }
    }
    return this.normalizeResolvedCandidates(candidates, options);
  }

  /** Resolve image tokens returned in a cloud-document comment reply. */
  async resolveDriveImages(
    items: DriveImageRequest[],
    options: MediaResolveOptions = {},
  ): Promise<DriveImageResolveResult> {
    if (items.length === 0) return { attachments: [], failedCount: 0 };
    await mkdir(this.rootDir, { recursive: true });

    const candidates: AttachmentCandidate[] = [];
    let failedCount = 0;
    for (const item of items) {
      try {
        candidates.push(await this.resolveDriveImage(item));
      } catch (err) {
        failedCount++;
        log.fail('media', err, { source: 'comment-image' });
      }
    }
    return {
      attachments: await this.normalizeResolvedCandidates(candidates, options),
      failedCount,
    };
  }

  private async resolveOne(item: ResourceRequest): Promise<AttachmentCandidate | null> {
    const { messageId, resource: r } = item;
    if (r.type === 'sticker') {
      log.info('media', 'skip', { reason: 'sticker', fileKey: r.fileKey });
      return null;
    }
    const kind: AttachmentKind = r.type;
    const tmpPath = join(
      this.rootDir,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    const resourceType: ResourceType = r.type === 'image' ? 'image' : 'file';
    const { contentType } = await downloadResourceToFile(
      this.channel,
      messageId,
      r.fileKey,
      resourceType,
      tmpPath,
    );

    return this.finalizeResolvedFile({
      tmpPath,
      kind,
      sourceMessageId: messageId,
      sourceFileKey: r.fileKey,
      mime: contentType ?? defaultMime(kind),
      ...(r.fileName ? { originalName: r.fileName } : {}),
    });
  }

  private async resolveDriveImage(item: DriveImageRequest): Promise<AttachmentCandidate> {
    const tmpPath = join(
      this.rootDir,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const response = await this.channel.rawClient.drive.v1.media.download({
        path: { file_token: item.fileToken },
      });
      await response.writeFile(tmpPath);
      const headerMime = headerValue(response.headers, 'content-type');
      const mime =
        await detectImageMime(tmpPath) ?? normalizeMime(headerMime) ?? 'application/octet-stream';
      return await this.finalizeResolvedFile({
        tmpPath,
        kind: 'image',
        sourceMessageId: item.sourceId,
        sourceFileKey: item.fileToken,
        mime,
      });
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  private async finalizeResolvedFile(input: {
    tmpPath: string;
    kind: AttachmentKind;
    sourceMessageId: string;
    sourceFileKey: string;
    mime: string;
    originalName?: string;
  }): Promise<AttachmentCandidate> {
    const tmpStat = await stat(input.tmpPath);
    const hash = await hashFile(input.tmpPath);
    const ext = safeExtensionForMime(input.mime);
    const absPath = join(this.rootDir, `${hash}.${ext}`);
    try {
      await stat(absPath);
      await rm(input.tmpPath, { force: true });
      log.info('media', 'cache-hit', { path: absPath });
    } catch {
      await rename(input.tmpPath, absPath);
    }
    const candidate: AttachmentCandidate = {
      absPath,
      kind: input.kind,
      size: tmpStat.size,
      mime: input.mime,
      hash,
      source: 'lark',
      sourceMessageId: input.sourceMessageId,
      sourceFileKey: input.sourceFileKey,
      ...(input.originalName ? { originalName: input.originalName } : {}),
    };
    log.info('media', 'downloaded', {
      path: candidate.absPath,
      size: candidate.size,
    });
    return candidate;
  }

  private async normalizeResolvedCandidates(
    candidates: AttachmentCandidate[],
    options: MediaResolveOptions,
  ): Promise<LocalAttachment[]> {
    const normalized = normalizeAttachments(candidates, options);
    await removeRejectedResolvedFiles(normalized);
    if (typeof options.cacheMaxBytes === 'number') {
      await enforceCacheMaxBytes(
        this.rootDir,
        options.cacheMaxBytes,
        new Set(
          normalized
            .filter((attachment) => attachment.decision === 'accepted')
            .map((attachment) => attachment.absPath),
        ),
      );
    }
    return normalized;
  }
}

async function downloadResourceToFile(
  channel: LarkChannel,
  messageId: string,
  fileKey: string,
  type: ResourceType,
  destPath: string,
): Promise<{ contentType?: string }> {
  const downloader = channel as LarkChannel & Partial<ResourceFileDownloader>;
  if (typeof downloader.downloadResourceToFile === 'function') {
    return downloader.downloadResourceToFile(messageId, fileKey, type, destPath);
  }

  const { buffer, contentType } = await channel.downloadResourceWithMeta(messageId, fileKey, type);
  await writeFile(destPath, buffer);
  return { contentType };
}

/** Delete files under the media cache whose mtime is older than maxAgeMs. */
export async function gcMediaCache(
  maxAgeMs: number,
  root: string = paths.mediaDir,
): Promise<void> {
  try {
    await stat(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  const files = await listFiles(root);
  for (const p of files) {
    try {
      const st = await stat(p);
      if (st.isFile() && st.mtimeMs < cutoff) {
        await rm(p);
        removed++;
      }
    } catch {
      /* skip */
    }
  }
  if (removed > 0) log.info('media', 'gc', { removed });
}

function defaultMime(kind: AttachmentKind): string {
  switch (kind) {
    case 'image':
      return 'image/png';
    case 'audio':
      return 'audio/ogg';
    case 'video':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function detectImageMime(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const head = bytes.subarray(0, bytesRead);
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (
      head.length >= pngSignature.length &&
      head.subarray(0, pngSignature.length).equals(pngSignature)
    ) {
      return 'image/png';
    }
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return 'image/jpeg';
    }
    const ascii = head.toString('ascii');
    if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
    if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
    return undefined;
  } finally {
    await handle.close();
  }
}

function normalizeMime(value: string | undefined): string | undefined {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase();
  return mime || undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const getter = (headers as { get?: (key: string) => unknown }).get;
  if (typeof getter === 'function') {
    const value = getter.call(headers, name);
    if (typeof value === 'string') return value;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

async function enforceCacheMaxBytes(
  root: string,
  maxBytes: number,
  protectedPaths: ReadonlySet<string>,
): Promise<void> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  const files = await Promise.all(
    (await listFiles(root)).map(async (path) => {
      const fileStat = await stat(path);
      return { path, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
    }),
  );
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files
    .filter((item) => !protectedPaths.has(item.path))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    await rm(file.path, { force: true });
    total -= file.size;
  }
}

async function removeRejectedResolvedFiles(attachments: readonly NormalizedAttachment[]): Promise<void> {
  await Promise.all(
    attachments
      .filter((attachment) => attachment.decision !== 'accepted')
      .map((attachment) => rm(attachment.absPath, { force: true })),
  );
}
