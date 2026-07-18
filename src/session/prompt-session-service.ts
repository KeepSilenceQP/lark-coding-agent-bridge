import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SessionCatalog } from './catalog.js';
import {
  deleteGroupPromptSnapshot,
  ensureGroupPromptSnapshot,
  inventoryGroupPromptSnapshots,
  readGroupPromptSnapshot,
  resolveLiveGroupPrompt,
} from './group-prompt-files.js';
import {
  agentSessionKey,
  createPromptBindingActivationMarker,
  createPromptBindingLedger,
  loadPromptBindingLedger,
  promptBindingIdentityKey,
  promptBindingLegacyIdentityKey,
  type PromptBinding,
  type PromptBindingIdentity,
  type PromptBindingLedger,
  type PromptBindingLedgerDocument,
  type PromptBindingLedgerHealth,
  type PromptBindingOrigin,
} from './prompt-binding-ledger.js';
import {
  PromptRunAdmissionController,
  type PromptRunAdmission,
  type PromptRunAdmissionInput,
} from './prompt-run-admission.js';
import type { SessionStore } from './store.js';

export interface PromptSessionServiceOptions {
  profileDir: string;
  profile: string;
  sessionCatalog: SessionCatalog;
  sessionStore: SessionStore;
  admissionController?: PromptRunAdmissionController;
  now?: () => number;
  createInstallId?: () => string;
  activationTimeoutMs?: number;
  activationTestHooks?: {
    afterMigratingLedgerCreated?(): Promise<void> | void;
    afterActivationMarkerCreated?(): Promise<void> | void;
  };
}

export interface PreparePromptSessionInput {
  identity: PromptBindingIdentity;
  origin: PromptBindingOrigin;
  existingAgentSessionId?: string;
  allowResume?: boolean;
  signal?: AbortSignal;
}

export interface DormantPromptSessionDecision {
  kind: 'dormant';
  existingAgentSessionId?: string;
}

export interface FreshPromptSessionDecision {
  kind: 'fresh';
  generation: number;
  binding: Exclude<PromptBinding, { kind: 'legacy-none' }>;
  systemPromptAddendum?: string;
}

export interface ResumePromptSessionDecision {
  kind: 'resume';
  agentSessionId: string;
  binding: PromptBinding;
  systemPromptAddendum?: string;
}

export type PromptSessionDecision =
  | DormantPromptSessionDecision
  | FreshPromptSessionDecision
  | ResumePromptSessionDecision;

export interface RecordPromptSessionIdentifierInput {
  identity: PromptBindingIdentity;
  origin: PromptBindingOrigin;
  binding: Exclude<PromptBinding, { kind: 'legacy-none' }>;
  generation: number;
  agentSessionId: string;
  admission?: PromptRunAdmission;
}

export interface ResetPromptSessionInput {
  identity: PromptBindingIdentity;
  origin: PromptBindingOrigin;
}

export interface ManualResumePromptSessionInput {
  identity: PromptBindingIdentity;
  origin: Extract<PromptBindingOrigin, { source: 'im' }>;
  agentSessionId: string;
  updatedAt: number;
}

export type ResetPromptSessionResult =
  | { kind: 'dormant' }
  | { kind: 'reset'; activated: boolean };

export interface PromptSessionGcResult {
  kind: 'skipped' | 'completed';
  retiredRecordsRemoved: number;
  orphanSnapshotsDetected: number;
  snapshotsDeleted: number;
}

const RETIRED_RECORD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const ORPHAN_SNAPSHOT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PROMPT_ACTIVATION_TIMEOUT_MS = 30_000;

export class PromptSessionService {
  readonly admissionController: PromptRunAdmissionController;
  private currentHealth: PromptBindingLedgerHealth;
  private currentLedger?: PromptBindingLedger;

  private constructor(
    private readonly options: PromptSessionServiceOptions,
    health: PromptBindingLedgerHealth,
    ledger?: PromptBindingLedger,
  ) {
    this.currentHealth = health;
    this.currentLedger = ledger;
    this.admissionController =
      options.admissionController ?? new PromptRunAdmissionController();
  }

  get health(): PromptBindingLedgerHealth {
    return structuredClone(this.currentHealth);
  }

  static async open(options: PromptSessionServiceOptions): Promise<PromptSessionService> {
    const loaded = await loadPromptBindingLedger(options.profileDir, options.profile);
    if (loaded.health === 'dormant' || loaded.health === 'corrupt') {
      return new PromptSessionService(options, loaded);
    }
    return new PromptSessionService(
      options,
      { health: loaded.health, ledger: loaded.document },
      loaded.ledger,
    );
  }

  async prepareSession(input: PreparePromptSessionInput): Promise<PromptSessionDecision> {
    if (
      this.currentHealth.health === 'activating' ||
      this.currentHealth.health === 'incomplete-initialization'
    ) {
      await this.recoverInterruptedActivation();
    }
    if (this.currentHealth.health === 'corrupt') {
      throw new Error(`prompt binding state is corrupt: ${this.currentHealth.reason}`);
    }
    if (this.currentHealth.health !== 'dormant') {
      return this.prepareActivatedSession(input);
    }
    if (input.existingAgentSessionId || !isEligibleGroup(input.origin)) {
      return dormantDecision(input.existingAgentSessionId);
    }
    const live = await resolveLiveGroupPrompt(this.options.profileDir, input.origin.chatId);
    if (live.kind === 'none') return dormantDecision();

    await this.activate();
    return this.prepareFreshSession(input, live);
  }

  admitRun(input: PromptRunAdmissionInput): PromptRunAdmission {
    return this.admissionController.admit(input);
  }

  private async prepareActivatedSession(
    input: PreparePromptSessionInput,
  ): Promise<FreshPromptSessionDecision | ResumePromptSessionDecision> {
    const ledger = this.requireHealthyLedger();
    throwIfAborted(input.signal);
    assertOriginMatchesIdentity(input.origin, input.identity);
    let snapshot = ledger.snapshot();
    const identityKey = promptBindingIdentityKey(input.identity);
    if (input.allowResume === false) return this.prepareFreshSession(input);
    if (snapshot.resetTombstones[identityKey]) return this.prepareFreshSession(input);
    let sessionKey = snapshot.activeByIdentity[identityKey];
    if (!sessionKey) {
      const legacyIdentityKey = promptBindingLegacyIdentityKey(input.identity);
      const legacySessionKey = snapshot.legacyActiveByScopeCwd[legacyIdentityKey];
      if (legacySessionKey) {
        const promoted = await ledger.transactLatest((draft) => {
          if (draft.activeByIdentity[identityKey]) return;
          if (draft.legacyActiveByScopeCwd[legacyIdentityKey] !== legacySessionKey) {
            throw new Error('legacy prompt binding pointer changed during promotion');
          }
          draft.activeByIdentity[identityKey] = legacySessionKey;
          delete draft.legacyActiveByScopeCwd[legacyIdentityKey];
        });
        this.currentHealth = { health: 'healthy', ledger: promoted };
        snapshot = promoted;
        sessionKey = promoted.activeByIdentity[identityKey];
      }
    }
    throwIfAborted(input.signal);
    if (!sessionKey) {
      if (input.existingAgentSessionId) {
        throw new Error('unknown post-activation agent session identifier');
      }
      return this.prepareFreshSession(input);
    }
    const record = snapshot.records[sessionKey];
    if (!record) throw new Error('active prompt binding record is missing');
    const agentSessionId = record.agentId === 'claude' ? record.sessionId : record.threadId;
    if (
      record.profile !== this.options.profile ||
      record.agentId !== input.identity.agentId ||
      record.cwdRealpath !== input.identity.cwdRealpath ||
      !isCompatibleRecordOrigin(record, input.origin)
    ) {
      throw new Error('active prompt binding record does not match the current identity and origin');
    }
    const systemPromptAddendum =
      record.binding.kind === 'pinned'
        ? await readGroupPromptSnapshot(this.options.profileDir, record.binding)
        : undefined;
    throwIfAborted(input.signal);
    await this.repairMirrors(input.identity, agentSessionId);
    throwIfAborted(input.signal);
    return {
      kind: 'resume',
      agentSessionId,
      binding: record.binding,
      ...(systemPromptAddendum !== undefined ? { systemPromptAddendum } : {}),
    };
  }

  async recordIdentifier(input: RecordPromptSessionIdentifierInput): Promise<void> {
    const ledger = this.requireHealthyLedger();
    assertOriginMatchesIdentity(input.origin, input.identity);
    const identityKey = promptBindingIdentityKey(input.identity);
    const legacyIdentityKey = promptBindingLegacyIdentityKey(input.identity);
    const sessionKey = agentSessionKey(input.identity.agentId, input.agentSessionId);
    const after = await ledger.transactLatest((draft) => {
      const currentGeneration = draft.resetTombstones[identityKey]?.generation ?? 0;
      if (currentGeneration !== input.generation) {
        throw new Error('stale prompt session generation after reset');
      }
      const existing = draft.records[sessionKey];
      if (existing) throw new Error(`prompt binding record already exists: ${sessionKey}`);
      const legacy = draft.legacyActiveByScopeCwd[legacyIdentityKey];
      if (legacy && legacy !== sessionKey) {
        delete draft.legacyActiveByScopeCwd[legacyIdentityKey];
        draft.retiredAt[legacy] = this.now();
      }
      const previous = draft.activeByIdentity[identityKey];
      if (previous && previous !== sessionKey) draft.retiredAt[previous] = this.now();
      draft.records[sessionKey] =
        input.identity.agentId === 'claude'
          ? {
              agentId: 'claude',
              sessionId: input.agentSessionId,
              profile: this.options.profile,
              cwdRealpath: input.identity.cwdRealpath,
              origin: input.origin,
              binding: input.binding,
              provenance: 'created',
              createdAt: this.now(),
            }
          : {
              agentId: 'codex',
              threadId: input.agentSessionId,
              profile: this.options.profile,
              cwdRealpath: input.identity.cwdRealpath,
              origin: input.origin,
              binding: input.binding,
              provenance: 'created',
              createdAt: this.now(),
            };
      draft.activeByIdentity[identityKey] = sessionKey;
      delete draft.resetTombstones[identityKey];
      if (input.binding.kind === 'pinned') {
        delete draft.unreferencedSnapshots[input.binding.sha256];
      }
    });
    this.currentHealth = { health: 'healthy', ledger: after };

    await this.repairMirrors(input.identity, input.agentSessionId);
    input.admission?.markIdentifierDurable();
  }

  async resetSession(input: ResetPromptSessionInput): Promise<ResetPromptSessionResult> {
    assertOriginMatchesIdentity(input.origin, input.identity);
    if (
      this.currentHealth.health === 'activating' ||
      this.currentHealth.health === 'incomplete-initialization'
    ) {
      await this.recoverInterruptedActivation();
    }
    let activated = false;
    const identityKey = promptBindingIdentityKey(input.identity);
    const legacyIdentityKey = promptBindingLegacyIdentityKey(input.identity);
    const resetAt = this.now();
    const applyReset = (draft: PromptBindingLedgerDocument): void => {
      const current = draft.activeByIdentity[identityKey];
      if (current) {
        delete draft.activeByIdentity[identityKey];
        draft.retiredAt[current] = resetAt;
      }
      const legacy = draft.legacyActiveByScopeCwd[legacyIdentityKey];
      if (legacy) {
        delete draft.legacyActiveByScopeCwd[legacyIdentityKey];
        draft.retiredAt[legacy] = resetAt;
      }
      const previous = draft.resetTombstones[identityKey];
      draft.resetTombstones[identityKey] = {
        generation: (previous?.generation ?? 0) + 1,
        resetAt,
      };
    };
    if (this.currentHealth.health === 'corrupt') {
      throw new Error(`prompt binding state is corrupt: ${this.currentHealth.reason}`);
    }
    if (this.currentHealth.health === 'dormant') {
      if (!isEligibleGroup(input.origin)) return { kind: 'dormant' };
      const live = await resolveLiveGroupPrompt(this.options.profileDir, input.origin.chatId);
      if (live.kind === 'none') return { kind: 'dormant' };
      await this.activate(applyReset);
      activated = true;
    }
    const ledger = this.requireHealthyLedger();
    let after: PromptBindingLedgerDocument;
    if (activated) {
      after = ledger.snapshot();
    } else {
      const lease = await this.admissionController.beginActivation({
        timeoutMs: this.activationTimeoutMs(),
      });
      try {
        after = await ledger.transactLatest(applyReset);
      } finally {
        lease.release();
      }
    }
    this.currentHealth = { health: 'healthy', ledger: after };
    await this.options.sessionCatalog.archiveActiveAwaited({
      ...input.identity,
      now: this.now(),
    });
    if (input.identity.agentId === 'claude') {
      await this.options.sessionStore.clearAwaited(input.identity.scopeId);
    }
    return { kind: 'reset', activated };
  }

  canManualResume(input: ManualResumePromptSessionInput): boolean {
    if (input.origin.chatType !== 'p2p' || input.origin.scopeId !== input.identity.scopeId) {
      return false;
    }
    if (this.currentHealth.health === 'dormant') return true;
    if (this.currentHealth.health !== 'healthy') return false;
    const snapshot = this.currentHealth.ledger;
    const record = snapshot.records[agentSessionKey(input.identity.agentId, input.agentSessionId)];
    if (!record) return input.updatedAt < snapshot.activatedAt;
    return (
      record.binding.kind === 'legacy-none' &&
      record.agentId === input.identity.agentId &&
      record.cwdRealpath === input.identity.cwdRealpath &&
      isCompatibleRecordOrigin(record, input.origin)
    );
  }

  async applyManualResume(input: ManualResumePromptSessionInput): Promise<'dormant' | 'applied'> {
    if (this.currentHealth.health === 'dormant') return 'dormant';
    if (!this.canManualResume(input)) throw new Error('manual resume candidate is not allowed');
    const ledger = this.requireHealthyLedger();
    const sessionKey = agentSessionKey(input.identity.agentId, input.agentSessionId);
    const identityKey = promptBindingIdentityKey(input.identity);
    const after = await ledger.transactLatest((draft) => {
      let record = draft.records[sessionKey];
      if (!record) {
        record =
          input.identity.agentId === 'claude'
            ? {
                agentId: 'claude',
                sessionId: input.agentSessionId,
                profile: this.options.profile,
                cwdRealpath: input.identity.cwdRealpath,
                origin: input.origin,
                binding: { kind: 'legacy-none' },
                provenance: 'adopted-legacy',
                createdAt: input.updatedAt,
              }
            : {
                agentId: 'codex',
                threadId: input.agentSessionId,
                profile: this.options.profile,
                cwdRealpath: input.identity.cwdRealpath,
                origin: input.origin,
                binding: { kind: 'legacy-none' },
                provenance: 'adopted-legacy',
                createdAt: input.updatedAt,
              };
        draft.records[sessionKey] = record;
      }
      const previous = draft.activeByIdentity[identityKey];
      if (previous && previous !== sessionKey) draft.retiredAt[previous] = this.now();
      draft.activeByIdentity[identityKey] = sessionKey;
      delete draft.resetTombstones[identityKey];
      delete draft.retiredAt[sessionKey];
    });
    this.currentHealth = { health: 'healthy', ledger: after };
    await this.repairMirrors(input.identity, input.agentSessionId);
    return 'applied';
  }

  async gc(): Promise<PromptSessionGcResult> {
    if (
      this.currentHealth.health === 'activating' ||
      this.currentHealth.health === 'incomplete-initialization'
    ) {
      await this.recoverInterruptedActivation();
    }
    if (this.currentHealth.health === 'dormant') {
      return {
        kind: 'skipped',
        retiredRecordsRemoved: 0,
        orphanSnapshotsDetected: 0,
        snapshotsDeleted: 0,
      };
    }
    if (this.currentHealth.health === 'corrupt') {
      throw new Error(`prompt binding state is corrupt: ${this.currentHealth.reason}`);
    }

    const lease = await this.admissionController.beginActivation({
      timeoutMs: this.activationTimeoutMs(),
    });
    try {
      const ledger = this.requireHealthyLedger();
      const inventory = await inventoryGroupPromptSnapshots(this.options.profileDir);
      const inventoryByHash = new Map(inventory.map((ref) => [ref.sha256, ref]));
      const detectedAt = this.now();
      let retiredRecordsRemoved = 0;
      let orphanSnapshotsDetected = 0;
      const afterRetention = await ledger.transactLatest((draft) => {
        for (const [sessionKey, retiredAt] of Object.entries(draft.retiredAt)) {
          if (detectedAt - retiredAt < RETIRED_RECORD_RETENTION_MS) continue;
          delete draft.records[sessionKey];
          delete draft.retiredAt[sessionKey];
          retiredRecordsRemoved += 1;
        }

        const reachable = new Set(
          Object.values(draft.records)
            .filter((record) => record.binding.kind === 'pinned')
            .map((record) =>
              record.binding.kind === 'pinned' ? record.binding.sha256 : '',
            ),
        );
        for (const hash of reachable) delete draft.unreferencedSnapshots[hash];
        for (const ref of inventory) {
          if (reachable.has(ref.sha256) || draft.unreferencedSnapshots[ref.sha256]) continue;
          draft.unreferencedSnapshots[ref.sha256] = { unreferencedAt: detectedAt };
          orphanSnapshotsDetected += 1;
        }
      });
      this.currentHealth = { health: 'healthy', ledger: afterRetention };

      const deletionCandidates = Object.entries(afterRetention.unreferencedSnapshots)
        .filter(([, marker]) => detectedAt - marker.unreferencedAt >= ORPHAN_SNAPSHOT_GRACE_MS)
        .map(([hash]) => hash);
      const clearedMarkers = new Set<string>();
      let snapshotsDeleted = 0;
      for (const hash of deletionCandidates) {
        const ref = inventoryByHash.get(hash);
        if (!ref) {
          clearedMarkers.add(hash);
          continue;
        }
        const deleted = await deleteGroupPromptSnapshot(this.options.profileDir, ref);
        if (deleted) snapshotsDeleted += 1;
        clearedMarkers.add(hash);
      }

      if (clearedMarkers.size > 0) {
        const afterCleanup = await ledger.transactLatest((draft) => {
          const reachable = new Set(
            Object.values(draft.records)
              .filter((record) => record.binding.kind === 'pinned')
              .map((record) =>
                record.binding.kind === 'pinned' ? record.binding.sha256 : '',
              ),
          );
          for (const hash of clearedMarkers) {
            if (!reachable.has(hash)) delete draft.unreferencedSnapshots[hash];
          }
        });
        this.currentHealth = { health: 'healthy', ledger: afterCleanup };
      }
      return {
        kind: 'completed',
        retiredRecordsRemoved,
        orphanSnapshotsDetected,
        snapshotsDeleted,
      };
    } finally {
      lease.release();
    }
  }

  private async repairMirrors(
    identity: PromptBindingIdentity,
    agentSessionId: string,
  ): Promise<void> {
    await this.options.sessionCatalog.upsertActiveAwaited({
      ...identity,
      ...(identity.agentId === 'claude'
        ? { sessionId: agentSessionId }
        : { threadId: agentSessionId }),
      now: this.now(),
    });
    if (identity.agentId === 'claude') {
      await this.options.sessionStore.setAwaited(
        identity.scopeId,
        agentSessionId,
        identity.cwdRealpath,
      );
    }
  }

  private async activate(
    finalize?: (draft: PromptBindingLedgerDocument) => void,
  ): Promise<void> {
    const lease = await this.admissionController.beginActivation({
      timeoutMs: this.activationTimeoutMs(),
    });
    try {
      const activatedAt = (this.options.now ?? Date.now)();
      const initial = this.buildMigrationDocument(activatedAt);
      const ledger = await createPromptBindingLedger(
        this.options.profileDir,
        this.options.profile,
        initial,
      );
      this.currentLedger = ledger;
      this.currentHealth = { health: 'activating', ledger: ledger.snapshot() };
      await this.options.activationTestHooks?.afterMigratingLedgerCreated?.();
      await createPromptBindingActivationMarker(this.options.profileDir, {
        installId: initial.installId,
        activatedAt,
      });
      this.currentHealth = {
        health: 'incomplete-initialization',
        ledger: ledger.snapshot(),
      };
      await this.options.activationTestHooks?.afterActivationMarkerCreated?.();
      const active = await ledger.transactLatest((draft) => {
        draft.phase = 'active';
        finalize?.(draft);
      });
      this.currentHealth = { health: 'healthy', ledger: active };
    } catch (error) {
      await this.reloadActivationState().catch(() => {});
      throw error;
    } finally {
      lease.release();
    }
  }

  private async reloadActivationState(): Promise<void> {
    const loaded = await loadPromptBindingLedger(this.options.profileDir, this.options.profile);
    if (loaded.health === 'dormant' || loaded.health === 'corrupt') {
      this.currentHealth = loaded;
      this.currentLedger = undefined;
      return;
    }
    this.currentHealth = { health: loaded.health, ledger: loaded.document };
    this.currentLedger = loaded.ledger;
  }

  private async recoverInterruptedActivation(): Promise<void> {
    if (
      this.currentHealth.health !== 'activating' &&
      this.currentHealth.health !== 'incomplete-initialization'
    ) {
      return;
    }
    if (!this.currentLedger) throw new Error('prompt binding ledger is unavailable');
    const markerMissing = this.currentHealth.health === 'activating';
    const lease = await this.admissionController.beginActivation({
      timeoutMs: this.activationTimeoutMs(),
    });
    try {
      const before = this.currentLedger.snapshot();
      const migrationSources = this.buildMigrationDocument(before.activatedAt);
      await this.currentLedger.transactLatest((draft) => {
        mergeMigrationSources(draft, migrationSources);
      });
      const inventory = await inventoryGroupPromptSnapshots(this.options.profileDir);
      const detectedAt = this.now();
      if (markerMissing) {
        await createPromptBindingActivationMarker(this.options.profileDir, {
          installId: before.installId,
          activatedAt: before.activatedAt,
        });
      }
      const active = await this.currentLedger.transactLatest((draft) => {
        const reachable = new Set(
          Object.values(draft.records)
            .filter((record) => record.binding.kind === 'pinned')
            .map((record) =>
              record.binding.kind === 'pinned' ? record.binding.sha256 : '',
            ),
        );
        for (const ref of inventory) {
          if (reachable.has(ref.sha256) || draft.unreferencedSnapshots[ref.sha256]) continue;
          draft.unreferencedSnapshots[ref.sha256] = { unreferencedAt: detectedAt };
        }
        draft.phase = 'active';
      });
      this.currentHealth = { health: 'healthy', ledger: active };
    } finally {
      lease.release();
    }
  }

  private buildMigrationDocument(activatedAt: number): PromptBindingLedgerDocument {
    const initial: PromptBindingLedgerDocument = {
      schemaVersion: 1,
      installId: (this.options.createInstallId ?? randomUUID)(),
      activatedAt,
      phase: 'migrating',
      ledgerRevision: 0,
      records: {},
      activeByIdentity: {},
      legacyActiveByScopeCwd: {},
      resetTombstones: {},
      retiredAt: {},
      unreferencedSnapshots: {},
    };
    for (const entry of this.options.sessionCatalog.entries()) {
      if (entry.status !== 'active') continue;
      const agentSessionId = entry.agentId === 'claude' ? entry.sessionId : entry.threadId;
      if (!agentSessionId) continue;
      const sessionKey = agentSessionKey(entry.agentId, agentSessionId);
      const record = importedRecord({
        profile: this.options.profile,
        agentId: entry.agentId,
        agentSessionId,
        scopeId: entry.scopeId,
        cwdRealpath: entry.cwdRealpath,
        createdAt: entry.updatedAt,
      });
      addImportedRecord(initial, sessionKey, record);
      initial.activeByIdentity[
        promptBindingIdentityKey({
          scopeId: entry.scopeId,
          agentId: entry.agentId,
          cwdRealpath: entry.cwdRealpath,
          policyFingerprint: entry.policyFingerprint,
        })
      ] = sessionKey;
    }
    for (const [scopeId, entry] of this.options.sessionStore.entries()) {
      if (!entry.sessionId || !entry.cwd) continue;
      const sessionKey = agentSessionKey('claude', entry.sessionId);
      const record = importedRecord({
        profile: this.options.profile,
        agentId: 'claude',
        agentSessionId: entry.sessionId,
        scopeId,
        cwdRealpath: entry.cwd,
        createdAt: entry.updatedAt,
      });
      const existing = initial.records[sessionKey];
      if (existing) {
        if (
          existing.cwdRealpath !== entry.cwd ||
          existing.origin.scopeId !== scopeId ||
          existing.agentId !== 'claude'
        ) {
          throw new Error(`conflicting legacy migration evidence for ${sessionKey}`);
        }
        continue;
      }
      addImportedRecord(initial, sessionKey, record);
      initial.legacyActiveByScopeCwd[
        promptBindingLegacyIdentityKey({
          scopeId,
          agentId: 'claude',
          cwdRealpath: entry.cwd,
        })
      ] = sessionKey;
    }
    return initial;
  }

  private async prepareFreshSession(
    input: PreparePromptSessionInput,
    resolved?: Awaited<ReturnType<typeof resolveLiveGroupPrompt>>,
  ): Promise<FreshPromptSessionDecision> {
    if (!this.currentLedger) throw new Error('prompt binding ledger is unavailable');
    const identityKey = promptBindingIdentityKey(input.identity);
    const generation =
      this.currentLedger.snapshot().resetTombstones[identityKey]?.generation ?? 0;
    if (!isEligibleGroup(input.origin)) {
      return { kind: 'fresh', generation, binding: { kind: 'none' } };
    }
    const live =
      resolved ??
      (await resolveLiveGroupPrompt(this.options.profileDir, input.origin.chatId));
    if (live.kind === 'none') return { kind: 'fresh', generation, binding: { kind: 'none' } };
    const ref = await ensureGroupPromptSnapshot(this.options.profileDir, live);
    const after = await this.currentLedger.transactLatest((draft) => {
      const referenced = Object.values(draft.records).some(
        (record) => record.binding.kind === 'pinned' && record.binding.sha256 === ref.sha256,
      );
      if (!referenced && !draft.unreferencedSnapshots[ref.sha256]) {
        draft.unreferencedSnapshots[ref.sha256] = {
          unreferencedAt: (this.options.now ?? Date.now)(),
        };
      }
    });
    this.currentHealth = { health: 'healthy', ledger: after };
    return {
      kind: 'fresh',
      generation,
      binding: { kind: 'pinned', ...ref },
      systemPromptAddendum: live.content,
    };
  }

  private requireHealthyLedger(): PromptBindingLedger {
    if (this.currentHealth.health !== 'healthy' || !this.currentLedger) {
      throw new Error(`prompt binding state is not healthy: ${this.currentHealth.health}`);
    }
    return this.currentLedger;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private activationTimeoutMs(): number {
    return this.options.activationTimeoutMs ?? DEFAULT_PROMPT_ACTIVATION_TIMEOUT_MS;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('prompt session preparation interrupted');
  error.name = 'AbortError';
  throw error;
}

function dormantDecision(existingAgentSessionId?: string): DormantPromptSessionDecision {
  return {
    kind: 'dormant',
    ...(existingAgentSessionId ? { existingAgentSessionId } : {}),
  };
}

function isEligibleGroup(
  origin: PromptBindingOrigin,
): origin is Extract<PromptBindingOrigin, { source: 'im' }> & { chatType: 'group' } {
  return origin.source === 'im' && origin.chatType === 'group';
}

function assertOriginMatchesIdentity(
  origin: PromptBindingOrigin,
  identity: PromptBindingIdentity,
): void {
  if (origin.scopeId !== identity.scopeId) {
    throw new Error('prompt binding origin does not match identity scope');
  }
}

interface ImportedRecordInput {
  profile: string;
  agentId: 'claude' | 'codex';
  agentSessionId: string;
  scopeId: string;
  cwdRealpath: string;
  createdAt: number;
}

function importedRecord(input: ImportedRecordInput) {
  const base = {
    profile: input.profile,
    cwdRealpath: input.cwdRealpath,
    origin: legacyOrigin(input.scopeId),
    binding: { kind: 'legacy-none' as const },
    provenance: 'imported-active' as const,
    createdAt: input.createdAt,
  };
  return input.agentId === 'claude'
    ? { ...base, agentId: 'claude' as const, sessionId: input.agentSessionId }
    : { ...base, agentId: 'codex' as const, threadId: input.agentSessionId };
}

function addImportedRecord(
  ledger: PromptBindingLedgerDocument,
  sessionKey: string,
  record: ReturnType<typeof importedRecord>,
): void {
  const existing = ledger.records[sessionKey];
  if (existing && !isDeepStrictEqual(existing, record)) {
    throw new Error(`conflicting legacy migration evidence for ${sessionKey}`);
  }
  ledger.records[sessionKey] = record;
}

function legacyOrigin(scopeId: string): PromptBindingOrigin {
  if (scopeId.startsWith('doc:')) {
    const documentId = scopeId.slice('doc:'.length) || scopeId;
    return {
      source: 'comment',
      scopeId,
      documentId,
      commentThreadId: scopeId,
    };
  }
  return {
    source: 'im',
    scopeId,
    chatId: scopeId,
    chatType: 'legacy-unknown',
  };
}

function isCompatibleRecordOrigin(
  record: PromptBindingLedgerDocument['records'][string],
  current: PromptBindingOrigin,
): boolean {
  if (isDeepStrictEqual(record.origin, current)) return true;
  if (record.binding.kind !== 'legacy-none' || record.provenance !== 'imported-active') {
    return false;
  }
  if (record.origin.scopeId !== current.scopeId || record.origin.source !== current.source) {
    return false;
  }
  if (record.origin.source === 'im' && current.source === 'im') {
    return record.origin.chatType === 'legacy-unknown';
  }
  return record.origin.source === 'comment' && current.source === 'comment';
}

function mergeMigrationSources(
  target: PromptBindingLedgerDocument,
  source: PromptBindingLedgerDocument,
): void {
  for (const [sessionKey, record] of Object.entries(source.records)) {
    const existing = target.records[sessionKey];
    if (existing && !isDeepStrictEqual(existing, record)) {
      throw new Error(`conflicting legacy migration evidence for ${sessionKey}`);
    }
    target.records[sessionKey] = record;
  }
  for (const field of ['activeByIdentity', 'legacyActiveByScopeCwd'] as const) {
    for (const [identityKey, sessionKey] of Object.entries(source[field])) {
      const existing = target[field][identityKey];
      if (existing && existing !== sessionKey) {
        throw new Error(`conflicting legacy migration index for ${identityKey}`);
      }
      target[field][identityKey] = sessionKey;
    }
  }
}
