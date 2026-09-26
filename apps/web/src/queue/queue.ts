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
//   until a read reports its commit `included`; only such acknowledged receipts are ever evicted (A9);
// - acknowledging a receipt records, in the same transaction, the revision of the read that reported it `included`
//   as the watermark (G3-1, review O1). Every tab renders only reads that show the watermark included, so under W1
//   (no history rewrite) an acknowledged receipt is in every rendered read: it is never asked about again, and may be
//   evicted without losing an overlay in any tab. Reads therefore ask only about the watermark and unacknowledged
//   receipts (reads.ts, `MAX_KNOWN`);
// - "Reset saved-actions history" (review O6) drops every receipt and neutralises the watermark in one transaction;
//   pending items are never touched;
// - an Undo made before its completion had a receipt is stored as a draft without `targetCommit` (ADR-0013). The claim
//   fills the token from the completion's receipt and persists it before the request leaves, so every attempt sends
//   the same bytes. A draft whose completion is refused (known not applied) is discarded locally; a receipt a draft
//   still needs is never evicted.
import type { Command, CommandType, CompleteTaskCommand, Receipt, TasksResponse } from '@vault-companion/contracts';
import { isUndoDraft, withTargetCommit } from '../commands.ts';
import { backoffMs, classify, knownNotApplied, type Outcome } from './classify.ts';
import type { DraftBasis, PendingError, PendingRecord, PendingStore, ReceiptRecord, Watermark } from './db.ts';

export type ItemState = 'pending' | 'saving' | 'saved' | 'attention';

export interface QueueItem {
  operationId: string;
  seq: number;
  type: CommandType;
  envelope: Command;
  label: string;
  taskKey: string | null;
  /** The account the item was created under (A7). */
  accountKey: string;
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
  /** Loaded in the same transaction as `items`: whenever a receipt is missing from them, this covers it. */
  watermark: Watermark | null;
}

/** The parts of a task read that prove which commits it contains. */
export type ReadEvidence = Pick<TasksResponse, 'revision' | 'known'>;

/** True if the read contains the watermark commit, so every receipt evicted under it is reflected in the read. */
export function satisfiesWatermark(read: ReadEvidence, watermark: Watermark | null): boolean {
  if (watermark === null || watermark.commitSha === RESET_WATERMARK) return true;
  return read.revision === watermark.commitSha || read.known[watermark.commitSha] === 'included';
}

/** The watermark commit after a history reset (O6): satisfied by every read, while its version keeps increasing. */
export const RESET_WATERMARK = '';

export interface EnqueueOptions {
  accountKey: string;
  label: string;
  taskKey?: string | null;
  dependsOn?: string | null;
  /**
   * Capture Save of a draft (P4-C): in the transaction that persists the item, the account's stored draft must still
   * be this version and is deleted; otherwise nothing is persisted and `enqueue` answers `'draft-conflict'`.
   */
  draft?: DraftBasis;
}

/** The part of `navigator.locks` the queue uses: an exclusive lock held for the callback's duration. */
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface QueueOptions {
  store: PendingStore;
  /**
   * POST the body with `X-VC-Account: accountKey`; must use `redirect: 'manual'` so expiry is detectable, and must
   * settle well within `LEASE_MS` (abort with a TimeoutError), or this tab's flush waits on it forever (N5).
   */
  send: (body: string, accountKey: string) => Promise<Response>;
  /** Cross-tab lock. Defaults to `navigator.locks`; `null` means none (local cancellation disabled). */
  locks?: LockManagerLike | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  onReceipt?: (receipt: Receipt, envelope: Command) => void;
}

const LOCK_NAME = 'vc-pending';
/** How long a claim keeps other tabs off an item. Longer than any request (`COMMAND_TIMEOUT_MS`); a dead tab's lease just expires. */
export const LEASE_MS = 60_000;
/** Acknowledged receipts kept for the "Saved to GitHub" list. Unacknowledged receipts are never evicted. */
const MAX_ACKNOWLEDGED = 20;

/** A draft Undo whose completion this device holds neither as a pending item nor as a receipt (ADR-0013). */
const UNDO_TARGET_UNKNOWN: PendingError = {
  code: 'refused:undo-target-unknown',
  message: "This device has no record of the completion being saved, so the Undo can't be sent. Undo it in Obsidian if needed.",
};

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
  #watermark: Watermark | null = null;
  /** Parsed envelopes with the body they were parsed from: another tab may rewrite a body (an Undo's token). */
  readonly #envelopes = new Map<string, { body: string; envelope: Command }>();
  readonly #listeners = new Set<() => void>();

  #accountKey: string | null = null;
  #signedOut = false;
  #generation = 0;
  #mutex: Promise<unknown> = Promise.resolve();
  #flushing: Promise<void> | null = null;
  #flushAgain = false;
  #cancelTimer: (() => void) | null = null;
  #snapshot: QueueSnapshot = { items: [], signedOut: false, watermark: null };

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

  /** The watermark as IndexedDB has it now, whichever tab set it. */
  readWatermark(): Promise<Watermark | null> {
    return this.#store.watermark();
  }

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

  /**
   * Persists the envelope, then schedules a send. Resolves once the item is durable on the device, or with
   * `'draft-conflict'` (nothing persisted) if `options.draft` is no longer the stored draft.
   */
  async enqueue(envelope: Command, options: EnqueueOptions): Promise<'enqueued' | 'draft-conflict'> {
    const result = await this.#locked(() => this.#enqueueLocked(envelope, options));
    if (result === 'enqueued') void this.flush();
    return result;
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

  /**
   * User "Retry": same envelope, immediately. Its dependents that needed attention go back behind it (R4). One
   * whose request is in flight keeps its claim but moves to a new dependency generation, so a refusal answering
   * the old predecessor state is requeued when it arrives rather than becoming final (N2). The predecessor and
   * every affected dependent are written in one IndexedDB transaction (G3-2).
   */
  async retry(operationId: string): Promise<void> {
    await this.#locked(async () => {
      const record = this.#records.get(operationId);
      if (!record || this.#leased(record)) return;
      const again = (r: PendingRecord): PendingRecord => ({ ...r, state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null });
      const writes = [again(record)];
      for (const dependent of this.#records.values()) {
        if (dependent.dependsOn !== operationId) continue;
        const next = { ...dependent, dependencyGeneration: (dependent.dependencyGeneration ?? 0) + 1 };
        writes.push(next.state === 'attention' && !this.#leased(next) ? again(next) : next);
      }
      // One transaction (G3-2): a tab that dies here leaves either all of it or none, never C requeued behind a
      // dependent whose old refusal would still count as final.
      await this.#persist(...writes);
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

  /**
   * Drop "Saved to GitHub" entries the UI no longer needs, with the read on screen as the watermark. Unacknowledged
   * receipts are kept regardless (A9), and so is any receipt that read does not report `included` (G3-1).
   */
  async forgetSaved(operationIds: Iterable<string>, read: ReadEvidence): Promise<void> {
    const ids = new Set(operationIds);
    await this.#locked(async () => {
      const chosen = [...this.#receipts.values()].filter((r) => r.acknowledged && ids.has(r.operationId));
      await this.#writeReceipts([], this.#evictable(chosen, read), null);
    });
  }

  /**
   * A rendered read: receipts it reports `included` become acknowledged, and in the same transaction the watermark moves
   * to this read's revision, so every later rendered read contains them (O1). Acknowledged receipts beyond the retention
   * limit are evicted. A read that does not contain the current watermark changes nothing. Resolves with the new
   * watermark version when one was written (the read it came from satisfies it).
   */
  async acknowledge(read: ReadEvidence): Promise<number | null> {
    return this.#locked(async () => {
      if (!satisfiesWatermark(read, this.#watermark)) return null;
      const now = [...this.#receipts.values()]
        .filter((r) => !r.acknowledged && read.known[r.receipt.commitSha] === 'included')
        .map((r) => ({ ...r, acknowledged: true }));
      const receipts = new Map(this.#receipts);
      for (const r of now) receipts.set(r.operationId, r);
      const acknowledged = [...receipts.values()].filter((r) => r.acknowledged).sort((a, b) => a.seq - b.seq);
      const excess = acknowledged.slice(0, Math.max(0, acknowledged.length - MAX_ACKNOWLEDGED));
      const evict = this.#evictable(excess, read);
      const watermark = now.length > 0 ? this.#nextWatermark(read.revision, evict.map((r) => r.operationId)) : null;
      await this.#writeReceipts(now, evict, watermark);
      return watermark?.version ?? null;
    });
  }

  /**
   * Review O6: forget every receipt and neutralise the watermark, in one transaction. For a device whose reads stay
   * stale (e.g. the vault history was rewritten, so the watermark commit is gone). Pending items are never touched.
   */
  async resetHistory(): Promise<void> {
    await this.#locked(async () => {
      const all = [...this.#receipts.values()];
      await this.#writeReceipts([], all, this.#nextWatermark(RESET_WATERMARK, all.map((r) => r.operationId)));
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
      const draft = this.#envelopeOf(record);
      let body = record.body;
      if (isUndoDraft(draft) && draft.type === 'UndoCompleteTask') {
        const targetId = draft.payload.target.operationId;
        const receipt = this.#receipts.get(targetId);
        const predecessor = this.#records.get(targetId);
        if (receipt) {
          // The token, once: persisted with the claim below, before the request leaves (ADR-0013).
          body = JSON.stringify(withTargetCommit(draft, receipt.receipt.commitSha));
        } else if (predecessor?.state === 'attention' && knownNotApplied(predecessor.lastError)) {
          // Nothing was completed, so there is nothing to undo (ADR-0013): dropped locally, never sent.
          await this.#store.delete(record.operationId);
          this.#records.delete(record.operationId);
          this.#emit();
          continue;
        } else if (predecessor) {
          blocks();
          continue;
        } else {
          await this.#persist({ ...record, state: 'attention', lastError: UNDO_TARGET_UNKNOWN });
          continue;
        }
      }
      // Mark before the request leaves: from here on its effect may exist in Git, and other tabs keep off it.
      const claimed: PendingRecord = { ...record, body, everSent: true, leaseUntil: now + LEASE_MS, claimId: crypto.randomUUID() };
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
    } catch (error) {
      // `send` aborts a request the server never answers (N5), so this tab keeps flushing later items.
      if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return { kind: 'retry', error: { code: 'timeout', message: 'The server did not answer. Will retry.' } };
      }
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
        if ((current.dependencyGeneration ?? 0) !== (sent.dependencyGeneration ?? 0)) {
          // Its predecessor was retried after this request left (N2): back in line behind it, same bytes.
          await this.#persist({ ...record, state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null });
          return;
        }
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
    const { records, receipts, watermark } = await this.#store.load();
    this.#records = new Map(records.map((r) => [r.operationId, r]));
    this.#receipts = new Map(receipts.map((r) => [r.operationId, r]));
    this.#watermark = watermark;
  }

  /**
   * Under the lock. The acknowledged ones of `candidates` — the watermark covers them (O1) — provided `read` contains
   * the current watermark. Otherwise none.
   */
  #evictable(candidates: ReceiptRecord[], read: ReadEvidence): ReceiptRecord[] {
    if (!satisfiesWatermark(read, this.#watermark)) return [];
    // A draft Undo takes its token from its completion's receipt (ADR-0013): keep that receipt until it has.
    const needed = new Set<string>();
    for (const r of this.#records.values()) {
      const e = this.#envelopeOf(r);
      if (isUndoDraft(e) && e.type === 'UndoCompleteTask') needed.add(e.payload.target.operationId);
    }
    return candidates.filter((r) => r.acknowledged && !needed.has(r.operationId));
  }

  #nextWatermark(commitSha: string, receiptOpIds: string[]): Watermark {
    return { commitSha, receiptOpIds, version: (this.#watermark?.version ?? 0) + 1 };
  }

  /** Under the lock. One transaction: acknowledgements, evictions, and the watermark that covers the acknowledgements. */
  async #writeReceipts(put: ReceiptRecord[], evict: ReceiptRecord[], watermark: Watermark | null): Promise<void> {
    if (put.length === 0 && evict.length === 0 && watermark === null) return;
    const remove = evict.map((r) => r.operationId);
    await this.#store.writeReceipts({ put: put.filter((r) => !remove.includes(r.operationId)), remove, watermark: watermark ?? undefined });
    for (const r of put) this.#receipts.set(r.operationId, r);
    for (const id of remove) this.#receipts.delete(id);
    if (watermark) this.#watermark = watermark;
    this.#emit();
  }

  async #enqueueLocked(envelope: Command, options: EnqueueOptions): Promise<'enqueued' | 'draft-conflict'> {
    if (this.#records.has(envelope.operationId) || this.#receipts.has(envelope.operationId)) return 'enqueued';
    const last = this.#ordered().at(-1);
    const now = this.#now();
    const record: PendingRecord = {
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
    };
    const draft = options.draft === undefined ? null : { accountKey: options.accountKey, basis: options.draft };
    if ((await this.#store.add(record, draft)) === 'draft-conflict') return 'draft-conflict';
    this.#records.set(record.operationId, record);
    this.#emit();
    return 'enqueued';
  }

  /** Durable first, in one transaction; the cache and listeners see the records only once it has committed. */
  async #persist(...records: PendingRecord[]): Promise<void> {
    await this.#store.put(...records);
    for (const record of records) this.#records.set(record.operationId, record);
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

  /** The envelope of exactly this body (review P4E-Astra #2): a cached parse of an older body is never used. */
  #envelopeOf(record: { operationId: string; body: string }): Command {
    const cached = this.#envelopes.get(record.operationId);
    if (cached?.body === record.body) return cached.envelope;
    const envelope = JSON.parse(record.body) as Command;
    this.#envelopes.set(record.operationId, { body: record.body, envelope });
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
      accountKey: record.accountKey,
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
      accountKey: saved.accountKey,
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
    this.#snapshot = { items, signedOut: this.#signedOut, watermark: this.#watermark };
    for (const listener of this.#listeners) listener();
  }
}
