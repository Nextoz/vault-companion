// UX2: the Today morning card's one-liners are a pure projection of reads the card already holds - no fetch here.
// A line with nothing to say is omitted (never a "Not configured" placeholder); the tasks line is always present.
import type { MorningBriefResponse, MorningResponse, ScoutsResponse, WeatherResponse } from '@vault-companion/contracts';
import type { QueueItem } from '../queue/queue.ts';
import { attentionCount } from '../scouts.ts';
import { localDate, latestCheckin } from './MoodCard.tsx';
import { morningSummary } from './Morning.tsx';
import { runWindowSummary } from './WeatherLab.tsx';

/** One line on the morning card; `id` is both the React key and which detail the line opens. */
export type MorningLineId = 'weather' | 'scouts' | 'papers' | 'triage' | 'tasks';

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

/** The projections the card has already loaded, plus the client-side counts it can compute on its own. */
export interface MorningCardFacts {
  readonly weather: WeatherResponse | null;
  /** A failed weather read (offline/error): still offer the line so the panel, and its retry, stays reachable. */
  readonly weatherFailed: boolean;
  readonly scouts: ScoutsResponse | null;
  readonly morning: MorningResponse | null;
  readonly eventsToTriage: number;
  readonly tasksToday: number;
}

/** One-line way into the Tasks screen; kept verbatim from UX1b so "No tasks today" never became a placeholder. */
export function tasksTodayText(count: number): string {
  if (count === 0) return 'No tasks today';
  return count === 1 ? '1 task today' : `${count} tasks today`;
}

/** Weather glance, scouts, papers, events, then the tasks line - each omitted when it has nothing to say. */
export function morningLines(facts: MorningCardFacts): MorningLine[] {
  const lines: MorningLine[] = [];
  // An unavailable forecast is still something to say: the line carries the honest reason, not a placeholder.
  if (facts.weather) {
    lines.push({ id: 'weather', text: facts.weather.status === 'ok'
      ? runWindowSummary(facts.weather.projection.runWindow) : facts.weather.message });
  } else if (facts.weatherFailed) {
    lines.push({ id: 'weather', text: 'Weather unavailable' });
  }
  const problems = facts.scouts ? attentionCount(facts.scouts) : 0;
  if (problems > 0) lines.push({ id: 'scouts', text: `${problems} scouts need attention` });
  if (facts.morning && (facts.morning.brief !== null || facts.morning.explained.length > 0)) {
    lines.push({ id: 'papers', text: morningSummary(facts.morning) });
  }
  if (facts.eventsToTriage > 0) lines.push({ id: 'triage', text: `${facts.eventsToTriage} new events` });
  lines.push({ id: 'tasks', text: tasksTodayText(facts.tasksToday) });
  return lines;
}

/** False once a check-in (not undone) exists for the day: the "How are you today?" line is then hidden. */
export function checkinDue(items: readonly QueueItem[], date: string = localDate()): boolean {
  return latestCheckin(items, date) === null;
}
