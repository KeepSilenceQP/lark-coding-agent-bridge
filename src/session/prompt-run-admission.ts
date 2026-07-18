export type PromptRunAdmissionSource = 'im' | 'comment';

export interface PromptRunAdmissionInput {
  runId: string;
  source: PromptRunAdmissionSource;
}

export interface PromptRunAdmission {
  markIdentifierDurable(): void;
  trackIdentifierDurability(durability: Promise<void>): void;
  finishWithoutIdentifier(): void;
}

export interface PromptActivationLease {
  release(): void;
}

export class PromptRunAdmissionPaused extends Error {
  constructor() {
    super('group prompt activation is in progress');
    this.name = 'PromptRunAdmissionPaused';
  }
}

export class PromptActivationTimeout extends Error {
  constructor() {
    super('group prompt activation drainage timed out');
    this.name = 'PromptActivationTimeout';
  }
}

interface PendingAdmission {
  settled: Promise<void>;
  identifierObserved: boolean;
  settle(): void;
  fail(error: unknown): void;
}

export class PromptRunAdmissionController {
  private readonly pending = new Set<PendingAdmission>();
  private activationInProgress = false;

  admit(_input: PromptRunAdmissionInput): PromptRunAdmission {
    if (this.activationInProgress) throw new PromptRunAdmissionPaused();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    let done = false;
    const pending: PendingAdmission = {
      settled: new Promise<void>((r, j) => {
        resolve = r;
        reject = j;
      }),
      identifierObserved: false,
      settle: () => {
        if (done) return;
        done = true;
        this.pending.delete(pending);
        resolve();
      },
      fail: (error) => {
        if (done) return;
        done = true;
        reject(error);
      },
    };
    // A durability failure must remain observable to a later activation, but
    // it must not become an unhandled rejection while no activation is running.
    void pending.settled.catch(() => {});
    this.pending.add(pending);
    return {
      markIdentifierDurable: () => {
        pending.identifierObserved = true;
        pending.settle();
      },
      trackIdentifierDurability: (durability) => {
        if (pending.identifierObserved) return;
        pending.identifierObserved = true;
        void durability.then(pending.settle, pending.fail);
      },
      finishWithoutIdentifier: () => {
        if (!pending.identifierObserved) pending.settle();
      },
    };
  }

  async beginActivation(options: { timeoutMs?: number } = {}): Promise<PromptActivationLease> {
    if (this.activationInProgress) throw new PromptRunAdmissionPaused();
    this.activationInProgress = true;
    const admitted = [...this.pending];
    try {
      await waitForDrain(admitted, options.timeoutMs);
    } catch (error) {
      this.activationInProgress = false;
      throw error;
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activationInProgress = false;
      },
    };
  }
}

async function waitForDrain(
  admitted: PendingAdmission[],
  timeoutMs: number | undefined,
): Promise<void> {
  const drained = Promise.all(admitted.map((item) => item.settled)).then(() => undefined);
  if (timeoutMs === undefined) return drained;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      drained,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PromptActivationTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
