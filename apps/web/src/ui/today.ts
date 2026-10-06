// UX8 (layout C): pure projections for Today's Overview - the single "Next up" pick and the data-driven tile grid.
// No React and no fetch: the card passes reads it already holds, and the grid renders the list it returns.
import { dateIn } from '../time.ts';

export const TODAY_ZONE = 'Europe/Copenhagen';

/** The slice of a calendar event the pick needs; `TriageCard` already carries exactly these fields. */
export interface NextUpEvent {
  readonly eventId: string;
  readonly title: string;
  readonly start: string;
}

export type NextUp<T> =
  | { readonly kind: 'event'; readonly event: NextUpEvent }
  | { readonly kind: 'task'; readonly task: T }
  | { readonly kind: 'none' };

/**
 * Today's events (Copenhagen date) that have not already started, soonest first. An event with an unreadable start is
 * dropped rather than guessed into the pick. Pure.
 */
export function todaysUpcomingEvents<T extends NextUpEvent>(events: readonly T[], today: string, nowIso: string): T[] {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return [];
  return events
    .filter((event) => Number.isFinite(Date.parse(event.start)) && dateIn(event.start, TODAY_ZONE) === today && Date.parse(event.start) >= now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/**
 * UX8: the one thing to do next. The next Calendar commitment today wins; otherwise the first of today's tasks;
 * otherwise a quiet empty state. Pure and total - it never invents an item.
 */
export function selectNextUp<T>(events: readonly NextUpEvent[], tasks: readonly T[], today: string, nowIso: string): NextUp<T> {
  const [event] = todaysUpcomingEvents(events, today, nowIso);
  if (event !== undefined) return { kind: 'event', event: { eventId: event.eventId, title: event.title, start: event.start } };
  const [task] = tasks;
  if (task !== undefined) return { kind: 'task', task };
  return { kind: 'none' };
}

/** The line under the pick: "3 more tasks today". Tasks stay on the Tasks tab, so Today never lists them. Pure. */
export function moreTasksText(count: number): string {
  if (count <= 0) return 'No more tasks today';
  return count === 1 ? '1 more task today' : `${count} more tasks today`;
}

/** One Overview tile. `label` is the accessible name; it defaults to the visible text unless the title names it. */
export interface TodayTile {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly label: string;
}

/** The facts the grid projects; a null fact drops that tile (never a placeholder). The brief tile is always present. */
export interface TodayTileFacts {
  readonly brief: string;
  readonly needs: string | null;
  readonly weather: string | null;
  readonly research: string | null;
}

/**
 * The tiles in a fixed order. Adding another source is one fact plus one entry here; the grid maps whatever list it
 * gets, so two more tiles need no layout change. Pure.
 */
export function todayTiles(facts: TodayTileFacts): TodayTile[] {
  const tiles: TodayTile[] = [{ id: 'brief', title: 'Morning Brief', text: facts.brief, label: 'Morning Brief' }];
  if (facts.needs !== null) tiles.push({ id: 'needs', title: 'Needs you', text: facts.needs, label: facts.needs });
  if (facts.weather !== null) tiles.push({ id: 'weather', title: 'Weather', text: facts.weather, label: facts.weather });
  if (facts.research !== null) tiles.push({ id: 'research', title: 'Research', text: facts.research, label: facts.research });
  return tiles;
}
