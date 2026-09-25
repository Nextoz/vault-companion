// IndexedDB `vault-companion` / stores `pending` and `receipts` (commands.md#client-pending-queue-pwa).
// Holds only the user's pending commands and recent receipts — never vault file contents.
import type { CommandType, Receipt } from '@vault-companion/contracts';

export const DB_NAME = 'vault-companion';
export const STORE = 'pending';
export const RECEIPTS = 'receipts';
const VERSION = 2;

export interface PendingError {
  code: string;
  message: string;
}

export interface PendingRecord {
  /** Key. Equals the envelope's operationId. */
  operationId: string;
  /** Enqueue order; items for the same task are sent FIFO by this. */
  seq: number;
  type: CommandType;
  /** The exact request body. Every attempt sends these bytes, unchanged (F19). */
  body: string;
  /** SHA-256 of the Access identity that created the item; never sent under another account. */
  accountKey: string;
  /** Items sharing a task key are sent strictly in order. Null for captures. */
  taskKey: string | null;
  /** operationId of the predecessor this item must wait for (Undo → its CompleteTask, F4). */
  dependsOn: string | null;
  /** True once a request carrying this envelope may have left the device: its effect may exist. */
  everSent: boolean;
  /** Failed attempts since the last success or user retry; drives backoff. */
  attempts: number;
  nextAttemptAt: number;
  /** `saving` is never persisted: an in-flight request is represented by its lease below. */
  state: 'pending' | 'attention';
  lastError: PendingError | null;
  /** Short display text captured at the moment of the action. */
  label: string;
  createdAt: number;
  /**
   * While `now < leaseUntil`, some tab has a request for this item in flight (A3): no other tab sends,
   * cancels or discards it. A lease that outlives a closed tab simply expires. Absent on version-1 rows.
   */
  leaseUntil?: number;
  /** Identifies the claim holding the lease; only that claim may settle a non-receipt outcome. */
  claimId?: string | null;
  /**
   * Bumped whenever the user retries `dependsOn`, even while this item is in flight (N2). A refusal to a request
   * sent under an older value answered a predecessor state that no longer holds: it is requeued, never final.
   * Absent on older rows (read as 0).
   */
  dependencyGeneration?: number;
}

/** A receipt kept after its pending record is gone, until a read reports its commit `included` (A9). */
export interface ReceiptRecord {
  operationId: string;
  seq: number;
  type: CommandType;
  body: string;
  accountKey: string;
  taskKey: string | null;
  label: string;
  receipt: Receipt;
  /** A read reported `receipt.commitSha` as included. Only acknowledged receipts may be evicted. */
  acknowledged: boolean;
  savedAt: number;
}

export interface PendingStore {
  all(): Promise<PendingRecord[]>;
  get(operationId: string): Promise<PendingRecord | undefined>;
  put(record: PendingRecord): Promise<void>;
  delete(...operationIds: string[]): Promise<void>;
  receipts(): Promise<ReceiptRecord[]>;
  /** One transaction: remove the pending record (if still present) and store its receipt. */
  settle(receipt: ReceiptRecord): Promise<void>;
  putReceipts(...receipts: ReceiptRecord[]): Promise<void>;
  deleteReceipts(...operationIds: string[]): Promise<void>;
  close(): void;
}

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });

/** Runs `fill` inside one readwrite transaction; a synchronous throw aborts everything it queued. */
async function write(db: IDBDatabase, stores: string[], fill: (tx: IDBTransaction) => void): Promise<void> {
  const tx = db.transaction(stores, 'readwrite');
  const completed = done(tx);
  try {
    fill(tx);
  } catch (error) {
    tx.abort();
    await completed.catch(() => undefined);
    throw error;
  }
  await completed;
}

export async function openPendingStore(factory: IDBFactory = indexedDB): Promise<PendingStore> {
  const open = factory.open(DB_NAME, VERSION);
  open.onupgradeneeded = () => {
    const names = open.result.objectStoreNames;
    if (!names.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'operationId' });
    if (!names.contains(RECEIPTS)) open.result.createObjectStore(RECEIPTS, { keyPath: 'operationId' });
  };
  // Another tab still holding version 1 must let go, or this tab could never open (and never keep actions).
  const db = await request(open);
  db.onversionchange = () => db.close();

  const readAll = async <T extends { seq: number }>(name: string) => {
    const tx = db.transaction(name, 'readonly');
    const rows = (await request(tx.objectStore(name).getAll())) as T[];
    return rows.sort((a, b) => a.seq - b.seq);
  };

  return {
    all: () => readAll<PendingRecord>(STORE),
    async get(operationId) {
      const tx = db.transaction(STORE, 'readonly');
      return (await request(tx.objectStore(STORE).get(operationId))) as PendingRecord | undefined;
    },
    put: (record) => write(db, [STORE], (tx) => tx.objectStore(STORE).put(record)),
    delete: (...ids) => write(db, [STORE], (tx) => ids.forEach((id) => tx.objectStore(STORE).delete(id))),
    receipts: () => readAll<ReceiptRecord>(RECEIPTS),
    settle: (receipt) =>
      write(db, [STORE, RECEIPTS], (tx) => {
        tx.objectStore(STORE).delete(receipt.operationId);
        tx.objectStore(RECEIPTS).put(receipt);
      }),
    putReceipts: (...rows) => write(db, [RECEIPTS], (tx) => rows.forEach((r) => tx.objectStore(RECEIPTS).put(r))),
    deleteReceipts: (...ids) => write(db, [RECEIPTS], (tx) => ids.forEach((id) => tx.objectStore(RECEIPTS).delete(id))),
    close() {
      db.close();
    },
  };
}
