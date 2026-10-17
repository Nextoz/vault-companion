// M1a: pure projection for the "Credit burn-down" monitor. Web only, no React, no fetches: the Scaleway voucher (a
// money row in the AI budget) is spent down against its own daily cost history. Missing days are never zero-filled
// and an unreadable voucher is a typed reason, never a guess.
import type { AiBudgetResponse, AiUsageResponse } from '@vault-companion/contracts';
import { aiUsageAddDays, aiUsageDayLabel } from '../ai-usage.ts';
import { budgetFreshness, budgetRows, type BudgetRow } from '../status-sheet.ts';

const DAY_MS = 86_400_000;
const SCALEWAY_ID = 'scaleway';
const BURN_WINDOW_DAYS = 7;
const CHART_WINDOW_DAYS = 30;
/** The vault's day rolls over at 03:00 local: an instant before then still belongs to the previous day. */
const DAY_BOUNDARY_HOUR = 3;

/** '€' is shown as "EUR"; any other unit is left verbatim, and a null unit stays empty. */
const displayUnit = (unit: string | null): string => (unit === '€' ? 'EUR' : unit ?? '');

/** "EUR 63" for whole euros, "EUR 12.5" otherwise; an empty unit keeps the bare number rather than inventing one. */
const money = (unit: string, value: number): string => {
  const shown = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  return unit ? `${unit} ${shown}` : shown;
};

/** The instant's calendar day and hour as read in `timeZone`; the phone's own zone is never consulted. */
const localDay = (timeZone: string, ms: number): { iso: string; hour: number } => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return { iso: `${at('year')}-${at('month')}-${at('day')}`, hour: Number(at('hour')) };
};

/** The day the voucher expires on: its own local day, pulled back across the 03:00 boundary. */
const expiryDay = (timeZone: string, resetMs: number): string => {
  const { iso, hour } = localDay(timeZone, resetMs);
  return hour < DAY_BOUNDARY_HOUR ? aiUsageAddDays(iso, -1) : iso;
};

export interface CreditBurnFreshness { readonly text: string; readonly stale: boolean; }
export interface CreditBurnPoint { readonly date: string; readonly left: number; }

export interface CreditBurnBurn {
  readonly avgPerDay: number;
  readonly recordedDays: number;
  readonly projected: number;
  readonly onPace: boolean;
  readonly paceText: string;
}

export interface CreditBurnRing { readonly fraction: number | null; }
export interface CreditBurnChart {
  readonly points: readonly CreditBurnPoint[];
  readonly idealFrom: CreditBurnPoint | null;
  readonly idealTo: CreditBurnPoint | null;
}
/** A sibling provider's budget row, carrying its own percentage when the row is a percentage one. */
export interface CreditBurnOther extends BudgetRow { readonly percent: number | null; }

export interface CreditBurnOk {
  readonly kind: 'ok';
  readonly left: number;
  readonly limit: number | null;
  readonly unit: string;
  readonly expiresLabel: string;
  readonly daysLeft: number;
  readonly burn: CreditBurnBurn | null;
  readonly ring: CreditBurnRing;
  readonly chart: CreditBurnChart;
  readonly others: readonly CreditBurnOther[];
  readonly summary: string;
  readonly freshness: CreditBurnFreshness | null;
}

export interface CreditBurnUnavailable {
  readonly kind: 'unavailable';
  readonly reason: string;
  readonly freshness: CreditBurnFreshness | null;
}

export type CreditBurnView = CreditBurnOk | CreditBurnUnavailable;

const freshnessFor = (budget: AiBudgetResponse | null, now: number, timeZone: string): CreditBurnFreshness | null => {
  const base = budgetFreshness(budget, now, timeZone);
  return base ? { text: `Scaleway console · vendor APIs · ${base.text}`, stale: base.stale } : null;
};

const unavailable = (reason: string, budget: AiBudgetResponse | null, now: number, timeZone: string): CreditBurnUnavailable =>
  ({ kind: 'unavailable', reason, freshness: freshnessFor(budget, now, timeZone) });

interface RecordedCost { readonly date: string; readonly cost: number; }

/** The Scaleway days the file actually carried inside [start, end], oldest first; absent days stay absent. */
const recordedCosts = (usage: AiUsageResponse | null, start: string, end: string): RecordedCost[] => {
  const days = usage?.providers[SCALEWAY_ID]?.days ?? [];
  return days
    .filter((day) => day.date >= start && day.date <= end)
    .map((day) => ({ date: day.date, cost: day.cost }))
    .sort((a, b) => a.date.localeCompare(b.date));
};

/** Backwards reconstruction: the balance after day `d` is what is left plus every recorded cost after `d`. */
const chartFor = (usage: AiUsageResponse | null, today: string, left: number, expiry: string): CreditBurnChart => {
  const days = recordedCosts(usage, aiUsageAddDays(today, -(CHART_WINDOW_DAYS - 1)), today);
  if (days.length === 0) return { points: [], idealFrom: null, idealTo: null };
  const points: CreditBurnPoint[] = [];
  let after = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    points.push({ date: days[index]!.date, left: left + after });
    after += days[index]!.cost;
  }
  points.reverse();
  return { points, idealFrom: points[0] ?? null, idealTo: { date: expiry, left: 0 } };
};

/** The pace read over the last seven local days; null when the file recorded no Scaleway day at all. */
const burnFor = (
  usage: AiUsageResponse | null, today: string, left: number, resetMs: number, now: number, unit: string, label: string,
): CreditBurnBurn | null => {
  const recorded = recordedCosts(usage, aiUsageAddDays(today, -(BURN_WINDOW_DAYS - 1)), today);
  if (recorded.length === 0) return null;
  const avgPerDay = recorded.reduce((sum, day) => sum + day.cost, 0) / recorded.length;
  const projected = left - avgPerDay * ((resetMs - now) / DAY_MS);
  const onPace = projected >= 0;
  const paceText = onPace
    ? `On pace: ~${money(unit, Math.round(Math.abs(projected)))} left on ${label}`
    : `Short ~${money(unit, Math.round(Math.abs(projected)))} by ${label}`;
  return { avgPerDay, recordedDays: recorded.length, projected, onPace, paceText };
};

/**
 * The monitor's whole read model: a typed reason when the voucher cannot be measured, otherwise the remaining
 * balance, its ring fraction, the pace against the expiry day, the reconstructed chart and the sibling rows.
 */
export function creditBurn(
  budget: AiBudgetResponse | null, usage: AiUsageResponse | null, now: number, timeZone: string,
): CreditBurnView {
  if (!budget) return unavailable('AI budget could not be read.', budget, now, timeZone);
  const provider = budget.providers.find((entry) => entry.id === SCALEWAY_ID && entry.kind === 'money');
  if (!provider) return unavailable('No Scaleway voucher in the budget file.', budget, now, timeZone);
  if (provider.resetsAt === null) return unavailable('Scaleway voucher has no expiry date.', budget, now, timeZone);
  const resetMs = Date.parse(provider.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= now) return unavailable('The Scaleway voucher has expired.', budget, now, timeZone);

  const unit = displayUnit(provider.unit);
  const expiry = expiryDay(timeZone, resetMs);
  const left = provider.value;
  const daysLeft = Math.ceil((resetMs - now) / DAY_MS);
  const burn = burnFor(usage, localDay(timeZone, now).iso, left, resetMs, now, unit, aiUsageDayLabel(expiry));
  const pace = burn === null ? 'pace unknown' : burn.onPace ? 'on pace' : `short ~${money(unit, Math.round(Math.abs(burn.projected)))}`;
  const others: CreditBurnOther[] = budgetRows(budget, now, timeZone)
    .filter((row) => row.id !== SCALEWAY_ID)
    .map((row) => {
      const source = budget.providers.find((entry) => entry.id === row.id);
      return { ...row, percent: source?.kind === 'percent' ? source.value : null };
    });

  return {
    kind: 'ok',
    left,
    limit: provider.limit,
    unit,
    expiresLabel: aiUsageDayLabel(expiry),
    daysLeft,
    burn,
    ring: { fraction: provider.limit ? Math.min(Math.max(left / provider.limit, 0), 1) : null },
    chart: chartFor(usage, localDay(timeZone, now).iso, left, expiry),
    others,
    summary: `Scaleway ${money(unit, left)} left · ${daysLeft} d · ${pace}`,
    freshness: freshnessFor(budget, now, timeZone),
  };
}
