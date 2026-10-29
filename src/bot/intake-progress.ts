import { CotPublisher, type CotClient } from './cot';

/** One progress owner per pending unit: merged inputs share it; active and
 * queued units never do. All network work is detached from queue ownership. */
export class IntakeProgress {
  private readonly entries = new Map<string, {
    publisher: CotPublisher;
    ready: Promise<void>;
    controller: AbortController;
  }>();

  ensure(key: string, options: {
    client: CotClient;
    chatId: string;
    scope: string;
    originMessageId: string;
    inputPreview: string;
    queued: boolean;
    onCreated(messageId: string): void;
    onFailed(kind: 'create' | 'update'): void;
  }): void {
    if (this.entries.has(key)) return;
    const controller = new AbortController();
    let failureReported = false;
    const fail = (kind: 'create' | 'update') => {
      if (failureReported || controller.signal.aborted) return;
      failureReported = true;
      options.onFailed(kind);
    };
    const publisher = new CotPublisher({
      ...options,
      runId: `intake-${options.originMessageId}`,
      initialStepName: options.queued ? '已收到，排队等待' : '已收到，正在准备',
      onDegraded: () => fail('update'),
    });
    const ready = publisher.start(controller.signal).then(() => {
      if (publisher.ref) options.onCreated(publisher.ref.messageId);
      if (publisher.disabled) fail(publisher.degradedReason ? 'update' : 'create');
    }).catch(() => fail('create'));
    this.entries.set(key, { publisher, ready, controller });
  }

  get(key: string | undefined) {
    return key ? this.entries.get(key) : undefined;
  }

  watchCancellation(key: string | undefined, signal: AbortSignal): () => void {
    if (!key) return () => {};
    const cancel = () => this.close(key);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    return () => signal.removeEventListener('abort', cancel);
  }

  close(key: string, reason: 'done' | 'error' = 'error'): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.controller.abort(reason);
    // A create/initial update can still be in flight. Close the late result,
    // without waiting here or replaying an already cancelled task's events.
    void entry.ready.then(() => entry.publisher.finish(reason)).catch(() => {});
  }

  closeAll(): void {
    for (const key of this.entries.keys()) this.close(key);
  }
}
