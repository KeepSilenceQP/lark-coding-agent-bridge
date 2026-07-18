import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteGroupPromptSnapshot,
  ensureGroupPromptSnapshot,
  inventoryGroupPromptSnapshots,
  readGroupPromptSnapshot,
  resolveLiveGroupPrompt,
} from '../../../src/session/group-prompt-files';

const roots: string[] = [];

async function tempProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-group-prompt-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('group prompt files', () => {
  it('rejects chat ids that are not one bounded safe path component', async () => {
    const profileDir = await tempProfile();
    const invalid = ['', '.', '..', '../escape', 'nested/chat', 'nested\\chat', 'chat\0id', 'a'.repeat(129)];

    for (const chatId of invalid) {
      await expect(resolveLiveGroupPrompt(profileDir, chatId)).rejects.toMatchObject({
        code: 'INVALID_CHAT_ID',
      });
    }
  });

  it('resolves a missing groups directory or live file to none without canonicalizing the final path', async () => {
    const profileDir = await tempProfile();
    const finalPath = join(profileDir, 'prompts', 'groups', 'oc_missing.md');
    const canonicalized: string[] = [];
    const fileSystem = {
      realpath: async (path: string) => {
        canonicalized.push(path);
        if (path === finalPath) throw new Error('final path must not be canonicalized');
        return realpath(path);
      },
    };

    await expect(resolveLiveGroupPrompt(profileDir, 'oc_missing', { fileSystem })).resolves.toEqual({
      kind: 'none',
    });

    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await expect(resolveLiveGroupPrompt(profileDir, 'oc_missing', { fileSystem })).resolves.toEqual({
      kind: 'none',
    });
    expect(canonicalized).toContain(profileDir);
    expect(canonicalized).not.toContain(finalPath);
  });

  it('rejects symlinked parent components and final files', async () => {
    const profileDir = await tempProfile();
    const outside = await tempProfile();
    await mkdir(join(outside, 'groups'), { recursive: true });
    await writeFile(join(outside, 'groups', 'oc_chat.md'), 'outside');
    await symlink(outside, join(profileDir, 'prompts'));

    await expect(resolveLiveGroupPrompt(profileDir, 'oc_chat')).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });

    await rm(join(profileDir, 'prompts'));
    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await symlink(join(outside, 'groups', 'oc_chat.md'), join(profileDir, 'prompts', 'groups', 'oc_chat.md'));
    await expect(resolveLiveGroupPrompt(profileDir, 'oc_chat')).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
  });

  it('reads and hashes the exact accepted UTF-8 bytes from an existing live file', async () => {
    const profileDir = await tempProfile();
    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await writeFile(join(profileDir, 'prompts', 'groups', 'oc_chat.md'), '角色：项目协调员\n');

    await expect(resolveLiveGroupPrompt(profileDir, 'oc_chat')).resolves.toEqual({
      kind: 'prompt',
      content: '角色：项目协调员\n',
      byteCount: 25,
      sha256: 'a93048c594999853dddabf1a4192412f29cf20302a4dc08193309091b3188d39',
    });
  });

  it('uses no-follow open and rejects empty, oversized, and fatally invalid UTF-8 files', async () => {
    const profileDir = await tempProfile();
    const groupsDir = join(profileDir, 'prompts', 'groups');
    const livePath = join(groupsDir, 'oc_chat.md');
    await mkdir(groupsDir, { recursive: true });
    let flags = 0;
    const fileSystem = {
      open: async (path: string, receivedFlags: number, mode?: number) => {
        flags = receivedFlags;
        return open(path, receivedFlags, mode);
      },
    };

    await writeFile(livePath, 'ok');
    await expect(resolveLiveGroupPrompt(profileDir, 'oc_chat', { fileSystem })).resolves.toMatchObject({
      kind: 'prompt',
    });
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);

    await writeFile(livePath, Buffer.alloc(0));
    await expect(resolveLiveGroupPrompt(profileDir, 'oc_chat')).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    await writeFile(livePath, Buffer.alloc(64 * 1024 + 1, 0x61));
    await expect(resolveLiveGroupPrompt(profileDir, 'oc_chat')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await writeFile(livePath, Buffer.from([0xc3, 0x28]));
    await expect(resolveLiveGroupPrompt(profileDir, 'oc_chat')).rejects.toMatchObject({ code: 'INVALID_UTF8' });
  });

  it('fails closed when the same descriptor or its final/parent path changes during the read', async () => {
    const profileDir = await tempProfile();
    const groupsDir = join(profileDir, 'prompts', 'groups');
    const livePath = join(groupsDir, 'oc_chat.md');
    await mkdir(groupsDir, { recursive: true });
    await writeFile(livePath, 'before');
    await expect(
      resolveLiveGroupPrompt(profileDir, 'oc_chat', {
        hooks: { beforeFinalStat: () => writeFile(livePath, 'after!') },
      }),
    ).rejects.toMatchObject({ code: 'CHANGED_DURING_READ' });

    await writeFile(livePath, 'stable');
    await expect(
      resolveLiveGroupPrompt(profileDir, 'oc_chat', {
        hooks: {
          afterOpen: async () => {
            await rename(livePath, `${livePath}.old`);
            await writeFile(livePath, 'replacement');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'CHANGED_DURING_READ' });

    await rm(livePath);
    await writeFile(join(groupsDir, 'oc_chat.md.old'), 'stable');
    await rename(join(groupsDir, 'oc_chat.md.old'), livePath);
    const outside = await tempProfile();
    await writeFile(join(outside, 'oc_chat.md'), 'outside');
    await expect(
      resolveLiveGroupPrompt(profileDir, 'oc_chat', {
        hooks: {
          afterOpen: async () => {
            await rename(groupsDir, `${groupsDir}.old`);
            await symlink(outside, groupsDir);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('creates an immutable mode-0600 snapshot and securely reads the pinned bytes', async () => {
    const profileDir = await tempProfile();
    const prompt = { content: 'pinned instructions\n', byteCount: 20, sha256: '72d57c31e1fabf2b09333356da78d9a24c31ea4099a7ad6b0477daf09353d343' };

    await expect(ensureGroupPromptSnapshot(profileDir, prompt)).resolves.toEqual({
      byteCount: prompt.byteCount,
      sha256: prompt.sha256,
    });
    const path = join(profileDir, 'prompts', 'session-snapshots', `${prompt.sha256}.md`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe(prompt.content);
    await expect(readGroupPromptSnapshot(profileDir, prompt)).resolves.toBe(prompt.content);
  });

  it('converges concurrent exclusive creates and revalidates every existing collision', async () => {
    const profileDir = await tempProfile();
    const prompt = { content: 'pinned instructions\n', byteCount: 20, sha256: '72d57c31e1fabf2b09333356da78d9a24c31ea4099a7ad6b0477daf09353d343' };

    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const continueCreate = new Promise<void>((resolve) => { release = resolve; });
    const first = ensureGroupPromptSnapshot(profileDir, prompt, {
      hooks: { afterOpen: async () => { markStarted(); await continueCreate; } },
    });
    await started;
    const second = ensureGroupPromptSnapshot(profileDir, prompt);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { byteCount: prompt.byteCount, sha256: prompt.sha256 },
      { byteCount: prompt.byteCount, sha256: prompt.sha256 },
    ]);

    const path = join(profileDir, 'prompts', 'session-snapshots', `${prompt.sha256}.md`);
    await writeFile(path, 'short');
    await expect(ensureGroupPromptSnapshot(profileDir, prompt)).rejects.toMatchObject({
      code: 'SNAPSHOT_BYTE_COUNT_MISMATCH',
    });
    await writeFile(path, 'tampered instruction');
    await expect(ensureGroupPromptSnapshot(profileDir, prompt)).rejects.toMatchObject({
      code: 'SNAPSHOT_HASH_MISMATCH',
    });
  });

  it('rejects malicious snapshot symlinks and non-regular collisions', async () => {
    const profileDir = await tempProfile();
    const outside = await tempProfile();
    const prompt = { content: 'pinned instructions\n', byteCount: 20, sha256: '72d57c31e1fabf2b09333356da78d9a24c31ea4099a7ad6b0477daf09353d343' };
    const dir = join(profileDir, 'prompts', 'session-snapshots');
    const path = join(dir, `${prompt.sha256}.md`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(outside, 'target'), prompt.content);
    await symlink(join(outside, 'target'), path);
    await expect(ensureGroupPromptSnapshot(profileDir, prompt)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(readGroupPromptSnapshot(profileDir, prompt)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });

    await rm(path);
    await mkdir(path);
    await expect(ensureGroupPromptSnapshot(profileDir, prompt)).rejects.toMatchObject({
      code: 'NOT_REGULAR_FILE',
    });
    await expect(readGroupPromptSnapshot(profileDir, prompt)).rejects.toMatchObject({
      code: 'NOT_REGULAR_FILE',
    });
  });

  it('verifies the same no-follow snapshot before GC deletion', async () => {
    const profileDir = await tempProfile();
    const prompt = { content: 'pinned instructions\n', byteCount: 20, sha256: '72d57c31e1fabf2b09333356da78d9a24c31ea4099a7ad6b0477daf09353d343' };
    await ensureGroupPromptSnapshot(profileDir, prompt);
    await expect(deleteGroupPromptSnapshot(profileDir, prompt)).resolves.toBe(true);
    await expect(readGroupPromptSnapshot(profileDir, prompt)).rejects.toMatchObject({ code: 'SNAPSHOT_MISSING' });
    await expect(deleteGroupPromptSnapshot(profileDir, prompt)).resolves.toBe(false);

    await ensureGroupPromptSnapshot(profileDir, prompt);
    const path = join(profileDir, 'prompts', 'session-snapshots', `${prompt.sha256}.md`);
    const outside = await tempProfile();
    await writeFile(join(outside, 'target'), prompt.content);
    await expect(
      deleteGroupPromptSnapshot(profileDir, prompt, {
        hooks: {
          beforeDeleteRevalidation: async () => {
            await rename(path, `${path}.old`);
            await symlink(join(outside, 'target'), path);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'CHANGED_DURING_READ' });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it('inventories only hash-valid regular snapshots for crash-gap recovery', async () => {
    const profileDir = await tempProfile();
    const prompt = { content: 'pinned instructions\n', byteCount: 20, sha256: '72d57c31e1fabf2b09333356da78d9a24c31ea4099a7ad6b0477daf09353d343' };
    await ensureGroupPromptSnapshot(profileDir, prompt);
    await writeFile(join(profileDir, 'prompts', 'session-snapshots', 'README'), 'ignored');

    await expect(inventoryGroupPromptSnapshots(profileDir)).resolves.toEqual([
      { byteCount: prompt.byteCount, sha256: prompt.sha256 },
    ]);
  });
});
