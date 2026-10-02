// SP step 1 (measure): the last read time per API route, in memory only, shown in the Vault status details so the
// owner can measure on the phone. A route is the URL without its query, so nothing a query carries is kept.

export interface ReadTiming {
  readonly route: string;
  /** Request start to body read, as the phone saw it (Access + network + Worker). */
  readonly totalMs: number;
  /** The Worker's own time from its `Server-Timing: app;dur=N` header; null when absent. */
  readonly serverMs: number | null;
  readonly at: number;
}

const MAX_ROUTES = 12;
const latest = new Map<string, ReadTiming>();

export const routeOf = (url: string): string => url.split(/[?#]/, 1)[0]!;

export function parseServerMs(header: string | null): number | null {
  const m = /(?:^|,)\s*app;dur=(\d+(?:\.\d+)?)/.exec(header ?? '');
  return m ? Math.round(Number(m[1])) : null;
}

export function recordRead(url: string, totalMs: number, serverTiming: string | null, at = Date.now()): void {
  const route = routeOf(url);
  latest.delete(route); // re-insert so the Map's order is oldest → newest
  latest.set(route, { route, totalMs: Math.round(totalMs), serverMs: parseServerMs(serverTiming), at });
  if (latest.size > MAX_ROUTES) latest.delete(latest.keys().next().value!);
}

/** Newest first. */
export const readTimings = (): ReadTiming[] => [...latest.values()].reverse();

export const clearReadTimings = (): void => latest.clear();
