import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { DB_NAME, openPendingStore, RECEIPTS, STORE } from './db.ts';

describe('IndexedDB schema upgrade', () => {
  it('v2 → v3 keeps pending rows and receipts, and starts without a watermark', async () => {
    const factory = new IDBFactory();
    const v2 = factory.open(DB_NAME, 2);
    v2.onupgradeneeded = () => {
      v2.result.createObjectStore(STORE, { keyPath: 'operationId' });
      v2.result.createObjectStore(RECEIPTS, { keyPath: 'operationId' });
      v2.transaction?.objectStore(STORE).put({ operationId: 'p1', seq: 1 });
      v2.transaction?.objectStore(RECEIPTS).put({ operationId: 'r1', seq: 2 });
    };
    await new Promise((resolve, reject) => {
      v2.onsuccess = resolve;
      v2.onerror = reject;
    });
    v2.result.close();

    const store = await openPendingStore(factory);
    expect(await store.all()).toMatchObject([{ operationId: 'p1' }]);
    expect(await store.receipts()).toMatchObject([{ operationId: 'r1' }]);
    expect(await store.watermark()).toBeNull();
    store.close();
  });
});
