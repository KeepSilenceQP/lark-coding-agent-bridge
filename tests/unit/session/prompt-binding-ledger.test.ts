import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentSessionKey,
  createPromptBindingLedger,
  parsePromptBindingLedger,
  persistPromptBindingLedger,
  probePromptBindingLedger,
  promptBindingIdentityKey,
  resolvePromptBindingPaths,
  type PromptBindingLedgerDocument,
} from '../../../src/session/prompt-binding-ledger.js';

const cleanups: Array<() => Promise<void>> = [];

describe('prompt binding ledger', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });
  it('derives every prompt state path from the trusted profile directory', () => {
    expect(resolvePromptBindingPaths('/profiles/work')).toEqual({
      promptDir: join('/profiles/work', 'prompts'),
      ledgerFile: join('/profiles/work', 'prompts', 'session-bindings.v1.json'),
      markerFile: join('/profiles/work', 'prompts', 'session-bindings.v1.activated'),
    });
  });

  it('parses a complete strict V1 ledger', () => {
    const ledger = validLedger();

    expect(parsePromptBindingLedger(JSON.stringify(ledger))).toEqual(ledger);
  });

  it('rejects unknown schema versions', () => {
    const ledger = validLedger();
    (ledger as unknown as { schemaVersion: number }).schemaVersion = 2;

    expect(() => parsePromptBindingLedger(JSON.stringify(ledger))).toThrow(/schemaVersion/i);
  });

  it('rejects unknown fields instead of silently normalizing them', () => {
    const ledger = { ...validLedger(), unexpected: true };

    expect(() => parsePromptBindingLedger(JSON.stringify(ledger))).toThrow(/unexpected/i);
  });

  it('rejects invalid pinned snapshot hashes', () => {
    const ledger = validLedger();
    const record = Object.values(ledger.records)[0]!;
    if (record.binding.kind === 'pinned') record.binding.sha256 = 'not-a-hash';

    expect(() => parsePromptBindingLedger(JSON.stringify(ledger))).toThrow(/sha256/i);
  });

  it('rejects malformed identity keys and dangling active indexes', () => {
    const ledger = validLedger();
    ledger.activeByIdentity = { malformed: 'claude:missing' };

    expect(() => parsePromptBindingLedger(JSON.stringify(ledger))).toThrow(/activeByIdentity/i);
  });

  it('rejects records imported from a different profile', () => {
    expect(() =>
      parsePromptBindingLedger(JSON.stringify(validLedger()), { expectedProfile: 'other' }),
    ).toThrow(/profile/i);
  });

  it('reports an untouched profile as dormant without creating prompt state', async () => {
    const profileDir = await temporaryProfile();

    await expect(probePromptBindingLedger(profileDir, 'work')).resolves.toEqual({
      health: 'dormant',
    });
    await expect(stat(join(profileDir, 'prompts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a matching active Sidecar and activation marker as healthy', async () => {
    const profileDir = await temporaryProfile();
    const ledger = validLedger();
    const paths = resolvePromptBindingPaths(profileDir);
    await mkdir(paths.promptDir);
    await writeFile(paths.ledgerFile, JSON.stringify(ledger), { mode: 0o600 });
    await writeFile(
      paths.markerFile,
      JSON.stringify({ installId: ledger.installId, activatedAt: ledger.activatedAt }),
      { mode: 0o600 },
    );

    const result = await probePromptBindingLedger(profileDir, 'work');
    expect(result).toMatchObject({ health: 'healthy', ledger });
  });

  it('serializes transactions, increments revision, and publishes the durable state', async () => {
    const profileDir = await temporaryProfile();
    const ledger = await createPromptBindingLedger(profileDir, 'work', validLedger());
    const hash = 'b'.repeat(64);

    const first = ledger.transact(4, (draft) => {
      draft.unreferencedSnapshots[hash] = { unreferencedAt: 1_720_000_000_200 };
    });
    const second = ledger.transact(5, (draft) => {
      draft.unreferencedSnapshots[hash] = { unreferencedAt: 1_720_000_000_300 };
    });

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { ledgerRevision: 5 },
      { ledgerRevision: 6 },
    ]);
    expect(ledger.snapshot()).toMatchObject({
      ledgerRevision: 6,
      unreferencedSnapshots: { [hash]: { unreferencedAt: 1_720_000_000_300 } },
    });
    const persisted = parsePromptBindingLedger(
      await readFile(resolvePromptBindingPaths(profileDir).ledgerFile, 'utf8'),
    );
    expect(persisted.ledgerRevision).toBe(6);
  });

  it('serializes service transactions against the latest queued revision', async () => {
    const profileDir = await temporaryProfile();
    const ledger = await createPromptBindingLedger(profileDir, 'work', validLedger());
    const firstHash = 'b'.repeat(64);
    const secondHash = 'c'.repeat(64);

    const first = ledger.transactLatest((draft) => {
      draft.unreferencedSnapshots[firstHash] = { unreferencedAt: 1_720_000_000_200 };
    });
    const second = ledger.transactLatest((draft) => {
      draft.unreferencedSnapshots[secondHash] = { unreferencedAt: 1_720_000_000_300 };
    });

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { ledgerRevision: 5 },
      { ledgerRevision: 6 },
    ]);
    expect(ledger.snapshot().unreferencedSnapshots).toMatchObject({
      [firstHash]: expect.any(Object),
      [secondHash]: expect.any(Object),
    });
  });

  it('does not publish memory when authoritative persistence fails', async () => {
    const profileDir = await temporaryProfile();
    let writes = 0;
    const ledger = await createPromptBindingLedger(profileDir, 'work', validLedger(), {
      persist: async (path, payload) => {
        writes += 1;
        if (writes > 1) throw new Error('disk-full');
        await persistPromptBindingLedger(path, payload);
      },
    });

    await expect(
      ledger.transact(4, (draft) => {
        draft.unreferencedSnapshots['b'.repeat(64)] = {
          unreferencedAt: 1_720_000_000_300,
        };
      }),
    ).rejects.toThrow(/disk-full/);
    expect(ledger.snapshot()).toMatchObject({ phase: 'active', ledgerRevision: 4 });
    const disk = parsePromptBindingLedger(
      await readFile(resolvePromptBindingPaths(profileDir).ledgerFile, 'utf8'),
    );
    expect(disk).toMatchObject({ phase: 'active', ledgerRevision: 4 });
  });

  it('fails closed on an unexpected disk revision and reloads the newer ledger', async () => {
    const profileDir = await temporaryProfile();
    const ledger = await createPromptBindingLedger(profileDir, 'work', validLedger());
    const newer = validLedger();
    newer.ledgerRevision = 8;
    const path = resolvePromptBindingPaths(profileDir).ledgerFile;
    await persistPromptBindingLedger(path, `${JSON.stringify(newer)}\n`);

    await expect(ledger.transact(4, () => {})).rejects.toThrow(/on-disk ledger revision/i);
    expect(ledger.snapshot().ledgerRevision).toBe(8);
  });

  it('rejects rewrites of an immutable session record', async () => {
    const profileDir = await temporaryProfile();
    const ledger = await createPromptBindingLedger(profileDir, 'work', validLedger());

    await expect(
      ledger.transact(4, (draft) => {
        draft.records['claude:session-1']!.createdAt += 1;
      }),
    ).rejects.toThrow(/immutable record/i);
    expect(ledger.snapshot().ledgerRevision).toBe(4);
  });
});

async function temporaryProfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-binding-ledger-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function validLedger(): PromptBindingLedgerDocument {
  const sessionKey = agentSessionKey('claude', 'session-1');
  const identityKey = promptBindingIdentityKey({
    scopeId: 'chat-1',
    agentId: 'claude',
    cwdRealpath: '/repo',
    policyFingerprint: 'policy-1',
  });
  return {
    schemaVersion: 1,
    installId: '018f3f9e-5d6a-7b8c-9d0e-1f2a3b4c5d6e',
    activatedAt: 1_720_000_000_000,
    phase: 'active',
    ledgerRevision: 4,
    records: {
      [sessionKey]: {
        agentId: 'claude',
        sessionId: 'session-1',
        profile: 'work',
        cwdRealpath: '/repo',
        origin: {
          source: 'im',
          scopeId: 'chat-1',
          chatId: 'chat-1',
          chatType: 'group',
        },
        binding: {
          kind: 'pinned',
          sha256: 'a'.repeat(64),
          byteCount: 12,
        },
        provenance: 'created',
        createdAt: 1_720_000_000_100,
      },
    },
    activeByIdentity: { [identityKey]: sessionKey },
    legacyActiveByScopeCwd: {},
    resetTombstones: {},
    retiredAt: {},
    unreferencedSnapshots: {},
  };
}
