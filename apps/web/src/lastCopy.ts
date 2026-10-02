// SP3 (ADR-0038): the last successful answer of a read-only screen, kept in memory for this page session only, so a
// tab or note seen before opens at once, marked as a copy, while the fresh read runs. Nothing here touches disk,
// the service worker, the queue or task reads. A signed-out answer drops every copy.
import type { Fetched } from './api.ts';

export interface Copy<T> {
  data: T;
  /** When the copied answer arrived (epoch ms). */
  at: number;
}

/** Enough for the read-only tabs plus the notes opened in one sitting; the oldest copy goes first. */
export const COPY_LIMIT = 40;

export function createLastCopies(limit = COPY_LIMIT) {
  const copies = new Map<string, Copy<unknown>>();
  const id = (account: string, key: string) => `${account}\u0000${key}`;
  return {
    get<T>(account: string | null, key: string): Copy<T> | null {
      if (!account) return null;
      return (copies.get(id(account, key)) as Copy<T> | undefined) ?? null;
    },
    put(account: string | null, key: string, data: unknown, at: number): void {
      if (!account) return;
      const k = id(account, key);
      copies.delete(k);
      copies.set(k, { data, at });
      while (copies.size > limit) copies.delete(copies.keys().next().value!);
    },
    clear(): void {
      copies.clear();
    },
  };
}

export type LastCopies = ReturnType<typeof createLastCopies>;

/** What a read-only screen shows. `copyAt` is set while `res` is an earlier answer, not this read's. */
export interface CopyView<T> {
  res: Fetched<T> | null;
  copyAt: number | null;
  refreshing: boolean;
  /** The last refresh failed; `res` is still the copy from `copyAt`. */
  failed: boolean;
}

/** Before the read: the copy if there is one, otherwise nothing (the screen's own "Loading…"). */
export function openView<T>(copies: LastCopies, account: string | null, key: string): CopyView<T> {
  const copy = copies.get<T>(account, key);
  return copy
    ? { res: { kind: 'ok', data: copy.data }, copyAt: copy.at, refreshing: true, failed: false }
    : { res: null, copyAt: null, refreshing: true, failed: false };
}

/** After the read. A fresh answer replaces the copy; a failure keeps what is shown but says it is a copy. */
export function settleView<T>(copies: LastCopies, account: string | null, key: string, prev: CopyView<T>, fresh: Fetched<T>, now: number): CopyView<T> {
  if (fresh.kind === 'ok') {
    copies.put(account, key, fresh.data, now);
    return { res: fresh, copyAt: null, refreshing: false, failed: false };
  }
  if (fresh.kind === 'signed-out') {
    copies.clear();
    return { res: fresh, copyAt: null, refreshing: false, failed: false };
  }
  if (prev.res?.kind === 'ok') {
    const at = prev.copyAt ?? copies.get<T>(account, key)?.at ?? now;
    return { res: prev.res, copyAt: at, refreshing: false, failed: true };
  }
  return { res: fresh, copyAt: null, refreshing: false, failed: false };
}

/** The app's single store; screens read and write it through `useLastCopy`. */
export const lastCopies = createLastCopies();
