// ux3: pure projections for the Status sheet. No React, no fetches, no DOM: the sheet reads only what the app
// already holds and these helpers turn it into the rows it shows. Times are Europe/Copenhagen via displayTime.
import type { AiBudgetResponse, DashboardResponse, HealthResponse, ScoutsResponse, WeatherProjection } from '@vault-companion/contracts';
import { displayTime } from '../freshness.ts';
import { displayState, lastRun, type DisplayState } from '../scouts.ts';

/** The vault revision the sheet shows: the first 12 characters (the rest stays in the read model). */
export const REVISION_CHARS = 12;
/** The calendar-sync tracker belongs to its own card; the scout lines match the Scouts tab and skip it. */
export const TRIAGE_APPLIER_ID = 'triage-applier';

export function shortRevision(revision: string): string {
  return revision.slice(0, REVISION_CHARS);
}

const builtFormat = (timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' });

/** "App <commit> - built <time>"; an absent build stamp reads "unknown" rather than a guess. */
export function buildLine(commit: string, builtAt: string | null, timeZone: string): string {
  return `App ${commit} \u00b7 built ${builtAt === null ? 'unknown' : builtFormat(timeZone).format(new Date(builtAt))}`;
}

/** Owner wording (B3): a degraded run "ran with problems"; the other states keep their names. */
export function stateLabel(state: DisplayState): string {
  return state === 'Degraded' ? 'Ran with problems' : state;
}

export interface ScoutRow {
  readonly file: string;
  readonly name: string;
  readonly state: DisplayState;
  readonly run: string | null;
}

/** One line per scout: state chip plus last run, from the same read the Scouts tab makes. */
export function scoutRows(scouts: ScoutsResponse): ScoutRow[] {
  return scouts.scouts
    .filter((entry) => !(entry.state === 'ok' && entry.status.scoutId === TRIAGE_APPLIER_ID))
    .map((entry) => {
      const status = entry.state === 'ok' ? entry.status : null;
      return {
        file: entry.file,
        name: status?.displayName ?? entry.file,
        state: displayState(status, scouts.now),
        run: status ? lastRun(status) : null,
      };
    });
}

export interface SourceRow {
  readonly label: string;
  /** The source's own time, or null when the app has no copy of that read yet (shown as "-"). */
  readonly time: string | null;
}

export interface SourceReads {
  /** The Dashboard answer the app already holds, when the user has opened that tab. */
  readonly dashboard: DashboardResponse | null;
  /** The Health answer the app already holds, when the user has opened that tab. */
  readonly health: HealthResponse | null;
}

const shownAt = (value: string, now: number, timeZone: string) => displayTime(Date.parse(value), now, timeZone);

const weatherRows = (projection: WeatherProjection | null, now: number, timeZone: string): SourceRow[] =>
  projection
    ? projection.models.map((model) => ({ label: model.label, time: shownAt(model.retrievedAt, now, timeZone) }))
    : [{ label: 'Weather models', time: null }];

/**
 * The Data sources group: weather models, markets and the health export, each with the time the app already knows.
 * A source with no in-memory copy yet shows "-"; a new endpoint is never added to fill it in.
 */
export function dataSourceRows(reads: SourceReads, now: number, timeZone: string): SourceRow[] {
  const weatherCard = reads.dashboard?.cards.find((card) => card.id === 'weather');
  const marketCard = reads.dashboard?.cards.find((card) => card.id === 'market');
  return [
    ...weatherRows(weatherCard?.status === 'ok' ? weatherCard.projection : null, now, timeZone),
    {
      label: 'Markets',
      time: marketCard?.status === 'ok' ? shownAt(marketCard.ticker.providerTime, now, timeZone) : null,
    },
    { label: 'Health export', time: reads.health?.status === 'ok' ? reads.health.day ?? null : null },
  ];
}

// AB2: the AI budget card. One row per provider from the read-only JSON; a missing file is an empty list, never an
// error. Thresholds are the owner's (per kind); colours land in `tone`, text stays verbatim next to its unit.
export type BudgetTone = 'ok' | 'warn' | 'bad';

/** GeneratedAt older than this is shown as stale rather than a fresh "Updated HH:MM" time. */
export const BUDGET_STALE_MS = 2 * 60 * 60 * 1000;

export interface BudgetRow {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly tone: BudgetTone;
  /** At least two daily points, oldest first; null when the card draws no sparkline. */
  readonly history: readonly number[] | null;
  readonly reset: string | null;
}

/** Percentages and counts read "58" / "18", not "58.0"; money always keeps two decimals. */
const compact = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const budgetValue = (kind: AiBudgetResponse['providers'][number]['kind'], value: number, unit: string | null): string => {
  if (kind === 'percent') return `${compact(value)} % used`;
  if (kind === 'money') return `${unit ?? '$'}${value.toFixed(2)} left`;
  return `${compact(value)}${unit ? ` ${unit}` : ''} left`;
};

const budgetTone = (kind: AiBudgetResponse['providers'][number]['kind'], value: number): BudgetTone => {
  if (kind === 'percent') return value >= 90 ? 'bad' : value >= 70 ? 'warn' : 'ok';
  if (kind === 'money') return value < 2 ? 'bad' : value < 5 ? 'warn' : 'ok';
  return value <= 2 ? 'bad' : 'ok';
};

/** "resets in 2 d 4 h" (relative, so no timezone is needed); null when there is no reset or it has passed. */
export function budgetReset(resetsAt: string | null, now: number): string | null {
  if (resetsAt === null) return null;
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `resets in ${days} d${hours > 0 ? ` ${hours} h` : ''}`;
  return hours > 0 ? `resets in ${hours} h` : null;
}

/** One row per provider from the read-only response; a missing file (`null`) is an empty list, never a guess. */
export function budgetRows(response: AiBudgetResponse | null, now: number, _timeZone: string): BudgetRow[] {
  if (!response) return [];
  return response.providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    value: budgetValue(provider.kind, provider.value, provider.unit),
    tone: budgetTone(provider.kind, provider.value),
    history: provider.history && provider.history.length >= 2 ? provider.history : null,
    reset: budgetReset(provider.resetsAt, now),
  }));
}

export interface BudgetFreshness {
  readonly text: string;
  readonly stale: boolean;
}

/** "Updated HH:MM" (Copenhagen), turning yellow "Stale (> 2 h)" once generatedAt is more than two hours old. */
export function budgetFreshness(response: AiBudgetResponse | null, now: number, timeZone: string): BudgetFreshness | null {
  if (!response) return null;
  const at = Date.parse(response.generatedAt);
  if (now - at > BUDGET_STALE_MS) return { text: 'Stale (> 2 h)', stale: true };
  return { text: `Updated ${displayTime(at, now, timeZone)}`, stale: false };
}
