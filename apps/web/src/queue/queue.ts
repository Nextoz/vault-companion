// Client pending queue (commands.md#client-pending-queue-pwa).
//
// Guarantees:
// - an envelope is persisted before its first send, and every attempt sends the stored bytes unchanged;
// - an item is sent only while the confirmed session's accountKey equals the item's accountKey;
// - items for the same task go FIFO, and a dependent (Undo) waits for its predecessor's receipt or terminal
//   refusal; an Undo of a never-sent completion cancels both locally (F4);
// - nothing is dropped except on receipt or explicit user discard. No retry limit.
import type { Command, CommandType, CompleteTaskCommand, Receipt } from '@vault-companion/contracts';
import { backoffMs, classify, type Outcome } from './classify.ts';
import type { PendingError, PendingRecord, PendingStore } from './db.ts';

export type ItemState = 'pending' | 'saving' | 'saved' | 'attention';

export interface QueueItem {
  operationId: string;
  seq: number;
  type: CommandType;
  envelope: Command;
  label: string;
  taskKey: string | null;
  state: ItemState;
  error: PendingError | null;
  everSent: boolean;
  /** Created under another account than the current session: never sent, needs attention. */
  accountMismatch: boolean;
  receipt: Receipt | null;
}

export interface QueueSnapshot {
  items: readonly QueueItem[];
  signedOut: boolean;
}

export interface EnqueueOptions {
  accountKey: string;
  label: string;
  taskKey?: string | null;
  dependsOn?: string | null;
}

export interface QueueOptions {
  store: PendingStore;
  /** POST the given body; must use `redirect: 'manual'` so an expired session is detectable. */
  send: (body: string) => Promise<Response>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  onReceipt?: (receipt: Receipt, envelope: Command) => void;
}

const ACCOUNT_MISMATCH: PendingError = {
  code: 'account-mismatch',
  message: 'Saved on this device under a different account. It will not be sent.',
};

const MAX_SAVED = 20;

export class PendingQueue {
  readonly #store: PendingStore;
  readonly #send: QueueOptions['send'];
  readonly #now: () => number;
  readonly #setTimer: NonNullable<QueueOptions['setTimer']>;
  readonly #onReceipt: QueueOptions['onReceipt'];

  readonly #records = new Map<string, PendingRecord>();
  readonly #envelopes = new Map<string, Command>();
  readonly #inFlight = new Set<string>();
  readonly #saved = new Map<string, QueueItem>();
  readonly #listeners = new Set<() => void>();

  #accountKey: string | null = null;
  #signedOut = false;
  #lock: Promise<unknown> = Promise.resolve();
  #flushing: Promise<void> | null = null;
  #flushAgain = false;
  #cancelTimer: (() => void) | null = null;
  #snapshot: QueueSnapshot = { items: [], signedOut: false };

  private constructor(options: QueueOptions) {
    this.#store = options.store;
    this.#send = options.send;
    this.#now = options.now ?? Date.now;
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
    this.#onReceipt = options.onReceipt;
  }

  static async open(options: QueueOptions): Promise<PendingQueue> {
    const queue = new PendingQueue(options);
    for (const record of await options.store.all()) queue.#remember(record);
    queue.#emit();
    return queue;
  }

  // ---- observation -------------------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): QueueSnapshot => this.#snapshot;

  // ---- session -----------------------------------------------------------------------------------------------

  /** A confirmed `/api/session`: sending resumes for items bound to this account. */
  setSession(accountKey: string): void {
    this.#accountKey = accountKey;
    this.#signedOut = false;
    this.#emit();
    void this.flush();
  }

  /** The session is gone (401, opaque redirect, Access 403): pause until `setSession`. */
  setSignedOut(): void {
    this.#signedOut = true;
    this.#emit();
  }

  // ---- user actions ------------------------------------------------------------------------------------------

  /** Persists the envelope, then schedules a send. Resolves once the item is durable on the device. */
  async enqueue(envelope: Command, options: EnqueueOptions): Promise<void> {
    await this.#exclusive(() => this.#enqueueLocked(envelope, options));
    void this.flush();
  }

  /**
   * Undo a completion (F4). If the completion never left the device, both are dropped locally
   * (`'cancelled'`). Otherwise the Undo is a real command queued behind its completion (`'queued'`).
   */
  async undoCompletion(
    target: CompleteTaskCommand,
    undo: Command,
    options: Omit<EnqueueOptions, 'dependsOn'>,
  ): Promise<'cancelled' | 'queued'> {
    const result = await this.#exclusive(async () => {
      const predecessor = this.#records.get(target.operationId);
      if (predecessor && !predecessor.everSent && !this.#inFlight.has(predecessor.operationId)) {
        await this.#store.delete(predecessor.operationId);
        this.#forget(predecessor.operationId);
        this.#emit();
        return 'cancelled' as const;
      }
      await this.#enqueueLocked(undo, { ...options, dependsOn: predecessor ? predecessor.operationId : null });
      return 'queued' as const;
    });
    if (result === 'queued') void this.flush();
    return result;
  }

  /** User "Retry" on an item that needs attention: same envelope, immediately. */
  async retry(operationId: string): Promise<void> {
    await this.#exclusive(async () => {
      const record = this.#records.get(operationId);
      if (!record) return;
      await this.#persist({ ...record, state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null });
    });
    void this.flush();
  }

  /** User "Discard". Refused while a request for the item is in flight (its outcome is unknown). */
  async discard(operationId: string): Promise<boolean> {
    return this.#exclusive(async () => {
      if (this.#inFlight.has(operationId)) return false;
      await this.#store.delete(operationId);
      this.#forget(operationId);
      this.#emit();
      return true;
    });
  }

  /** Drop "Saved to GitHub" entries the UI no longer needs to show. */
  forgetSaved(operationIds: Iterable<string>): void {
    let changed = false;
    for (const id of operationIds) changed = this.#saved.delete(id) || changed;
    if (changed) this.#emit();
  }

  /** `online`, focus, start: try now, skipping any backoff wait. */
  async kick(): Promise<void> {
    await this.#exclusive(async () => {
      for (const record of this.#records.values()) {
        if (record.state === 'pending' && record.nextAttemptAt > 0) {
          this.#records.set(record.operationId, { ...record, nextAttemptAt: 0 });
        }
      }
    });
    await this.flush();
  }

  dispose(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#listeners.clear();
  }

  // ---- sending -----------------------------------------------------------------------------------------------

  /** Sends every eligible item, one at a time, until none is eligible. Concurrent calls coalesce. */
  flush(): Promise<void> {
    if (this.#flushing) {
      this.#flushAgain = true;
      return this.#flushing;
    }
    this.#flushing = (async () => {
      try {
        do {
          this.#flushAgain = false;
          for (;;) {
            const claimed = await this.#exclusive(() => this.#claimNext());
            if (!claimed) break;
            const outcome = await this.#attempt(claimed);
            await this.#exclusive(() => this.#settle(claimed, outcome));
            if (outcome.kind === 'signed-out') break;
          }
        } while (this.#flushAgain && !this.#signedOut);
      } finally {
        this.#flushing = null;
        this.#scheduleWake();
      }
    })();
    return this.#flushing;
  }

  async #claimNext(): Promise<PendingRecord | null> {
    if (this.#signedOut || this.#accountKey === null) return null;
    const now = this.#now();
    const blocked = new Set<string>();
    for (const record of this.#ordered()) {
      const blocks = () => {
        if (record.taskKey !== null) blocked.add(record.taskKey);
      };
      if (record.accountKey !== this.#accountKey) {
        blocks();
        continue;
      }
      if (record.taskKey !== null && blocked.has(record.taskKey)) continue;
      // A terminal refusal is final for automatic sending and releases its successors.
      if (record.state === 'attention') continue;
      if (this.#inFlight.has(record.operationId)) {
        blocks();
        continue;
      }
      if (record.dependsOn !== null) {
        const predecessor = this.#records.get(record.dependsOn);
        if (predecessor && predecessor.state !== 'attention') {
          blocks();
          continue;
        }
      }
      if (record.nextAttemptAt > now) {
        blocks();
        continue;
      }
      // Mark before the request leaves: from here on its effect may exist in Git.
      const claimed: PendingRecord = { ...record, everSent: true };
      await this.#persist(claimed);
      this.#inFlight.add(claimed.operationId);
      this.#emit();
      return claimed;
    }
    return null;
  }

  async #attempt(record: PendingRecord): Promise<Outcome> {
    try {
      return await classify(await this.#send(record.body));
    } catch {
      return { kind: 'retry', error: { code: 'network', message: 'No connection. Will retry.' } };
    }
  }

  async #settle(sent: PendingRecord, outcome: Outcome): Promise<void> {
    this.#inFlight.delete(sent.operationId);
    const record = this.#records.get(sent.operationId) ?? sent;
    switch (outcome.kind) {
      case 'receipt': {
        await this.#store.delete(record.operationId);
        const envelope = this.#envelopeOf(record);
        this.#forget(record.operationId);
        this.#saved.set(record.operationId, {
          ...this.#itemOf(record, envelope),
          state: 'saved',
          error: null,
          receipt: outcome.receipt,
        });
        while (this.#saved.size > MAX_SAVED) this.#saved.delete(this.#saved.keys().next().value as string);
        this.#emit();
        this.#onReceipt?.(outcome.receipt, envelope);
        return;
      }
      case 'attention':
        await this.#persist({ ...record, state: 'attention', lastError: outcome.error });
        return;
      case 'retry': {
        const attempts = record.attempts + 1;
        await this.#persist({
          ...record,
          state: 'pending',
          attempts,
          nextAttemptAt: this.#now() + backoffMs(attempts),
          lastError: outcome.error,
        });
        return;
      }
      case 'signed-out':
        this.#signedOut = true;
        await this.#persist({ ...record, state: 'pending' });
        return;
    }
  }

  #scheduleWake(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    if (this.#signedOut || this.#accountKey === null) return;
    let next = Infinity;
    for (const r of this.#records.values()) {
      if (r.state === 'pending' && r.accountKey === this.#accountKey && r.nextAttemptAt > 0) {
        next = Math.min(next, r.nextAttemptAt);
      }
    }
    if (next === Infinity) return;
    this.#cancelTimer = this.#setTimer(() => void this.flush(), Math.max(0, next - this.#now()));
  }

  // ---- internals ---------------------------------------------------------------------------------------------

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => undefined);
    return run;
  }

  async #enqueueLocked(envelope: Command, options: EnqueueOptions): Promise<void> {
    if (this.#records.has(envelope.operationId)) return;
    const last = this.#ordered().at(-1);
    const now = this.#now();
    await this.#persist({
      operationId: envelope.operationId,
      seq: Math.max(now, (last?.seq ?? 0) + 1),
      type: envelope.type,
      body: JSON.stringify(envelope),
      accountKey: options.accountKey,
      taskKey: options.taskKey ?? null,
      dependsOn: options.dependsOn ?? null,
      everSent: false,
      attempts: 0,
      nextAttemptAt: 0,
      state: 'pending',
      lastError: null,
      label: options.label,
      createdAt: now,
    });
  }

  async #persist(record: PendingRecord): Promise<void> {
    await this.#store.put(record);
    this.#remember(record);
    this.#emit();
  }

  #remember(record: PendingRecord): void {
    this.#records.set(record.operationId, record);
  }

  #forget(operationId: string): void {
    this.#records.delete(operationId);
    this.#envelopes.delete(operationId);
  }

  #ordered(): PendingRecord[] {
    return [...this.#records.values()].sort((a, b) => a.seq - b.seq);
  }

  #envelopeOf(record: PendingRecord): Command {
    let envelope = this.#envelopes.get(record.operationId);
    if (!envelope) {
      envelope = JSON.parse(record.body) as Command;
      this.#envelopes.set(record.operationId, envelope);
    }
    return envelope;
  }

  #itemOf(record: PendingRecord, envelope = this.#envelopeOf(record)): QueueItem {
    const mismatch = this.#accountKey !== null && record.accountKey !== this.#accountKey;
    const state: ItemState = mismatch
      ? 'attention'
      : this.#inFlight.has(record.operationId)
        ? 'saving'
        : record.state;
    return {
      operationId: record.operationId,
      seq: record.seq,
      type: record.type,
      envelope,
      label: record.label,
      taskKey: record.taskKey,
      state,
      error: mismatch ? ACCOUNT_MISMATCH : record.lastError,
      everSent: record.everSent,
      accountMismatch: mismatch,
      receipt: null,
    };
  }

  #emit(): void {
    const items = [...this.#ordered().map((r) => this.#itemOf(r)), ...this.#saved.values()].sort(
      (a, b) => a.seq - b.seq,
    );
    this.#snapshot = { items, signedOut: this.#signedOut };
    for (const listener of this.#listeners) listener();
  }
}
