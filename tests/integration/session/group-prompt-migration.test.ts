import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionCatalog } from '../../../src/session/catalog.js';
import {
  promptBindingIdentityKey,
  promptBindingLegacyIdentityKey,
} from '../../../src/session/prompt-binding-ledger.js';
import { PromptSessionService } from '../../../src/session/prompt-session-service.js';
import { SessionStore } from '../../../src/session/store.js';

const cleanups: Array<() => Promise<void>> = [];

describe('group prompt first-install migration', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('imports active Catalog and independent Claude SessionStore entries as legacy-none', async () => {
    const profileDir = await temporaryProfile();
    const catalog = new SessionCatalog(join(profileDir, 'sessions.json.catalog.json'));
    const sessions = new SessionStore(join(profileDir, 'sessions.json'));
    const catalogIdentity = {
      scopeId: 'chat-old',
      agentId: 'codex' as const,
      cwdRealpath: '/repo/codex',
      policyFingerprint: 'policy-old',
    };
    catalog.upsertActive({ ...catalogIdentity, threadId: 'thread-old', now: 100 });
    sessions.set('doc:legacy-doc', 'session-old', '/repo/claude');
    await Promise.all([catalog.flush(), sessions.flush()]);
    const groupsDir = join(profileDir, 'prompts', 'groups');
    await mkdir(groupsDir, { recursive: true });
    await writeFile(join(groupsDir, 'chat-new.md'), 'activate', { mode: 0o600 });
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: catalog,
      sessionStore: sessions,
      now: () => 1_720_000_000_000,
      createInstallId: () => 'install-1',
    });

    await service.prepareSession({
      identity: {
        scopeId: 'chat-new',
        agentId: 'codex',
        cwdRealpath: '/repo/new',
        policyFingerprint: 'policy-new',
      },
      origin: {
        source: 'im',
        scopeId: 'chat-new',
        chatId: 'chat-new',
        chatType: 'group',
      },
    });

    expect(service.health).toMatchObject({
      health: 'healthy',
      ledger: {
        records: {
          'codex:thread-old': {
            binding: { kind: 'legacy-none' },
            provenance: 'imported-active',
          },
          'claude:session-old': {
            binding: { kind: 'legacy-none' },
            provenance: 'imported-active',
            origin: { source: 'comment', scopeId: 'doc:legacy-doc' },
          },
        },
        activeByIdentity: {
          [promptBindingIdentityKey(catalogIdentity)]: 'codex:thread-old',
        },
        legacyActiveByScopeCwd: {
          [promptBindingLegacyIdentityKey({
            scopeId: 'doc:legacy-doc',
            agentId: 'claude',
            cwdRealpath: '/repo/claude',
          })]: 'claude:session-old',
        },
      },
    });

    await expect(
      service.prepareSession({
        identity: catalogIdentity,
        origin: {
          source: 'im',
          scopeId: 'chat-old',
          chatId: 'chat-old',
          chatType: 'group',
        },
        existingAgentSessionId: 'thread-old',
      }),
    ).resolves.toMatchObject({
      kind: 'resume',
      agentSessionId: 'thread-old',
      binding: { kind: 'legacy-none' },
    });

    await expect(
      service.prepareSession({
        identity: {
          scopeId: 'doc:legacy-doc',
          agentId: 'claude',
          cwdRealpath: '/repo/claude',
          policyFingerprint: 'policy-comment',
        },
        origin: {
          source: 'comment',
          scopeId: 'doc:legacy-doc',
          documentId: 'legacy-doc',
          commentThreadId: 'comment-thread',
        },
        existingAgentSessionId: 'session-old',
      }),
    ).resolves.toMatchObject({
      kind: 'resume',
      agentSessionId: 'session-old',
      binding: { kind: 'legacy-none' },
    });
  });

  it('retires a transitional legacy pointer when a migrated comment is forced fresh', async () => {
    const profileDir = await temporaryProfile();
    const catalog = new SessionCatalog(join(profileDir, 'sessions.json.catalog.json'));
    const sessions = new SessionStore(join(profileDir, 'sessions.json'));
    sessions.set('doc:legacy-doc', 'session-old', '/repo/claude');
    await sessions.flush();
    const groupsDir = join(profileDir, 'prompts', 'groups');
    await mkdir(groupsDir, { recursive: true });
    await writeFile(join(groupsDir, 'chat-new.md'), 'activate', { mode: 0o600 });
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: catalog,
      sessionStore: sessions,
      now: () => 1_720_000_000_000,
      createInstallId: () => 'install-force-fresh',
    });
    await service.prepareSession({
      identity: {
        scopeId: 'chat-new',
        agentId: 'codex',
        cwdRealpath: '/repo/new',
        policyFingerprint: 'policy-new',
      },
      origin: {
        source: 'im',
        scopeId: 'chat-new',
        chatId: 'chat-new',
        chatType: 'group',
      },
    });
    const commentIdentity = {
      scopeId: 'doc:legacy-doc',
      agentId: 'claude' as const,
      cwdRealpath: '/repo/claude',
      policyFingerprint: 'policy-comment',
    };
    const commentOrigin = {
      source: 'comment' as const,
      scopeId: 'doc:legacy-doc',
      documentId: 'legacy-doc',
      commentThreadId: 'comment-thread',
    };

    const fresh = await service.prepareSession({
      identity: commentIdentity,
      origin: commentOrigin,
      existingAgentSessionId: 'session-old',
      allowResume: false,
    });
    if (fresh.kind !== 'fresh') throw new Error('expected fresh decision');

    await service.recordIdentifier({
      identity: commentIdentity,
      origin: commentOrigin,
      binding: fresh.binding,
      generation: fresh.generation,
      agentSessionId: 'session-new',
    });

    expect(service.health).toMatchObject({
      health: 'healthy',
      ledger: {
        records: {
          'claude:session-old': { binding: { kind: 'legacy-none' } },
          'claude:session-new': { binding: { kind: 'none' } },
        },
        legacyActiveByScopeCwd: {},
        retiredAt: { 'claude:session-old': 1_720_000_000_000 },
      },
    });
  });
});

async function temporaryProfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'group-prompt-migration-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
