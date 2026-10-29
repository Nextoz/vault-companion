import type { RingAnalysisResponse, RingDailyRow } from '@vault-companion/contracts';
import { canonicalSlotStart } from './ring-slots.ts';

export type RingDailyFull = { row: RingDailyRow; slotsN: number | null; longestGapMin: number | null; sleepMask: string | null };
type Analysis = Omit<RingAnalysisResponse, 'revision' | 'now' | 'today'>;
const shift = (date: string, n: number) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
export function ringDayBounds(date: string, tz: string) {
  const midnight = (day: string) => {
    const utc = Date.parse(`${day}T00:00:00Z`);
    let instant = utc;
    for (let i = 0; i < 3; i++) instant += utc - Date.parse(`${canonicalSlotStart(instant, tz).slice(0, 19)}Z`);
    return instant;
  };
  const start = midnight(date), end = midnight(shift(date, 1));
  return { dayStart: canonicalSlotStart(start, tz), dayEnd: canonicalSlotStart(end, tz), daySlots: (end - start) / 900000 as 92 | 96 | 100 };
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: (number | null)[]) => xs.includes(null) ? null : Math.round(Math.sqrt(mean((xs as number[]).map((x) => (x - mean(xs as number[])) ** 2))));
const unwrap = (clock: string) => { const m = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)); return m >= 720 ? m - 1440 : m; };
let cachedZone: string | undefined, cachedClock: Intl.DateTimeFormat;
export function analyseRing(rows: readonly RingDailyFull[], today: string, tz: string): Analysis {
  if (cachedZone !== tz) {
    cachedClock = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    cachedZone = tz;
  }
  const clock = (instant: number) => cachedClock.format(instant);
  const observed = rows.filter(({ row }) => row.date <= today).sort((a, b) => a.row.date.localeCompare(b.row.date));
  const firstDate = observed[0]?.row.date ?? null, lastDate = observed.at(-1)?.row.date ?? null;
  const result: Analysis = { status: firstDate ? 'ok' : 'missing', firstDate, lastDate, coverage: { days: [], nightsMissed: null }, nights: [], spread7: null, spread14: null, sri7: null, socialJetlag: null };
  if (!firstDate || !lastDate) return result;
  const start = firstDate > shift(today, -29) ? firstDate : shift(today, -29);
  const byDate = new Map(observed.map((r) => [r.row.date, r]));
  result.coverage.nightsMissed = 0;
  for (let date = start; date <= today; date = shift(date, 1)) {
    const full = byDate.get(date), row = full?.row;
    const hours = (n: number | null | undefined) => n == null ? null : n / 4;
    result.coverage.days.push({ date, dataHours: hours(full?.slotsN), longestGapMin: full?.longestGapMin ?? null,
      metricHours: { hr: hours(row?.hrN), spo2: hours(row?.spo2N), hrv: hours(row?.hrvN), temp: hours(row?.tempN), sleep: hours(row?.sleepN) } });
    if (date <= lastDate && (!row || row.sleepN === 0)) result.coverage.nightsMissed++;
    if (row?.sleepStart && row.sleepEnd) result.nights.push({ date, bedtime: row.sleepStart.slice(11, 16), wake: row.sleepEnd.slice(11, 16),
      midpoint: clock((Date.parse(row.sleepStart) + Date.parse(row.sleepEnd)) / 2), sleepMin: row.lightMin === null || row.deepMin === null ? null : row.lightMin + row.deepMin, awakeMin: row.awakeMin });
  }
  const latest = result.nights.at(-1)?.date;
  const consecutive = (n: number) => latest ? Array.from({ length: n }, (_, i) => result.nights.find((r) => r.date === shift(latest, i - n + 1))) : [];
  for (const n of [7, 14] as const) {
    const nights = consecutive(n);
    if (nights.length === n && nights.every((r) => r !== undefined)) result[n === 7 ? 'spread7' : 'spread14'] = {
      midpointSdMin: sd(nights.map((r) => r.midpoint === null ? null : unwrap(r.midpoint))), durationSdMin: sd(nights.map((r) => r.sleepMin)),
    };
  }
  const week = consecutive(7);
  if (week.length === 7 && week.every((r) => r && byDate.get(r.date)?.sleepMask != null)) {
    // Clock labels plus occurrence number align the repeated fall-back hour without reusing slots.
    const labels = (date: string) => {
      const mask = byDate.get(date)!.sleepMask!, start = Date.parse(ringDayBounds(date, tz).dayStart), seen = new Map<string, number>();
      return new Map([...mask].map((state, i) => {
        const label = clock(start + i * 900000), occurrence = seen.get(label) ?? 0;
        seen.set(label, occurrence + 1); return [`${label}/${occurrence}`, state];
      }));
    };
    let eligible = 0, same = 0, previous = labels(week[0]!.date);
    for (const night of week.slice(1)) {
      const current = labels(night!.date);
      for (const [key, a] of previous) { const b = current.get(key); if (a !== '-' && b !== undefined && b !== '-') { eligible++; if (a === b) same++; } }
      previous = current;
    }
    if (eligible) result.sri7 = { share: Math.round(same / eligible * 1000) / 1000, n: eligible };
  }
  const weekend: number[] = [], weekday: number[] = [];
  for (const night of result.nights) {
    if (night.midpoint !== null) ([0, 6].includes(new Date(night.date).getUTCDay()) ? weekend : weekday).push(unwrap(night.midpoint));
  }
  if (weekend.length + weekday.length >= 14 && weekend.length >= 4 && weekday.length >= 1) result.socialJetlag = {
    shiftMin: Math.round(mean(weekend) - mean(weekday)), weekendNights: weekend.length, weekdayNights: weekday.length,
  };
  return result;
}
