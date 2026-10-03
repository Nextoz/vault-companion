// Morning Brief v2 day model (pure domain, no I/O). Deterministic helpers the writer phrases later.

import type { HealthMetric, HealthMetricKey } from '@vault-companion/contracts';

/** Day window in local time: 07:00 inclusive to 22:00 exclusive. */
export const BRIEF_DAY_START_HOUR = 7;
export const BRIEF_DAY_END_HOUR = 22;
/** Gaps shorter than this are not worth surfacing. */
export const MIN_FREE_BLOCK_MINUTES = 15;
/** A free block at or above this is "long". */
export const LONG_FREE_BLOCK_MINUTES = 90;

export interface BriefEvent {
  title: string;
  /** ISO instant. */
  start: string;
  /** ISO instant. */
  end: string;
  allDay: boolean;
}

export interface FreeBlock {
  /** ISO instant. */
  start: string;
  /** ISO instant. */
  end: string;
  minutes: number;
  long: boolean;
}

export interface BriefTodo {
  text: string;
  /** YYYY-MM-DD, or null when undated. */
  due: string | null;
  bill: boolean;
}

export interface StateFlag {
  key: HealthMetricKey;
  compare: 'above' | 'below';
}

export interface MoodSnapshot {
  mood: number;
  energy: number;
  sleep: number;
}

export interface StateLine {
  flags: StateFlag[];
  mood: MoodSnapshot | null;
  low: boolean;
}

/** Offset (local wall clock - UTC) in ms of `instant` in `timeZone`. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const pick = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : Number.NaN;
  };
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
  return asUtc - instant.getTime();
}

/** Local wall-clock time of `date` in `timeZone` as a UTC instant (DST-correct). */
export function localWallToInstant(date: string, hour: number, minute: number, timeZone: string): number {
  const parts = date.split('-');
  const wall = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), hour, minute, 0, 0);
  // Two passes settle the offset on either side of a DST transition.
  let instant = wall - zoneOffsetMs(new Date(wall), timeZone);
  instant = wall - zoneOffsetMs(new Date(instant), timeZone);
  return instant;
}

/** A planning reminder: trimmed title is only uppercase letters/spaces and ends with CHECK. */
function isPlanningReminder(title: string): boolean {
  return /^[A-Z ]*CHECK$/.test(title.trim());
}

function toFreeBlock(startMs: number, endMs: number): FreeBlock {
  const minutes = (endMs - startMs) / 60_000;
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), minutes, long: minutes >= LONG_FREE_BLOCK_MINUTES };
}

/**
 * Free blocks inside the local 07:00-22:00 window of `date`. All-day events and planning reminders are ignored;
 * remaining events are clipped to the window, overlapping/touching ones merged, and gaps under 15 minutes dropped.
 */
export function freeBlocks(events: BriefEvent[], date: string, timeZone = 'Europe/Copenhagen'): FreeBlock[] {
  const windowStart = localWallToInstant(date, BRIEF_DAY_START_HOUR, 0, timeZone);
  const windowEnd = localWallToInstant(date, BRIEF_DAY_END_HOUR, 0, timeZone);

  const busy: Array<[number, number]> = [];
  for (const event of events) {
    if (event.allDay || isPlanningReminder(event.title)) continue;
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const clippedStart = Math.max(start, windowStart);
    const clippedEnd = Math.min(end, windowEnd);
    if (clippedEnd <= clippedStart) continue;
    busy.push([clippedStart, clippedEnd]);
  }
  busy.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: Array<[number, number]> = [];
  for (const [start, end] of busy) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const minGapMs = MIN_FREE_BLOCK_MINUTES * 60_000;
  const free: FreeBlock[] = [];
  let cursor = windowStart;
  for (const [start, end] of merged) {
    if (start - cursor >= minGapMs) free.push(toFreeBlock(cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (windowEnd - cursor >= minGapMs) free.push(toFreeBlock(cursor, windowEnd));
  return free;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Null sorts last; otherwise YYYY-MM-DD lexicographic order. */
function compareDue(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface RankedTodo {
  todo: BriefTodo;
  index: number;
  group: 0 | 1 | 2;
}

/**
 * Bills and todos due today or within 3 days (earliest due first), then overdue (oldest first), then the rest in
 * input order. At most 3. Stable and pure.
 */
export function rankTodos(todos: BriefTodo[], date: string): BriefTodo[] {
  const soon = addDays(date, 3);
  const ranked: RankedTodo[] = todos.map((todo, index) => {
    let group: 0 | 1 | 2;
    if (todo.bill || (todo.due !== null && todo.due >= date && todo.due <= soon)) group = 0;
    else if (todo.due !== null && todo.due < date) group = 1;
    else group = 2;
    return { todo, index, group };
  });

  const byDueThenInput = (a: RankedTodo, b: RankedTodo): number =>
    compareDue(a.todo.due, b.todo.due) || a.index - b.index;

  const group0 = ranked.filter((r) => r.group === 0).sort(byDueThenInput);
  const group1 = ranked.filter((r) => r.group === 1).sort(byDueThenInput);
  const group2 = ranked.filter((r) => r.group === 2);
  return [...group0, ...group1, ...group2].slice(0, 3).map((r) => r.todo);
}

/**
 * Compact state for the writer: only metrics a service already judged a clear departure (above/below), the mood
 * inputs verbatim, and a low flag. No wording, no diagnosis.
 */
export function stateLine(metrics: HealthMetric[], mood: MoodSnapshot | null): StateLine {
  const flags: StateFlag[] = [];
  for (const metric of metrics) {
    if (metric.compare === 'above' || metric.compare === 'below') flags.push({ key: metric.key, compare: metric.compare });
  }
  return { flags, mood, low: mood !== null && (mood.mood <= -2 || mood.energy <= -2) };
}
