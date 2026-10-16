// Week runway service (M8): composes the weather week, calendar busy intervals and triage into the pure
// projectWeekRunway projection. Read-only: every failing source degrades to 'unavailable'; nothing is logged.
import type { ApiError, TriageResponse, WeatherResponse, WeekRunwayResponse } from '@vault-companion/contracts';
import { localWallToInstant, projectWeekRunway, userDate } from '@vault-companion/domain';
import type { CalendarBusyInterval, GoogleReader } from './google-reader.ts';

export interface WeekRunwayServiceDeps {
  readonly readWeather: () => Promise<WeatherResponse | ApiError>;
  readonly readTriage: () => Promise<TriageResponse | ApiError>;
  /** Builds a fresh reader per refresh; `null` leaves the calendar source unavailable. */
  readonly createReader: (() => Pick<GoogleReader, 'readBusy'>) | null;
  readonly now: () => Date;
  readonly timeZone: string;
  readonly busyTtlMs?: number;
}

const isApiError = (x: unknown): x is ApiError =>
  typeof x === 'object' && x !== null && 'code' in x && 'retryable' in x;

const pad = (n: number): string => String(n).padStart(2, '0');

/** `count` calendar days after `day` (YYYY-MM-DD), DST-independent day arithmetic. */
const dayPlus = (day: string, count: number): string => {
  const parts = day.split('-');
  const utc = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + count));
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
};

/** Local wall time as a normalized ISO instant string. */
const localInstant = (day: string, hour: number, timeZone: string): string =>
  new Date(localWallToInstant(day, hour, 0, timeZone)).toISOString();

export function createWeekRunwayService(deps: WeekRunwayServiceDeps): { readWeekRunway(): Promise<WeekRunwayResponse> } {
  const { readWeather, readTriage, createReader, now, timeZone } = deps;
  const busyTtlMs = deps.busyTtlMs ?? 600_000;
  let cached: { intervals: readonly CalendarBusyInterval[]; timeMin: string; at: number } | null = null;

  const readBusy = async (timeMin: string, timeMax: string): Promise<readonly CalendarBusyInterval[] | null> => {
    if (createReader === null) return null;
    if (cached !== null && cached.timeMin === timeMin && now().getTime() - cached.at < busyTtlMs) {
      return cached.intervals;
    }
    // A fresh reader per refresh: its token is cached inside, so no reader is kept between refreshes.
    const result = await createReader().readBusy(timeMin, timeMax);
    if (isApiError(result)) return null; // failed reads are not cached; the next call retries
    cached = { intervals: result, timeMin, at: now().getTime() };
    return result;
  };

  return {
    async readWeekRunway(): Promise<WeekRunwayResponse> {
      const at = now();
      const today = userDate(at, timeZone);
      const timeMin = localInstant(today, 17, timeZone);
      const timeMax = localInstant(dayPlus(today, 6), 23, timeZone);

      // Each source degrades to null; a thrown error never escapes and nothing is logged.
      const safe = async <T>(run: () => Promise<T>): Promise<T | null> => {
        try {
          return await run();
        } catch {
          return null;
        }
      };
      const [weather, triage, busy] = await Promise.all([
        safe(readWeather),
        safe(readTriage),
        safe(() => readBusy(timeMin, timeMax)),
      ]);

      const week = weather !== null && !isApiError(weather) && weather.status === 'ok' && weather.projection.week != null
        ? weather.projection.week
        : null;
      return projectWeekRunway({
        now: at,
        timeZone,
        week,
        busy,
        triage: triage !== null && !isApiError(triage) ? triage : null,
      });
    },
  };
}
