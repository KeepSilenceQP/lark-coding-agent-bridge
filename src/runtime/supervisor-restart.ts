import type { LarkChannel } from '@larksuite/channel';

interface Participant {
  isIdle(): boolean;
  pause(): () => void;
}

/** One service restart waits for every hosted channel, including queued work. */
export class SupervisorRestartBarrier {
  private participants = new Set<Participant>();
  private events = 0;
  private launch: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private launching = false;
  private failed = new Set<() => void>();
  private resume: Array<() => void> = [];

  constructor(private onError: (error: unknown) => void = () => {}) {}

  isRestarting(): boolean { return this.launching || this.disposed; }

  register(participant: Participant): () => void {
    if (this.isRestarting()) throw new Error('supervisor restart has closed profile admission');
    this.participants.add(participant);
    return () => this.participants.delete(participant);
  }

  enter(): (() => void) | undefined {
    if (this.launching || this.disposed) return undefined;
    this.events++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.events--;
      this.check();
    };
  }

  request(launch: () => void, onFailure: () => void = () => {}): void {
    if (this.disposed || this.launching) return;
    this.launch ??= launch;
    this.failed.add(onFailure);
    // Also observe work started outside IM handlers, e.g. meeting agents.
    this.timer ??= setInterval(() => this.check(), 500);
    this.timer.unref();
    this.check();
  }

  check(): void {
    if (!this.launch || this.disposed || this.launching || this.events !== 0) return;
    if ([...this.participants].some((p) => !p.isIdle())) return;
    // No await between the idle check, admission closure, and helper launch.
    this.launching = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      for (const participant of this.participants) this.resume.push(participant.pause());
      this.launch();
    } catch (error) {
      this.fail(error);
    } finally {
      this.launch = undefined;
    }
  }

  fail(error: unknown): void {
    if (this.disposed || !this.launching) return;
    this.launching = false;
    for (const release of this.resume.splice(0)) release();
    for (const failed of this.failed) failed();
    this.failed.clear();
    this.onError(error);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.launch = undefined;
    this.failed.clear();
    this.resume = [];
  }
}

type Handlers = Parameters<LarkChannel['on']>[0];

export function guardSupervisorHandlers(
  handlers: Handlers,
  barrier: SupervisorRestartBarrier | undefined,
  onRejected: (name: string, args: unknown[]) => Promise<unknown>,
): Handlers {
  if (!barrier) return handlers;
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name,
    async (...args: unknown[]) => {
      const leave = barrier.enter();
      if (!leave) return onRejected(name, args);
      try {
        return await (handler as (...args: unknown[]) => unknown)(...args);
      } finally {
        leave();
      }
    },
  ])) as Handlers;
}
