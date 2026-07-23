import type { AgentRun } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  /** Set when interrupted due to reaction revision supersede (not /stop). */
  superseded?: boolean;
}

export interface RunReservation {
  readonly scopeId: string;
  readonly signal: AbortSignal;
  release(): void;
}

interface ReservationState {
  controller: AbortController;
  released: boolean;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  private readonly reservations = new Map<string, ReservationState>();
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string): RunReservation | undefined {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return undefined;
    const state: ReservationState = {
      controller: new AbortController(),
      released: false,
    };
    this.reservations.set(chatId, state);
    return {
      scopeId: chatId,
      signal: state.controller.signal,
      release: () => {
        if (state.released) return;
        state.released = true;
        if (this.reservations.get(chatId) === state) this.reservations.delete(chatId);
      },
    };
  }

  register(chatId: string, run: AgentRun, reservation?: RunReservation): RunHandle {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    if (reservation?.signal.aborted) {
      throw new Error(`run reservation was interrupted for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    const handle: RunHandle = { run, interrupted: false };
    this.handles.set(chatId, handle);
    return handle;
  }

  pauseNewRuns(reason: string): () => void {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = undefined;
    };
  }

  newRunsPaused(): boolean {
    return this.pauseDepth > 0;
  }

  newRunsPauseReason(): string | undefined {
    return this.pauseReason;
  }

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  snapshot(): RunHandle[] {
    return [...this.handles.values()];
  }

  scopes(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId: string): boolean {
    let interrupted = false;
    const reservation = this.reservations.get(chatId);
    if (reservation) {
      this.reservations.delete(chatId);
      reservation.released = true;
      reservation.controller.abort();
      interrupted = true;
    }
    const h = this.handles.get(chatId);
    if (!h) return interrupted;
    h.interrupted = true;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    for (const reservation of this.reservations.values()) {
      reservation.released = true;
      reservation.controller.abort();
    }
    this.reservations.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = [...this.handles.values()];
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }
}
