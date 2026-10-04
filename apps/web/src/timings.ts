// SP step 1 (measure): a short rolling list of read times per API route, in memory only, shown in the Vault
// status details so the owner can measure on the phone. A route is the URL without its query, so nothing a query
// carries is kept.

export interface ReadTiming {
  readonly route: string;
  /** Request start to body read, as the phone saw it (Access + network + Worker). */
  readonly totalMs: number;
  /** The Worker's own time from its `Server-Timing: app;dur=N` header; null when absent. */
  readonly serverMs: number | null;
  readonly at: number;
}

/** One Speed line: the latest read plus the median over the kept reads for that route. */
export interface SpeedRow {
  readonly route: string;
  readonly lastTotalMs: number;
  readonly medianTotalMs: number;
  /** Median over the kept reads that carried a Worker time; null when none did. */
  readonly medianServerMs: number | null;
  readonly count: number;
}

const MAX_ROUTES = 12;
const KEEP_PER_ROUTE = 10;
const reads = new Map<string, ReadTiming[]>();

export const routeOf = (url: string): string => url.split(/[?#]/, 1)[0]!;

export function parseServerMs(header: string | null): number | null {
  const m = /(?:^|,)\s*app;dur=(\d+(?:\.\d+)?)/.exec(header ?? '');
  return m ? Math.round(Number(m[1])) : null;
}

export function recordRead(url: string, totalMs: number, serverTiming: string | null, at = Date.now()): void {
  const route = routeOf(url);
  const kept = reads.get(route) ?? [];
  kept.push({ route, totalMs: Math.round(totalMs), serverMs: parseServerMs(serverTiming), at });
  if (kept.length > KEEP_PER_ROUTE) kept.splice(0, kept.length - KEEP_PER_ROUTE);
  reads.delete(route); // re-insert so the Map's order is oldest -> newest
  reads.set(route, kept);
  if (reads.size > MAX_ROUTES) reads.delete(reads.keys().next().value!);
}

/** Every kept read, newest first: routes ordered by their newest read, then reads newest first within each. */
export const readTimings = (): ReadTiming[] =>
  [...reads.values()].reverse().flatMap((list) => [...list].reverse());

export const clearReadTimings = (): void => reads.clear();

/** Median of an even count is the mean of the two middle values, rounded. */
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

/** One row per route, newest route first, summarising the kept reads. */
export function speedRows(timings: readonly ReadTiming[]): SpeedRow[] {
  const byRoute = new Map<string, ReadTiming[]>();
  for (const t of timings) {
    const list = byRoute.get(t.route);
    if (list) list.push(t);
    else byRoute.set(t.route, [t]);
  }
  return [...byRoute.entries()].map(([route, list]) => {
    const newestFirst = [...list].sort((a, b) => b.at - a.at);
    const serverReads = newestFirst.flatMap((t) => (t.serverMs === null ? [] : [t.serverMs]));
    return {
      route,
      lastTotalMs: newestFirst[0]!.totalMs,
      medianTotalMs: median(newestFirst.map((t) => t.totalMs)),
      medianServerMs: serverReads.length > 0 ? median(serverReads) : null,
      count: newestFirst.length,
    };
  });
}
