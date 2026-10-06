// CAL-b: pure helpers for the "Add to Calendar" sheet. No React, no DOM, no fetches: date/time arithmetic, the
// event-type keyword guess and the item keys are all testable on their own. All wall-clock decisions are made in
// Europe/Copenhagen, the vault's own zone.
import { CALENDAR_ITEM_KEY_MAX, calendarItemKey, type ActiveWorkLocator, type MorningBriefResponse, type TaskLocator } from '@vault-companion/contracts';
import { plainWikilinks } from '../text.ts';
import { dateIn, isoWithOffset } from '../time.ts';

/** The zone every pre-fill date/time is read and written in. */
export const CALENDAR_ZONE = 'Europe/Copenhagen';
/** ADR-0048 colour buckets; mirrored from `CalendarEventType` in @vault-companion/domain (apps/web does not depend on
 * the domain package, so the wire values are repeated here - the Worker re-validates every request against the enum). */
export const CALENDAR_EVENT_TYPES = [
  'important', 'training', 'learning-practice', 'ai', 'learning-event',
  'tangerine', 'banana', 'flamingo', 'graphite', 'none',
] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];
export const CALENDAR_TYPE_LABELS: Readonly<Record<CalendarEventType, string>> = {
  important: 'Important', training: 'Training', 'learning-practice': 'Learning practice', ai: 'AI',
  'learning-event': 'Learning event', tangerine: 'Tangerine', banana: 'Banana', flamingo: 'Flamingo',
  graphite: 'Graphite', none: 'No colour',
};
export const CALENDAR_TYPE_FALLBACK: CalendarEventType = 'none';
/** The Worker's `CalendarItemKey` cap; the key must fit it whole. */
export const ITEM_KEY_MAX = CALENDAR_ITEM_KEY_MAX;
export const TITLE_MAX = 500;
export const NOTES_MAX = 2000;
export const MAX_CHIPS = 4;
const NOTE_HEADER = 'From Vault Companion';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The ordinal that makes duplicate text unambiguous; pre-ADR-0056 locators without one are not linkable. */
function calendarOrdinal(locator: { occurrencesAtRead: number; occurrenceIndex?: number | undefined }): number {
  if (typeof locator.occurrenceIndex === 'number' && locator.occurrenceIndex >= 1) return locator.occurrenceIndex;
  return locator.occurrencesAtRead === 1 ? 1 : -1;
}

/**
 * ADR-0056 stable link key: `task:`/`active:` plus the item's ordinal among identical lines plus the normalised line
 * text. Unrelated edits elsewhere in the file change blob/line index but not this key. Editing the item itself still
 * detaches its link (accepted caveat).
 */
export function taskCalendarKey(locator: TaskLocator): string {
  return calendarItemKey('task', locator.lineText, calendarOrdinal(locator));
}

/** The stable ADR-0056 link key for an Active Work item. */
export function activeWorkCalendarKey(locator: ActiveWorkLocator): string {
  return calendarItemKey('active', locator.lineText, calendarOrdinal(locator));
}

/** The event title: wikilinks flattened, then emoji tokens and `#tags` dropped and spacing collapsed. */
export function itemTitle(text: string): string {
  const plain = plainWikilinks(text)
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, ' ')
    .replace(/(^|\s)#[^\s#]+/gu, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, TITLE_MAX);
}

/** The first clock time named in the text: `14:00`, `at 3pm`, `9:30 am`. Null when the text names none. */
export function parseTimeHint(text: string): { hour: number; minute: number } | null {
  const colon = /(?:^|[^\d:])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/.exec(text);
  if (colon) return { hour: Number(colon[1]), minute: Number(colon[2]) };
  const meridiem = /(?:^|[^\d:])(\d{1,2})(?::([0-5]\d))?\s*(am|pm)(?![\w])/i.exec(text);
  if (!meridiem) return null;
  const twelve = Number(meridiem[1]) % 12;
  return { hour: twelve + (meridiem[3]!.toLowerCase() === 'pm' ? 12 : 0), minute: Number(meridiem[2] ?? '0') };
}

/**
 * A small deterministic guess at the event's colour bucket. Order matters: a "training run" is Training, an "AI
 * course" is Learning event; anything unrecognised stays `none` rather than guessing a colour.
 */
export function guessEventType(text: string): CalendarEventType {
  if (/\b(?:gym|run|jog|workout|training|yoga|swim|swimming|cycle|cycling|ride|lift|weights|exercise|match|football|soccer|climb|climbing|row|rowing|dance)\b/i.test(text)) return 'training';
  if (/\b(?:lecture|course|class|seminar|workshop|webinar|conference|lesson|exam|study group)\b/i.test(text)) return 'learning-event';
  if (/\b(?:practice|practise|rehearse|rehearsal|drill|revise|flashcards|reps)\b/i.test(text)) return 'learning-practice';
  if (/\b(?:ai|llm|gpt|prompt|prompts|model|models|agent|codex|claude)\b/i.test(text)) return 'ai';
  if (/\b(?:important|urgent|deadline|doctor|dentist|appointment|interview|meeting|call|flight|tax|bill|pay|renew|submit|hand in)\b/i.test(text)) return 'important';
  return CALENDAR_TYPE_FALLBACK;
}

/** Due, else scheduled, else today (Europe/Copenhagen). */
export function calendarDate(item: { due: string | null; scheduled: string | null }, today: string): string {
  return item.due ?? item.scheduled ?? today;
}

export interface CalendarTarget {
  readonly itemKey: string;
  readonly text: string;
  readonly due: string | null;
  readonly scheduled: string | null;
  readonly linked: boolean;
}

export interface CalendarPrefill {
  readonly title: string;
  readonly date: string;
  readonly allDay: boolean;
  /** `HH:MM` for the form's time inputs; ignored while `allDay`. */
  readonly start: string;
  readonly end: string;
  readonly type: CalendarEventType;
  readonly notes: string;
}

/** The form's opening values: date first, a 30-minute window only when the text names a start time. */
export function calendarPrefill(
  item: { text: string; due: string | null; scheduled: string | null },
  today: string,
): CalendarPrefill {
  const plain = plainWikilinks(item.text);
  const hint = parseTimeHint(plain);
  const date = calendarDate(item, today);
  const notes = `${NOTE_HEADER}\n${plain}`.slice(0, NOTES_MAX);
  // A description that is only markers/emoji would otherwise send an empty title, which the Worker refuses.
  const title = itemTitle(plain) || plain.trim().slice(0, TITLE_MAX) || 'Untitled event';
  if (!hint) {
    return { title, date, allDay: true, start: '09:00', end: '09:30', type: guessEventType(plain), notes };
  }
  const endMinutes = Math.min(hint.hour * 60 + hint.minute + 30, 23 * 60 + 59);
  return {
    title, date, allDay: false,
    start: `${pad2(hint.hour)}:${pad2(hint.minute)}`,
    end: `${pad2(Math.floor(endMinutes / 60))}:${pad2(endMinutes % 60)}`,
    type: guessEventType(plain), notes,
  };
}

export interface CalendarChip {
  readonly label: string;
  readonly start: string;
  readonly end: string;
  /** `HH:MM` in the sheet's zone, for the time inputs. */
  readonly startTime: string;
  readonly endTime: string;
}

/** Up to four of today's free blocks, as one-tap chips. Blocks on other days (or an empty brief) yield no chips. */
export function calendarChips(
  gaps: MorningBriefResponse['brief']['gaps'],
  today: string,
  zone = CALENDAR_ZONE,
): CalendarChip[] {
  const chips: CalendarChip[] = [];
  for (const gap of gaps) {
    const startMs = Date.parse(gap.start);
    const endMs = Date.parse(gap.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    if (dateIn(new Date(startMs).toISOString(), zone) !== today) continue;
    chips.push({
      label: `${clock(new Date(startMs), zone)}-${clock(new Date(endMs), zone)}`,
      start: gap.start, end: gap.end,
      startTime: clock(new Date(startMs), zone), endTime: clock(new Date(endMs), zone),
    });
    if (chips.length >= MAX_CHIPS) break;
  }
  return chips;
}

const clockFormat = (zone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false });
const clock = (at: Date, zone: string) => clockFormat(zone).format(at);

/**
 * `HH:MM` on a Copenhagen date to an ISO instant with that day's own UTC offset (DST-safe, via the IANA zone).
 * `end` at or before `start` rolls to the next day, so a window is never inverted.
 */
export function timedWindow(date: string, start: string, end: string, zone = CALENDAR_ZONE): { start: string; end: string } | null {
  const from = parseClock(start);
  const to = parseClock(end);
  if (!from || !to) return null;
  const startIso = localIso(date, from.hour, from.minute, zone, 0);
  const rolls = to.hour * 60 + to.minute <= from.hour * 60 + from.minute;
  return { start: startIso, end: localIso(date, to.hour, to.minute, zone, rolls ? 1 : 0) };
}

function parseClock(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/** Minutes east of UTC for the zone at that instant; exact for whole-minute offsets such as Europe/Copenhagen. */
function zoneOffsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

function localIso(date: string, hour: number, minute: number, zone: string, addDays: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year!, month! - 1, day! + addDays, hour, minute, 0, 0);
  let instant = wall;
  for (let i = 0; i < 2; i += 1) instant = wall - zoneOffsetMinutes(zone, new Date(instant)) * 60_000;
  return isoWithOffset(new Date(instant), -zoneOffsetMinutes(zone, new Date(instant)));
}

/** One message for any failure the sheet can show: offline, a typed refusal, or an unanswered call. */
export function calendarErrorMessage(kind: 'offline' | 'error', code: string | null): string {
  if (kind === 'offline') return 'You are offline. Calendar changes need a connection.';
  if (code === 'calendar-write-unavailable') return 'Calendar writing is not set up';
  if (code === 'google-reauth-needed') return 'Google Calendar needs to be reconnected';
  if (code === 'conflict:stale') return 'This item is already in your calendar.';
  if (code === 'calendar-link-needs-recheck') return 'Reload tasks to re-check this item before changing its calendar link.';
  return 'Could not reach Google Calendar. Try again.';
}
