import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { ensureGroupPromptSnapshot } from '../../../src/session/group-prompt-files.js';
import {
  createPromptBindingActivationMarker,
  createPromptBindingLedger,
} from '../../../src/session/prompt-binding-ledger.js';
import {
  DEFAULT_PROMPT_ACTIVATION_TIMEOUT_MS,
  PromptSessionService,
} from '../../../src/session/prompt-session-service.js';
import { PromptRunAdmissionController } from '../../../src/session/prompt-run-admission.js';
import { SessionStore } from '../../../src/session/store.js';

const cleanups: Array<() => Promise<void>> = [];

describe('PromptSessionService', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('opens an untouched profile as dormant without creating prompt state', async () => {
    const profileDir = await temporaryProfile();
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
    });

    expect(service.health).toEqual({ health: 'dormant' });
    await expect(
      service.prepareSession({
        identity: identity(),
        origin: groupOrigin(),
        existingAgentSessionId: 'legacy-thread',
      }),
    ).resolves.toEqual({ kind: 'dormant', existingAgentSessionId: 'legacy-thread' });
    await expect(stat(join(profileDir, 'prompts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('activates a dormant profile for a fresh eligible group with a valid prompt', async () => {
    const profileDir = await temporaryProfile();
    const groupsDir = join(profileDir, 'prompts', 'groups');
    await mkdir(groupsDir, { recursive: true });
    await writeFile(join(groupsDir, 'chat-1.md'), 'group role', { mode: 0o600 });
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
      now: () => 1_720_000_000_000,
      createInstallId: () => 'install-1',
    });

    const decision = await service.prepareSession({
      identity: identity(),
      origin: groupOrigin(),
    });

    expect(decision).toMatchObject({
      kind: 'fresh',
      binding: { kind: 'pinned', byteCount: 10 },
      systemPromptAddendum: 'group role',
    });
    expect(service.health.health).toBe('healthy');
    const marker = JSON.parse(
      await readFile(join(profileDir, 'prompts', 'session-bindings.v1.activated'), 'utf8'),
    );
    expect(marker).toEqual({
      installId: 'install-1',
      activatedAt: 1_720_000_000_000,
    });
  });

  it('commits a fresh identifier authoritatively before publishing the mirror', async () => {
    const profileDir = await temporaryProfile();
    const groupsDir = join(profileDir, 'prompts', 'groups');
    await mkdir(groupsDir, { recursive: true });
    await writeFile(join(groupsDir, 'chat-1.md'), 'group role', { mode: 0o600 });
    const catalog = new SessionCatalog(join(profileDir, 'sessions.json.catalog.json'));
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: catalog,
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
      now: () => 1_720_000_000_000,
      createInstallId: () => 'install-1',
    });
    const decision = await service.prepareSession({
      identity: identity(),
      origin: groupOrigin(),
    });
    if (decision.kind !== 'fresh') throw new Error('expected fresh decision');

    await service.recordIdentifier({
      identity: identity(),
      origin: groupOrigin(),
      binding: decision.binding,
      generation: decision.generation,
      agentSessionId: 'thread-1',
    });

    expect(service.health).toMatchObject({
      health: 'healthy',
      ledger: {
        records: {
          'codex:thread-1': {
            threadId: 'thread-1',
            binding: decision.binding,
          },
        },
      },
    });
    expect(catalog.activeFor(identity())).toMatchObject({ threadId: 'thread-1' });
  });

  it('resumes from the exact pinned snapshot without rereading an edited live file', async () => {
    const profileDir = await temporaryProfile();
    const groupsDir = join(profileDir, 'prompts', 'groups');
    const liveFile = join(groupsDir, 'chat-1.md');
    await mkdir(groupsDir, { recursive: true });
    await writeFile(liveFile, 'version one', { mode: 0o600 });
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
      now: () => 1_720_000_000_000,
      createInstallId: () => 'install-1',
    });
    const fresh = await service.prepareSession({ identity: identity(), origin: groupOrigin() });
    if (fresh.kind !== 'fresh') throw new Error('expected fresh decision');
    await service.recordIdentifier({
      identity: identity(),
      origin: groupOrigin(),
      binding: fresh.binding,
      generation: fresh.generation,
      agentSessionId: 'thread-1',
    });
    await writeFile(liveFile, 'version two', { mode: 0o600 });

    await expect(
      service.prepareSession({
        identity: identity(),
        origin: groupOrigin(),
        existingAgentSessionId: 'thread-1',
      }),
    ).resolves.toMatchObject({
      kind: 'resume',
      agentSessionId: 'thread-1',
      binding: fresh.binding,
      systemPromptAddendum: 'version one',
    });
  });

  it('forces a fresh vendor session when an activated caller disallows concurrent resume', async () => {
    const profileDir = await temporaryProfile();
    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
    });
    const first = await service.prepareSession({ identity: identity(), origin: groupOrigin() });
    if (first.kind !== 'fresh') throw new Error('expected fresh decision');
    await service.recordIdentifier({
      identity: identity(),
      origin: groupOrigin(),
      binding: first.binding,
      generation: first.generation,
      agentSessionId: 'thread-active',
    });

    await expect(
      service.prepareSession({
        identity: identity(),
        origin: groupOrigin(),
        existingAgentSessionId: 'thread-active',
        allowResume: false,
      }),
    ).resolves.toMatchObject({ kind: 'fresh', binding: first.binding });
  });

  it('repairs a stale compatibility mirror from the authoritative active pointer', async () => {
    const profileDir = await temporaryProfile();
    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
    const catalog = new SessionCatalog(join(profileDir, 'sessions.json.catalog.json'));
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: catalog,
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
    });
    const fresh = await service.prepareSession({ identity: identity(), origin: groupOrigin() });
    if (fresh.kind !== 'fresh') throw new Error('expected fresh decision');
    await service.recordIdentifier({
      identity: identity(),
      origin: groupOrigin(),
      binding: fresh.binding,
      generation: fresh.generation,
      agentSessionId: 'thread-authoritative',
    });
    catalog.upsertActive({ ...identity(), threadId: 'thread-stale' });

    await expect(
      service.prepareSession({
        identity: identity(),
        origin: groupOrigin(),
        existingAgentSessionId: 'thread-stale',
      }),
    ).resolves.toMatchObject({
      kind: 'resume',
      agentSessionId: 'thread-authoritative',
    });
    expect(catalog.activeFor(identity())).toMatchObject({ threadId: 'thread-authoritative' });
  });

  it('commits a reset tombstone and retires the old record before clearing mirrors', async () => {
    const profileDir = await temporaryProfile();
    const groupsDir = join(profileDir, 'prompts', 'groups');
    await mkdir(groupsDir, { recursive: true });
    await writeFile(join(groupsDir, 'chat-1.md'), 'group role', { mode: 0o600 });
    const catalog = new SessionCatalog(join(profileDir, 'sessions.json.catalog.json'));
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: catalog,
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
      now: () => 1_720_000_000_000,
      createInstallId: () => 'install-1',
    });
    const fresh = await service.prepareSession({ identity: identity(), origin: groupOrigin() });
    if (fresh.kind !== 'fresh') throw new Error('expected fresh decision');
    await service.recordIdentifier({
      identity: identity(),
      origin: groupOrigin(),
      binding: fresh.binding,
      generation: fresh.generation,
      agentSessionId: 'thread-1',
    });

    await service.resetSession({ identity: identity(), origin: groupOrigin() });

    const health = service.health;
    expect(health).toMatchObject({
      health: 'healthy',
      ledger: {
        activeByIdentity: {},
        retiredAt: { 'codex:thread-1': 1_720_000_000_000 },
      },
    });
    if (health.health !== 'healthy') throw new Error('expected healthy state');
    expect(Object.values(health.ledger.resetTombstones)).toEqual([
      { generation: 1, resetAt: 1_720_000_000_000 },
    ]);
    expect(catalog.activeFor(identity())).toBeUndefined();
  });

  it('commits first activation and the initial /new tombstone in one ledger revision', async () => {
    const profileDir = await temporaryProfile();
    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
      now: () => 1_720_000_000_000,
      createInstallId: () => 'install-atomic-reset',
    });

    await expect(
      service.resetSession({ identity: identity(), origin: groupOrigin() }),
    ).resolves.toEqual({ kind: 'reset', activated: true });

    expect(service.health).toMatchObject({
      health: 'healthy',
      ledger: {
        phase: 'active',
        ledgerRevision: 1,
      },
    });
    const health = service.health;
    if (health.health !== 'healthy') throw new Error('expected healthy state');
    expect(Object.values(health.ledger.resetTombstones)).toEqual([
      { generation: 1, resetAt: 1_720_000_000_000 },
    ]);
  });

  it('closes admission and drains already admitted work before an activated reset', async () => {
    const profileDir = await temporaryProfile();
    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
      now: () => 1_720_000_000_000,
    });
    await service.prepareSession({ identity: identity(), origin: groupOrigin() });
    const admitted = service.admitRun({ runId: 'run-before-reset', source: 'im' });

    const reset = service.resetSession({ identity: identity(), origin: groupOrigin() });
    await Promise.resolve();
    expect(() => service.admitRun({ runId: 'run-during-reset', source: 'im' })).toThrow(
      /activation is in progress/i,
    );
    let settled = false;
    void reset.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    admitted.finishWithoutIdentifier();
    await expect(reset).resolves.toEqual({ kind: 'reset', activated: false });
  });

  it('uses a finite production activation deadline and reopens admission after timeout', async () => {
    const profileDir = await temporaryProfile();
    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
    const admissionController = new PromptRunAdmissionController();
    const beginActivation = admissionController.beginActivation.bind(admissionController);
    const beginSpy = vi
      .spyOn(admissionController, 'beginActivation')
      .mockImplementation((options) => beginActivation({ ...options, timeoutMs: 1 }));
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
      admissionController,
    });
    const stuck = service.admitRun({ runId: 'stuck-dormant-run', source: 'im' });

    await expect(
      service.prepareSession({ identity: identity(), origin: groupOrigin() }),
    ).rejects.toThrow(/drainage timed out/i);
    expect(beginSpy).toHaveBeenCalledWith({
      timeoutMs: DEFAULT_PROMPT_ACTIVATION_TIMEOUT_MS,
    });
    expect(service.health).toEqual({ health: 'dormant' });

    const reopened = service.admitRun({ runId: 'after-timeout', source: 'im' });
    reopened.finishWithoutIdentifier();
    stuck.finishWithoutIdentifier();
  });

  it('rejects a late identifier from a run prepared before /new', async () => {
    const profileDir = await temporaryProfile();
    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
      now: () => 1_720_000_000_000,
      createInstallId: () => 'install-late-id',
    });
    const prepared = await service.prepareSession({ identity: identity(), origin: groupOrigin() });
    if (prepared.kind !== 'fresh') throw new Error('expected fresh decision');

    await service.resetSession({ identity: identity(), origin: groupOrigin() });
    await expect(
      service.recordIdentifier({
        identity: identity(),
        origin: groupOrigin(),
        binding: prepared.binding,
        generation: prepared.generation,
        agentSessionId: 'thread-too-late',
      }),
    ).rejects.toThrow(/stale|reset/i);
    expect(service.health).toMatchObject({
      health: 'healthy',
      ledger: { activeByIdentity: {}, records: {} },
    });
  });

  it.each([false, true])(
    'recovers an interrupted migrating ledger (marker=%s) before accepting a run',
    async (withMarker) => {
      const profileDir = await temporaryProfile();
      await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
      await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
      const orphanContent = 'crash gap';
      const orphanHash = createHash('sha256').update(orphanContent).digest('hex');
      await ensureGroupPromptSnapshot(profileDir, {
        content: orphanContent,
        byteCount: Buffer.byteLength(orphanContent),
        sha256: orphanHash,
      });
      await createPromptBindingLedger(profileDir, 'work', {
        schemaVersion: 1,
        installId: 'install-recovery',
        activatedAt: 1_720_000_000_000,
        phase: 'migrating',
        ledgerRevision: 0,
        records: {},
        activeByIdentity: {},
        legacyActiveByScopeCwd: {},
        resetTombstones: {},
        retiredAt: {},
        unreferencedSnapshots: {},
      });
      if (withMarker) {
        await createPromptBindingActivationMarker(profileDir, {
          installId: 'install-recovery',
          activatedAt: 1_720_000_000_000,
        });
      }
      const service = await PromptSessionService.open({
        profileDir,
        profile: 'work',
        sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
        sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
        now: () => 1_720_000_000_500,
      });

      await expect(
        service.prepareSession({ identity: identity(), origin: groupOrigin() }),
      ).resolves.toMatchObject({ kind: 'fresh', binding: { kind: 'pinned' } });
      expect(service.health).toMatchObject({ health: 'healthy', ledger: { phase: 'active' } });
      expect(service.health).toMatchObject({
        health: 'healthy',
        ledger: {
          unreferencedSnapshots: {
            [orphanHash]: { unreferencedAt: 1_720_000_000_500 },
          },
        },
      });
    },
  );

  it.each(['after-ledger', 'after-marker'] as const)(
    'recovers activation in the same service after a %s persistence fault',
    async (faultPhase) => {
      const profileDir = await temporaryProfile();
      await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
      await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
      let failOnce = true;
      const service = await PromptSessionService.open({
        profileDir,
        profile: 'work',
        sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
        sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
        activationTestHooks: {
          afterMigratingLedgerCreated: async () => {
            if (faultPhase === 'after-ledger' && failOnce) {
              failOnce = false;
              throw new Error('injected marker persistence failure');
            }
          },
          afterActivationMarkerCreated: async () => {
            if (faultPhase === 'after-marker' && failOnce) {
              failOnce = false;
              throw new Error('injected final persistence failure');
            }
          },
        },
      });

      await expect(
        service.prepareSession({ identity: identity(), origin: groupOrigin() }),
      ).rejects.toThrow(/injected/);
      expect(service.health.health).toBe(
        faultPhase === 'after-ledger' ? 'activating' : 'incomplete-initialization',
      );

      await expect(
        service.prepareSession({ identity: identity(), origin: groupOrigin() }),
      ).resolves.toMatchObject({ kind: 'fresh', binding: { kind: 'pinned' } });
      expect(service.health.health).toBe('healthy');
    },
  );

  it.each(['after-ledger', 'after-marker'] as const)(
    'lets /new retry in the same service after a %s activation fault',
    async (faultPhase) => {
      const profileDir = await temporaryProfile();
      await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
      await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
      let failOnce = true;
      const service = await PromptSessionService.open({
        profileDir,
        profile: 'work',
        sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
        sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
        activationTestHooks: {
          afterMigratingLedgerCreated: async () => {
            if (faultPhase === 'after-ledger' && failOnce) {
              failOnce = false;
              throw new Error('injected marker persistence failure');
            }
          },
          afterActivationMarkerCreated: async () => {
            if (faultPhase === 'after-marker' && failOnce) {
              failOnce = false;
              throw new Error('injected final persistence failure');
            }
          },
        },
      });

      await expect(
        service.resetSession({ identity: identity(), origin: groupOrigin() }),
      ).rejects.toThrow(/injected/);
      await expect(
        service.resetSession({ identity: identity(), origin: groupOrigin() }),
      ).resolves.toMatchObject({ kind: 'reset' });
      expect(service.health).toMatchObject({
        health: 'healthy',
        ledger: { phase: 'active' },
      });
      const health = service.health;
      if (health.health !== 'healthy') throw new Error('expected healthy state');
      expect(Object.values(health.ledger.resetTombstones)).toHaveLength(1);
    },
  );

  it('allows only legacy-none p2p history and never rebinds a pinned group session', async () => {
    const profileDir = await temporaryProfile();
    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
    const catalog = new SessionCatalog(join(profileDir, 'sessions.json.catalog.json'));
    const sessions = new SessionStore(join(profileDir, 'sessions.json'));
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: catalog,
      sessionStore: sessions,
      now: () => 1_720_000_000_000,
      createInstallId: () => 'install-1',
    });
    const fresh = await service.prepareSession({ identity: identity(), origin: groupOrigin() });
    if (fresh.kind !== 'fresh') throw new Error('expected fresh decision');
    await service.recordIdentifier({
      identity: identity(),
      origin: groupOrigin(),
      binding: fresh.binding,
      generation: fresh.generation,
      agentSessionId: 'thread-pinned',
    });
    const dmIdentity = {
      scopeId: 'dm-1',
      agentId: 'codex' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'policy-dm',
    };
    const dmOrigin = {
      source: 'im' as const,
      scopeId: 'dm-1',
      chatId: 'dm-1',
      chatType: 'p2p' as const,
    };

    expect(
      service.canManualResume({
        identity: dmIdentity,
        origin: dmOrigin,
        agentSessionId: 'thread-pinned',
        updatedAt: 1_710_000_000_000,
      }),
    ).toBe(false);
    expect(
      service.canManualResume({
        identity: dmIdentity,
        origin: dmOrigin,
        agentSessionId: 'thread-legacy',
        updatedAt: 1_710_000_000_000,
      }),
    ).toBe(true);
    await expect(
      service.applyManualResume({
        identity: dmIdentity,
        origin: dmOrigin,
        agentSessionId: 'thread-legacy',
        updatedAt: 1_710_000_000_000,
      }),
    ).resolves.toBe('applied');
    expect(service.health).toMatchObject({
      health: 'healthy',
      ledger: {
        records: {
          'codex:thread-legacy': {
            binding: { kind: 'legacy-none' },
            provenance: 'adopted-legacy',
          },
        },
      },
    });
  });

  it('retains retired records for 90 days and orphan snapshots for a further 7 days', async () => {
    const profileDir = await temporaryProfile();
    await mkdir(join(profileDir, 'prompts', 'groups'), { recursive: true });
    await writeFile(join(profileDir, 'prompts', 'groups', 'chat-1.md'), 'group role');
    let now = 1_720_000_000_000;
    const service = await PromptSessionService.open({
      profileDir,
      profile: 'work',
      sessionCatalog: new SessionCatalog(join(profileDir, 'sessions.json.catalog.json')),
      sessionStore: new SessionStore(join(profileDir, 'sessions.json')),
      now: () => now,
      createInstallId: () => 'install-gc',
    });
    const fresh = await service.prepareSession({ identity: identity(), origin: groupOrigin() });
    if (fresh.kind !== 'fresh' || fresh.binding.kind !== 'pinned') {
      throw new Error('expected pinned fresh decision');
    }
    await service.recordIdentifier({
      identity: identity(),
      origin: groupOrigin(),
      binding: fresh.binding,
      generation: fresh.generation,
      agentSessionId: 'thread-retired',
    });
    await service.resetSession({ identity: identity(), origin: groupOrigin() });
    const snapshotPath = join(
      profileDir,
      'prompts',
      'session-snapshots',
      `${fresh.binding.sha256}.md`,
    );

    now += 90 * 24 * 60 * 60 * 1000 - 1;
    await service.gc();
    expect(service.health).toMatchObject({
      health: 'healthy',
      ledger: { records: { 'codex:thread-retired': expect.any(Object) } },
    });

    now += 1;
    await service.gc();
    const afterRecordGc = service.health;
    expect(afterRecordGc).toMatchObject({
      health: 'healthy',
      ledger: {
        records: {},
        retiredAt: {},
        unreferencedSnapshots: {
          [fresh.binding.sha256]: { unreferencedAt: now },
        },
      },
    });
    await expect(stat(snapshotPath)).resolves.toMatchObject({ isFile: expect.any(Function) });

    now += 7 * 24 * 60 * 60 * 1000;
    await service.gc();
    expect(service.health).toMatchObject({
      health: 'healthy',
      ledger: { unreferencedSnapshots: {} },
    });
    await expect(stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function temporaryProfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-session-service-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function identity() {
  return {
    scopeId: 'chat-1',
    agentId: 'codex' as const,
    cwdRealpath: '/repo',
    policyFingerprint: 'policy-1',
  };
}

function groupOrigin() {
  return {
    source: 'im' as const,
    scopeId: 'chat-1',
    chatId: 'chat-1',
    chatType: 'group' as const,
  };
}
