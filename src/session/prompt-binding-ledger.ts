import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeFileAtomic } from '../platform/atomic-write.js';

export type PromptAgentId = 'claude' | 'codex';
export type AgentSessionKey = `${PromptAgentId}:${string}`;
export type PromptBindingPhase = 'migrating' | 'active';
export type PromptBindingProvenance = 'created' | 'imported-active' | 'adopted-legacy';

export interface PromptBindingIdentity {
  scopeId: string;
  agentId: PromptAgentId;
  cwdRealpath: string;
  policyFingerprint: string;
}

export type PromptBindingLegacyIdentity = Omit<PromptBindingIdentity, 'policyFingerprint'>;

export interface PromptBindingImOrigin {
  source: 'im';
  scopeId: string;
  chatId: string;
  chatType: 'p2p' | 'group' | 'legacy-unknown';
  threadId?: string;
}

export interface PromptBindingCommentOrigin {
  source: 'comment';
  scopeId: string;
  documentId: string;
  commentThreadId: string;
}

export type PromptBindingOrigin = PromptBindingImOrigin | PromptBindingCommentOrigin;
export type PromptBinding =
  | { kind: 'none' }
  | { kind: 'legacy-none' }
  | { kind: 'pinned'; sha256: string; byteCount: number };

interface PromptBindingRecordBase {
  profile: string;
  cwdRealpath: string;
  origin: PromptBindingOrigin;
  binding: PromptBinding;
  provenance: PromptBindingProvenance;
  createdAt: number;
}

export type PromptBindingRecord =
  | (PromptBindingRecordBase & {
      agentId: 'claude';
      sessionId: string;
      threadId?: never;
    })
  | (PromptBindingRecordBase & {
      agentId: 'codex';
      threadId: string;
      sessionId?: never;
    });

export interface PromptResetTombstone {
  generation: number;
  resetAt: number;
}

export interface PromptUnreferencedSnapshot {
  unreferencedAt: number;
}

export interface PromptBindingLedgerDocument {
  schemaVersion: 1;
  installId: string;
  activatedAt: number;
  phase: PromptBindingPhase;
  ledgerRevision: number;
  records: Record<string, PromptBindingRecord>;
  activeByIdentity: Record<string, AgentSessionKey>;
  legacyActiveByScopeCwd: Record<string, AgentSessionKey>;
  resetTombstones: Record<string, PromptResetTombstone>;
  retiredAt: Record<string, number>;
  unreferencedSnapshots: Record<string, PromptUnreferencedSnapshot>;
}

const KEY_SEPARATOR = '\x1f';

export function agentSessionKey(agentId: PromptAgentId, id: string): AgentSessionKey {
  if (agentId !== 'claude' && agentId !== 'codex') throw new Error('invalid agentId');
  assertKeyPart(id, 'agent session id');
  if (id.includes(':')) throw new Error('agent session id contains an invalid separator');
  return `${agentId}:${id}`;
}

export function promptBindingIdentityKey(input: PromptBindingIdentity): string {
  assertKeyPart(input.scopeId, 'identity scopeId');
  if (input.agentId !== 'claude' && input.agentId !== 'codex') throw new Error('invalid identity agentId');
  assertAbsolutePath(input.cwdRealpath, 'identity cwdRealpath');
  assertKeyPart(input.policyFingerprint, 'identity policyFingerprint');
  return [
    input.scopeId,
    input.agentId,
    input.cwdRealpath,
    input.policyFingerprint,
  ].join(KEY_SEPARATOR);
}

export function promptBindingLegacyIdentityKey(input: PromptBindingLegacyIdentity): string {
  assertKeyPart(input.scopeId, 'legacy identity scopeId');
  if (input.agentId !== 'claude' && input.agentId !== 'codex') {
    throw new Error('invalid legacy identity agentId');
  }
  assertAbsolutePath(input.cwdRealpath, 'legacy identity cwdRealpath');
  return [input.scopeId, input.agentId, input.cwdRealpath].join(KEY_SEPARATOR);
}

export interface ParsePromptBindingLedgerOptions {
  expectedProfile?: string;
}

export function parsePromptBindingLedger(
  raw: string,
  options: ParsePromptBindingLedgerOptions = {},
): PromptBindingLedgerDocument {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error('invalid prompt binding ledger schemaVersion');
  }
  assertExactKeys(parsed, [
    'schemaVersion',
    'installId',
    'activatedAt',
    'phase',
    'ledgerRevision',
    'records',
    'activeByIdentity',
    'legacyActiveByScopeCwd',
    'resetTombstones',
    'retiredAt',
    'unreferencedSnapshots',
  ], 'ledger');
  validateLedger(parsed as Record<string, unknown>);
  if (options.expectedProfile !== undefined) {
    assertProfile(options.expectedProfile, 'expectedProfile');
    const records = (parsed as PromptBindingLedgerDocument).records;
    if (Object.values(records).some((record) => record.profile !== options.expectedProfile)) {
      throw new Error('prompt binding ledger contains a cross-profile record');
    }
  }
  return parsed as PromptBindingLedgerDocument;
}

function validateLedger(value: Record<string, unknown>): void {
  assertNonEmptyString(value.installId, 'installId');
  assertTimestamp(value.activatedAt, 'activatedAt');
  if (value.phase !== 'migrating' && value.phase !== 'active') {
    throw new Error('invalid ledger phase');
  }
  assertNonNegativeInteger(value.ledgerRevision, 'ledgerRevision');
  const records = assertDictionary(value.records, 'records');
  for (const [key, record] of Object.entries(records)) validateRecord(key, record);
  for (const field of [
    'activeByIdentity',
    'legacyActiveByScopeCwd',
    'resetTombstones',
    'retiredAt',
    'unreferencedSnapshots',
  ] as const) {
    assertDictionary(value[field], field);
  }
  validateIndexes(value, records);
}

function validateIndexes(value: Record<string, unknown>, records: Record<string, unknown>): void {
  const active = value.activeByIdentity as Record<string, unknown>;
  assertUniqueIndexValues(active, 'activeByIdentity');
  for (const [identityKey, sessionKey] of Object.entries(active)) {
    const identity = parseIdentityKey(identityKey, true, 'activeByIdentity');
    const record = requireIndexedRecord(sessionKey, records, `activeByIdentity[${identityKey}]`);
    assertRecordMatchesIdentity(record, identity, `activeByIdentity[${identityKey}]`);
  }

  const legacy = value.legacyActiveByScopeCwd as Record<string, unknown>;
  assertUniqueIndexValues(legacy, 'legacyActiveByScopeCwd');
  for (const [identityKey, sessionKey] of Object.entries(legacy)) {
    const identity = parseIdentityKey(identityKey, false, 'legacyActiveByScopeCwd');
    const record = requireIndexedRecord(sessionKey, records, `legacyActiveByScopeCwd[${identityKey}]`);
    assertRecordMatchesIdentity(record, identity, `legacyActiveByScopeCwd[${identityKey}]`);
    if ((record.binding as { kind?: unknown }).kind !== 'legacy-none') {
      throw new Error(`legacyActiveByScopeCwd[${identityKey}] must reference legacy-none`);
    }
    for (const [activeKey, activeSessionKey] of Object.entries(active)) {
      const activeIdentity = parseIdentityKey(activeKey, true, 'activeByIdentity');
      if (
        activeIdentity.scopeId === identity.scopeId &&
        activeIdentity.agentId === identity.agentId &&
        activeIdentity.cwdRealpath === identity.cwdRealpath &&
        activeSessionKey !== sessionKey
      ) {
        throw new Error(`conflicting active and legacy indexes for ${identityKey}`);
      }
    }
  }

  const tombstones = value.resetTombstones as Record<string, unknown>;
  for (const [identityKey, tombstoneInput] of Object.entries(tombstones)) {
    parseIdentityKey(identityKey, true, 'resetTombstones');
    if (identityKey in active) throw new Error(`resetTombstones conflicts with activeByIdentity`);
    const tombstone = assertDictionary(tombstoneInput, `resetTombstones[${identityKey}]`);
    assertExactKeys(tombstone, ['generation', 'resetAt'], `resetTombstones[${identityKey}]`);
    assertNonNegativeInteger(tombstone.generation, `resetTombstones[${identityKey}].generation`);
    assertTimestamp(tombstone.resetAt, `resetTombstones[${identityKey}].resetAt`);
  }

  const retiredAt = value.retiredAt as Record<string, unknown>;
  const activeSessions = new Set([...Object.values(active), ...Object.values(legacy)]);
  for (const [sessionKey, timestamp] of Object.entries(retiredAt)) {
    requireIndexedRecord(sessionKey, records, `retiredAt[${sessionKey}]`);
    assertTimestamp(timestamp, `retiredAt[${sessionKey}]`);
    if (activeSessions.has(sessionKey)) throw new Error(`active record ${sessionKey} cannot be retired`);
  }

  const unreferenced = value.unreferencedSnapshots as Record<string, unknown>;
  const referencedHashes = new Set(
    Object.values(records)
      .map((record) => (record as Record<string, unknown>).binding as Record<string, unknown>)
      .filter((binding) => binding.kind === 'pinned')
      .map((binding) => binding.sha256),
  );
  for (const [sha256, markerInput] of Object.entries(unreferenced)) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`unreferencedSnapshots has invalid sha256`);
    const marker = assertDictionary(markerInput, `unreferencedSnapshots[${sha256}]`);
    assertExactKeys(marker, ['unreferencedAt'], `unreferencedSnapshots[${sha256}]`);
    assertTimestamp(marker.unreferencedAt, `unreferencedSnapshots[${sha256}].unreferencedAt`);
    if (referencedHashes.has(sha256)) throw new Error(`referenced snapshot ${sha256} cannot be unreferenced`);
  }
}

function assertUniqueIndexValues(index: Record<string, unknown>, context: string): void {
  const seen = new Set<unknown>();
  for (const value of Object.values(index)) {
    if (seen.has(value)) throw new Error(`${context} contains duplicate session pointers`);
    seen.add(value);
  }
}

function parseIdentityKey(
  key: string,
  withPolicy: boolean,
  context: string,
): PromptBindingLegacyIdentity & { policyFingerprint?: string } {
  const parts = key.split(KEY_SEPARATOR);
  if (parts.length !== (withPolicy ? 4 : 3)) throw new Error(`${context} has malformed identity key`);
  const [scopeId, agentId, cwdRealpath, policyFingerprint] = parts;
  assertKeyPart(scopeId, `${context} scopeId`);
  if (agentId !== 'claude' && agentId !== 'codex') throw new Error(`${context} has invalid agentId`);
  assertAbsolutePath(cwdRealpath, `${context} cwdRealpath`);
  if (withPolicy) assertKeyPart(policyFingerprint, `${context} policyFingerprint`);
  return {
    scopeId,
    agentId,
    cwdRealpath,
    ...(policyFingerprint === undefined ? {} : { policyFingerprint }),
  };
}

function requireIndexedRecord(
  sessionKey: unknown,
  records: Record<string, unknown>,
  context: string,
): Record<string, unknown> {
  assertNonEmptyString(sessionKey, context);
  if (!/^(claude|codex):[^:\x1f]+$/.test(sessionKey)) {
    throw new Error(`${context} contains malformed agent session key`);
  }
  const record = records[sessionKey];
  if (!record) throw new Error(`${context} references missing record`);
  return record as Record<string, unknown>;
}

function assertRecordMatchesIdentity(
  record: Record<string, unknown>,
  identity: PromptBindingLegacyIdentity,
  context: string,
): void {
  const origin = record.origin as Record<string, unknown>;
  if (
    record.agentId !== identity.agentId ||
    record.cwdRealpath !== identity.cwdRealpath ||
    origin.scopeId !== identity.scopeId
  ) {
    throw new Error(`${context} conflicts with indexed record identity`);
  }
}

function validateRecord(key: string, input: unknown): void {
  const record = assertDictionary(input, `record ${key}`);
  const agentId = record.agentId;
  if (agentId !== 'claude' && agentId !== 'codex') throw new Error(`record ${key} has invalid agentId`);
  const idField = agentId === 'claude' ? 'sessionId' : 'threadId';
  const id = record[idField];
  assertKeyPart(id, `record ${key}.${idField}`);
  if (key !== agentSessionKey(agentId, id as string)) {
    throw new Error(`record ${key} conflicts with agent id`);
  }
  assertExactKeys(
    record,
    ['agentId', idField, 'profile', 'cwdRealpath', 'origin', 'binding', 'provenance', 'createdAt'],
    `record ${key}`,
  );
  assertProfile(record.profile, `record ${key}.profile`);
  assertAbsolutePath(record.cwdRealpath, `record ${key}.cwdRealpath`);
  validateOrigin(record.origin, `record ${key}.origin`);
  validateBinding(record.binding, `record ${key}.binding`);
  if (!['created', 'imported-active', 'adopted-legacy'].includes(record.provenance as string)) {
    throw new Error(`record ${key} has invalid provenance`);
  }
  assertTimestamp(record.createdAt, `record ${key}.createdAt`);
}

function validateOrigin(input: unknown, context: string): void {
  const origin = assertDictionary(input, context);
  assertKeyPart(origin.scopeId, `${context}.scopeId`);
  if (origin.source === 'im') {
    assertExactKeys(origin, ['source', 'scopeId', 'chatId', 'chatType', 'threadId'], context);
    assertKeyPart(origin.chatId, `${context}.chatId`);
    if (!['p2p', 'group', 'legacy-unknown'].includes(origin.chatType as string)) {
      throw new Error(`${context}.chatType is invalid`);
    }
    if (origin.threadId !== undefined) assertKeyPart(origin.threadId, `${context}.threadId`);
    return;
  }
  if (origin.source === 'comment') {
    assertExactKeys(origin, ['source', 'scopeId', 'documentId', 'commentThreadId'], context);
    assertKeyPart(origin.documentId, `${context}.documentId`);
    assertKeyPart(origin.commentThreadId, `${context}.commentThreadId`);
    return;
  }
  throw new Error(`${context}.source is invalid`);
}

function validateBinding(input: unknown, context: string): void {
  const binding = assertDictionary(input, context);
  if (binding.kind === 'none' || binding.kind === 'legacy-none') {
    assertExactKeys(binding, ['kind'], context);
    return;
  }
  if (binding.kind === 'pinned') {
    assertExactKeys(binding, ['kind', 'sha256', 'byteCount'], context);
    if (typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256)) {
      throw new Error(`${context}.sha256 is invalid`);
    }
    assertNonNegativeInteger(binding.byteCount, `${context}.byteCount`);
    if (binding.byteCount === 0) throw new Error(`${context}.byteCount must be positive`);
    return;
  }
  throw new Error(`${context}.kind is invalid`);
}

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  context: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new Error(`${context} contains unexpected field: ${unexpected}`);
  const missing = allowed.find((key) => !(key in value) && key !== 'threadId');
  if (missing) throw new Error(`${context} is missing field: ${missing}`);
}

function assertDictionary(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${context} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, context: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function assertKeyPart(value: unknown, context: string): asserts value is string {
  assertNonEmptyString(value, context);
  if (value.includes(KEY_SEPARATOR)) throw new Error(`${context} contains an invalid separator`);
}

function assertProfile(value: unknown, context: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${context} is invalid`);
  }
}

function assertAbsolutePath(value: unknown, context: string): asserts value is string {
  assertNonEmptyString(value, context);
  if (!isAbsolute(value)) throw new Error(`${context} must be absolute`);
}

function assertNonNegativeInteger(value: unknown, context: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${context} must be a non-negative integer`);
  }
}

function assertTimestamp(value: unknown, context: string): asserts value is number {
  assertNonNegativeInteger(value, context);
}

export interface PromptBindingPaths {
  promptDir: string;
  ledgerFile: string;
  markerFile: string;
}

export function resolvePromptBindingPaths(profileDir: string): PromptBindingPaths {
  const promptDir = join(profileDir, 'prompts');
  return {
    promptDir,
    ledgerFile: join(promptDir, 'session-bindings.v1.json'),
    markerFile: join(promptDir, 'session-bindings.v1.activated'),
  };
}

export type PromptBindingLedgerHealth =
  | { health: 'dormant' }
  | { health: 'activating'; ledger: PromptBindingLedgerDocument }
  | { health: 'healthy'; ledger: PromptBindingLedgerDocument }
  | { health: 'incomplete-initialization'; ledger: PromptBindingLedgerDocument }
  | { health: 'corrupt'; reason: string };

export async function probePromptBindingLedger(
  profileDir: string,
  expectedProfile?: string,
): Promise<PromptBindingLedgerHealth> {
  const paths = resolvePromptBindingPaths(profileDir);
  let ledgerRaw: string | undefined;
  let markerRaw: string | undefined;
  try {
    [ledgerRaw, markerRaw] = await Promise.all([
      readOptionalFile(paths.ledgerFile),
      readOptionalFile(paths.markerFile),
    ]);
  } catch (error) {
    return { health: 'corrupt', reason: errorMessage(error) };
  }
  if (ledgerRaw === undefined && markerRaw === undefined) return { health: 'dormant' };
  if (ledgerRaw === undefined) {
    return { health: 'corrupt', reason: 'activation marker exists without Sidecar' };
  }
  let ledger: PromptBindingLedgerDocument;
  try {
    ledger = parsePromptBindingLedger(ledgerRaw, { expectedProfile });
  } catch (error) {
    return { health: 'corrupt', reason: errorMessage(error) };
  }
  if (markerRaw === undefined) {
    return ledger.phase === 'migrating'
      ? { health: 'activating', ledger }
      : { health: 'corrupt', reason: 'active Sidecar is missing activation marker' };
  }
  let marker: PromptBindingActivationMarker;
  try {
    marker = parseActivationMarker(markerRaw);
  } catch (error) {
    return { health: 'corrupt', reason: errorMessage(error) };
  }
  if (marker.installId !== ledger.installId || marker.activatedAt !== ledger.activatedAt) {
    return { health: 'corrupt', reason: 'activation marker does not match Sidecar' };
  }
  return ledger.phase === 'active'
    ? { health: 'healthy', ledger }
    : { health: 'incomplete-initialization', ledger };
}

export interface PromptBindingActivationMarker {
  installId: string;
  activatedAt: number;
}

export function parseActivationMarker(raw: string): PromptBindingActivationMarker {
  const marker = assertDictionary(JSON.parse(raw) as unknown, 'activation marker');
  assertExactKeys(marker, ['installId', 'activatedAt'], 'activation marker');
  assertNonEmptyString(marker.installId, 'activation marker installId');
  assertTimestamp(marker.activatedAt, 'activation marker activatedAt');
  return marker as unknown as PromptBindingActivationMarker;
}

export type PromptBindingLedgerMutator = (
  draft: PromptBindingLedgerDocument,
) => void | Promise<void>;

export type PromptBindingLedgerPersist = (path: string, payload: string) => Promise<void>;

export interface PromptBindingLedgerIoOptions {
  persist?: PromptBindingLedgerPersist;
}

export type PromptBindingLedgerLoadResult =
  | { health: 'dormant' }
  | { health: 'corrupt'; reason: string }
  | {
      health: 'activating' | 'healthy' | 'incomplete-initialization';
      document: PromptBindingLedgerDocument;
      ledger: PromptBindingLedger;
    };

export class StalePromptBindingLedgerRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StalePromptBindingLedgerRevisionError';
  }
}

export class PromptBindingLedger {
  private current: PromptBindingLedgerDocument;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly profileDir: string,
    private readonly expectedProfile: string,
    initial: PromptBindingLedgerDocument,
    private readonly persist: PromptBindingLedgerPersist = persistPromptBindingLedger,
  ) {
    this.current = cloneLedger(initial);
  }

  snapshot(): PromptBindingLedgerDocument {
    return cloneLedger(this.current);
  }

  transact(
    expectedRevision: number,
    mutator: PromptBindingLedgerMutator,
  ): Promise<PromptBindingLedgerDocument> {
    return this.enqueueTransaction(expectedRevision, mutator);
  }

  transactLatest(mutator: PromptBindingLedgerMutator): Promise<PromptBindingLedgerDocument> {
    return this.enqueueTransaction(undefined, mutator);
  }

  private enqueueTransaction(
    expectedRevision: number | undefined,
    mutator: PromptBindingLedgerMutator,
  ): Promise<PromptBindingLedgerDocument> {
    const transaction = this.queue.then(async () => {
      if (expectedRevision !== undefined && expectedRevision !== this.current.ledgerRevision) {
        throw new StalePromptBindingLedgerRevisionError(
          `stale expected ledger revision ${expectedRevision}; current is ${this.current.ledgerRevision}`,
        );
      }
      const path = resolvePromptBindingPaths(this.profileDir).ledgerFile;
      const disk = parsePromptBindingLedger(await readFile(path, 'utf8'), {
        expectedProfile: this.expectedProfile,
      });
      if (disk.ledgerRevision !== this.current.ledgerRevision) {
        const previousRevision = this.current.ledgerRevision;
        this.current = disk;
        throw new StalePromptBindingLedgerRevisionError(
          `unexpected on-disk ledger revision ${disk.ledgerRevision}; current was ${previousRevision}`,
        );
      }
      const draft = cloneLedger(this.current);
      await mutator(draft);
      assertImmutableLedgerMetadata(this.current, draft);
      assertImmutableRecords(this.current, draft);
      draft.ledgerRevision = this.current.ledgerRevision + 1;
      const next = parsePromptBindingLedger(JSON.stringify(draft), {
        expectedProfile: this.expectedProfile,
      });
      await this.persist(path, serializeLedger(next));
      this.current = next;
      return this.snapshot();
    });
    this.queue = transaction.then(
      () => undefined,
      () => undefined,
    );
    return transaction;
  }
}

export async function createPromptBindingLedger(
  profileDir: string,
  expectedProfile: string,
  initial: PromptBindingLedgerDocument,
  options: PromptBindingLedgerIoOptions = {},
): Promise<PromptBindingLedger> {
  const checked = parsePromptBindingLedger(JSON.stringify(initial), { expectedProfile });
  const paths = resolvePromptBindingPaths(profileDir);
  const existing = await readOptionalFile(paths.ledgerFile);
  if (existing !== undefined) throw new Error('prompt binding Sidecar already exists');
  const persist = options.persist ?? persistPromptBindingLedger;
  await persist(paths.ledgerFile, serializeLedger(checked));
  return new PromptBindingLedger(profileDir, expectedProfile, checked, persist);
}

export async function loadPromptBindingLedger(
  profileDir: string,
  expectedProfile: string,
  options: PromptBindingLedgerIoOptions = {},
): Promise<PromptBindingLedgerLoadResult> {
  const health = await probePromptBindingLedger(profileDir, expectedProfile);
  if (health.health === 'dormant' || health.health === 'corrupt') return health;
  return {
    health: health.health,
    document: cloneLedger(health.ledger),
    ledger: new PromptBindingLedger(
      profileDir,
      expectedProfile,
      health.ledger,
      options.persist ?? persistPromptBindingLedger,
    ),
  };
}

export async function createPromptBindingActivationMarker(
  profileDir: string,
  marker: PromptBindingActivationMarker,
): Promise<void> {
  const checked = parseActivationMarker(JSON.stringify(marker));
  const path = resolvePromptBindingPaths(profileDir).markerFile;
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(dirname(path));
}

export async function persistPromptBindingLedger(path: string, payload: string): Promise<void> {
  await writeFileAtomic(path, payload, { mode: 0o600 });
}

async function fsyncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every supported platform.
  }
}

function serializeLedger(ledger: PromptBindingLedgerDocument): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

function cloneLedger(ledger: PromptBindingLedgerDocument): PromptBindingLedgerDocument {
  return structuredClone(ledger);
}

function assertImmutableRecords(
  before: PromptBindingLedgerDocument,
  after: PromptBindingLedgerDocument,
): void {
  for (const [key, record] of Object.entries(before.records)) {
    if (!(key in after.records)) {
      if (!(key in before.retiredAt) || key in after.retiredAt) {
        throw new Error(`immutable record ${key} cannot be removed before retirement cleanup`);
      }
      continue;
    }
    if (!isDeepStrictEqual(record, after.records[key])) {
      throw new Error(`immutable record ${key} cannot be rewritten`);
    }
  }
}

function assertImmutableLedgerMetadata(
  before: PromptBindingLedgerDocument,
  after: PromptBindingLedgerDocument,
): void {
  if (before.schemaVersion !== after.schemaVersion) throw new Error('schemaVersion is immutable');
  if (before.installId !== after.installId) throw new Error('installId is immutable');
  if (before.activatedAt !== after.activatedAt) throw new Error('activatedAt is immutable');
  if (before.phase === 'active' && after.phase !== 'active') {
    throw new Error('active ledger phase cannot transition backwards');
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
