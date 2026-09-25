// IndexedDB `vault-companion` / stores `pending`, `receipts`, `meta` (commands.md#client-pending-queue-pwa) and
// `drafts`. Holds only the user's pending commands, recent receipts, the read watermark and unsent capture drafts —
// never vault file contents.
import type { CommandType, Receipt } from '@vault-companion/contracts';
import type { CaptureKind } from '../prefs.ts';

export const DB_NAME = 'vault-companion';
export const STORE = 'pending';
export const RECEIPTS = 'receipts';
export const META = 'meta';
export const DRAFTS = 'drafts';
const WATERMARK = 'watermark';
/**
 * v3 adds `meta` (the read watermark, G3-1), v4 adds `drafts` (P4-C). The upgrade only creates missing stores, so
 * rows survive.
 */
const VERSION = 4;

/**
 * The unfinished Capture text of one account: the user's own unsent words, never a command. Keyed by `accountKey`,
 * so a draft is only ever offered back to the account that wrote it.
 */
export interface Draft {
  accountKey: string;
  /** Identity of this draft. Once it is saved or discarded, no write based on it can bring it back. */
  id: string;
  /** Bumped by every write. A write is accepted only from the version it was based on (compare-and-swap). */
  version: number;
  kind: CaptureKind;
  text: string;
  updatedAt: number;
}

/** The draft version an app instance last read or wrote; `null`: it has seen no draft (it may only create one). */
export type DraftBasis = Pick<Draft, 'id' | 'version'> | null;

/** `conflict`: another instance changed, saved or discarded the draft since `basis`. Nothing was written. */
export type DraftWrite = 'ok' | 'conflict';

/**
 * Capture Save of a draft. `basis` non-null: the command is enqueued only if the stored draft is still exactly that
 * version, and the draft is deleted in the same transaction. `basis` null: the text was never kept as a draft, so
 * nothing is checked or deleted (another instance's draft, if any, stays).
 */
export interface DraftSubmit {
  accountKey: string;
  basis: DraftBasis;
}

/**
 * True if a write based on `basis` may replace `current` (G-CAS), and `next` is not older than it (G-NEWER).
 * A null basis may only create; a non-null basis may only follow that exact version, so a draft that is gone stays
 * gone.
 */
export function mayReplace(current: Draft | undefined, basis: DraftBasis, updatedAt: number): boolean {
  if (current && updatedAt < current.updatedAt) return false;
  if (basis === null) return current === undefined;
  return current !== undefined && current.id === basis.id && current.version === basis.version;
}

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

/**
 * Written in the same transaction that evicts acknowledged receipts (G3-1): `commitSha` is the revision of the read
 * that reported every evicted receipt `included`. A read that does not show it included may predate those commits,
 * and must not be rendered: the receipts that would have overlaid it are gone, in every tab.
 */
export interface Watermark {
  commitSha: string;
  /** The receipts whose eviction set this watermark (diagnostics only). */
  receiptOpIds: string[];
  /** Increases with every new watermark; lets a tab tell whether its rendered read predates the current one. */
  version: number;
}

export interface ReceiptChange {
  put?: ReceiptRecord[];
  remove?: string[];
  watermark?: Watermark | undefined;
}

export interface Loaded {
  records: PendingRecord[];
  receipts: ReceiptRecord[];
  watermark: Watermark | null;
}

export interface PendingStore {
  /** One readonly transaction: a consistent view of all three stores. */
  load(): Promise<Loaded>;
  all(): Promise<PendingRecord[]>;
  get(operationId: string): Promise<PendingRecord | undefined>;
  /** One transaction: every record is written, or (on any failure) none is. */
  put(...records: PendingRecord[]): Promise<void>;
  delete(...operationIds: string[]): Promise<void>;
  /**
   * One transaction: the new record is written and, if `draftOf` is an accountKey, that account's draft is deleted.
   * Either both happen or neither, so saved text can never survive as a draft and be captured twice.
   */
  add(record: PendingRecord, draft: DraftSubmit | null): Promise<'ok' | 'draft-conflict'>;
  receipts(): Promise<ReceiptRecord[]>;
  /** One transaction: remove the pending record (if still present) and store its receipt. */
  settle(receipt: ReceiptRecord): Promise<void>;
  /** One transaction: receipts written and removed together with the watermark that makes removal safe. */
  writeReceipts(change: ReceiptChange): Promise<void>;
  watermark(): Promise<Watermark | null>;
  draft(accountKey: string): Promise<Draft | undefined>;
  /** One transaction: written only if `mayReplace(current, basis, draft.updatedAt)`. */
  putDraft(draft: Draft, basis: DraftBasis): Promise<DraftWrite>;
  /** One transaction: deleted only if the stored draft is still `basis`. */
  deleteDraft(accountKey: string, basis: NonNullable<DraftBasis>): Promise<DraftWrite>;
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

/**
 * One readwrite transaction that reads `key` from `store` and lets `decide` write based on it. Nothing but IndexedDB
 * requests run inside, so the read and the writes are atomic against every other instance (IndexedDB serialises
 * readwrite transactions over overlapping stores). A throw in `decide` aborts everything it queued.
 */
async function guarded<T, R>(
  db: IDBDatabase,
  stores: string[],
  store: string,
  key: IDBValidKey,
  decide: (current: T | undefined, tx: IDBTransaction) => R,
): Promise<R> {
  const tx = db.transaction(stores, 'readwrite');
  const completed = done(tx);
  let result: { value: R } | null = null;
  const read = tx.objectStore(store).get(key);
  read.onsuccess = () => {
    try {
      result = { value: decide(read.result as T | undefined, tx) };
    } catch {
      tx.abort();
    }
  };
  await completed;
  if (!result) throw new Error('IndexedDB transaction failed');
  return (result as { value: R }).value;
}

export async function openPendingStore(factory: IDBFactory = indexedDB): Promise<PendingStore> {
  const open = factory.open(DB_NAME, VERSION);
  open.onupgradeneeded = () => {
    const names = open.result.objectStoreNames;
    if (!names.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'operationId' });
    if (!names.contains(RECEIPTS)) open.result.createObjectStore(RECEIPTS, { keyPath: 'operationId' });
    if (!names.contains(META)) open.result.createObjectStore(META);
    if (!names.contains(DRAFTS)) open.result.createObjectStore(DRAFTS, { keyPath: 'accountKey' });
  };
  // Another tab still holding an older version must let go, or this tab could never open (and never keep actions).
  const db = await request(open);
  db.onversionchange = () => db.close();

  const bySeq = <T extends { seq: number }>(rows: T[]) => rows.sort((a, b) => a.seq - b.seq);
  const readAll = async <T extends { seq: number }>(name: string) => {
    const tx = db.transaction(name, 'readonly');
    return bySeq((await request(tx.objectStore(name).getAll())) as T[]);
  };
  const readWatermark = async (tx: IDBTransaction) =>
    ((await request(tx.objectStore(META).get(WATERMARK))) as Watermark | undefined) ?? null;

  return {
    async load() {
      const tx = db.transaction([STORE, RECEIPTS, META], 'readonly');
      const [records, receipts, watermark] = await Promise.all([
        request(tx.objectStore(STORE).getAll()) as Promise<PendingRecord[]>,
        request(tx.objectStore(RECEIPTS).getAll()) as Promise<ReceiptRecord[]>,
        readWatermark(tx),
      ]);
      return { records: bySeq(records), receipts: bySeq(receipts), watermark };
    },
    all: () => readAll<PendingRecord>(STORE),
    async get(operationId) {
      const tx = db.transaction(STORE, 'readonly');
      return (await request(tx.objectStore(STORE).get(operationId))) as PendingRecord | undefined;
    },
    put: (...records) => write(db, [STORE], (tx) => records.forEach((r) => tx.objectStore(STORE).put(r))),
    delete: (...ids) => write(db, [STORE], (tx) => ids.forEach((id) => tx.objectStore(STORE).delete(id))),
    async add(record, draft) {
      if (draft === null || draft.basis === null) {
        await write(db, [STORE], (tx) => tx.objectStore(STORE).put(record));
        return 'ok';
      }
      const { basis } = draft;
      // Check, enqueue and delete in one transaction: of all instances holding this draft version, exactly one
      // enqueues it; every other one finds it gone and enqueues nothing.
      return guarded<Draft, 'ok' | 'draft-conflict'>(db, [STORE, DRAFTS], DRAFTS, draft.accountKey, (current, tx) => {
        if (!current || current.id !== basis.id || current.version !== basis.version) return 'draft-conflict';
        tx.objectStore(STORE).put(record);
        tx.objectStore(DRAFTS).delete(draft.accountKey);
        return 'ok';
      });
    },
    receipts: () => readAll<ReceiptRecord>(RECEIPTS),
    settle: (receipt) =>
      write(db, [STORE, RECEIPTS], (tx) => {
        tx.objectStore(STORE).delete(receipt.operationId);
        tx.objectStore(RECEIPTS).put(receipt);
      }),
    writeReceipts: ({ put = [], remove = [], watermark }) =>
      write(db, [RECEIPTS, META], (tx) => {
        if (watermark) tx.objectStore(META).put(watermark, WATERMARK);
        put.forEach((r) => tx.objectStore(RECEIPTS).put(r));
        remove.forEach((id) => tx.objectStore(RECEIPTS).delete(id));
      }),
    watermark: () => readWatermark(db.transaction(META, 'readonly')),
    async draft(accountKey) {
      const tx = db.transaction(DRAFTS, 'readonly');
      return (await request(tx.objectStore(DRAFTS).get(accountKey))) as Draft | undefined;
    },
    putDraft: (draft, basis) =>
      guarded<Draft, DraftWrite>(db, [DRAFTS], DRAFTS, draft.accountKey, (current, tx) => {
        if (!mayReplace(current, basis, draft.updatedAt)) return 'conflict';
        tx.objectStore(DRAFTS).put(draft);
        return 'ok';
      }),
    deleteDraft: (accountKey, basis) =>
      guarded<Draft, DraftWrite>(db, [DRAFTS], DRAFTS, accountKey, (current, tx) => {
        if (!current || current.id !== basis.id || current.version !== basis.version) return 'conflict';
        tx.objectStore(DRAFTS).delete(accountKey);
        return 'ok';
      }),
    close() {
      db.close();
    },
  };
}
