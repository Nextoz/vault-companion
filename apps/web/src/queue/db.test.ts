import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { DB_NAME, META, openPendingStore, RECEIPTS, STORE } from './db.ts';

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

  it('v3 → v4 keeps pending rows, receipts and the watermark, and starts without drafts', async () => {
    const factory = new IDBFactory();
    const v3 = factory.open(DB_NAME, 3);
    const watermark = { commitSha: 'c'.repeat(40), receiptOpIds: ['r0'], version: 1 };
    v3.onupgradeneeded = () => {
      v3.result.createObjectStore(STORE, { keyPath: 'operationId' });
      v3.result.createObjectStore(RECEIPTS, { keyPath: 'operationId' });
      v3.result.createObjectStore(META);
      v3.transaction?.objectStore(STORE).put({ operationId: 'p1', seq: 1 });
      v3.transaction?.objectStore(RECEIPTS).put({ operationId: 'r1', seq: 2 });
      v3.transaction?.objectStore(META).put(watermark, 'watermark');
    };
    await new Promise((resolve, reject) => {
      v3.onsuccess = resolve;
      v3.onerror = reject;
    });
    v3.result.close();

    const store = await openPendingStore(factory);
    expect(await store.all()).toMatchObject([{ operationId: 'p1' }]);
    expect(await store.receipts()).toMatchObject([{ operationId: 'r1' }]);
    expect(await store.watermark()).toEqual(watermark);
    expect(await store.draft('a'.repeat(64))).toBeUndefined();
    const draft = { accountKey: 'a'.repeat(64), id: 'd1', version: 1, kind: 'task' as const, text: 'synthetic', updatedAt: 1 };
    expect(await store.putDraft(draft, null)).toBe('ok');
    expect(await store.draft('a'.repeat(64))).toMatchObject({ text: 'synthetic' });
    store.close();
  });
});
