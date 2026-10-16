// M3: the Scout heartbeat projection. Pure: no React, no fetch, no DOM. "now" is the server's own res.now, so a
// skewed phone clock can never repaint a scout as fresh; days and times are the owner's time zone.
import type { ScoutStatus, ScoutsResponse } from '@vault-companion/contracts';
import { displayState, type DisplayState } from '../../scouts.ts';
import { TRIAGE_APPLIER_ID } from '../status-sheet.ts';

/** How many local days a row's squares cover: oldest first, ending on today. */
export const HEARTBEAT_DAYS = 14;

/** A square's day status - the worst run of that day, or 'none' when no run happened that day (never invented). */
export type HeartbeatCell = 'ok' | 'degraded' | 'failed' | 'none';
/** A row's health, mirroring `displayState`; 'none' means no status file has been written yet. */
export type HeartbeatState = 'ok' | 'degraded' | 'failed' | 'stale' | 'none';

export interface HeartbeatCounts {
  readonly ok: number;
  readonly degraded: number;
  readonly failed: number;
  readonly stale: number;
}

export interface HeartbeatRow {
  readonly id: string;
  readonly name: string;
  readonly state: HeartbeatState;
  /** "HH:MM" when the last attempt was today (local), "N d ago" otherwise, "-" when there was none. */
  readonly last: string;
  readonly cells: readonly HeartbeatCell[];
}

export interface ScoutHeartbeat {
  readonly rows: readonly HeartbeatRow[];
  readonly counts: HeartbeatCounts;
  /** "8 ok - 2 degraded - 1 failed" (a zero part is dropped); "N ok - all healthy" when nothing is wrong. */
  readonly summary: string;
  /** "Scout status files - Updated HH:MM" from res.now. */
  readonly freshness: string;
}

const STATE: Record<DisplayState, HeartbeatState> = {
  Healthy: 'ok',
  Degraded: 'degraded',
  Failed: 'failed',
  Stale: 'stale',
  Running: 'ok',
  'No status yet': 'none',
};

/** The local calendar day ("YYYY-MM-DD") an instant falls on. */
const localDay = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

const localTime = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

const asUtc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));

/** The count local days ending on today, oldest first. Calendar arithmetic in UTC, so no 23/25-hour day shifts a key. */
function recentDays(now: number, timeZone: string, count: number): string[] {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  const base = Date.UTC(part('year'), part('month') - 1, part('day'));
  return Array.from({ length: count }, (_, index) =>
    new Date(base - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10));
}

const cellRank: Record<HeartbeatCell, number> = { none: 0, ok: 1, degraded: 2, failed: 3 };
const runCell = (status: ScoutStatus['history'][number]['status']): HeartbeatCell =>
  status === 'failed' ? 'failed' : status === 'degraded' ? 'degraded' : 'ok';

/** Each day's cell is the worst of that day's history runs: failed > degraded > success/running = ok, none if empty. */
function cellsFor(history: ScoutStatus['history'], days: readonly string[], timeZone: string): HeartbeatCell[] {
  return days.map((day) => {
    let worst: HeartbeatCell = 'none';
    for (const run of history) {
      const at = Date.parse(run.at);
      if (!Number.isFinite(at) || localDay(at, timeZone) !== day) continue;
      const cell = runCell(run.status);
      if (cellRank[cell] > cellRank[worst]) worst = cell;
    }
    return worst;
  });
}

const lastText = (attempt: string | null, now: number, timeZone: string): string => {
  const at = attempt === null ? NaN : Date.parse(attempt);
  if (!Number.isFinite(at)) return '\u2014';
  const day = localDay(at, timeZone);
  if (day === localDay(now, timeZone)) return localTime(at, timeZone);
  const days = Math.round((asUtc(localDay(now, timeZone)) - asUtc(day)) / 86_400_000);
  return `${Math.max(1, days)} d ago`;
};

const summaryText = (counts: HeartbeatCounts): string => {
  const parts = [`${counts.ok} ok`];
  if (counts.degraded > 0) parts.push(`${counts.degraded} degraded`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.stale > 0) parts.push(`${counts.stale} stale`);
  const healthy = counts.degraded === 0 && counts.failed === 0 && counts.stale === 0;
  return parts.join(' \u00b7 ') + (healthy ? ' \u00b7 all healthy' : '');
};

/**
 * The heartbeat the Boards monitor draws: one row per scheduled scout, 14 local-day squares each, a count line, a
 * freshness line. The calendar-sync tracker is skipped like `scoutRows`; an unreadable file is a failed row, never a
 * guess. "now" is res.now, so staleness never depends on the phone clock.
 */
export function scoutHeartbeat(res: ScoutsResponse, timeZone: string): ScoutHeartbeat {
  const now = Date.parse(res.now);
  const days = recentDays(now, timeZone, HEARTBEAT_DAYS);
  const rows: HeartbeatRow[] = [];
  for (const entry of res.scouts) {
    if (entry.state === 'ok' && entry.status.scoutId === TRIAGE_APPLIER_ID) continue;
    if (entry.state === 'unreadable') {
      rows.push({ id: entry.file, name: entry.file, state: 'failed', last: '\u2014', cells: days.map(() => 'none') });
      continue;
    }
    rows.push({
      id: entry.status.scoutId,
      name: entry.status.displayName,
      state: STATE[displayState(entry.status, res.now)],
      last: lastText(entry.status.lastAttemptAt, now, timeZone),
      cells: cellsFor(entry.status.history, days, timeZone),
    });
  }
  const count = (state: HeartbeatState) => rows.filter((row) => row.state === state).length;
  const counts: HeartbeatCounts = { ok: count('ok'), degraded: count('degraded'), failed: count('failed'), stale: count('stale') };
  return { rows, counts, summary: summaryText(counts), freshness: `Scout status files \u00b7 Updated ${localTime(now, timeZone)}` };
}
