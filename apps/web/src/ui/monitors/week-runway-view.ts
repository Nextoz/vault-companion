// M8: pure view helpers for the Week runway monitor card. Every label is derived from the shared week-runway read
// model in Europe/Copenhagen wall time via Intl — no provider calls, no vault text, no domain or React import.
import { WEATHER_TIME_ZONE, type WeekRunwayEvening, type WeekRunwayResponse } from '@vault-companion/contracts';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: WEATHER_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** A pick or `now` instant as Copenhagen wall-clock parts, e.g. { hour: '16', minute: '05' }. */
function localClock(iso: string): { hour: string; minute: string } {
  const parts = clock.formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return { hour: get('hour'), minute: get('minute') };
}

/** One plain `YYYY-MM-DD` date as the day column's two labels, { wd: 'Fri', dt: '16' } (UTC date math only). */
export function dayParts(day: string): { wd: string; dt: string } {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return { wd: day, dt: '' };
  return { wd: WEEKDAYS[(date.getUTCDay() + 6) % 7]!, dt: String(date.getUTCDate()) };
}

/** The expanded section label's span: the first and last evening as "FRI 16 – THU 22". */
export function rangeLabel(evenings: readonly WeekRunwayEvening[]): string {
  if (evenings.length === 0) return '';
  const first = dayParts(evenings[0]!.day);
  const last = dayParts(evenings[evenings.length - 1]!.day);
  return `${first.wd.toUpperCase()} ${first.dt} – ${last.wd.toUpperCase()} ${last.dt}`;
}

/** A pick's clock span: "17–21" when both ends sit on the hour, "18:30" alone while the end is unknown, else
 * "18:30–21:00". Always Copenhagen wall time, so a DST fold inside the week never shifts the label. */
export function pickTime(start: string, end: string | null): string {
  const from = localClock(start);
  if (end === null) return `${from.hour}:${from.minute}`;
  const to = localClock(end);
  if (from.minute === '00' && to.minute === '00') return `${from.hour}–${to.hour}`;
  return `${from.hour}:${from.minute}–${to.hour}:${to.minute}`;
}

/** The busy row's day list: "Sat 17 & Mon 19", "Sat 17, Mon 19 & Wed 21" for three, "" when none are busy. */
export function busyDaysLabel(evenings: readonly WeekRunwayEvening[]): string {
  const days = evenings
    .filter((evening) => evening.state === 'busy')
    .map((evening) => {
      const parts = dayParts(evening.day);
      return `${parts.wd} ${parts.dt}`;
    });
  if (days.length === 0) return '';
  if (days.length === 1) return days[0]!;
  return `${days.slice(0, -1).join(', ')} & ${days[days.length - 1]}`;
}

/** The collapsed summary: "3 free evenings · 2 picked" (singular "1 free evening"); when the calendar could not
 * be read the free count is replaced by the apology, "Calendar unavailable · 2 picked". */
export function summaryLine(r: WeekRunwayResponse): string {
  if (r.sources.calendar !== 'ok') return `Calendar unavailable · ${r.counts.picked} picked`;
  return `${r.counts.free} free evening${r.counts.free === 1 ? '' : 's'} · ${r.counts.picked} picked`;
}

/** The footer freshness line: "Updated 16:05" in Copenhagen wall time. */
export function updatedLabel(now: string): string {
  const time = localClock(now);
  return `Updated ${time.hour}:${time.minute}`;
}
