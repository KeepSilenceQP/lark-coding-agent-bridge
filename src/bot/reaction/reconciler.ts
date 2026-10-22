import type { LarkChannel } from '@larksuite/channel';
import { createHash } from 'node:crypto';
import { log } from '../../core/logger';
import {
  computeCanonicalFingerprint,
  computeLegacyDoneFingerprint,
  EMPTY_FINGERPRINT,
  type ReactionLedger,
} from './ledger';
import { isPassiveReaction, isPredefinedEmoji, lookupReactionSemantics } from './semantics';
import { DEFAULT_REACTION_POLICY, type ReactionPolicy } from './policy';
import type {
  BufferedReactionEvent,
  CanonicalReactionRecord,
  EffectiveReactionEntry,
  ReactionKey,
  ReactionKeyComponents,
  ReactionTriggerEntry,
  ReconciliationResult,
} from './types';
import { parseReactionKey } from './types';

// ── Config ──

export const RECONCILE_MAX_RETRIES = 3;
export const RECONCILE_RETRY_DELAY_MS = 800;

// ── List API types (real Feishu im.reactions.list response shape) ──

interface ReactionListItem {
  reaction_id?: string;
  action_time?: string;
  operator?: {
    operator_id?: string;
    operator_type?: string; // 'user' | 'app'
  };
  reaction_type?: {
    emoji_type?: string;
  };
}

interface ReactionListResponse {
  data?: {
    items?: ReactionListItem[];
    has_more?: boolean;
    page_token?: string;
  };
}

// ── Reconciler deps ──

export interface ReconcilerDeps {
  channel: LarkChannel;
  ledger: ReactionLedger;
  botOpenId?: string;
  appId?: string;
  policy?: ReactionPolicy;
}

/**
 * Reconcile buffered events against the authoritative reaction list API.
 *
 * Key behaviors:
 * - Fetches ALL pages from messageReaction.list (full pagination, not just page 1).
 * - Excludes self-app reactions (operator_type==='app' or self openId).
 * - Computes canonical fingerprint (operator_id, emoji_type; dedup by reaction_id).
 * - Compares fingerprint against persistent ledger to decide: no-op, net-zero,
 *   or new revision.
 * - Implements finite retry on list API lag (F4); only returns
 *   reconciliationFailed after exhausting retries.
 * - Persists updated ledger entry on state change (F3/F5).
 */
export async function reconcile(
  key: ReactionKey,
  events: BufferedReactionEvent[],
  deps: ReconcilerDeps,
): Promise<ReconciliationResult> {
  // A flush keeps the policy accepted at intake across every paginated read,
  // retry, fingerprint and semantic lookup, even if the file changes meanwhile.
  const policy = deps.policy ?? DEFAULT_REACTION_POLICY;
  const components = parseReactionKey(key);
  const base: ReconciliationResult = {
    key,
    components,
    triggerReactions: [],
    effectiveReactionSet: [],
    revision: 0,
    fingerprint: EMPTY_FINGERPRINT,
    netZeroConsumed: false,
    reconciliationFailed: false,
    noOp: true,
  };

  // Keep passive markers out of retries, triggers and net-zero withdrawal
  // acknowledgements, including callers that bypass ordinary event intake.
  events = events.filter(event => !isPassiveReaction(event.emojiType, policy));
  if (events.length === 0) {
    const entry = deps.ledger.get(key);
    return {
      ...base,
      revision: entry?.lastRevision ?? 0,
      fingerprint: entry?.fingerprint ?? EMPTY_FINGERPRINT,
    };
  }

  // ── Fetch authoritative snapshot with finite retry (F4) ──
  // Retry on: (a) fetch throw, OR (b) stale success — snapshot doesn't
  // reflect the net change expected from buffered events.
  let records: CanonicalReactionRecord[] = [];
  let lastErr: unknown;
  let reconciled = false;

  for (let attempt = 1; attempt <= RECONCILE_MAX_RETRIES && !reconciled; attempt++) {
    try {
      records = await fetchAllReactions(deps.channel, components.targetMessageId, deps);
      lastErr = undefined;

      // F4: Staleness check — verify snapshot is compatible with buffered
      // events' net change. Added emoji must be in snapshot; removed must not.
      const opRecs = records.filter(r => r.operator_id === components.operatorOpenId);
      if (isSnapshotCompatible(events, opRecs)) {
        reconciled = true;
        break;
      }

      log.warn('reaction', 'reconcile-list-stale', {
        targetMessageId: components.targetMessageId,
        attempt,
        maxRetries: RECONCILE_MAX_RETRIES,
      });
    } catch (err) {
      lastErr = err;
      log.warn('reaction', 'reconcile-list-attempt-failed', {
        targetMessageId: components.targetMessageId,
        attempt,
        maxRetries: RECONCILE_MAX_RETRIES,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (attempt < RECONCILE_MAX_RETRIES) {
      await sleep(RECONCILE_RETRY_DELAY_MS * attempt);
    }
  }

  if (!reconciled) {
    log.warn('reaction', 'reconcile-list-failed', {
      targetMessageId: components.targetMessageId,
      err: lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'stale-after-retries'),
    });
    return { ...base, reconciliationFailed: true, noOp: false };
  }

  // ── Filter to this operator only ──
  const rawOperatorRecords = records.filter(
    (r) => r.operator_id === components.operatorOpenId,
  );
  const operatorRecords = rawOperatorRecords.filter(
    (r) => !isPassiveReaction(r.emoji_type, policy),
  );

  // ── Compute canonical fingerprint (F8/F9: cross-platform deterministic) ──
  const fingerprint = computeCanonicalFingerprint(operatorRecords, policy);

  // ── Build effectiveReactionSet from API records (authoritative) ──
  const effectiveSet = buildEffectiveSet(operatorRecords, policy);

  // ── Build ordered triggerReactions from buffered events ──
  const triggers = buildTriggerReactions(events, policy);

  // ── Load ledger state ──
  const ledgerEntry = deps.ledger.get(key);
  let consumedFingerprint = ledgerEntry?.consumedFingerprint ?? EMPTY_FINGERPRINT;
  let currentFingerprint = ledgerEntry?.fingerprint ?? EMPTY_FINGERPRINT;

  // Re-project both sides with the same policy. Otherwise making a retained
  // emoji passive (or actionable) looks like new user input and can replay an
  // already consumed reaction. Only an exactly consumed snapshot is rebased;
  // do not accidentally consume a previously unconsumed state.
  if (ledgerEntry?.rawRecords && currentFingerprint === consumedFingerprint) {
    currentFingerprint = consumedFingerprint = computeCanonicalFingerprint(
      ledgerEntry.rawRecords,
      policy,
    );
  }

  // The immediately preceding release excluded DONE but did not save rawRecords.
  // Recognize an exactly consumed snapshot using that historical policy before
  // applying today's mapping. A retained DONE becoming actionable is not new
  // input; an actual DONE event must still be evaluated against the old baseline.
  // Newly added markers that are passive today may already appear in the list
  // without ever entering intake, so also check the old recorded-ID projection.
  if (ledgerEntry && !ledgerEntry.rawRecords && !ledgerEntry.policyVersion
    && currentFingerprint === consumedFingerprint
    && !events.some(event => event.emojiType === 'DONE')) {
    const previousIds = new Set(ledgerEntry.recordIds);
    const historicalRecords = rawOperatorRecords.filter(record =>
      !isPassiveReaction(record.emoji_type, policy)
        || !record.reaction_id || previousIds.has(record.reaction_id));
    if (currentFingerprint === computeCanonicalFingerprint(rawOperatorRecords, DEFAULT_REACTION_POLICY)
      || currentFingerprint === computeCanonicalFingerprint(historicalRecords, DEFAULT_REACTION_POLICY)) {
      currentFingerprint = consumedFingerprint = fingerprint;
    }
  }

  // Older ledgers included DONE. Only normalize an exact, already-consumed
  // legacy snapshot; actual actionable changes still create a new revision.
  const legacyFingerprint = computeLegacyDoneFingerprint(rawOperatorRecords, components.operatorOpenId);
  if (!ledgerEntry?.rawRecords && isPassiveReaction('DONE', policy)
    && currentFingerprint === legacyFingerprint && consumedFingerprint === legacyFingerprint) {
    currentFingerprint = consumedFingerprint = fingerprint;
  }

  // A passive marker may have been removed while intake ignored it, then
  // explicitly re-added after being configured as actionable. Its canonical
  // membership is unchanged, but a new API reaction ID proves this is fresh
  // input. Only use this evidence across a policy change and when the old
  // record was excluded from active recordIds; a mere meaning edit must not
  // turn API ID churn for an already-active reaction into a replay.
  const reactivatedPassiveAddition = Boolean(
    ledgerEntry?.rawRecords && ledgerEntry.policyVersion
      && ledgerEntry.policyVersion !== policy.version
      && events.some(event => {
        if (event.action !== 'added'
          || events.some(other => other.emojiType === event.emojiType && other.action === 'removed')) return false;
        const previous = ledgerEntry.rawRecords!.filter(record => record.emoji_type === event.emojiType);
        if (previous.length === 0 || previous.some(record => !record.reaction_id
          || ledgerEntry.recordIds.includes(record.reaction_id))) return false;
        const previousIds = new Set(previous.map(record => record.reaction_id));
        return operatorRecords.some(record => record.emoji_type === event.emojiType
          && record.reaction_id && !previousIds.has(record.reaction_id));
      }),
  );

  // ── No-op: fingerprint unchanged (F3/F5: check against consumed fingerprint) ──
  if (fingerprint === currentFingerprint && fingerprint === consumedFingerprint && !reactivatedPassiveAddition) {
    // Also refresh raw passive records on a no-op. Their presence is needed
    // to project this consumed state after a later policy change.
    await persistLedgerEntry(deps, key, fingerprint, consumedFingerprint,
      operatorRecords.map((r) => r.reaction_id).filter((id): id is string => Boolean(id)),
      ledgerEntry?.lastRevision ?? 0, rawOperatorRecords, policy.version);
    // Check for net-zero added→removed exception (DD7)
    const netZero = detectNetZeroPair(events);
    if (netZero) {
      return {
        ...base,
        triggerReactions: triggers,
        effectiveReactionSet: effectiveSet,
        revision: ledgerEntry?.lastRevision ?? 0,
        fingerprint,
        netZeroConsumed: true,
        noOp: false,
      };
    }
    // True no-op: no state change, no net-zero pair
    return {
      ...base,
      triggerReactions: triggers,
      effectiveReactionSet: effectiveSet,
      revision: ledgerEntry?.lastRevision ?? 0,
      fingerprint,
      noOp: true,
    };
  }

  // ── State change → new revision (F3: persist updated ledger) ──
  const newRevision = (ledgerEntry?.lastRevision ?? 0) + 1;

  await persistLedgerEntry(deps, key, fingerprint, fingerprint,
    operatorRecords.map((r) => r.reaction_id).filter((id): id is string => Boolean(id)),
    newRevision, rawOperatorRecords, policy.version);

  return {
    ...base,
    triggerReactions: triggers,
    effectiveReactionSet: effectiveSet,
    revision: newRevision,
    fingerprint,
    noOp: false,
  };
}

// ── Persist ledger entry (F3/F5) ──

async function persistLedgerEntry(
  deps: ReconcilerDeps,
  key: ReactionKey,
  fingerprint: string,
  consumedFingerprint: string,
  recordIds: string[],
  revision: number,
  rawRecords: CanonicalReactionRecord[],
  policyVersion: string,
): Promise<void> {
  try {
    await deps.ledger.updateEntry(key, (prev) => ({
      fingerprint,
      consumedFingerprint,
      latestActionTime: Date.now(),
      recordIds,
      rawRecords,
      policyVersion,
      lastRevision: revision > (prev?.lastRevision ?? 0) ? revision : (prev?.lastRevision ?? 0),
    }));
  } catch (err) {
    log.warn('reaction', 'ledger-persist-failed', {
      key,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Full-page list fetch ──

async function fetchAllReactions(
  channel: LarkChannel,
  messageId: string,
  deps: ReconcilerDeps,
): Promise<CanonicalReactionRecord[]> {
  const collected: CanonicalReactionRecord[] = [];
  let pageToken: string | undefined;

  do {
    const res = (await channel.rawClient.im.v1.messageReaction.list({
      path: { message_id: messageId },
      params: {
        user_id_type: 'open_id',
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    })) as ReactionListResponse;

    const items = res?.data?.items ?? [];
    for (const item of items) {
      // Read nested operator/reaction_type per real Feishu API contract
      const opType = item.operator?.operator_type ?? 'user';
      const opId = item.operator?.operator_id ?? '';
      const emoji = item.reaction_type?.emoji_type ?? '';

      // Keep passive records as a baseline for future policy changes. They
      // are filtered before building effective sets and active fingerprints.
      if (isSelfApp(item, deps)) continue;

      collected.push({
        reaction_id: item.reaction_id,
        operator_type: opType,
        operator_id: opId,
        emoji_type: emoji,
      });
    }

    pageToken = res?.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);

  return collected;
}

function isSelfApp(item: ReactionListItem, deps: ReconcilerDeps): boolean {
  const opType = item.operator?.operator_type;
  const opId = item.operator?.operator_id;
  if (opType === 'app') return true;
  if (deps.botOpenId && opId === deps.botOpenId) return true;
  if (deps.appId && opId === deps.appId) return true;
  return false;
}

// ── Build effective set from API records ──

function buildEffectiveSet(records: CanonicalReactionRecord[], policy: ReactionPolicy): EffectiveReactionEntry[] {
  const seen = new Set<string>();
  const result: EffectiveReactionEntry[] = [];
  for (const r of records) {
    if (seen.has(r.emoji_type)) continue;
    seen.add(r.emoji_type);

    if (isPredefinedEmoji(r.emoji_type, policy)) {
      const sem = lookupReactionSemantics(r.emoji_type, policy);
      result.push({
        emojiType: r.emoji_type,
        emojiDisplay: sem.emojiDisplay,
        emojiMeaning: 'emojiMeaning' in sem ? sem.emojiMeaning : undefined,
        semanticKey: 'semanticKey' in sem ? sem.semanticKey : undefined,
        emojiMeaningSource: sem.emojiMeaningSource,
        behavior: sem.behavior,
      });
    } else {
      result.push({
        emojiType: r.emoji_type,
        emojiMeaningSource: 'unmapped',
      });
    }
  }
  return result;
}

// ── Build trigger reactions from buffered events ──

function buildTriggerReactions(events: BufferedReactionEvent[], policy: ReactionPolicy): ReactionTriggerEntry[] {
  return events.map((e) => {
    const semantics = lookupReactionSemantics(e.emojiType, policy);
    return {
      action: e.action,
      emojiType: e.emojiType,
      emojiDisplay: semantics.emojiDisplay,
      emojiMeaning: 'emojiMeaning' in semantics ? semantics.emojiMeaning : undefined,
      semanticKey: 'semanticKey' in semantics ? semantics.semanticKey : undefined,
      emojiMeaningSource: semantics.emojiMeaningSource,
      behavior: semantics.behavior,
      actionTime: e.actionTime,
    };
  });
}

// ── F4: Snapshot compatibility check ──

/**
 * Check if the list snapshot is compatible with buffered events' net change.
 * - For each added emojiType: must be present in snapshot (or the list is stale)
 * - For each removed emojiType: must be absent from snapshot (or the list is stale)
 * Returns true if the snapshot is consistent with the net effect.
 */
export function isSnapshotCompatible(
  events: BufferedReactionEvent[],
  operatorRecords: CanonicalReactionRecord[],
): boolean {
  const snapshotEmojis = new Set(operatorRecords.map((r) => r.emoji_type));

  // Net-change detection per emojiType
  const netChange = new Map<string, number>();
  for (const e of events) {
    const delta = e.action === 'added' ? 1 : -1;
    netChange.set(e.emojiType, (netChange.get(e.emojiType) ?? 0) + delta);
  }

  for (const [emojiType, net] of netChange) {
    if (net > 0 && !snapshotEmojis.has(emojiType)) {
      // Added event expects this emoji in snapshot, but it's absent → stale
      return false;
    }
    if (net < 0 && snapshotEmojis.has(emojiType)) {
      // Removed event expects this emoji absent, but it's still present → stale
      return false;
    }
    // net === 0: no expectation either way (added+removed pair)
  }
  return true;
}

// ── Net-zero detection ──

/**
 * Detect an added→removed pair for the SAME emojiType where the list API
 * already reflects the removal (fingerprint back to original).
 */
export function detectNetZeroPair(events: BufferedReactionEvent[]): boolean {
  if (events.length === 0) return false;

  const byEmoji = new Map<string, { added: number; removed: number }>();
  for (const e of events) {
    const counts = byEmoji.get(e.emojiType) ?? { added: 0, removed: 0 };
    if (e.action === 'added') counts.added++;
    else counts.removed++;
    byEmoji.set(e.emojiType, counts);
  }

  for (const counts of byEmoji.values()) {
    if (counts.added > 0 && counts.removed > 0 && counts.added === counts.removed) {
      return true;
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
