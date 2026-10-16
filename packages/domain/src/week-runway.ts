// Week runway projection (M8): the next 7 evenings (17:00-23:00 local wall time) marked free / busy / pick /
// unknown with that day's weather. Pure projection of read-model data: no HTTP, no vault writes, no identity.
import type {
  TriageResponse,
  WeatherWeekDay,
  WeekRunwayEvening,
  WeekRunwayPick,
  WeekRunwayResponse,
} from '@vault-companion/contracts';
import { localWallToInstant } from './morning-brief.ts';
import { userDate } from './time.ts';

/** Calendar busy time as ISO instant strings. `null` input overall means the calendar source is unavailable. */
export interface BusyInterval {
  readonly start: string;
  readonly end: string;
}

type TriageDecisionLine = TriageResponse['decisions'][number];

/** Decisions that still count: not undo lines and not undone (ADR-0024), in time order. Unparseable `at` is skipped. */
function effectiveDecisions(decisions: readonly TriageDecisionLine[]): TriageDecisionLine[] {
  const sorted = [...decisions]
    .filter((line) => !Number.isNaN(Date.parse(line.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const undone = new Set(
    sorted.filter((line) => line.decision === 'undo' && line.undoes !== null).map((line) => line.undoes),
  );
  return sorted.filter((line) => line.decision !== 'undo' && !undone.has(line.decisionId));
}

/** `count` consecutive calendar dates starting at `firstDay` (YYYY-MM-DD), DST-independent day arithmetic. */
function nextDays(firstDay: string, count: number): string[] {
  const parts = firstDay.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const pad = (n: number) => String(n).padStart(2, '0');
  return Array.from({ length: count }, (_, i) => {
    const utc = new Date(Date.UTC(year, month - 1, day + i));
    return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
  });
}

/**
 * Projects the week runway: 7 evenings from the user's current date. A null input source is reported 'unavailable'
 * rather than guessed; bad dates skip the item instead of throwing.
 */
export function projectWeekRunway(input: {
  now: Date;
  timeZone: string;
  week: readonly WeatherWeekDay[] | null;
  busy: readonly BusyInterval[] | null;
  triage: TriageResponse | null;
}): WeekRunwayResponse {
  const { now, timeZone, week, busy, triage } = input;

  const weatherByDay = new Map((week ?? []).map((entry) => [entry.day, entry]));
  const intervals = (busy ?? [])
    .map((interval) => ({ start: Date.parse(interval.start), end: Date.parse(interval.end) }))
    .filter((interval) => !Number.isNaN(interval.start) && !Number.isNaN(interval.end));

  const windows = nextDays(userDate(now, timeZone), 7).map((day) => ({
    day,
    winStart: localWallToInstant(day, 17, 0, timeZone),
    winEnd: localWallToInstant(day, 23, 0, timeZone),
  }));

  // Picks: effective decisions, latest per event, kept when that latest decision is 'go'.
  const cards = new Map((triage?.cards ?? []).map((card) => [card.eventId, card]));
  const latestByEvent = new Map<string, TriageDecisionLine>();
  if (triage !== null) for (const line of effectiveDecisions(triage.decisions)) latestByEvent.set(line.eventId, line);
  const picksByDay = new Map<string, WeekRunwayPick[]>();
  for (const [eventId, line] of latestByEvent) {
    if (line.decision !== 'go') continue;
    const card = cards.get(eventId);
    const start = card ? card.start : line.start;
    if (start == null) continue; // skip if no start
    const startMs = Date.parse(start);
    if (Number.isNaN(startMs)) continue;
    const end = card ? card.end : null;
    const endMs = end != null ? Date.parse(end) : startMs;
    if (Number.isNaN(endMs)) continue;
    const pick: WeekRunwayPick = { eventId, title: card ? card.title : line.title ?? '', start, end };
    for (const { day, winStart, winEnd } of windows) {
      if (startMs < winEnd && endMs >= winStart) {
        const list = picksByDay.get(day);
        if (list) list.push(pick);
        else picksByDay.set(day, [pick]);
      }
    }
  }

  const evenings: WeekRunwayEvening[] = windows.map(({ day, winStart, winEnd }) => {
    const weather = weatherByDay.get(day);
    const picks = (picksByDay.get(day) ?? [])
      .slice()
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, 20); // contract cap: earliest starts win
    const isBusy = intervals.some((interval) => interval.start < winEnd && interval.end > winStart);
    const state: WeekRunwayEvening['state'] = picks.length > 0
      ? 'pick'
      : busy === null
        ? 'unknown'
        : isBusy
          ? 'busy'
          : 'free';
    return {
      day,
      highTemperatureC: weather?.highTemperatureC ?? null,
      weatherCode: weather?.weatherCode ?? null,
      state,
      picks,
    };
  });

  return {
    now: now.toISOString(),
    sources: {
      calendar: busy === null ? 'unavailable' : 'ok',
      weather: week === null ? 'unavailable' : 'ok',
      triage: triage === null ? 'unavailable' : 'ok',
    },
    evenings,
    counts: {
      free: evenings.filter((evening) => evening.state === 'free').length,
      busy: evenings.filter((evening) => evening.state === 'busy').length,
      picked: evenings.reduce((sum, evening) => sum + evening.picks.length, 0),
    },
  };
}
