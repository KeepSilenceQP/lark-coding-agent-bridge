/** Coalesce ordered progress writes without blocking agent event consumption. */
export function createProgressRenderer<T>(render: (state: T) => Promise<void>) {
  let pending: { state: T } | undefined;
  let active: Promise<void> | undefined;
  let stopped = false;
  let failed = false;
  let failure: unknown;
  const drain = async () => {
    while (!stopped && pending) {
      const { state } = pending;
      pending = undefined;
      try { await render(state); }
      catch (err) { failed = true; failure = err; stopped = true; pending = undefined; }
    }
  };
  return {
    enqueue(state: T): void {
      if (stopped) return;
      pending = { state };
      if (!active) active = drain().finally(() => {
        active = undefined;
        if (pending && !stopped) this.enqueue(pending.state);
      });
    },
    async settle(): Promise<void> {
      while (active) await active;
      if (failed) throw failure;
    },
    abandon(): void { stopped = true; pending = undefined; },
  };
}
