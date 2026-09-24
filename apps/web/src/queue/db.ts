// IndexedDB `vault-companion` / store `pending` (commands.md#client-pending-queue-pwa).
// Holds only the user's pending commands — never vault file contents.
import type { CommandType } from '@vault-companion/contracts';

export const DB_NAME = 'vault-companion';
export const STORE = 'pending';

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
  /** `saving` is never persisted: an in-flight request does not survive a reload. */
  state: 'pending' | 'attention';
  lastError: PendingError | null;
  /** Short display text captured at the moment of the action. */
  label: string;
  createdAt: number;
}

export interface PendingStore {
  all(): Promise<PendingRecord[]>;
  get(operationId: string): Promise<PendingRecord | undefined>;
  put(record: PendingRecord): Promise<void>;
  delete(...operationIds: string[]): Promise<void>;
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

export async function openPendingStore(factory: IDBFactory = indexedDB): Promise<PendingStore> {
  const open = factory.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(STORE)) {
      open.result.createObjectStore(STORE, { keyPath: 'operationId' });
    }
  };
  const db = await request(open);

  return {
    async all() {
      const tx = db.transaction(STORE, 'readonly');
      const rows = (await request(tx.objectStore(STORE).getAll())) as PendingRecord[];
      return rows.sort((a, b) => a.seq - b.seq);
    },
    async get(operationId) {
      const tx = db.transaction(STORE, 'readonly');
      return (await request(tx.objectStore(STORE).get(operationId))) as PendingRecord | undefined;
    },
    async put(record) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      await done(tx);
    },
    async delete(...operationIds) {
      const tx = db.transaction(STORE, 'readwrite');
      for (const id of operationIds) tx.objectStore(STORE).delete(id);
      await done(tx);
    },
    close() {
      db.close();
    },
  };
}
