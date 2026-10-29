import { expect, it } from 'vitest';
import type { PhoneSample } from './phone-samples.ts';
import { aggregatePhoneSlots, splitPhoneSlotsByMonth } from './phone-slots.ts';
import { canonicalSlotStart } from './ring-slots.ts';
const tz = 'Europe/Copenhagen';
const sample = (key: PhoneSample['key'], start: string, end: string, value: number): PhoneSample =>
  ({ key, start: Date.parse(start), end: Date.parse(end), value, ...(key === 'inBed' ? { inBed: true } : {}) });
const at = (time: string) => `2026-10-10T${time}:00+02:00`;
const aggregate = (samples: PhoneSample[], from = at('07:00'), sentAt = at('12:00')) =>
  aggregatePhoneSlots(samples, new Date(from), new Date(sentAt), tz);
it('allocates each integer sample exactly, with largest-remainder ties to the earlier instant', () => {
  const slots = aggregate([sample('steps', at('09:10'), at('09:20'), 987)]);
  expect(slots.map((s) => [canonicalSlotStart(s.instant), s.values.steps])).toEqual([
    [at('09:00'), 494], [at('09:15'), 493],
  ]);
  expect(slots.reduce((sum, s) => sum + s.values.steps!, 0)).toBe(987);
  expect(aggregate([sample('flights', at('09:14'), at('09:17'), 2)]).map((s) => s.values.flights)).toEqual([1, 1]);
  expect(aggregate([sample('distance', at('09:10'), at('09:20'), 1.234)]).map((s) => s.values.distance_km)).toEqual([0.617, 0.617]);
});
it('places zero-length samples by start, and uses start-assigned mean versus latest-starting last', () => {
  const slots = aggregate([
    sample('steps', at('09:15'), at('09:15'), 7),
    sample('walkingSpeed', at('09:01'), at('10:00'), 2), sample('walkingSpeed', at('09:12'), at('09:12'), 6),
    sample('steadiness', at('09:12'), at('09:12'), 6), sample('steadiness', at('09:01'), at('10:00'), 2),
  ]);
  expect(slots.map((s) => [s.values.steps, s.values.walking_speed_kmh, s.values.steadiness_pct])).toEqual([
    [null, 4, 6], [7, null, null],
  ]);
  expect(aggregate([])).toEqual([]);
});
it('unions headphone and in-bed overlap minutes while averaging sound in energy space', () => {
  const slots = aggregate([
    sample('headphone', at('09:00'), at('09:10'), 60), sample('headphone', at('09:05'), at('09:15'), 80),
    sample('inBed', at('09:00'), at('09:10'), 0), sample('inBed', at('09:05'), at('09:15'), 0),
  ]);
  expect(slots).toHaveLength(1);
  expect(slots[0]!.values).toMatchObject({ headphone_min: 15, headphone_db: 77.03, in_bed_min: 15, steps: null });
});
it('drops slot starts before from plus an hour and keeps the current partial slot', () => {
  const slots = aggregate([
    sample('steps', at('09:00'), at('09:00'), 1), sample('steps', at('09:15'), at('09:15'), 2),
    sample('steps', at('09:30'), at('09:35'), 3),
  ], at('08:07'), at('09:35'));
  expect(slots.map((s) => [canonicalSlotStart(s.instant), s.values.steps])).toEqual([[at('09:15'), 2], [at('09:30'), 3]]);
});
it('keeps repeated October instants separate, sorted, and splits by Copenhagen month', () => {
  const a = '2026-10-25T02:15:00+02:00', b = '2026-10-25T02:15:00+01:00';
  const slots = aggregate([sample('steps', b, b, 2), sample('steps', a, a, 1)], '2026-10-24T00:00:00+02:00', '2026-10-25T04:00:00+01:00');
  expect(slots.map((s) => canonicalSlotStart(s.instant))).toEqual([a, b]);
  const oct = '2026-10-31T23:45:00+01:00', nov = '2026-11-01T00:00:00+01:00';
  const months = splitPhoneSlotsByMonth(aggregate([sample('steps', nov, nov, 2), sample('steps', oct, oct, 1)],
    '2026-10-31T20:00:00+01:00', '2026-11-01T00:05:00+01:00'), tz);
  expect([...months.keys()]).toEqual(['2026-10', '2026-11']);
  expect([...months.values()].map((rows) => rows[0]!.values.steps)).toEqual([1, 2]);
});
