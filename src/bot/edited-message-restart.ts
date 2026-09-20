import { createHash } from 'node:crypto';
import type { NormalizedMessage } from '@larksuite/channel';
import type { RunExecution } from '../runtime/run-executor';
import type { ReplacementReservation, RunHandle } from './active-runs';
import type { PendingEditHold } from './pending-queue';
import { normalizeFetchedEditableMessage } from './quote';

export type EditedRunEligibility =
  | 'eligible'
  | 'not-sole-trigger'
  | 'unsupported-original'
  | 'thread-not-ready';

export interface RegisterEditedRunInput {
  scope: string;
  chatId: string;
  chatType: string;
  threadId?: string;
  messages: NormalizedMessage[];
  handle: RunHandle;
  execution?: RunExecution;
  cwdRealpath: string;
  policyFingerprint: string;
  codexThreadId?: string;
  workChainId: string;
  lifecycleUnitId: string;
}

export interface EditedRunRecord {
  state: 'active' | 'claimed' | 'ended';
  eligibility: EditedRunEligibility;
  messageId: string;
  authorId: string;
  chatId: string;
  chatType: string;
  threadId?: string;
  scope: string;
  originalMessage: NormalizedMessage;
  deliveredFingerprint: string;
  handle: RunHandle;
  execution?: RunExecution;
  cwdRealpath: string;
  policyFingerprint: string;
  codexThreadId?: string;
  workChainId: string;
  lifecycleUnitId: string;
  toolStartedEver: boolean;
}

/** Hash the exact normalized text delivered to Codex; raw message bodies are never retained. */
export function fingerprintEditedMessageText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function eligibilityFor(input: RegisterEditedRunInput, message: NormalizedMessage): EditedRunEligibility {
  if (input.messages.length !== 1) return 'not-sole-trigger';
  if (
    !isHumanMessage(message) ||
    (message.rawContentType !== 'text' && message.rawContentType !== 'post') ||
    message.resources.length > 0
  ) return 'unsupported-original';
  return input.codexThreadId ? 'eligible' : 'thread-not-ready';
}

/**
 * Process-memory ownership registry for edit restarts. All mutations compare the
 * exact RunHandle so delayed cleanup from a superseded run cannot affect its successor.
 */
export class EditedMessageRestartRegistry {
  private readonly records = new Map<string, EditedRunRecord>();
  private readonly inFlight = new Map<string, Promise<EditedMessageRestartOutcome>>();
  private readonly consumed = new Map<string, true>();
  private readonly maxRetained: number;

  constructor(options: { maxRetained?: number } = {}) {
    this.maxRetained = Math.max(8, options.maxRetained ?? 256);
  }

  registerRun(input: RegisterEditedRunInput): void {
    for (const message of input.messages) {
      if (!isHumanMessage(message)) continue;
      const { raw: _raw, ...safeMessage } = message;
      this.records.set(message.messageId, {
        state: 'active',
        eligibility: eligibilityFor(input, message),
        messageId: message.messageId,
        authorId: message.senderId,
        chatId: input.chatId,
        chatType: input.chatType,
        threadId: input.threadId,
        scope: input.scope,
        originalMessage: safeMessage,
        deliveredFingerprint: fingerprintEditedMessageText(message.content),
        handle: input.handle,
        execution: input.execution,
        cwdRealpath: input.cwdRealpath,
        policyFingerprint: input.policyFingerprint,
        codexThreadId: input.codexThreadId,
        workChainId: input.workChainId,
        lifecycleUnitId: input.lifecycleUnitId,
        toolStartedEver: false,
      });
      this.pruneEnded();
    }
  }

  get(messageId: string): EditedRunRecord | undefined {
    return this.records.get(messageId);
  }

  markThreadDurable(handle: RunHandle, codexThreadId: string): boolean {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.state !== 'active' || record.handle !== handle) continue;
      record.codexThreadId = codexThreadId;
      if (record.eligibility === 'thread-not-ready') record.eligibility = 'eligible';
      changed = true;
    }
    return changed;
  }

  markToolStarted(handle: RunHandle): void {
    for (const record of this.records.values()) {
      if (record.state !== 'ended' && record.handle === handle) record.toolStartedEver = true;
    }
  }

  markTerminal(handle: RunHandle): void {
    for (const record of this.records.values()) {
      if (record.state !== 'ended' && record.handle === handle) record.state = 'ended';
    }
    this.pruneEnded();
  }

  claim(record: EditedRunRecord): boolean {
    if (this.records.get(record.messageId) !== record || record.state !== 'active') return false;
    record.state = 'claimed';
    return true;
  }

  releaseClaim(record: EditedRunRecord): void {
    if (this.records.get(record.messageId) === record && record.state === 'claimed') {
      record.state = 'active';
    }
  }

  runExclusive(
    messageId: string,
    transaction: () => Promise<EditedMessageRestartOutcome>,
  ): Promise<EditedMessageRestartOutcome> {
    const existing = this.inFlight.get(messageId);
    if (existing) return existing;
    const promise = transaction().finally(() => {
      if (this.inFlight.get(messageId) === promise) this.inFlight.delete(messageId);
    });
    this.inFlight.set(messageId, promise);
    return promise;
  }

  inFlightFor(messageId: string): Promise<EditedMessageRestartOutcome> | undefined {
    return this.inFlight.get(messageId);
  }

  isConsumed(key: string): boolean {
    return this.consumed.has(key);
  }

  consume(key: string): void {
    this.consumed.delete(key);
    this.consumed.set(key, true);
    while (this.consumed.size > this.maxRetained) {
      const oldest = this.consumed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.consumed.delete(oldest);
    }
  }

  private pruneEnded(): void {
    const ended = [...this.records.entries()].filter(([, record]) => record.state === 'ended');
    for (const [messageId] of ended.slice(0, Math.max(0, ended.length - this.maxRetained))) {
      this.records.delete(messageId);
    }
  }
}

function isHumanMessage(message: NormalizedMessage): boolean {
  if (message.senderType === 'user') return true;
  const rawSender = (message.raw as { sender?: { sender_type?: unknown } } | undefined)
    ?.sender?.sender_type;
  return rawSender === 'user';
}

export type EditedMessageRestartResultCode =
  | 'ignored'
  | 'no-edit'
  | 'original-ended'
  | 'not-sole-trigger'
  | 'unsupported-original'
  | 'thread-not-ready'
  | 'latest-unreadable'
  | 'latest-invalid'
  | 'window-closed'
  | 'stop-not-confirmed'
  | 'corrected-start-failed'
  | 'started';

export interface EditedMessageRestartOutcome {
  handled: boolean;
  code: EditedMessageRestartResultCode;
}

interface EditedRestartEvent {
  messageId: string;
  operator: { openId: string };
  emojiType: string;
  action: 'added' | 'removed';
}

export interface EditedMessageCorrectionSnapshot {
  messageId: string;
  revision: string;
  fingerprint: string;
  text: string;
}

export interface MaterializedEditedMessageCorrection extends EditedMessageCorrectionSnapshot {
  oldRunStartedTool: boolean;
}

export interface EditedMessageRestartControlDeps<TPrepared = unknown> {
  enabled: boolean;
  botOpenId?: string;
  registry: EditedMessageRestartRegistry;
  activeRuns: {
    get(scope: string): RunHandle | undefined;
    reserveReplacement(scope: string, handle: RunHandle): ReplacementReservation | undefined;
  };
  pending: { acquireEditHold(scope: string): PendingEditHold };
  channel: {
    botIdentity?: { openId: string; name: string };
    fetchRawMessage(messageId: string): Promise<import('@larksuite/channel').ApiMessageItem[]>;
    send(chatId: string, content: { markdown: string }, options: { replyTo: string; replyInThread?: boolean }): Promise<unknown>;
  };
  checkAccess(record: EditedRunRecord): boolean;
  prepare(
    record: EditedRunRecord,
    corrected: EditedMessageCorrectionSnapshot,
  ): Promise<{ ok: true; prepared: TPrepared } | { ok: false }>;
  materializePrepared(
    record: EditedRunRecord,
    corrected: MaterializedEditedMessageCorrection,
    prepared: TPrepared,
  ): TPrepared;
  startCorrected(input: {
    record: EditedRunRecord;
    corrected: MaterializedEditedMessageCorrection;
    prepared: TPrepared;
    replacement: ReplacementReservation;
    hold: PendingEditHold;
  }): Promise<{ ok: true; completion: Promise<void> } | { ok: false }>;
}

const FEEDBACK: Record<Exclude<EditedMessageRestartResultCode, 'ignored' | 'started'>, string> = {
  'no-edit': '没有检测到消息内容变化，当前运行保持不变。',
  'original-ended': '原运行已经结束，消息修正窗口已关闭。',
  'not-sole-trigger': '这条消息不是当前运行的唯一触发消息，无法单独修正重启。',
  'unsupported-original': '当前消息类型或附件不支持修正重启。',
  'thread-not-ready': '当前 Codex thread 尚未就绪，未停止运行。',
  'latest-unreadable': '无法读取修改后的最新消息，当前运行保持不变。',
  'latest-invalid': '修改后的消息类型、附件或会话位置不受支持，当前运行保持不变。',
  'window-closed': '原运行已经结束或已被替换，消息修正窗口已关闭。',
  'stop-not-confirmed': '无法确认原运行已停止，因此没有启动修正后的运行。',
  'corrected-start-failed': '原运行已停止，但修正后的运行启动失败。请重新发送消息。',
};

export async function handleEditedMessageRestartReaction<TPrepared>(
  event: EditedRestartEvent,
  deps: EditedMessageRestartControlDeps<TPrepared>,
): Promise<EditedMessageRestartOutcome> {
  if (!deps.enabled || event.emojiType !== 'Loudspeaker') return { handled: false, code: 'ignored' };
  if (event.action === 'removed') return { handled: true, code: 'ignored' };
  if (event.action !== 'added' || event.operator.openId === deps.botOpenId) {
    return { handled: true, code: 'ignored' };
  }
  const record = deps.registry.get(event.messageId);
  if (!record || event.operator.openId !== record.authorId || !deps.checkAccess(record)) {
    return { handled: true, code: 'ignored' };
  }
  const existingTransaction = deps.registry.inFlightFor(event.messageId);
  if (existingTransaction) return existingTransaction;
  if (record.state === 'ended') return reply('original-ended', record, deps);
  if (record.state !== 'active') {
    return deps.registry.runExclusive(event.messageId, () => reply('window-closed', record, deps));
  }
  if (record.eligibility !== 'eligible') return reply(record.eligibility, record, deps);
  if (!record.execution) return reply('thread-not-ready', record, deps);
  if (deps.activeRuns.get(record.scope) !== record.handle) {
    return reply('original-ended', record, deps);
  }
  const oldExecution = record.execution;

  return deps.registry.runExclusive(event.messageId, async () => {
    let items: import('@larksuite/channel').ApiMessageItem[];
    try {
      items = await deps.channel.fetchRawMessage(event.messageId);
    } catch {
      return reply('latest-unreadable', record, deps);
    }
    const normalized = await normalizeFetchedEditableMessage(deps.channel, items, {
      messageId: record.messageId,
      chatId: record.chatId,
      chatType: record.chatType === 'p2p' ? 'p2p' : 'group',
      threadId: record.threadId,
      authorId: record.authorId,
    });
    if (!normalized.ok) {
      const code = normalized.reason === 'malformed' ? 'latest-unreadable' : 'latest-invalid';
      return reply(code, record, deps);
    }
    const fingerprint = fingerprintEditedMessageText(normalized.snapshot.text);
    if (fingerprint === record.deliveredFingerprint) return reply('no-edit', record, deps);
    const correctionKey = fingerprintEditedMessageText(
      `${record.messageId}\x1f${normalized.snapshot.revision}\x1f${fingerprint}`,
    );
    if (deps.registry.isConsumed(correctionKey)) return reply('no-edit', record, deps);
    if (!deps.checkAccess(record)) return { handled: true, code: 'ignored' };
    if (deps.activeRuns.get(record.scope) !== record.handle) {
      return reply('window-closed', record, deps);
    }
    const correctedSnapshot = {
      messageId: record.messageId,
      revision: normalized.snapshot.revision,
      fingerprint,
      text: normalized.snapshot.text,
    };
    let prepared: Awaited<ReturnType<typeof deps.prepare>>;
    try {
      prepared = await deps.prepare(record, correctedSnapshot);
    } catch {
      return reply('window-closed', record, deps);
    }
    if (!prepared.ok) return reply('window-closed', record, deps);

    // No await between these ownership primitives: pending cannot drain into
    // the scope while the exact active handle is being claimed.
    const hold = deps.pending.acquireEditHold(record.scope);
    const replacement = deps.activeRuns.reserveReplacement(record.scope, record.handle);
    if (!replacement) {
      hold.release();
      return reply('window-closed', record, deps);
    }
    if (!replacement.revalidate() || !deps.registry.claim(record)) {
      replacement.release();
      hold.release();
      return reply('window-closed', record, deps);
    }
    if (!replacement.beginStop()) {
      deps.registry.releaseClaim(record);
      replacement.release();
      hold.release();
      return reply('window-closed', record, deps);
    }
    record.handle.superseded = true;
    let exited = false;
    try {
      exited = await oldExecution.stopAndConfirmExit();
    } catch {
      exited = false;
    }
    if (!exited) {
      // Fail closed: a stream ending is not proof that the old OS process has
      // exited. Keep the exact replacement gate and pending hold until the
      // executor observes authoritative process exit; this reaction does not
      // auto-start a corrected run after its confirmation window timed out.
      void oldExecution.waitForConfirmedExit().then(
        () => {
          replacement.confirmExit();
          replacement.release();
          deps.registry.markTerminal(record.handle);
          hold.release();
        },
        () => {
          // Unknown exit state remains fail-closed: retain ownership and hold.
        },
      );
      return reply('stop-not-confirmed', record, deps);
    }
    if (!replacement.confirmExit()) {
      deps.registry.releaseClaim(record);
      replacement.release();
      hold.release();
      return reply('stop-not-confirmed', record, deps);
    }

    // Tool activity stays monotonic until authoritative exit. Only now is it
    // safe to merge the drained executor observation and freeze the corrected
    // prompt consumed by the successor adapter.
    record.toolStartedEver ||= oldExecution.toolStartedEver();
    const corrected: MaterializedEditedMessageCorrection = {
      ...correctedSnapshot,
      oldRunStartedTool: record.toolStartedEver,
    };
    let materializedPrepared: TPrepared;
    try {
      materializedPrepared = deps.materializePrepared(record, corrected, prepared.prepared);
    } catch {
      replacement.release();
      hold.release();
      return reply('corrected-start-failed', record, deps);
    }

    let started: Awaited<ReturnType<typeof deps.startCorrected>>;
    try {
      started = await deps.startCorrected({
        record,
        corrected,
        prepared: materializedPrepared,
        replacement,
        hold,
      });
    } catch {
      started = { ok: false };
    }
    if (!started.ok) {
      replacement.release();
      hold.release();
      return reply('corrected-start-failed', record, deps);
    }
    deps.registry.consume(correctionKey);
    void started.completion.then(
      () => hold.release(),
      () => hold.release(),
    );
    const warning = record.toolStartedEver
      ? ' 注意：原运行已经启动过工具，之前产生的副作用可能仍然存在，并未自动回滚。'
      : '';
    await sendFeedback(record, deps, `已停止原运行，并使用修改后的完整消息启动了新的 Codex turn。${warning}`);
    return { handled: true, code: 'started' };
  });
}

async function reply<TPrepared>(
  code: Exclude<EditedMessageRestartResultCode, 'ignored' | 'started'>,
  record: EditedRunRecord,
  deps: EditedMessageRestartControlDeps<TPrepared>,
): Promise<EditedMessageRestartOutcome> {
  await sendFeedback(record, deps, FEEDBACK[code]);
  return { handled: true, code };
}

async function sendFeedback<TPrepared>(
  record: EditedRunRecord,
  deps: EditedMessageRestartControlDeps<TPrepared>,
  markdown: string,
): Promise<void> {
  try {
    await deps.channel.send(record.chatId, { markdown }, {
      replyTo: record.messageId,
      ...(record.threadId ? { replyInThread: true } : {}),
    });
  } catch {
    // Feedback is best-effort and must never mutate the control transaction.
  }
}
