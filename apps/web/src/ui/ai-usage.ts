// AB3b: pure projection for the Dashboard's AI usage panel. Tokens are output + cache-write only (never cache-read),
// calls for Jev, cost for DeepSeek and Scaleway; a day is shown only when the vault file carried it, never zero-filled.
import type { AiBudgetResponse, AiUsageDay, AiUsageProvider, AiUsageResponse } from '@vault-companion/contracts';
import { displayTime } from '../freshness.ts';
import { BUDGET_STALE_MS, budgetRows, type BudgetRow, type BudgetTone } from './status-sheet.ts';

export type AiUsageMetric = 'tokens' | 'calls' | 'cost';
export type AiUsageRange = 7 | 30;

/** Which daily number a provider is measured in. Unknown ids fall back to calls, so an added provider still renders. */
const METRIC_BY_ID: Record<string, AiUsageMetric> = {
  claude: 'tokens', 'claude-code': 'tokens', claude_code: 'tokens', codex: 'tokens',
  jev: 'calls', deepseek: 'cost', scaleway: 'cost',
};

export function aiUsageMetric(id: string): AiUsageMetric {
  return METRIC_BY_ID[id.trim().toLowerCase()] ?? 'calls';
}

/** Tokens = output + cache-write. Cache-read is deliberately excluded: it is not the usage this panel counts. */
export function aiUsageDayValue(metric: AiUsageMetric, day: AiUsageDay): number {
  if (metric === 'tokens') return day.outputTokens + day.cacheWriteTokens;
  if (metric === 'cost') return day.cost;
  return day.calls;
}

const DAY_MS = 86_400_000;
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const aiUsageAddDays = (date: string, days: number): string => toIso(dayMs(date) + days * DAY_MS);

const shortDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', day: 'numeric', month: 'short' });
/** "3 Sep" from an ISO date, UTC so the shown day is the file's own day. */
export function aiUsageDayLabel(date: string): string {
  const parts = shortDay.formatToParts(dayMs(date));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('day')} ${value('month')}`.trim();
}

export interface AiUsagePoint { readonly date: string; readonly value: number; }

export interface AiUsageTile {
  readonly id: string;
  readonly title: string;
  readonly metric: AiUsageMetric;
  readonly currency: string | null;
  /** Only the days the file carried inside the window, oldest first; no invented points. */
  readonly points: readonly AiUsagePoint[];
  /** First day the file carried at all, even when it is older than the window; null with no days. */
  readonly historyStart: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  /** The budget row's own text and threshold tone, verbatim; null when the budget has no row for this provider. */
  readonly left: string | null;
  readonly leftTone: BudgetTone | null;
  /** Said plainly when the window is not fully covered; null when it is. */
  readonly note: string | null;
}

export interface AiUsageFreshness { readonly text: string; readonly stale: boolean; }

/** "Updated HH:MM" (Copenhagen); past the budget's two hours it also says so rather than posing as fresh. */
export function aiUsageFreshness(usage: AiUsageResponse | null, now: number, timeZone: string): AiUsageFreshness | null {
  if (!usage) return null;
  const at = Date.parse(usage.generatedAt);
  if (!Number.isFinite(at)) return { text: 'Update time unknown', stale: true };
  const shown = `Updated ${displayTime(at, now, timeZone)}`;
  return now - at > BUDGET_STALE_MS ? { text: `${shown} \u00b7 stale (> 2 h)`, stale: true } : { text: shown, stale: false };
}

const tileFor = (id: string, provider: AiUsageProvider, budgetById: ReadonlyMap<string, BudgetRow>, range: AiUsageRange): AiUsageTile => {
  const title = provider.label?.trim() ? provider.label : id;
  const metric = aiUsageMetric(id);
  const row = budgetById.get(id) ?? null;
  const days = provider.days
    .filter((day) => Number.isFinite(dayMs(day.date)))
    .slice()
    .sort((a, b) => dayMs(a.date) - dayMs(b.date));
  const left = row ? row.value : null;
  const leftTone = row ? row.tone : null;
  if (days.length === 0) {
    return { id, title, metric, currency: provider.currency ?? null, points: [], historyStart: null,
      windowStart: null, windowEnd: null, left, leftTone, note: `${title}: no history yet` };
  }
  const windowEnd = days[days.length - 1]!.date;
  const windowStart = aiUsageAddDays(windowEnd, -(range - 1));
  const points = days
    .filter((day) => day.date >= windowStart)
    .map((day) => ({ date: day.date, value: aiUsageDayValue(metric, day) }));
  const historyStart = days[0]!.date;
  const note = historyStart > windowStart ? `${title}: history starts ${aiUsageDayLabel(historyStart)}` : null;
  return { id, title, metric, currency: provider.currency ?? null, points, historyStart, windowStart, windowEnd, left, leftTone, note };
};

export interface AiUsageView { readonly tiles: readonly AiUsageTile[]; readonly freshness: AiUsageFreshness | null; }

/** One tile per provider the response carried, in the file's order; unknown ids stay and render with their id. */
export function aiUsageTiles(
  usage: AiUsageResponse | null, budget: AiBudgetResponse | null, now: number, timeZone: string, range: AiUsageRange,
): AiUsageView {
  if (!usage) return { tiles: [], freshness: null };
  const budgetById = new Map(budgetRows(budget, now, timeZone).map((row) => [row.id, row]));
  return {
    tiles: Object.entries(usage.providers).map(([id, provider]) => tileFor(id, provider, budgetById, range)),
    freshness: aiUsageFreshness(usage, now, timeZone),
  };
}

const integer = new Intl.NumberFormat('en-US');

/** Cost keeps its currency: a three-letter code formats by locale, any other unit is prefixed as-is. */
export function formatAiUsageValue(metric: AiUsageMetric, currency: string | null, value: number): string {
  if (metric !== 'cost') return integer.format(value);
  if (currency && /^[A-Za-z]{3}$/.test(currency)) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(value);
  }
  return currency ? `${currency}${value.toFixed(2)}` : value.toFixed(2);
}

export interface AiUsageSpark { readonly segments: readonly (readonly string[])[]; readonly dots: readonly string[]; }

/** SVG geometry for one tile. Days are placed by date, so a missing day stays a gap; single days become dots. */
export function aiUsageSpark(tile: AiUsageTile, width: number, height: number, pad: number): AiUsageSpark {
  const { points, windowStart, windowEnd } = tile;
  if (points.length === 0 || windowStart === null || windowEnd === null) return { segments: [], dots: [] };
  const from = dayMs(windowStart);
  const span = dayMs(windowEnd) - from || 1;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const vspan = Math.max(...values) - min || 1;
  const x = (date: string) => pad + ((dayMs(date) - from) / span) * (width - 2 * pad);
  const y = (value: number) => height - pad - ((value - min) / vspan) * (height - 2 * pad);
  const runs: string[][] = [];
  let run: string[] = [];
  let previous: number | null = null;
  for (const point of points) {
    const at = dayMs(point.date);
    if (previous !== null && at - previous !== DAY_MS && run.length > 0) { runs.push(run); run = []; }
    run.push(`${x(point.date).toFixed(1)},${y(point.value).toFixed(1)}`);
    previous = at;
  }
  if (run.length > 0) runs.push(run);
  const dots = runs.filter((entry) => entry.length === 1).map((entry) => entry[0]!);
  return { segments: runs.filter((entry) => entry.length >= 2), dots };
}
