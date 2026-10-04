// UX2: the Today morning card's one-liners are a pure projection of reads the card already holds - no fetch here.
// A line with nothing to say is omitted (never a "Not configured" placeholder); the tasks line is always present.
// UX7: the weather line is plain day language plus the run window's own wording, and one research entry replaces the
// old reading-brief line (its content now lives in the Morning Brief sheet). Pure.
import { effectiveRadarDecisions, WEATHER_TIME_ZONE } from '@vault-companion/contracts';
import type { MorningBriefMissingResponse, MorningBriefReadResponse, MorningBriefResponse, RadarResponse, ScoutsResponse, WeatherProjection, WeatherResponse, WeatherRunWindow } from '@vault-companion/contracts';
import type { QueueItem } from '../queue/queue.ts';
import { attentionCount, pluralise, scoutsNeedAttention } from '../scouts.ts';
import { dateIn } from '../time.ts';
import { localDate, latestCheckin } from './MoodCard.tsx';
import { needsYouText, type NeedsYouRow } from './needs-you.ts';

/** One line on the morning card; `id` is both the React key and which detail the line opens. */
export type MorningLineId = 'needs' | 'weather' | 'scouts' | 'research' | 'triage' | 'tasks';

export interface MorningLine {
  readonly id: MorningLineId;
  readonly text: string;
}

/** One row the Morning Brief (MB2) adds above the existing morning lines. `todo` rows open Tasks; nothing else does. */
export interface BriefLine {
  readonly id: string;
  readonly text: string;
  /** The small "Fallback brief" marker shown when the brief was written without the model. */
  readonly marker: boolean;
  readonly todo: boolean;
}

/** "HH:MM" of an ISO instant with an offset, rendered in that offset - never in the device's own zone. */
const wallClock = (instant: string): string => instant.slice(11, 16);

/**
 * MB2: the brief's rows, ABOVE the card's existing lines. Null when there is no usable brief for today (fetch
 * failure, invalid response, or a stale date), so the card falls back to its current lines unchanged. Pure.
 */
export function briefLines(file: MorningBriefResponse | null, today: string): BriefLine[] | null {
  if (file === null || file.date !== today) return null;
  const lines: BriefLine[] = [];
  if (file.source === 'fallback') lines.push({ id: 'fallback', text: 'Fallback brief', marker: true, todo: false });
  lines.push({ id: 'day', text: file.brief.dayLine, marker: false, todo: false });
  if (file.brief.stateLine !== undefined) lines.push({ id: 'state', text: file.brief.stateLine, marker: false, todo: false });
  file.brief.gaps.forEach((gap, i) => {
    if (gap.suggestion === undefined) return;
    lines.push({ id: `gap-${i}`, text: `${wallClock(gap.start)}-${wallClock(gap.end)}  ${gap.suggestion}`, marker: false, todo: false });
  });
  file.brief.todos.forEach((todo) => {
    lines.push({ id: `todo-${todo.id}`, text: todo.firstStep === undefined ? todo.text : `${todo.text} - ${todo.firstStep}`, marker: false, todo: true });
  });
  if (file.brief.encouragement !== undefined) lines.push({ id: 'encouragement', text: file.brief.encouragement, marker: false, todo: false });
  return lines;
}

/** True only for the ADR-0055 "no brief file today" response. */
export function isMissingBrief(file: MorningBriefReadResponse): file is MorningBriefMissingResponse {
  return 'kind' in file && file.kind === 'missing';
}

/** ADR-0055: no brief file today. The reason is the job's fixed status error code, never free text. */
export function missingBriefText(reason: string | null): string {
  return reason === null ? 'No brief yet' : `No brief yet - ${reason}`;
}

/** The projections the card has already loaded, plus the client-side counts it can compute on its own. */
export interface MorningCardFacts {
  readonly weather: WeatherResponse | null;
  /** A failed weather read (offline/error): still offer the line so the panel, and its retry, stays reachable. */
  readonly weatherFailed: boolean;
  readonly scouts: ScoutsResponse | null;
  readonly eventsToTriage: number;
  readonly tasksToday: number;
  /** UX7: research highlights left after the Radar Remove/Keep decisions; null hides the line (read unavailable). */
  readonly researchHighlights: number | null;
  /** NY1: rows for the "Needs you" sheet, already built by the card; empty hides the line. */
  readonly needs: readonly NeedsYouRow[];
}

/** One-line way into the Tasks screen; kept verbatim from UX1b so "No tasks today" never became a placeholder. */
export function tasksTodayText(count: number): string {
  if (count === 0) return 'No tasks today';
  return count === 1 ? '1 task today' : `${count} tasks today`;
}

/** The Copenhagen local hour (0-23) of an instant; -1 when unreadable, so it never lands inside a daytime window. */
function hourIn(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const value = Number(parts.find((part) => part.type === 'hour')?.value ?? Number.NaN);
  return Number.isInteger(value) ? value : -1;
}

/**
 * UX7: the day's plain-weather glance - "Rain all day · 11° · breezy", "Dry · 14°". Rain is read from the day's
 * Copenhagen daytime points (08:00-20:00), temperature is the warmest returned, and wind shows only when it matters.
 * A gap in the forecast stays "Rain unknown" - never a guess. Pure.
 */
export function weatherDayGlance(projection: WeatherProjection): string {
  const day = dateIn(projection.now, WEATHER_TIME_ZONE);
  const points = projection.models.flatMap((series) => series.points)
    .filter((point) => dateIn(point.time, WEATHER_TIME_ZONE) === day)
    .filter((point) => { const hour = hourIn(point.time, WEATHER_TIME_ZONE); return hour >= 8 && hour < 20; });
  const rains = points.map((point) => point.rainMm).filter((value): value is number => value !== null);
  const temps = points.map((point) => point.temperatureC).filter((value): value is number => value !== null);
  const winds = points.map((point) => point.windMs).filter((value): value is number => value !== null);
  const rain = rains.length === 0 ? 'Rain unknown'
    : rains.every((mm) => mm < 0.1) ? 'Dry' : rains.every((mm) => mm >= 0.1) ? 'Rain all day' : 'Showers';
  // A gap is never filled with the run window's narrower range unless no daytime temperature was returned at all.
  const temp = temps.length > 0 ? Math.round(Math.max(...temps))
    : projection.runWindow === null ? null : Math.round(projection.runWindow.temperatureRangeC.max);
  const windMax = winds.length > 0 ? Math.max(...winds) : projection.runWindow?.windRangeMs.max ?? null;
  const wind = windMax === null ? null : windMax > 7.9 ? 'strong wind' : windMax > 3.4 ? 'breezy' : null;
  return [rain, temp === null ? null : `${temp}°`, wind].filter((part): part is string => part !== null).join(' · ');
}

/**
 * UX7: the chosen run window's own wording - "Run window 08-10, dry". Null when the forecast chose no window, so the
 * card simply omits it (never a bare "No daytime window"). Pure.
 */
export function runWindowGlance(window: WeatherRunWindow | null): string | null {
  if (window === null) return null;
  const start = String(hourIn(window.start, WEATHER_TIME_ZONE)).padStart(2, '0');
  const end = String(hourIn(window.end, WEATHER_TIME_ZONE)).padStart(2, '0');
  const condition = window.rainMm === null ? 'rain unknown' : window.rainMm < 0.1 ? 'dry' : 'wet';
  return `Run window ${start}-${end}, ${condition}`;
}

/** The weather line: the day's plain language, plus the run window's own wording when one exists. Pure. */
export function weatherLine(projection: WeatherProjection): string {
  const window = runWindowGlance(projection.runWindow);
  return window === null ? weatherDayGlance(projection) : `${weatherDayGlance(projection)} · ${window}`;
}

/** UX7: the Radar cards left after Remove/Keep - the same filter `deriveRadar` shows as "papers ranked". Pure. */
export function radarHighlights(read: RadarResponse): number {
  const decisions = effectiveRadarDecisions(read.decisions);
  return read.papers.filter((paper) => !decisions.removed.has(paper.paperId) && !decisions.kept.has(paper.paperId)).length;
}

/** One research entry: "Research · 3 highlights"; "No research highlights" keeps Radar reachable when nothing ranked. */
export function researchHighlightsText(count: number): string {
  if (count === 0) return 'No research highlights';
  return count === 1 ? 'Research · 1 highlight' : `Research · ${count} highlights`;
}

/** UX7: the Morning Brief sheet's own state. A usable brief for today yields its rows; anything else (no file, a stale
 *  date, or a failed read) yields the ADR-0055 reason line and no rows. Pure. */
export interface MorningBriefSheetState {
  readonly missing: string | null;
  readonly lines: readonly BriefLine[];
}

export function morningBriefSheet(brief: MorningBriefReadResponse | null, today: string): MorningBriefSheetState {
  if (brief !== null && !isMissingBrief(brief)) {
    const lines = briefLines(brief, today);
    if (lines !== null) return { missing: null, lines };
  }
  return { missing: missingBriefText(brief !== null && isMissingBrief(brief) ? brief.statusError : null), lines: [] };
}

/** Needs you, weather, scouts, the research entry, events and the tasks line - each omitted when it has nothing to say. */
export function morningLines(facts: MorningCardFacts): MorningLine[] {
  const lines: MorningLine[] = [];
  // NY1: what only the owner can decide leads the card; nothing to decide hides the line entirely.
  if (facts.needs.length > 0) lines.push({ id: 'needs', text: needsYouText(facts.needs.length) });
  // An unavailable forecast is still something to say: the line carries the honest reason, not a placeholder.
  if (facts.weather) {
    lines.push({ id: 'weather', text: facts.weather.status === 'ok'
      ? weatherLine(facts.weather.projection) : facts.weather.message });
  } else if (facts.weatherFailed) {
    lines.push({ id: 'weather', text: 'Weather unavailable' });
  }
  const problems = facts.scouts ? attentionCount(facts.scouts) : 0;
  if (problems > 0) lines.push({ id: 'scouts', text: scoutsNeedAttention(problems) });
  if (facts.researchHighlights !== null) lines.push({ id: 'research', text: researchHighlightsText(facts.researchHighlights) });
  if (facts.eventsToTriage > 0) lines.push({ id: 'triage', text: pluralise(facts.eventsToTriage, 'new event') });
  lines.push({ id: 'tasks', text: tasksTodayText(facts.tasksToday) });
  return lines;
}

/** False once a check-in (not undone) exists for the day: the "How are you today?" line is then hidden. */
export function checkinDue(items: readonly QueueItem[], date: string = localDate()): boolean {
  return latestCheckin(items, date) === null;
}
