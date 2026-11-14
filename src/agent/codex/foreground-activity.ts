import type { CodexTurnState, CodexTurnStateProbe } from './turn-state-probe';
import { log } from '../../core/logger';

const TOOL_SILENCE_MS = 65 * 60_000;
const MAX_CHILDREN = 8;

interface ChildProgress {
  token: string;
  lastProgressAt: number;
  hasRunningTool: boolean;
  active: boolean;
}

/** Per-run fallback for runtimes that finish a spawn item before its foreground child. */
export class CodexForegroundActivity {
  private parentTurnId: string | undefined;
  private children = new Map<string, ChildProgress>();
  private readonly observations = new Map<string, ChildProgress>();
  private pending: Promise<CodexTurnState | undefined> | undefined;
  private closed = false;
  private completedAt: number | undefined;
  private parentToken: string | undefined;
  private parentProgressAt: number | undefined;
  private diagnosticToken: string | undefined;

  constructor(
    private readonly probe: CodexTurnStateProbe,
    private threadId: string | undefined,
    private readonly baselineTurnId: string | undefined,
  ) {}

  setThreadId(threadId: string): void {
    if (!this.threadId) this.threadId = threadId;
    else if (threadId !== this.threadId) this.close();
  }

  close(): void {
    this.closed = true;
    this.children.clear();
    this.observations.clear();
  }

  read(): Promise<CodexTurnState | undefined> {
    if (this.closed || !this.threadId) return Promise.resolve(undefined);
    if (!this.pending) {
      this.pending = this.readCurrent().finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  async check(idleTimeoutMs: number): Promise<{ remainingMs: number; timeoutMs: number } | undefined> {
    await this.read();
    if (this.closed) return undefined;
    // Leave time for the existing terminal recovery to deliver a persisted
    // parent final; an idle check itself must never manufacture completion.
    if (this.completedAt !== undefined) {
      return this.reportCheck({ remainingMs: this.completedAt + idleTimeoutMs - Date.now(), timeoutMs: idleTimeoutMs }, 'parent-completed');
    }
    let deadline: { remainingMs: number; timeoutMs: number } | undefined;
    const observed = [...this.children.values()];
    const active = observed.filter((child) => child.active);
    if (!active.length && this.parentProgressAt !== undefined) {
      const remainingMs = this.parentProgressAt + idleTimeoutMs - Date.now();
      if (remainingMs > 0) return this.reportCheck({ remainingMs, timeoutMs: idleTimeoutMs }, 'parent-progress');
    }
    // Finished older children must not shorten a newer foreground wait.
    for (const child of active.length ? active : observed) {
      const timeoutMs = child.hasRunningTool ? TOOL_SILENCE_MS : idleTimeoutMs;
      const remainingMs = child.lastProgressAt + timeoutMs - Date.now();
      if (!deadline || remainingMs < deadline.remainingMs) deadline = { remainingMs, timeoutMs };
    }
    return this.reportCheck(deadline, deadline ? 'child-progress' : 'no-verified-activity');
  }

  private reportCheck(
    result: { remainingMs: number; timeoutMs: number } | undefined,
    reason: string,
  ): typeof result {
    log.info('agent', 'idle-activity-check', {
      threadId: this.threadId, turnId: this.parentTurnId, childCount: this.children.size,
      parentProgressAt: this.parentProgressAt, remainingMs: result?.remainingMs, reason,
    });
    return result;
  }

  private reportParent(parent: CodexTurnState | undefined, reason: string): void {
    const token = JSON.stringify([parent?.id, parent?.status, parent?.foregroundCandidateCount,
      parent?.foregroundChildThreadIds, reason]);
    if (token === this.diagnosticToken) return;
    log.info('agent', 'foreground-probe', {
      threadId: this.threadId, turnId: parent?.id, turnStatus: parent?.status,
      candidateCount: parent?.foregroundCandidateCount ?? 0,
      verifiedCount: parent?.foregroundChildThreadIds?.length ?? 0, reason,
    });
    this.diagnosticToken = token;
  }

  private async readCurrent(): Promise<CodexTurnState | undefined> {
    const threadId = this.threadId!;
    const parent = await this.probe(threadId);
    if (this.closed) return undefined;
    if (parent && parent.id !== this.baselineTurnId &&
        (!this.parentTurnId || parent.id === this.parentTurnId) && parent.status === 'completed') {
      this.reportParent(parent, 'parent-completed');
      this.completedAt ??= Date.now();
      this.children.clear();
      return parent;
    }
    this.completedAt = undefined;
    if (!parent || parent.id === this.baselineTurnId || parent.status !== 'inProgress' ||
        (this.parentTurnId && parent.id !== this.parentTurnId)) {
      this.reportParent(parent, !parent ? 'no-parent-state' : parent.id === this.baselineTurnId ?
        'baseline-turn' : parent.status !== 'inProgress' ? 'parent-not-running' : 'different-parent-turn');
      this.children.clear();
      this.parentToken = undefined;
      this.parentProgressAt = undefined;
      return parent;
    }
    this.parentTurnId = parent.id;
    const token = JSON.stringify([parent.itemCount, parent.progressToken]);
    if (this.parentToken !== undefined && token !== this.parentToken) this.parentProgressAt = Date.now();
    this.parentToken = token;
    this.reportParent(parent, parent.foregroundProbeReason ??
      (parent.foregroundChildThreadIds?.length ? 'api-links' : 'no-foreground-links'));
    // Bound probe work without letting completed spawn history crowd out the
    // most recent foreground children in a long parent turn.
    const ids = [...new Set(parent.foregroundChildThreadIds ?? [])].slice(-MAX_CHILDREN);
    const states = await Promise.all(ids.map(async (id) => {
      try { return { id, state: await this.probe(id) }; }
      catch { return { id, state: undefined }; }
    }));
    if (this.closed) return undefined;
    const next = new Map<string, ChildProgress>();
    for (const { id, state } of states) {
      if (!state || (state.parentThreadId !== threadId &&
          !(state.parentThreadId === undefined && parent.foregroundLinkSource === 'legacy-rollout'))) {
        log.info('agent', 'foreground-child-skipped', {
          threadId, childThreadId: id, reason: state ? 'parent-mismatch' : 'probe-unavailable',
        });
        continue;
      }
      const previous = this.observations.get(id);
      // Initial completed history is not fresh activity. An observed transition
      // to completion gives the parent its normal idle interval to continue.
      if (!previous && state.status !== 'inProgress') continue;
      const token = JSON.stringify([state.id, state.status, state.itemCount, state.progressToken]);
      const progress = {
        token,
        lastProgressAt: previous?.token === token ? previous.lastProgressAt : Date.now(),
        hasRunningTool: state.status === 'inProgress' && state.hasRunningTool === true,
        active: state.status === 'inProgress',
      };
      next.set(id, progress);
      this.observations.set(id, progress);
    }
    this.children = next;
    return parent;
  }
}
