import { describe, expect, it, vi } from 'vitest';
import { HEALTH_VITALS_DAILY_CSV, RingAnalysisResponse } from '@vault-companion/contracts';
import { analyseRing, type RingDailyFull } from './ring-analysis.ts';
import { parseRingDailyFull, readRingAnalysis, ringDayBounds } from './ring-read.ts';
import { RING_DAILY_HEADER, RING_DAILY_HEADER_V1 } from './ring-metrics.ts';
import { FileTooLarge } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const tz = 'Europe/Copenhagen';
const shift = (date: string, n: number) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
function full(date: string, midpoint = '00:00', mask?: string): RingDailyFull {
  return { slotsN: 80, longestGapMin: 240, sleepMask: mask ?? '0'.repeat(ringDayBounds(date, tz).daySlots), row: {
    date, sleepStart: `${date}T${midpoint}:00+01:00`, sleepEnd: `${date}T${midpoint}:00+01:00`,
    lightMin: 300, deepMin: 60, awakeMin: 15, restingHr: null, avgHr: null, minSpo2: null, avgSpo2: null, hrvSdnnMs: null, bodyTempC: null,
    hrN: 80, spo2N: 0, hrvN: 4, tempN: 2, sleepN: 24,
  } };
}
const series = (start: string, n: number) => Array.from({ length: n }, (_, i) => full(shift(start, i)));
const analyse = (rows: RingDailyFull[], today = rows.at(-1)!.row.date) => analyseRing(rows, today, tz);
const legacy = '2026-10-28,Wed,,,,,,,72,,,,,1,0,0,0,0';
const deps = (store: InMemoryStore) => ({ store, now: () => new Date('2026-10-28T12:00:00Z'), timeZone: tz });
describe('ring analysis', () => {
  it('clips 30 calendar dates, ignores future rows and leaves unknown days null', () => {
    const rows = [full('2026-09-01'), full('2026-10-27'), full('2026-10-29')];
    rows[1]!.row.sleepN = 0;
    const a = analyse(rows, '2026-10-28');
    expect(a).toMatchObject({ firstDate: '2026-09-01', lastDate: '2026-10-27', coverage: { nightsMissed: 29 } });
    expect(a.coverage.days).toHaveLength(30); expect(a.coverage.days[0]!.date).toBe('2026-09-29');
    expect(a.coverage.days.at(-1)).toEqual({ date: '2026-10-28', dataHours: null, longestGapMin: null, metricHours: { hr: null, spo2: null, hrv: null, temp: null, sleep: null } });
    expect(a.coverage.days.at(-2)).toMatchObject({ dataHours: 20, longestGapMin: 240, metricHours: { hr: 20, spo2: 0, hrv: 1, temp: 0.5, sleep: 0 } });
    expect(analyse([full('2026-10-27')], '2026-10-28').coverage.days).toHaveLength(2);
    const unknown = full('2026-10-28'); unknown.slotsN = null; unknown.longestGapMin = null;
    expect(analyse([unknown]).coverage.days[0]).toMatchObject({ dataHours: null, longestGapMin: null });
  });
  it('counts only gaps or explicit zero sleep counts in the observed range', () => {
    const rows = [full('2026-10-24'), full('2026-10-26'), full('2026-10-27')]; rows[1]!.row.sleepN = 0;
    expect(analyse(rows, '2026-10-28').coverage.nightsMissed).toBe(2);
  });
  it('bisects elapsed instants across midnight and unwraps population SD', () => {
    const rows = series('2026-10-26', 14);
    rows.forEach((r, i) => { r.row.sleepStart = `${shift(r.row.date, -1)}T${i < 7 ? '22:30' : '23:30'}:00+01:00`; r.row.sleepEnd = `${r.row.date}T${i < 7 ? '00:30' : '02:30'}:00+01:00`; r.row.lightMin = i < 7 ? 60 : 180; r.row.deepMin = 0; });
    const a = analyse(rows);
    expect(a.nights[0]).toMatchObject({ bedtime: '22:30', wake: '00:30', midpoint: '23:30', sleepMin: 60, awakeMin: 15 });
    expect(a.spread14).toEqual({ midpointSdMin: 45, durationSdMin: 60 }); expect(a.spread7).toEqual({ midpointSdMin: 0, durationSdMin: 0 });
    rows[13]!.row.deepMin = null;
    expect(analyse(rows).spread7?.durationSdMin).toBeNull(); expect(analyse(rows).nights.at(-1)?.sleepMin).toBeNull();
    const dst = full('2026-03-29'); dst.row.sleepStart = '2026-03-29T01:30:00+01:00'; dst.row.sleepEnd = '2026-03-29T04:30:00+02:00';
    expect(analyse([dst]).nights[0]?.midpoint).toBe('03:30');
  });
  it('requires consecutive nights and masks, ending at the latest night', () => {
    const rows = series('2026-10-01', 15); rows.splice(12, 1);
    expect(analyse(rows)).toMatchObject({ spread7: null, spread14: null, sri7: null });
    const week = series('2026-10-01', 7);
    expect(analyse(week, '2026-10-10').sri7).toEqual({ share: 1, n: 576 });
    week[2]!.sleepMask = null; expect(analyse(week).sri7).toBeNull();
    week[2]!.row.sleepEnd = null; expect(analyse(week).spread7).toBeNull();
  });
  it.each([['2026-02-01', 576], ['2026-03-26', 568], ['2026-10-23', 576]])('pairs DST clock labels exactly for %s', (start, n) => {
    const rows = series(start, 7); expect(analyse(rows).sri7).toEqual({ share: 1, n });
  });
  it('pairs repeated fall-back labels in occurrence order; excludes unknown slots', () => {
    const rows = series('2026-10-23', 7), fall = rows[2]!;
    fall.sleepMask = '0'.repeat(12) + '1'.repeat(4) + '0'.repeat(84);
    expect(analyse(rows).sri7).toEqual({ share: 1, n: 576 }); // second 02:00 hour has no counterpart
    rows[0]!.sleepMask = '-' + '1' + '0'.repeat(94);
    expect(analyse(rows).sri7).toEqual({ share: 0.998, n: 575 });
    rows.forEach((r) => { r.sleepMask = '-'.repeat(r.sleepMask!.length); }); expect(analyse(rows).sri7).toBeNull();
  });
  it('requires 14 nights and four weekend nights for signed social jetlag', () => {
    const rows = series('2026-10-01', 18);
    rows.forEach((r) => { if ([0, 6].includes(new Date(r.row.date).getUTCDay())) { r.row.sleepStart = `${r.row.date}T01:00:00+02:00`; r.row.sleepEnd = r.row.sleepStart; } else { r.row.sleepStart = `${shift(r.row.date, -1)}T23:00:00+02:00`; r.row.sleepEnd = r.row.sleepStart; } });
    expect(analyse(rows.slice(0, 13)).socialJetlag).toBeNull();
    expect(analyse(rows.filter((r) => !['2026-10-10', '2026-10-11', '2026-10-17'].includes(r.row.date))).socialJetlag).toBeNull();
    expect(analyse(rows.filter((r) => !['2026-10-10', '2026-10-11'].includes(r.row.date))).socialJetlag).toEqual({ shiftMin: 120, weekendNights: 4, weekdayNights: 12 });
  });
  it.each(['sha', 'size', 'utf8', 'large-error'])('retains the daily read guard: %s', async (guard) => {
    const store = await InMemoryStore.create({ [HEALTH_VITALS_DAILY_CSV]: `${RING_DAILY_HEADER_V1}\n${legacy}\n` });
    const original = await store.readFile(HEALTH_VITALS_DAILY_CSV as Parameters<typeof store.readFile>[0], store.headCommit);
    vi.spyOn(store, 'readFile').mockImplementation(async () => {
      if (guard === 'large-error') throw new FileTooLarge();
      return { ...original!, ...(guard === 'sha' ? { blobSha: 'f'.repeat(40) } : { bytes: guard === 'size' ? new Uint8Array(1024 * 1024 + 1) : new Uint8Array([255]) }) };
    });
    expect(await readRingAnalysis(deps(store))).toMatchObject({ status: 'unreadable', nights: [], coverage: { days: [] } });
  });
  it('reads V1 as ok with unknown new coverage, reads only daily and refuses malformed new cells', async () => {
    const store = await InMemoryStore.create({ [HEALTH_VITALS_DAILY_CSV]: `${RING_DAILY_HEADER_V1}\n${legacy}\n` }), read = vi.spyOn(store, 'readFile');
    const a = RingAnalysisResponse.parse(await readRingAnalysis(deps(store)));
    expect(a).toMatchObject({ status: 'ok', coverage: { days: [{ dataHours: null, longestGapMin: null }] } });
    expect(read.mock.calls.map(([path]) => path)).toEqual([HEALTH_VITALS_DAILY_CSV]);
    for (const cells of ['1,0,' + '0'.repeat(95), '1,0,' + 'x'.repeat(96), '1.5,0,' + '0'.repeat(96), '1,0.5,' + '0'.repeat(96)]) {
      const bad = await InMemoryStore.create({ [HEALTH_VITALS_DAILY_CSV]: `${RING_DAILY_HEADER}\n${legacy},${cells}\n` });
      expect(await readRingAnalysis(deps(bad))).toMatchObject({ status: 'unreadable', nights: [], coverage: { days: [], nightsMissed: null } });
    }
    expect(parseRingDailyFull(`${RING_DAILY_HEADER}\n${legacy},,,\n`)[0]).toMatchObject({ slotsN: null, longestGapMin: null, sleepMask: null });
    expect(await readRingAnalysis(deps(await InMemoryStore.create({})))).toMatchObject({ status: 'missing', firstDate: null, nights: [] });
  });
});
