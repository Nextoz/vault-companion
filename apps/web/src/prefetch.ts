// SP4: after a task read applies, quietly warm the Worker's per-commit read cache (packages/github/src/
// contents-store.ts) for the read-only tabs the owner is likely to open next. Bodies are discarded: nothing here is
// rendered, stored or parsed, and every failure is silent (no throw, no log, no retry). Nothing here touches the
// queue, prefs or any UI state.

export interface PrefetchDeps {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Runs `run` later, when the browser is idle; never before. */
  schedule(run: () => void): void;
  isOnline(): boolean;
  isHidden(): boolean;
  saveData(): boolean;
}

/** Read-only endpoints, in the order the tabs sit in: the Worker's cache is filled without a waterfall. */
const READ_PATHS = ['/api/notes', '/api/history', '/api/training'] as const;

/** A prefetch the Worker has not answered by then is abandoned; the tab's own read will ask again. */
const TIMEOUT_MS = 10_000;

function idleSchedule(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => run(), { timeout: 1500 });
  else setTimeout(() => run(), 1500);
}

/** Browser defaults; tests inject fakes. No I/O happens until `maybePrefetch` runs. */
export const browserPrefetchDeps: PrefetchDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  schedule: idleSchedule,
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  saveData: () => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } } | undefined)?.connection;
    return connection?.saveData === true;
  },
};

export function createPrefetcher(deps: PrefetchDeps = browserPrefetchDeps) {
  /** Only the last accepted key is kept: the history does not grow, and a pair prefetches at most once. */
  let lastKey: string | null = null;

  async function warm(): Promise<void> {
    for (const path of READ_PATHS) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
      try {
        const res = await deps.fetch(path, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: abort.signal,
          headers: { Accept: 'application/json' },
        });
        // Signed out (opaque redirect, 401, 403) or any other non-OK answer: stop, leave the rest cold.
        if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403 || !res.ok) return;
        await res.arrayBuffer();
      } catch {
        return;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return {
    /** Warm the cache for this vault revision, at most once for each (accountKey, revision) pair. */
    maybePrefetch(accountKey: string, revision: string): void {
      if (!accountKey || !revision) return;
      if (!deps.isOnline() || deps.isHidden() || deps.saveData()) return;
      const key = `${accountKey}\u0000${revision}`;
      if (key === lastKey) return;
      lastKey = key;
      deps.schedule(() => void warm());
    },
  };
}
