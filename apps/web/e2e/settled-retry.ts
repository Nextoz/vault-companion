import { expect, type Page } from '@playwright/test';

// Request interception happens before the client stores the failure and releases its send lease.
// Observe the durable state before reconnecting or destroying a page with a pending command.
export const waitForSettledRetry = (page: Page) => expect.poll(() => page.evaluate(() =>
  new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('vault-companion');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('pending', 'readonly');
      const read = tx.objectStore('pending').getAll();
      tx.onabort = () => { db.close(); reject(tx.error); };
      tx.oncomplete = () => {
        db.close();
        const records = read.result as { attempts: number; leaseUntil?: number; state: string }[];
        resolve(records.length === 1 && records.every((r) =>
          r.state === 'pending' && r.attempts > 0 && !r.leaseUntil));
      };
    };
  }),
)).toBe(true);
