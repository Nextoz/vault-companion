import { readFileSync } from 'node:fs';
import { PowerResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { parseCo2Body, parsePriceBody, projectPower, type PriceRow } from './power.ts';

// Real Energi Data Service captures (16 Oct 2026, ~19:15 Copenhagen).
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../test/fixtures/monitors/${name}`, import.meta.url), 'utf8'));
const timeZone = 'Europe/Copenhagen';
const prices = parsePriceBody(fixture('day-ahead-prices-dk2.json'))!;
const co2 = parseCo2Body(fixture('co2-emis-dk2.json'))!;
const co2Prog = parseCo2Body(fixture('co2-prog-dk2.json'))!;
const at = (iso: string) => ({ now: new Date(iso), fetchedAt: iso, timeZone });

function project(input: Partial<Parameters<typeof projectPower>[0]> = {}) {
  const result = projectPower({ prices, co2, co2Prog, ...at('2026-10-16T17:15:00Z'), ...input });
  expect(PowerResponse.parse(result)).toEqual(result);
  return result;
}

/** Synthetic quarter-hour rows (flat price) for DST-boundary days; the real fixture has no DST day. */
function flatRows(fromUtc: string, quarters: number): PriceRow[] {
  const start = Date.parse(fromUtc);
  return Array.from({ length: quarters }, (_, i) => ({ timeUtc: new Date(start + i * 15 * 60_000).toISOString(), dkkPerMwh: 1000 }));
}

describe('power projection (real captures)', () => {
  it('builds Copenhagen hours, averages, windows, the now hour and CO2 now', () => {
    const result = project();
    if (result.status !== 'ok') throw new Error('expected ok');
    const { today, tomorrow } = result;
    if (today.status !== 'ok' || tomorrow.status !== 'ok') throw new Error('expected both days');
    expect(today.day).toBe('2026-10-16');
    expect(today.hours).toHaveLength(24);
    expect(today.hours[0]).toEqual({ start: '2026-10-15T22:00:00.000Z', label: '00', krPerKwh: 1.4117, quarters: 4 });
    expect([today.averageKrPerKwh, today.minKrPerKwh, today.maxKrPerKwh]).toEqual([1.562, 1.1426, 1.9616]);
    expect(today.cheapestWindow).toMatchObject({ day: '2026-10-16', label: '12-15', averageKrPerKwh: 1.2085 });
    expect(tomorrow.day).toBe('2026-10-17');
    expect(tomorrow.hours).toHaveLength(24);
    expect(tomorrow.averageKrPerKwh).toBe(1.1727);
    expect(tomorrow.cheapestWindow).toMatchObject({ label: '12-15', averageKrPerKwh: 0.9367 });
    expect(result.nowHour).toMatchObject({ label: '19', krPerKwh: 1.9616 });
    // The past 12-15 window today is not offered as "upcoming"; tomorrow's is.
    expect(result.upcomingWindow).toEqual({ day: '2026-10-17', start: '2026-10-17T10:00:00.000Z', end: '2026-10-17T13:00:00.000Z', label: '12-15', averageKrPerKwh: 0.9367 });
    expect(result.co2).toEqual({ at: '2026-10-16T17:10:00.000Z', gPerKwh: 39, kind: 'measured' });
  });

  it('says tomorrow is not published yet instead of drawing an empty day', () => {
    const todayOnly = prices.filter((row) => row.timeUtc < '2026-10-16T22:00:00.000Z');
    const result = project({ prices: todayOnly });
    expect(result).toMatchObject({ status: 'ok', tomorrow: { status: 'not-published', day: '2026-10-17' } });
  });

  it('is unavailable (empty) when the provider has no rows for today', () => {
    const empty = parsePriceBody(fixture('day-ahead-prices-empty.json'))!;
    expect(empty).toEqual([]);
    expect(project({ prices: empty })).toMatchObject({ status: 'unavailable', reason: 'empty' });
  });

  it('falls back to the CO2 forecast, and shows no CO2 when every row is stale', () => {
    expect(project({ co2: null, ...at('2026-10-16T17:20:00Z') })).toMatchObject({
      status: 'ok',
      co2: { at: '2026-10-16T17:20:00.000Z', gPerKwh: 38, kind: 'forecast' },
    });
    expect(project({ co2Prog: null, ...at('2026-10-16T19:15:00Z') })).toMatchObject({ status: 'ok', co2: null });
  });

  it('leaves a provider null out of the hour mean and counts the remaining quarters', () => {
    const gap = prices.map((row) => (row.timeUtc === '2026-10-15T22:00:00.000Z' ? { ...row, dkkPerMwh: null } : row));
    const result = project({ prices: gap });
    expect(result.status === 'ok' && result.today.status === 'ok' && result.today.hours[0]!.quarters).toBe(3);
  });
});

describe('power projection across DST (review focus)', () => {
  it('gives 25 hours on 25 Oct 2026, with 02 twice', () => {
    const result = project({ prices: flatRows('2026-10-24T22:00:00Z', 100), co2: null, co2Prog: null, ...at('2026-10-25T10:00:00Z') });
    if (result.status !== 'ok' || result.today.status !== 'ok') throw new Error('expected ok');
    expect(result.today.hours).toHaveLength(25);
    expect(result.today.hours.filter((h) => h.label === '02')).toHaveLength(2);
    expect(result.today.hours.at(-1)!.label).toBe('23');
  });

  it('gives 23 hours on 28 Mar 2027, without 02', () => {
    const result = project({ prices: flatRows('2027-03-27T23:00:00Z', 92), co2: null, co2Prog: null, ...at('2027-03-28T10:00:00Z') });
    if (result.status !== 'ok' || result.today.status !== 'ok') throw new Error('expected ok');
    expect(result.today.hours).toHaveLength(23);
    expect(result.today.hours.some((h) => h.label === '02')).toBe(false);
  });

  it('writes a window that ends at local midnight as -24', () => {
    // Only hours 21-23 are still ahead at 21:30 local; tomorrow is not published.
    const result = project({ prices: flatRows('2026-10-15T22:00:00Z', 96), co2: null, co2Prog: null, ...at('2026-10-16T19:30:00Z') });
    expect(result).toMatchObject({ status: 'ok', upcomingWindow: { label: '21-24', day: '2026-10-16' } });
  });
});

describe('strict body parsing', () => {
  const row = { TimeUTC: '2026-10-16T00:00:00', TimeDK: '2026-10-16T02:00:00', PriceArea: 'DK2', DayAheadPriceEUR: 1, DayAheadPriceDKK: 7.5 };
  const body = (...rows: unknown[]) => ({ total: rows.length, dataset: 'DayAheadPrices', records: rows });
  it('accepts a valid row and refuses anything unexpected', () => {
    expect(parsePriceBody(body(row))).toEqual([{ timeUtc: '2026-10-16T00:00:00.000Z', dkkPerMwh: 7.5 }]);
    expect(parsePriceBody(body({ ...row, TimeUTC: '2026-10-16T00:07:00' }))).toBeNull();
    expect(parsePriceBody(body({ ...row, PriceArea: 'DK1' }))).toBeNull();
    expect(parsePriceBody(body(row, row))).toBeNull();
    expect(parsePriceBody(body({ ...row, DayAheadPriceDKK: 'x' }))).toBeNull();
    expect(parsePriceBody(body({ ...row, TimeUTC: '2026-10-16T00:00:00Z' }))).toBeNull();
    expect(parsePriceBody([row])).toBeNull();
    expect(parseCo2Body(body({ Minutes5UTC: '2026-10-16T00:00:00', PriceArea: 'DK2', CO2Emission: -1 }))).toBeNull();
  });
});
