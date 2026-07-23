import type { LarkChannel } from '@larksuite/channel';
import { createHash } from 'node:crypto';
import { log } from '../../core/logger';
import {
  computeCanonicalFingerprint,
  EMPTY_FINGERPRINT,
  type ReactionLedger,
} from './ledger';
import { isPredefinedEmoji, lookupReactionSemantics } from './semantics';
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

// ── List API types ──

interface ReactionListItem {
  reaction_id?: string;
  operator_type?: string;
  operator_id?: string;
  emoji_type?: string;
  timestamp?: string;
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

  // ── Fetch authoritative snapshot with finite retry (F4) ──
  let records: CanonicalReactionRecord[] = [];
  let lastErr: unknown;

  for (let attempt = 1; attempt <= RECONCILE_MAX_RETRIES; attempt++) {
    try {
      records = await fetchAllReactions(deps.channel, components.targetMessageId, deps);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      log.warn('reaction', 'reconcile-list-attempt-failed', {
        targetMessageId: components.targetMessageId,
        attempt,
        maxRetries: RECONCILE_MAX_RETRIES,
        err: err instanceof Error ? err.message : String(err),
      });
      if (attempt < RECONCILE_MAX_RETRIES) {
        await sleep(RECONCILE_RETRY_DELAY_MS * attempt);
      }
    }
  }

  if (lastErr) {
    log.warn('reaction', 'reconcile-list-failed', {
      targetMessageId: components.targetMessageId,
      err: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    return { ...base, reconciliationFailed: true, noOp: false };
  }

  // ── Filter to this operator only ──
  const operatorRecords = records.filter(
    (r) => r.operator_id === components.operatorOpenId,
  );

  // ── Compute canonical fingerprint (F8/F9: cross-platform deterministic) ──
  const fingerprint = computeCanonicalFingerprint(operatorRecords);

  // ── Build effectiveReactionSet from API records (authoritative) ──
  const effectiveSet = buildEffectiveSet(operatorRecords);

  // ── Build ordered triggerReactions from buffered events ──
  const triggers = buildTriggerReactions(events);

  // ── Load ledger state ──
  const ledgerEntry = deps.ledger.get(key);
  const consumedFingerprint = ledgerEntry?.consumedFingerprint ?? EMPTY_FINGERPRINT;
  const currentFingerprint = ledgerEntry?.fingerprint ?? EMPTY_FINGERPRINT;

  // ── No-op: fingerprint unchanged (F3/F5: check against consumed fingerprint) ──
  if (fingerprint === currentFingerprint && fingerprint === consumedFingerprint) {
    // Check for net-zero added→removed exception (DD7)
    const netZero = detectNetZeroPair(events);
    if (netZero) {
      // Persist the event-pair consumption (F3)
      await persistLedgerEntry(deps, key, fingerprint, consumedFingerprint,
        operatorRecords.map((r) => r.reaction_id).filter((id): id is string => Boolean(id)),
        (ledgerEntry?.lastRevision ?? 0));
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
    newRevision);

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
): Promise<void> {
  try {
    await deps.ledger.updateEntry(key, (prev) => ({
      fingerprint,
      consumedFingerprint,
      latestActionTime: Date.now(),
      recordIds,
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
      // Exclude self-app reactions
      if (isSelfApp(item, deps)) continue;

      collected.push({
        reaction_id: item.reaction_id,
        operator_type: item.operator_type ?? 'user',
        operator_id: item.operator_id ?? '',
        emoji_type: item.emoji_type ?? '',
      });
    }

    pageToken = res?.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);

  return collected;
}

function isSelfApp(item: ReactionListItem, deps: ReconcilerDeps): boolean {
  if (item.operator_type === 'app') return true;
  if (deps.botOpenId && item.operator_id === deps.botOpenId) return true;
  if (deps.appId && item.operator_id === deps.appId) return true;
  return false;
}

// ── Build effective set from API records ──

function buildEffectiveSet(records: CanonicalReactionRecord[]): EffectiveReactionEntry[] {
  const seen = new Set<string>();
  const result: EffectiveReactionEntry[] = [];
  for (const r of records) {
    if (seen.has(r.emoji_type)) continue;
    seen.add(r.emoji_type);

    if (isPredefinedEmoji(r.emoji_type)) {
      const sem = lookupReactionSemantics(r.emoji_type);
      result.push({
        emojiType: r.emoji_type,
        emojiDisplay: sem.emojiDisplay,
        emojiMeaning: 'emojiMeaning' in sem ? sem.emojiMeaning : undefined,
        semanticKey: 'semanticKey' in sem ? sem.semanticKey : undefined,
        emojiMeaningSource: sem.emojiMeaningSource,
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

function buildTriggerReactions(events: BufferedReactionEvent[]): ReactionTriggerEntry[] {
  return events.map((e) => ({
    action: e.action,
    emojiType: e.emojiType,
    emojiDisplay: e.semantics.emojiDisplay,
    emojiMeaning: 'emojiMeaning' in e.semantics ? e.semantics.emojiMeaning : undefined,
    semanticKey: 'semanticKey' in e.semantics ? e.semantics.semanticKey : undefined,
    emojiMeaningSource: e.semantics.emojiMeaningSource,
    actionTime: e.actionTime,
  }));
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
