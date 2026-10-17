// M6: projection of the vault activity file into what the heatmap card draws. Pure: no React, no clock of its own.
// Levels are quartiles of the non-zero days, so one bulk-edit day cannot wash out the rest of the year.
import type { VaultActivityResponse } from '@vault-companion/contracts';

const ZONE = 'Europe/Copenhagen';
/** The producer runs daily; a file older than this has missed a run and is shown as stale. */
export const VAULT_ACTIVITY_STALE_MS = 26 * 60 * 60 * 1000;
export const HEATMAP_AREA_LIMIT = 5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type HeatLevel = 0 | 1 | 2 | 3 | 4;
export interface HeatCell { date: string; notes: number; col: number; row: number; level: HeatLevel; today: boolean }
export interface HeatArea { area: string; notes: number; share: number }
export interface VaultHeatmap {
  summary: string;
  streakDays: number;
  monthNotes: number;
  cols: number;
  cells: HeatCell[];
  monthLabels: { label: string; col: number }[];
  areas: HeatArea[];
  stale: boolean;
  footer: string;
}

/** Monday = 0 … Sunday = 6, from a calendar day (no time zone involved). */
function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The value at the given quantile of an ascending list (nearest rank). */
function quantile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

function freshness(generatedAt: string, stale: boolean): string {
  const at = new Date(generatedAt);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  if (!stale) return `Vault git history · Updated ${time}`;
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, day: 'numeric', month: 'short' }).format(at);
  return `Vault git history · Stale · Updated ${day} ${time}`;
}

export function projectVaultHeatmap(res: VaultActivityResponse, nowMs: number): VaultHeatmap {
  const days = res.days;
  const nonZero = days.map((d) => d.notes).filter((n) => n > 0).sort((a, b) => a - b);
  const [q1, q2, q3] = [quantile(nonZero, 0.25), quantile(nonZero, 0.5), quantile(nonZero, 0.75)];
  const level = (n: number): HeatLevel => (n === 0 ? 0 : n <= q1 ? 1 : n <= q2 ? 2 : n <= q3 ? 3 : 4);
  const offset = days.length ? weekday(days[0]!.date) : 0;
  const cells = days.map((d, index): HeatCell => ({
    date: d.date, notes: d.notes, col: Math.floor((index + offset) / 7), row: weekday(d.date), level: level(d.notes),
    today: index === days.length - 1,
  }));
  const monthLabels = cells.filter((c) => c.date.endsWith('-01'))
    .map((c) => ({ label: MONTHS[Number(c.date.slice(5, 7)) - 1]!, col: c.col }));

  const total = res.areas30d.reduce((sum, a) => sum + a.notes, 0);
  const top = res.areas30d.slice(0, HEATMAP_AREA_LIMIT);
  const restNotes = res.areas30d.slice(HEATMAP_AREA_LIMIT).reduce((sum, a) => sum + a.notes, 0);
  const share = (n: number) => (total > 0 ? n / total : 0);
  const areas: HeatArea[] = top.map((a) => ({ ...a, share: share(a.notes) }));
  if (restNotes > 0) areas.push({ area: 'Other', notes: restNotes, share: share(restNotes) });

  const stale = nowMs - Date.parse(res.generatedAt) > VAULT_ACTIVITY_STALE_MS;
  return {
    summary: `${res.currentStreak}-day streak · ${res.notesThisMonth} notes this month`,
    streakDays: res.currentStreak,
    monthNotes: res.notesThisMonth,
    cols: cells.length ? cells[cells.length - 1]!.col + 1 : 0,
    cells, monthLabels, areas, stale,
    footer: freshness(res.generatedAt, stale),
  };
}
