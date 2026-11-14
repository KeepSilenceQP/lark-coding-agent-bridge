import type { CodexTurnState, CodexTurnStateProbe } from './turn-state-probe';

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
      return { remainingMs: this.completedAt + idleTimeoutMs - Date.now(), timeoutMs: idleTimeoutMs };
    }
    let deadline: { remainingMs: number; timeoutMs: number } | undefined;
    const observed = [...this.children.values()];
    const active = observed.filter((child) => child.active);
    // Finished older children must not shorten a newer foreground wait.
    for (const child of active.length ? active : observed) {
      const timeoutMs = child.hasRunningTool ? TOOL_SILENCE_MS : idleTimeoutMs;
      const remainingMs = child.lastProgressAt + timeoutMs - Date.now();
      if (!deadline || remainingMs < deadline.remainingMs) deadline = { remainingMs, timeoutMs };
    }
    return deadline;
  }

  private async readCurrent(): Promise<CodexTurnState | undefined> {
    const threadId = this.threadId!;
    const parent = await this.probe(threadId);
    if (this.closed) return undefined;
    if (parent && parent.id !== this.baselineTurnId &&
        (!this.parentTurnId || parent.id === this.parentTurnId) && parent.status === 'completed') {
      this.completedAt ??= Date.now();
      this.children.clear();
      return parent;
    }
    this.completedAt = undefined;
    if (!parent || parent.id === this.baselineTurnId || parent.status !== 'inProgress' ||
        (this.parentTurnId && parent.id !== this.parentTurnId)) {
      this.children.clear();
      return parent;
    }
    this.parentTurnId = parent.id;
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
      if (!state || state.parentThreadId !== threadId) continue;
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
