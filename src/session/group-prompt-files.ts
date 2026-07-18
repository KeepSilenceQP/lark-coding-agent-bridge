import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_CHAT_ID_LENGTH = 128;
const SAFE_CHAT_ID = /^[A-Za-z0-9_-]+$/;
export const GROUP_PROMPT_MAX_BYTES = 64 * 1024;

export type GroupPromptFileErrorCode =
  | 'INVALID_CHAT_ID'
  | 'UNSAFE_PATH'
  | 'UNSUPPORTED_NOFOLLOW'
  | 'NOT_REGULAR_FILE'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'CHANGED_DURING_READ'
  | 'INVALID_SNAPSHOT_REFERENCE'
  | 'SNAPSHOT_MISSING'
  | 'SNAPSHOT_BYTE_COUNT_MISMATCH'
  | 'SNAPSHOT_HASH_MISMATCH';

export class GroupPromptFileError extends Error {
  readonly code: GroupPromptFileErrorCode;

  constructor(code: GroupPromptFileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GroupPromptFileError';
    this.code = code;
  }
}

export interface ResolvedGroupPromptNone {
  kind: 'none';
}

export interface ResolvedGroupPromptContent {
  kind: 'prompt';
  content: string;
  byteCount: number;
  sha256: string;
}

export type ResolvedGroupPrompt = ResolvedGroupPromptNone | ResolvedGroupPromptContent;

export interface GroupPromptSnapshotRef {
  sha256: string;
  byteCount: number;
}

export interface GroupPromptSnapshotSource extends GroupPromptSnapshotRef {
  content: string;
}

export interface GroupPromptFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  mkdir(path: string, mode: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
}

export interface GroupPromptFileOptions {
  fileSystem?: Partial<GroupPromptFileSystem>;
  hooks?: GroupPromptFileHooks;
}

export interface GroupPromptFileHooks {
  afterOpen?(purpose: 'live' | 'snapshot-read' | 'snapshot-create', path: string): void | Promise<void>;
  afterInitialStat?(purpose: 'live' | 'snapshot-read', path: string): void | Promise<void>;
  beforeFinalStat?(purpose: 'live' | 'snapshot-read', path: string): void | Promise<void>;
  beforeDeleteRevalidation?(path: string): void | Promise<void>;
}

const nodeFileSystem: GroupPromptFileSystem = {
  realpath,
  lstat: (path) => lstat(path, { bigint: true }),
  open,
  mkdir: async (path, mode) => {
    await mkdir(path, { mode });
  },
  readdir,
  unlink,
};
const snapshotCreates = new Map<string, Promise<GroupPromptSnapshotRef>>();

export async function resolveLiveGroupPrompt(
  profileDir: string,
  chatId: string,
  options: GroupPromptFileOptions = {},
): Promise<ResolvedGroupPrompt> {
  validateChatId(chatId);
  const fs = fileSystem(options);
  const canonicalProfileDir = await fs.realpath(profileDir);
  const promptsDir = join(canonicalProfileDir, 'prompts');
  const groupsDir = join(promptsDir, 'groups');
  const livePath = join(groupsDir, `${chatId}.md`);
  const promptsStat = await requireDirectoryOrMissing(fs, promptsDir);
  if (!promptsStat) return { kind: 'none' };
  const groupsStat = await requireDirectoryOrMissing(fs, groupsDir);
  if (!groupsStat) return { kind: 'none' };
  const finalStat = await lstatOrMissing(fs, livePath);
  if (!finalStat) return { kind: 'none' };
  if (finalStat.isSymbolicLink()) {
    throw new GroupPromptFileError('UNSAFE_PATH', 'group prompt path is not trusted');
  }
  if (!finalStat.isFile()) {
    throw new GroupPromptFileError('NOT_REGULAR_FILE', 'group prompt is not a regular file');
  }
  const bytes = await securelyReadFile(
    fs,
    livePath,
    finalStat,
    [
      [promptsDir, promptsStat],
      [groupsDir, groupsStat],
    ],
    'live',
    options.hooks,
  );
  return {
    kind: 'prompt',
    content: decodeUtf8(bytes),
    byteCount: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

export async function ensureGroupPromptSnapshot(
  profileDir: string,
  source: GroupPromptSnapshotSource,
  options: GroupPromptFileOptions = {},
): Promise<GroupPromptSnapshotRef> {
  const bytes = validateSnapshotSource(source);
  const fs = fileSystem(options);
  const context = await snapshotContext(fs, profileDir, true);
  const path = snapshotPath(context.snapshotDir, source.sha256);
  const pending = snapshotCreates.get(path);
  if (pending) {
    await pending;
    await readSnapshotBytes(fs, context, source, options.hooks);
    return snapshotRef(source);
  }
  const creation = createOrReuseSnapshot(fs, context, path, source, bytes, options.hooks);
  snapshotCreates.set(path, creation);
  try {
    return await creation;
  } finally {
    if (snapshotCreates.get(path) === creation) snapshotCreates.delete(path);
  }
}

async function createOrReuseSnapshot(
  fs: GroupPromptFileSystem,
  context: SnapshotContext,
  path: string,
  source: GroupPromptSnapshotSource,
  bytes: Buffer,
  hooks?: GroupPromptFileHooks,
): Promise<GroupPromptSnapshotRef> {
  const noFollow = requireNoFollow();
  let handle: FileHandle;
  try {
    handle = await fs.open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    await readSnapshotBytes(fs, context, source, hooks);
    return snapshotRef(source);
  }
  try {
    await hooks?.afterOpen?.('snapshot-create', path);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new GroupPromptFileError('NOT_REGULAR_FILE', 'snapshot is not a regular file');
    }
    await revalidateParents(fs, context.parents);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (!sameIdentity(before, written) || written.size !== BigInt(bytes.byteLength)) {
      throw new GroupPromptFileError('CHANGED_DURING_READ', 'snapshot changed while being created');
    }
    const persisted = await readBounded(handle);
    const after = await handle.stat({ bigint: true });
    if (!sameFileState(written, after) || !persisted.equals(bytes)) {
      throw new GroupPromptFileError('CHANGED_DURING_READ', 'snapshot changed while being created');
    }
    const current = await lstatOrMissing(fs, path);
    if (!current || current.isSymbolicLink() || !sameIdentity(after, current)) {
      throw new GroupPromptFileError('CHANGED_DURING_READ', 'snapshot path changed while being created');
    }
    await revalidateParents(fs, context.parents);
  } finally {
    await handle.close();
  }
  await fsyncDirectory(fs, context.snapshotDir);
  return snapshotRef(source);
}

export async function readGroupPromptSnapshot(
  profileDir: string,
  ref: GroupPromptSnapshotRef,
  options: GroupPromptFileOptions = {},
): Promise<string> {
  validateSnapshotRef(ref);
  const fs = fileSystem(options);
  const context = await snapshotContext(fs, profileDir, false);
  const bytes = await readSnapshotBytes(fs, context, ref, options.hooks);
  return decodeUtf8(bytes);
}

export async function deleteGroupPromptSnapshot(
  profileDir: string,
  ref: GroupPromptSnapshotRef,
  options: GroupPromptFileOptions = {},
): Promise<boolean> {
  validateSnapshotRef(ref);
  const fs = fileSystem(options);
  let context: SnapshotContext;
  try {
    context = await snapshotContext(fs, profileDir, false);
  } catch (err) {
    if (err instanceof GroupPromptFileError && err.code === 'SNAPSHOT_MISSING') return false;
    throw err;
  }
  const path = snapshotPath(context.snapshotDir, ref.sha256);
  const initial = await lstatOrMissing(fs, path);
  if (!initial) return false;
  await readSnapshotBytes(fs, context, ref, options.hooks);
  await options.hooks?.beforeDeleteRevalidation?.(path);
  const current = await lstatOrMissing(fs, path);
  if (!current || current.isSymbolicLink() || !sameIdentity(initial, current)) {
    throw new GroupPromptFileError('CHANGED_DURING_READ', 'snapshot path changed before deletion');
  }
  await revalidateParents(fs, context.parents);
  await fs.unlink(path);
  await fsyncDirectory(fs, context.snapshotDir);
  return true;
}

/**
 * Return every valid content-addressed snapshot currently present. Unknown
 * filenames are ignored, while a hash-shaped entry must pass the same
 * no-follow and immutable-read validation as a normal pinned snapshot.
 */
export async function inventoryGroupPromptSnapshots(
  profileDir: string,
  options: GroupPromptFileOptions = {},
): Promise<GroupPromptSnapshotRef[]> {
  const fs = fileSystem(options);
  let context: SnapshotContext;
  try {
    context = await snapshotContext(fs, profileDir, false);
  } catch (err) {
    if (err instanceof GroupPromptFileError && err.code === 'SNAPSHOT_MISSING') return [];
    throw err;
  }
  await revalidateParents(fs, context.parents);
  const names = await fs.readdir(context.snapshotDir);
  const refs: GroupPromptSnapshotRef[] = [];
  for (const name of names.sort()) {
    const match = /^([a-f0-9]{64})\.md$/.exec(name);
    if (!match) continue;
    const sha = match[1]!;
    const path = snapshotPath(context.snapshotDir, sha);
    const stat = await lstatOrMissing(fs, path);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new GroupPromptFileError('UNSAFE_PATH', 'snapshot path is not trusted');
    }
    if (!stat.isFile()) {
      throw new GroupPromptFileError('NOT_REGULAR_FILE', 'snapshot is not a regular file');
    }
    if (stat.size <= 0n || stat.size > BigInt(GROUP_PROMPT_MAX_BYTES)) {
      throw new GroupPromptFileError(
        stat.size <= 0n ? 'EMPTY_FILE' : 'FILE_TOO_LARGE',
        'snapshot has an invalid size',
      );
    }
    const ref = { sha256: sha, byteCount: Number(stat.size) };
    const bytes = await readSnapshotBytes(fs, context, ref, options.hooks);
    decodeUtf8(bytes);
    refs.push(ref);
  }
  await revalidateParents(fs, context.parents);
  return refs;
}

interface SnapshotContext {
  snapshotDir: string;
  parents: ReadonlyArray<readonly [string, BigIntStats]>;
}

async function snapshotContext(
  fs: GroupPromptFileSystem,
  profileDir: string,
  create: boolean,
): Promise<SnapshotContext> {
  const canonicalProfileDir = await fs.realpath(profileDir);
  const promptsDir = join(canonicalProfileDir, 'prompts');
  const snapshotDir = join(promptsDir, 'session-snapshots');
  const promptsStat = await directory(fs, promptsDir, create);
  const snapshotStat = await directory(fs, snapshotDir, create);
  if (!promptsStat || !snapshotStat) {
    throw new GroupPromptFileError('SNAPSHOT_MISSING', 'snapshot does not exist');
  }
  return {
    snapshotDir,
    parents: [
      [promptsDir, promptsStat],
      [snapshotDir, snapshotStat],
    ],
  };
}

async function directory(
  fs: GroupPromptFileSystem,
  path: string,
  create: boolean,
): Promise<BigIntStats | undefined> {
  let stat = await lstatOrMissing(fs, path);
  if (!stat && create) {
    try {
      await fs.mkdir(path, 0o700);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    stat = await lstatOrMissing(fs, path);
  }
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new GroupPromptFileError('UNSAFE_PATH', 'snapshot parent path is not trusted');
  }
  return stat;
}

async function readSnapshotBytes(
  fs: GroupPromptFileSystem,
  context: SnapshotContext,
  ref: GroupPromptSnapshotRef,
  hooks?: GroupPromptFileHooks,
): Promise<Buffer> {
  const path = snapshotPath(context.snapshotDir, ref.sha256);
  const stat = await lstatOrMissing(fs, path);
  if (!stat) throw new GroupPromptFileError('SNAPSHOT_MISSING', 'snapshot does not exist');
  if (stat.isSymbolicLink()) {
    throw new GroupPromptFileError('UNSAFE_PATH', 'snapshot path is not trusted');
  }
  if (!stat.isFile()) {
    throw new GroupPromptFileError('NOT_REGULAR_FILE', 'snapshot is not a regular file');
  }
  const bytes = await securelyReadFile(fs, path, stat, context.parents, 'snapshot-read', hooks);
  if (bytes.byteLength !== ref.byteCount) {
    throw new GroupPromptFileError('SNAPSHOT_BYTE_COUNT_MISMATCH', 'snapshot byte count does not match');
  }
  if (sha256(bytes) !== ref.sha256) {
    throw new GroupPromptFileError('SNAPSHOT_HASH_MISMATCH', 'snapshot hash does not match');
  }
  return bytes;
}

function validateSnapshotSource(source: GroupPromptSnapshotSource): Buffer {
  validateSnapshotRef(source);
  const bytes = Buffer.from(source.content, 'utf8');
  if (bytes.byteLength !== source.byteCount || sha256(bytes) !== source.sha256) {
    throw new GroupPromptFileError('INVALID_SNAPSHOT_REFERENCE', 'snapshot source metadata does not match');
  }
  return bytes;
}

function validateSnapshotRef(ref: GroupPromptSnapshotRef): void {
  if (
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    !Number.isSafeInteger(ref.byteCount) ||
    ref.byteCount <= 0 ||
    ref.byteCount > GROUP_PROMPT_MAX_BYTES
  ) {
    throw new GroupPromptFileError('INVALID_SNAPSHOT_REFERENCE', 'invalid snapshot reference');
  }
}

function snapshotRef(ref: GroupPromptSnapshotRef): GroupPromptSnapshotRef {
  return { sha256: ref.sha256, byteCount: ref.byteCount };
}

function snapshotPath(snapshotDir: string, hash: string): string {
  return join(snapshotDir, `${hash}.md`);
}

function fileSystem(options: GroupPromptFileOptions): GroupPromptFileSystem {
  return { ...nodeFileSystem, ...options.fileSystem };
}

async function lstatOrMissing(
  fs: GroupPromptFileSystem,
  path: string,
): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function requireDirectoryOrMissing(
  fs: GroupPromptFileSystem,
  path: string,
): Promise<BigIntStats | undefined> {
  const stat = await lstatOrMissing(fs, path);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new GroupPromptFileError('UNSAFE_PATH', 'group prompt parent path is not trusted');
  }
  return stat;
}

async function securelyReadFile(
  fs: GroupPromptFileSystem,
  path: string,
  expectedPathStat: BigIntStats,
  expectedParents: ReadonlyArray<readonly [string, BigIntStats]>,
  purpose: 'live' | 'snapshot-read',
  hooks?: GroupPromptFileHooks,
): Promise<Buffer> {
  const noFollow = requireNoFollow();
  let handle: FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | noFollow);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new GroupPromptFileError('UNSAFE_PATH', 'group prompt path is not trusted', { cause: err });
    }
    if (code === 'ENOENT') {
      throw new GroupPromptFileError('CHANGED_DURING_READ', 'group prompt changed during validation', {
        cause: err,
      });
    }
    throw err;
  }
  try {
    await hooks?.afterOpen?.(purpose, path);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new GroupPromptFileError('NOT_REGULAR_FILE', 'group prompt is not a regular file');
    }
    if (!sameIdentity(before, expectedPathStat)) {
      throw new GroupPromptFileError('CHANGED_DURING_READ', 'group prompt changed during validation');
    }
    await hooks?.afterInitialStat?.(purpose, path);
    await revalidateParents(fs, expectedParents);
    const bytes = await readBounded(handle);
    await hooks?.beforeFinalStat?.(purpose, path);
    const after = await handle.stat({ bigint: true });
    if (!sameFileState(before, after)) {
      throw new GroupPromptFileError('CHANGED_DURING_READ', 'group prompt changed while being read');
    }
    const currentPathStat = await lstatOrMissing(fs, path);
    if (!currentPathStat || currentPathStat.isSymbolicLink() || !sameIdentity(after, currentPathStat)) {
      throw new GroupPromptFileError('CHANGED_DURING_READ', 'group prompt path changed while being read');
    }
    await revalidateParents(fs, expectedParents);
    return bytes;
  } finally {
    await handle.close();
  }
}

function requireNoFollow(): number {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number' || noFollow === 0) {
    throw new GroupPromptFileError('UNSUPPORTED_NOFOLLOW', 'secure file open is unavailable');
  }
  return noFollow;
}

async function fsyncDirectory(fs: GroupPromptFileSystem, path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | requireNoFollow());
    await handle.sync();
  } catch {
    // Directory fsync is not supported by every target filesystem/platform.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const limit = GROUP_PROMPT_MAX_BYTES + 1;
  const buffer = Buffer.allocUnsafe(limit);
  let offset = 0;
  while (offset < limit) {
    const { bytesRead } = await handle.read(buffer, offset, limit - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset === 0) throw new GroupPromptFileError('EMPTY_FILE', 'group prompt file is empty');
  if (offset > GROUP_PROMPT_MAX_BYTES) {
    throw new GroupPromptFileError('FILE_TOO_LARGE', 'group prompt exceeds the size limit');
  }
  return buffer.subarray(0, offset);
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (err) {
    throw new GroupPromptFileError('INVALID_UTF8', 'group prompt is not valid UTF-8', { cause: err });
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function revalidateParents(
  fs: GroupPromptFileSystem,
  expectedParents: ReadonlyArray<readonly [string, BigIntStats]>,
): Promise<void> {
  for (const [path, expected] of expectedParents) {
    const current = await lstatOrMissing(fs, path);
    if (!current || current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(current, expected)) {
      throw new GroupPromptFileError('UNSAFE_PATH', 'group prompt parent path changed');
    }
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validateChatId(chatId: string): void {
  if (
    chatId.length === 0 ||
    chatId.length > MAX_CHAT_ID_LENGTH ||
    chatId === '.' ||
    chatId === '..' ||
    !SAFE_CHAT_ID.test(chatId)
  ) {
    throw new GroupPromptFileError('INVALID_CHAT_ID', 'invalid group chat identifier');
  }
}
