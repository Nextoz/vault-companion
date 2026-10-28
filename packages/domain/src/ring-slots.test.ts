import { describe, expect, it } from 'vitest';
import { RING_METRICS } from './ring-metrics.ts';
import { canonicalSlotStart, parseRingPayload, slotMonth, splitByMonth } from './ring-slots.ts';
const now = new Date('2026-11-01T12:00:00+01:00');
const slot = (start = '2026-11-01T10:15:00+01:00', patch: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ...Object.fromEntries(RING_METRICS.map((m) => [m.key, null])), start, hr: 987, ...patch });
const payload = (slots: unknown[] = [slot()], patch: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 'ring-slots/1', device: 'synthetic', generatedAt: now.toISOString(), slots, ...patch });
describe('ring payload', () => {
  const refusals: [string, unknown[], Record<string, unknown>, 400 | 422, string][] = [
    ...['2026-11-01T10:07:00+01:00', '2026-11-01T10:15:30+01:00', '2026-11-01T10:15:00.000+01:00', '2026-10-24T10:15:00+01:00', '2026-11-01T12:15:00+01:00'].map((start): [string, unknown[], Record<string, unknown>, 422, string] => [start, [slot(start)], {}, 422, 'slot 0 start']),
    ['duplicate', [slot(), slot()], {}, 422, 'slot 1 start'],
    ['unknown', [slot(undefined, { extra: 987 })], {}, 400, 'slot 0 extra'],
    ['missing', [Object.fromEntries(Object.entries(slot()).filter(([k]) => k !== 'steps'))], {}, 400, 'slot 0 steps'],
    ['all null', [slot(undefined, { hr: null })], {}, 422, 'slot 0 start'],
    ...[['hr', '987'], ['hr', -987], ['hr', 1.5], ['tempC', 1.123], ['tempC', 0.00000000001], ['sleepLightMin', 16]].map(([key, value]): [string, unknown[], Record<string, unknown>, 400, string] => [String(key), [slot(undefined, { [key!]: value })], {}, 400, `slot 0 ${key}`]),
    ['sleep sum', [slot(undefined, { sleepLightMin: 8, sleepDeepMin: 8 })], {}, 422, 'slot 0 sleepDeepMin'],
    ...[ ['schema', 'ring-slots/2'], ['device', ''], ['device', 'x'.repeat(65)], ['generatedAt', '2026-11-01T12:05:01+01:00'] ].map(([key, value]): [string, unknown[], Record<string, unknown>, 400, string] => [key!, [slot()], { [key!]: value }, 400, key!]),
  ];
  it.each(refusals)('refuses %s privately', (_name, slots, patch, status, key) => {
    const result = parseRingPayload(payload(slots, patch), now);
    expect(result).toMatchObject({ ok: false, status });
    if (!result.ok) { expect(result.error).toContain(key); expect(result.error).not.toContain('987'); }
  });
  it('refuses malformed JSON, start and generatedAt types', () => {
    for (const body of ['{', payload([slot(undefined, { start: 987 })]), payload([], { generatedAt: '987' })]) expect(parseRingPayload(body, now)).toMatchObject({ ok: false, status: 400 });
  });
  it('accepts empty slots, zero, decimals and the inclusive window', () => {
    expect(parseRingPayload(payload([]), now)).toEqual({ ok: true, version: 1, slots: [] });
    const result = parseRingPayload(payload([slot('2026-10-24T12:00:00+02:00', { hr: 0, tempC: 1.1, sleepLightMin: 15 })], { generatedAt: '2026-11-01T11:00:00+01:00' }), now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slots[0]?.values).toMatchObject({ hr: 0, tempC: 1.1, steps: null });
  });
  it('preserves both DST instants and refuses aliases', () => {
    const a = '2026-10-25T02:15:00+02:00', b = '2026-10-25T02:15:00+01:00';
    const result = parseRingPayload(payload([slot(b), slot(a)]), now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slots.map((s) => canonicalSlotStart(s.instant))).toEqual([a, b]);
    expect(parseRingPayload(payload([slot(b), slot('2026-10-25T01:15:00Z')]), now)).toMatchObject({ ok: false, status: 422 });
  });
  it('splits by Copenhagen month oldest first', () => {
    const result = parseRingPayload(payload([slot('2026-11-01T00:00:00+01:00'), slot('2026-10-31T23:45:00+01:00')]), now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...splitByMonth([...result.slots].reverse()).keys()]).toEqual(['2026-10', '2026-11']);
      expect(slotMonth(Date.parse('2026-10-31T23:00:00Z'))).toBe('2026-11');
    }
  });
});
