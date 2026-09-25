// Client pending queue (commands.md#client-pending-queue-pwa).
//
// Guarantees:
// - an envelope is persisted before its first send, and every attempt sends the stored bytes unchanged;
// - an item is sent only while the confirmed session's accountKey equals the item's accountKey, re-checked after
//   the claim is durable and immediately before the request, which carries that key as `X-VC-Account` (A7);
// - items for the same task go FIFO, and a dependent (Undo) waits for its predecessor's receipt or a refusal known
//   not to have applied (R4); an Undo of a completion no tab ever sent cancels both locally (F4);
// - several tabs share one IndexedDB database: claim, cancellation, settlement and discard run under the
//   `vc-pending` Web Lock after re-reading IndexedDB. In-memory state is a cache, never the basis of a decision (A3).
//   Without Web Locks, local cancellation is disabled;
// - nothing is dropped except on receipt or explicit user discard. No retry limit. A receipt is kept in IndexedDB
//   until a read reports its commit `included`; only such acknowledged receipts are ever evicted (A9).
import type { Command, CommandType, CompleteTaskCommand, Receipt } from '@vault-companion/contracts';
import { backoffMs, classify, knownNotApplied, type Outcome } from './classify.ts';
import type { PendingError, PendingRecord, PendingStore, ReceiptRecord } from './db.ts';

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
  /** A saved item whose commit a read has reported `included`: the read now reflects it. */
  acknowledged: boolean;
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

/** The part of `navigator.locks` the queue uses: an exclusive lock held for the callback's duration. */
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface QueueOptions {
  store: PendingStore;
  /** POST the body with `X-VC-Account: accountKey`; must use `redirect: 'manual'` so expiry is detectable. */
  send: (body: string, accountKey: string) => Promise<Response>;
  /** Cross-tab lock. Defaults to `navigator.locks`; `null` means none (local cancellation disabled). */
  locks?: LockManagerLike | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  onReceipt?: (receipt: Receipt, envelope: Command) => void;
}

const LOCK_NAME = 'vc-pending';
/** How long a claim keeps other tabs off an item. Longer than any request; a dead tab's lease just expires. */
const LEASE_MS = 60_000;
/** Acknowledged receipts kept for the "Saved to GitHub" list. Unacknowledged receipts are never evicted. */
const MAX_ACKNOWLEDGED = 20;

const ACCOUNT_MISMATCH: PendingError = {
  code: 'account-mismatch',
  message: 'Saved on this device under a different account. It will not be sent.',
};

interface Claim {
  record: PendingRecord;
  /** Session generation the claim was made under; any session change since releases it unsent. */
  generation: number;
}

/** The session changed between claim and request: nothing was sent. */
type Attempt = Outcome | { kind: 'released' };

function defaultLocks(): LockManagerLike | null {
  const locks = globalThis.navigator?.locks;
  return locks ? { request: (name, callback) => locks.request(name, () => callback()) } : null;
}

export class PendingQueue {
  readonly #store: PendingStore;
  readonly #send: QueueOptions['send'];
  readonly #locks: LockManagerLike | null;
  readonly #now: () => number;
  readonly #setTimer: NonNullable<QueueOptions['setTimer']>;
  readonly #onReceipt: QueueOptions['onReceipt'];

  // Caches of IndexedDB, refreshed inside every lock. Never trusted for a decision outside one.
  #records = new Map<string, PendingRecord>();
  #receipts = new Map<string, ReceiptRecord>();
  readonly #envelopes = new Map<string, Command>();
  readonly #listeners = new Set<() => void>();

  #accountKey: string | null = null;
  #signedOut = false;
  #generation = 0;
  #mutex: Promise<unknown> = Promise.resolve();
  #flushing: Promise<void> | null = null;
  #flushAgain = false;
  #cancelTimer: (() => void) | null = null;
  #snapshot: QueueSnapshot = { items: [], signedOut: false };

  private constructor(options: QueueOptions) {
    this.#store = options.store;
    this.#send = options.send;
    this.#locks = options.locks === undefined ? defaultLocks() : options.locks;
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
    await queue.#reload();
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
    if (this.#signedOut || this.#accountKey !== accountKey) this.#generation++;
    this.#accountKey = accountKey;
    this.#signedOut = false;
    this.#emit();
    void this.flush();
  }

  /** The session is gone (401, opaque redirect, Access 403): pause until `setSession`. */
  setSignedOut(): void {
    this.#generation++;
    this.#signedOut = true;
    this.#emit();
  }

  // ---- user actions ------------------------------------------------------------------------------------------

  /** Persists the envelope, then schedules a send. Resolves once the item is durable on the device. */
  async enqueue(envelope: Command, options: EnqueueOptions): Promise<void> {
    await this.#locked(() => this.#enqueueLocked(envelope, options));
    void this.flush();
  }

  /**
   * Undo a completion (F4). If no tab ever sent the completion, both are dropped locally (`'cancelled'`).
   * Otherwise — or without Web Locks to prove it — the Undo is a real command queued behind it (`'queued'`).
   */
  async undoCompletion(
    target: CompleteTaskCommand,
    undo: Command,
    options: Omit<EnqueueOptions, 'dependsOn'>,
  ): Promise<'cancelled' | 'queued'> {
    const result = await this.#locked(async () => {
      // Freshly read under the lock. An absent predecessor may have been sent and settled by another tab.
      const predecessor = this.#records.get(target.operationId);
      if (this.#locks !== null && predecessor && !predecessor.everSent) {
        await this.#store.delete(predecessor.operationId);
        this.#records.delete(predecessor.operationId);
        this.#emit();
        return 'cancelled' as const;
      }
      await this.#enqueueLocked(undo, { ...options, dependsOn: predecessor ? predecessor.operationId : null });
      return 'queued' as const;
    });
    if (result === 'queued') void this.flush();
    return result;
  }

  /** User "Retry": same envelope, immediately. Its dependents that needed attention go back behind it (R4). */
  async retry(operationId: string): Promise<void> {
    await this.#locked(async () => {
      const record = this.#records.get(operationId);
      if (!record || this.#leased(record)) return;
      const again = (r: PendingRecord) => this.#persist({ ...r, state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null });
      await again(record);
      for (const dependent of this.#records.values()) {
        if (dependent.dependsOn === operationId && dependent.state === 'attention' && !this.#leased(dependent)) {
          await again(dependent);
        }
      }
    });
    void this.flush();
  }

  /** User "Discard". Refused while any tab has a request for the item in flight (its outcome is unknown). */
  async discard(operationId: string): Promise<boolean> {
    return this.#locked(async () => {
      const record = this.#records.get(operationId);
      if (record && this.#leased(record)) return false;
      await this.#store.delete(operationId);
      this.#records.delete(operationId);
      this.#emit();
      return true;
    });
  }

  /** Drop "Saved to GitHub" entries the UI no longer needs. Unacknowledged receipts are kept regardless (A9). */
  async forgetSaved(operationIds: Iterable<string>): Promise<void> {
    const ids = new Set(operationIds);
    await this.#locked(async () => {
      const drop = [...this.#receipts.values()].filter((r) => r.acknowledged && ids.has(r.operationId));
      if (drop.length === 0) return;
      await this.#store.deleteReceipts(...drop.map((r) => r.operationId));
      for (const r of drop) this.#receipts.delete(r.operationId);
      this.#emit();
    });
  }

  /** The `known` map of a read: receipts it reports `included` become acknowledged, and evictable. */
  async acknowledge(known: Readonly<Record<string, 'included' | 'not-included'>>): Promise<void> {
    await this.#locked(async () => {
      const now = [...this.#receipts.values()]
        .filter((r) => !r.acknowledged && known[r.receipt.commitSha] === 'included')
        .map((r) => ({ ...r, acknowledged: true }));
      if (now.length > 0) await this.#store.putReceipts(...now);
      for (const r of now) this.#receipts.set(r.operationId, r);
      const acknowledged = [...this.#receipts.values()].filter((r) => r.acknowledged).sort((a, b) => a.seq - b.seq);
      const evict = acknowledged.slice(0, Math.max(0, acknowledged.length - MAX_ACKNOWLEDGED));
      if (evict.length > 0) await this.#store.deleteReceipts(...evict.map((r) => r.operationId));
      for (const r of evict) this.#receipts.delete(r.operationId);
      this.#emit();
    });
  }

  /** `online`, focus, start: try now, skipping any backoff wait. */
  async kick(): Promise<void> {
    await this.#locked(async () => {
      for (const record of this.#records.values()) {
        if (record.state === 'pending' && record.nextAttemptAt > 0 && record.accountKey === this.#accountKey) {
          await this.#persist({ ...record, nextAttemptAt: 0 });
        }
      }
      this.#emit();
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
            const claim = await this.#locked(() => this.#claimNext());
            if (!claim) break;
            const outcome = await this.#attempt(claim);
            await this.#locked(() => this.#settle(claim.record, outcome));
            if (outcome.kind === 'signed-out' || outcome.kind === 'released') break;
          }
        } while (this.#flushAgain && !this.#signedOut);
      } finally {
        this.#flushing = null;
        this.#scheduleWake();
      }
    })();
    return this.#flushing;
  }

  /** Under the lock, on freshly read records. */
  async #claimNext(): Promise<Claim | null> {
    if (this.#signedOut || this.#accountKey === null) return null;
    const account = this.#accountKey;
    const generation = this.#generation;
    const now = this.#now();
    const blocked = new Set<string>();
    for (const record of this.#ordered()) {
      const blocks = () => {
        if (record.taskKey !== null) blocked.add(record.taskKey);
      };
      if (record.accountKey !== account) {
        blocks();
        continue;
      }
      if (record.taskKey !== null && blocked.has(record.taskKey)) continue;
      if (record.state === 'attention') {
        // Final for automatic sending; it releases same-task successors only if it is known not to have applied.
        if (!knownNotApplied(record.lastError)) blocks();
        continue;
      }
      if (this.#leased(record, now)) {
        blocks();
        continue;
      }
      if (record.dependsOn !== null) {
        const predecessor = this.#records.get(record.dependsOn);
        if (predecessor && !(predecessor.state === 'attention' && knownNotApplied(predecessor.lastError))) {
          blocks();
          continue;
        }
      }
      if (record.nextAttemptAt > now) {
        blocks();
        continue;
      }
      // Mark before the request leaves: from here on its effect may exist in Git, and other tabs keep off it.
      const claimed: PendingRecord = { ...record, everSent: true, leaseUntil: now + LEASE_MS, claimId: crypto.randomUUID() };
      await this.#persist(claimed);
      // The session is re-checked in #attempt, synchronously before the request and after every await here.
      return { record: claimed, generation };
    }
    return null;
  }

  #maySend(record: PendingRecord, generation: number): boolean {
    return !this.#signedOut && this.#generation === generation && this.#accountKey === record.accountKey;
  }

  async #attempt({ record, generation }: Claim): Promise<Attempt> {
    // Synchronously before the request, so after every await of the claim: any session change since the claim
    // decision (another account, signed out) releases the item unsent (A7).
    if (!this.#maySend(record, generation)) return { kind: 'released' };
    try {
      return await classify(await this.#send(record.body, record.accountKey), record.operationId);
    } catch {
      return { kind: 'retry', error: { code: 'network', message: 'No connection. Will retry.' } };
    }
  }

  /** Under the lock, on freshly read records. */
  async #settle(sent: PendingRecord, outcome: Attempt): Promise<void> {
    if (outcome.kind === 'receipt') {
      // A receipt proves the effect, whoever else settled or discarded the item meanwhile.
      const receipt: ReceiptRecord = this.#receipts.get(sent.operationId) ?? {
        operationId: sent.operationId,
        seq: sent.seq,
        type: sent.type,
        body: sent.body,
        accountKey: sent.accountKey,
        taskKey: sent.taskKey,
        label: sent.label,
        receipt: outcome.receipt,
        acknowledged: false,
        savedAt: this.#now(),
      };
      await this.#store.settle(receipt);
      this.#records.delete(sent.operationId);
      this.#receipts.set(receipt.operationId, receipt);
      this.#emit();
      this.#onReceipt?.(outcome.receipt, this.#envelopeOf(sent));
      return;
    }
    // Settled, discarded or re-claimed by another tab since: its state is no longer ours to write.
    const current = this.#records.get(sent.operationId);
    if (!current || current.claimId !== sent.claimId) {
      this.#emit();
      return;
    }
    const record = this.#unleased(current);
    switch (outcome.kind) {
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
      case 'released':
        await this.#persist(record);
        return;
    }
  }

  #scheduleWake(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    if (this.#signedOut || this.#accountKey === null) return;
    let next = Infinity;
    for (const r of this.#records.values()) {
      if (r.state !== 'pending' || r.accountKey !== this.#accountKey) continue;
      if (r.nextAttemptAt > 0) next = Math.min(next, r.nextAttemptAt);
      // Another tab's claim: look again once it expires, in case that tab is gone.
      if ((r.leaseUntil ?? 0) > 0) next = Math.min(next, r.leaseUntil ?? 0);
    }
    if (next === Infinity) return;
    this.#cancelTimer = this.#setTimer(() => void this.flush(), Math.max(0, next - this.#now()));
  }

  // ---- internals ---------------------------------------------------------------------------------------------

  /** One at a time in this tab, then across tabs via the Web Lock, then re-read IndexedDB before `fn` decides. */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const body = async () => {
      await this.#reload();
      return fn();
    };
    const locked = () => (this.#locks ? this.#locks.request(LOCK_NAME, body) : body());
    const run = this.#mutex.then(locked, locked);
    this.#mutex = run.catch(() => undefined);
    return run;
  }

  async #reload(): Promise<void> {
    const [records, receipts] = await Promise.all([this.#store.all(), this.#store.receipts()]);
    this.#records = new Map(records.map((r) => [r.operationId, r]));
    this.#receipts = new Map(receipts.map((r) => [r.operationId, r]));
  }

  async #enqueueLocked(envelope: Command, options: EnqueueOptions): Promise<void> {
    if (this.#records.has(envelope.operationId) || this.#receipts.has(envelope.operationId)) return;
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
      leaseUntil: 0,
      claimId: null,
    });
  }

  async #persist(record: PendingRecord): Promise<void> {
    await this.#store.put(record);
    this.#records.set(record.operationId, record);
    this.#emit();
  }

  #leased(record: PendingRecord, now = this.#now()): boolean {
    return (record.leaseUntil ?? 0) > now;
  }

  #unleased(record: PendingRecord): PendingRecord {
    return { ...record, leaseUntil: 0, claimId: null };
  }

  #ordered(): PendingRecord[] {
    return [...this.#records.values()].sort((a, b) => a.seq - b.seq);
  }

  #envelopeOf(record: { operationId: string; body: string }): Command {
    let envelope = this.#envelopes.get(record.operationId);
    if (!envelope) {
      envelope = JSON.parse(record.body) as Command;
      this.#envelopes.set(record.operationId, envelope);
    }
    return envelope;
  }

  #itemOf(record: PendingRecord): QueueItem {
    const mismatch = this.#accountKey !== null && record.accountKey !== this.#accountKey;
    const state: ItemState = mismatch ? 'attention' : this.#leased(record) ? 'saving' : record.state;
    return {
      operationId: record.operationId,
      seq: record.seq,
      type: record.type,
      envelope: this.#envelopeOf(record),
      label: record.label,
      taskKey: record.taskKey,
      state,
      error: mismatch ? ACCOUNT_MISMATCH : record.lastError,
      everSent: record.everSent,
      accountMismatch: mismatch,
      receipt: null,
      acknowledged: false,
    };
  }

  #savedItemOf(saved: ReceiptRecord): QueueItem {
    return {
      operationId: saved.operationId,
      seq: saved.seq,
      type: saved.type,
      envelope: this.#envelopeOf(saved),
      label: saved.label,
      taskKey: saved.taskKey,
      state: 'saved',
      error: null,
      everSent: true,
      accountMismatch: false,
      receipt: saved.receipt,
      acknowledged: saved.acknowledged,
    };
  }

  #emit(): void {
    const items = [
      ...[...this.#records.values()].map((r) => this.#itemOf(r)),
      ...[...this.#receipts.values()].map((r) => this.#savedItemOf(r)),
    ].sort((a, b) => a.seq - b.seq);
    this.#snapshot = { items, signedOut: this.#signedOut };
    for (const listener of this.#listeners) listener();
  }
}
