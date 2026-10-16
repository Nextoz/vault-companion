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

/**
 * One Overview tile (R3b, review #7): the label carries the noun, the body the fact, never the noun again. A count
 * tile splits its fact into `stat` (the number, set in rounded numerals) and `body` (its unit): "2" + "items".
 * `name` is the accessible name: "Needs you · 2 items"; the brief keeps its plain "Morning Brief".
 */
export interface TodayTile {
  readonly id: string;
  readonly label: string;
  readonly stat: string | null;
  readonly body: string;
  readonly name: string;
}

/**
 * The facts the grid projects; a null fact drops that tile (never a placeholder), and so does a zero Needs you count.
 * The brief tile is always present. Counts are plain numbers: the tile owns the wording.
 */
export interface TodayTileFacts {
  readonly brief: string;
  readonly needs: number | null;
  readonly weather: string | null;
  readonly research: number | null;
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

function countTile(id: string, label: string, count: number, one: string, many: string, none: string): TodayTile {
  if (count <= 0) return { id, label, stat: null, body: none, name: `${label} · ${none}` };
  const unit = plural(count, one, many);
  return { id, label, stat: String(count), body: unit, name: `${label} · ${count} ${unit}` };
}

/**
 * The tiles in a fixed order. Adding another source is one fact plus one entry here; the grid maps whatever list it
 * gets, so two more tiles need no layout change. Pure.
 */
export function todayTiles(facts: TodayTileFacts): TodayTile[] {
  const tiles: TodayTile[] = [{ id: 'brief', label: 'Morning Brief', stat: null, body: facts.brief, name: 'Morning Brief' }];
  if (facts.needs !== null && facts.needs > 0) tiles.push(countTile('needs', 'Needs you', facts.needs, 'item', 'items', ''));
  if (facts.weather !== null) tiles.push({ id: 'weather', label: 'Weather', stat: null, body: facts.weather, name: `Weather · ${facts.weather}` });
  if (facts.research !== null) tiles.push(countTile('research', 'Research', facts.research, 'highlight', 'highlights', 'No highlights'));
  return tiles;
}

/**
 * The tile's domain hue (tokens.css, review #10) for its 2 px top edge: the brief is the day's calendar, Needs you is
 * things to do, then weather and research. An unknown id gets the neutral separator, never an invented colour.
 */
export function tileHue(id: string): string {
  const hues: Record<string, string> = {
    brief: '--hue-events', needs: '--hue-tasks', weather: '--hue-weather', research: '--hue-research',
  };
  return `var(${hues[id] ?? '--line'})`;
}
