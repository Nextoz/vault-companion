import { expect, it } from 'vitest';
import { affectedDates, deriveRingDaily, mergeDailyFile, ringNightSessions } from './ring-daily.ts';
import { RING_DAILY_HEADER, RING_METRICS } from './ring-metrics.ts';
import { type RingSlot } from './ring-slots.ts';
const tz = 'Europe/Copenhagen';
const slot = (start: string, values: Partial<RingSlot['values']> = {}): RingSlot => ({ instant: Date.parse(start), values: { ...Object.fromEntries(RING_METRICS.map((m) => [m.key, null])), ...values } as RingSlot['values'] });
const cells = (slots: RingSlot[], date = '2026-11-01') => Object.fromEntries(RING_DAILY_HEADER.split(',').map((key, i) => [key, deriveRingDaily(slots, [date], tz).get(date)?.split(',')[i]]));
it('uses registry aggregations, half-even rounding, counts and missing values', () => {
  const slots = [slot('2026-11-01T12:00:00+01:00', { hr: 72, spo2: 97, hrvMs: 40, tempC: 36.25, steps: 987 }), slot('2026-11-01T12:15:00+01:00', { hr: 73, spo2: 98, hrvMs: 41, tempC: 36.25 })];
  expect(cells(slots)).toMatchObject({ date: '2026-11-01', weekday: 'Sun', avg_hr: '72', min_spo2: '97', avg_spo2: '97.5', hrv_sdnn_ms: '40', body_temp_c: '36.2', hr_n: '2', spo2_n: '2', hrv_n: '2', temp_n: '2', sleep_n: '0', sleep_start: '', light_min: '' });
  expect(cells([slot('2026-11-01T12:00:00+01:00')])).toMatchObject({ avg_hr: '', hr_n: '0', avg_spo2: '', spo2_n: '0', resting_hr: '' });
  expect(deriveRingDaily([], ['2026-11-01'], tz).size).toBe(0);
});
it('takes daily derivation rules from registry entries', () => {
  const agg = RING_METRICS.find((m) => m.key === 'hr')!.daily.find((a) => a.column === 'avg_hr')!, original = agg.fn;
  agg.fn = 'min';
  try { expect(cells([slot('2026-11-01T12:00:00+01:00', { hr: 60 }), slot('2026-11-01T12:15:00+01:00', { hr: 80 })]).avg_hr).toBe('60'); }
  finally { agg.fn = original; }
});
it('joins four empty slots, splits five, selects longest session and breaks ties later', () => {
  const s = (time: string) => slot(`2026-11-01T${time}:00+01:00`, { sleepAwakeMin: 15 });
  const slots = ['04:00', '05:15', '06:45', '08:00', '10:00'].map(s);
  expect(ringNightSessions(slots, tz).map((n) => n.slots.length)).toEqual([2, 2, 1]);
  expect(cells(slots)).toMatchObject({ sleep_start: '2026-11-01T06:45:00+01:00', sleep_end: '2026-11-01T08:15:00+01:00', awake_min: '30', deep_min: '0', sleep_n: '2' });
  expect(cells([...slots, s('05:30')])).toMatchObject({ sleep_start: '2026-11-01T04:00:00+01:00', sleep_n: '5' });
});
it('uses all interval slots for resting HR, requires three and rounds an even median', () => {
  const slots = [slot('2026-11-01T04:00:00+01:00', { sleepLightMin: 15, hr: 60 }), slot('2026-11-01T05:00:00+01:00', { sleepLightMin: 15, hr: 80 })];
  expect(cells(slots).resting_hr).toBe('');
  slots.push(slot('2026-11-01T04:15:00+01:00', { hr: 72 }), slot('2026-11-01T04:30:00+01:00', { hr: 73 }));
  expect(cells(slots)).toMatchObject({ resting_hr: '72', sleep_n: '2' });
  slots.push(slot('2026-11-01T05:15:00+01:00', { hr: 987 }));
  expect(cells(slots).resting_hr).toBe('72');
});
it('assigns a cross-month night by wake minus three wall-clock hours and computes affected dates', () => {
  const slots = [slot('2026-10-31T23:00:00+01:00', { sleepLightMin: 15 }), slot('2026-11-01T00:15:00+01:00', { sleepDeepMin: 15 }), slot('2026-11-01T01:30:00+01:00', { sleepAwakeMin: 15 })];
  expect(cells(slots, '2026-10-31')).toMatchObject({ sleep_start: '2026-10-31T23:00:00+01:00', sleep_end: '2026-11-01T01:45:00+01:00', light_min: '15', deep_min: '15', awake_min: '15' });
  expect(affectedDates([slots[2]!], slots, tz)).toEqual(['2026-10-31', '2026-11-01']);
  const extended = [...slots, slot('2026-11-01T02:45:00+01:00', { sleepLightMin: 15 })];
  expect(cells(extended).sleep_start).toBe('2026-10-31T23:00:00+01:00');
  expect(affectedDates([slots[0]!], extended, tz)).toEqual(['2026-10-31', '2026-11-01']);
});
it.each([['2026-03-29', '2026-03-29T00:00:00+01:00', 92], ['2026-10-25', '2026-10-25T00:00:00+02:00', 100]] as const)('uses calendar day across DST %s', (date, start, count) => {
  const base = Date.parse(start), slots = Array.from({ length: count }, (_, i) => slot(new Date(base + i * 900000).toISOString(), { hr: 72 }));
  slots.push(slot(new Date(base - 900000).toISOString(), { hr: 987 }), slot(new Date(base + count * 900000).toISOString(), { hr: 987 }));
  expect(cells(slots, date)).toMatchObject({ hr_n: String(count), avg_hr: '72' });
});
it('merges daily rows with exact untouched bytes, idempotence, ordered insert and missing-date survival', () => {
  const old = `\uFEFF${RING_DAILY_HEADER}\r\n2026-10-31,synthetic\r\n2026-11-02,older`, rows = deriveRingDaily([slot('2026-11-01T12:00:00+01:00', { hr: 72 })], ['2026-11-01', '2026-11-02'], tz);
  const result = mergeDailyFile(old, rows);
  expect(result).toEqual({ ok: true, changed: true, text: old.replace('2026-11-02,older', `${rows.get('2026-11-01')}\r\n2026-11-02,older`) });
  if (!result.ok) throw Error('refused');
  expect(mergeDailyFile(result.text, rows)).toEqual({ ...result, changed: false });
  expect(mergeDailyFile(null, rows)).toEqual({ ok: true, changed: true, text: `${RING_DAILY_HEADER}\n${rows.get('2026-11-01')}\n` });
  expect(mergeDailyFile('wrong\n', rows)).toMatchObject({ ok: false, code: 'refused:structure' });
  const replacement = new Map([['2026-11-01', '2026-11-01,replaced']]);
  expect(mergeDailyFile(result.text, replacement)).toEqual({ ok: true, changed: true, text: result.text.replace(rows.get('2026-11-01')!, '2026-11-01,replaced') });
});
