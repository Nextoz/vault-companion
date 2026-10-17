// Power monitor (M4c1): pure presentation helpers over the Power contracts — no provider calls, no React, no vault
// text. The caller owns the fetch (`api.getPower`) and the `unavailable` branch; every helper takes an `ok` response.
import type { PowerCo2, PowerDay, PowerResponse, PowerWindow } from '@vault-companion/contracts';

/** Spot price with exactly two decimals and a dot, e.g. 1.12 -> "1.12", 0.6 -> "0.60". */
export const formatKr = (value: number): string => value.toFixed(2);

/** One line for the card body: current price and the cheapest upcoming window, whichever parts are known. */
export function powerSummary(r: PowerResponse): string {
  if (r.status !== 'ok') return 'Prices unavailable';
  const nowPart = r.nowHour !== null ? `Now ${formatKr(r.nowHour.krPerKwh)} kr` : null;
  const cheapPart = r.upcomingWindow !== null
    ? `${r.upcomingWindow.label} ${formatKr(r.upcomingWindow.averageKrPerKwh)} kr`
    : null;
  if (nowPart !== null && cheapPart !== null) return `${nowPart} · cheapest ${cheapPart}`;
  if (cheapPart !== null) return `Cheapest ${cheapPart}`;
  if (nowPart !== null) return nowPart;
  return 'Prices unavailable';
}

/** The fetch stamp as a local "HH:mm" clock time (en-GB, h23), e.g. "16:05". */
export function powerFreshTime(fetchedAt: string, timeZone = 'Europe/Copenhagen'): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(fetchedAt));
}

/** How old a fetch may be before the card shows it as stale (a failed refresh reuses the previous rows). */
const POWER_STALE_MS = 45 * 60_000;

/** True only for an `ok` response whose rows were fetched more than 45 minutes before `nowMs`. */
export function powerStale(r: PowerResponse, nowMs: number): boolean {
  return r.status === 'ok' && nowMs - Date.parse(r.fetchedAt) > POWER_STALE_MS;
}

/** Bar colour class: the current hour, the cheapest window's hours, and the rest. */
export type BarKind = 'cheap' | 'now' | 'normal';

export interface PowerBar {
  label: string;
  krPerKwh: number;
  ratio: number;
  kind: BarKind;
}

const barKind = (start: string, nowStart: string | null, window: PowerWindow | null): BarKind => {
  if (start === nowStart) return 'now';
  if (window !== null && start >= window.start && start < window.end) return 'cheap';
  return 'normal';
};

/**
 * One bar per hour of a day's chart: the hour's share of the day's maximum price, clamped 0..1. A day whose maximum is
 * not positive (all-negative prices) draws every bar at 0 rather than an inverted chart.
 */
export function powerBars(
  day: Extract<PowerDay, { status: 'ok' }>,
  nowStart: string | null,
  window: PowerWindow | null,
): PowerBar[] {
  const max = Math.max(...day.hours.map((hour) => hour.krPerKwh));
  return day.hours.map((hour): PowerBar => ({
    label: hour.label,
    krPerKwh: hour.krPerKwh,
    ratio: max > 0 ? Math.min(Math.max(hour.krPerKwh / max, 0), 1) : 0,
    kind: barKind(hour.start, nowStart, window),
  }));
}

/** CO2 line: measured is "now", forecast keeps its qualifier, null keeps the card from guessing. */
export function co2Line(co2: PowerCo2 | null): string {
  if (co2 === null) return 'CO₂ not available';
  return co2.kind === 'measured' ? `${Math.round(co2.gPerKwh)} g/kWh now` : `${Math.round(co2.gPerKwh)} g/kWh forecast`;
}
