import type { PowerCo2, PowerDay, PowerHour, PowerResponse, PowerWindow } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { co2Line, formatKr, powerBars, powerFreshTime, powerStale, powerSummary } from './power.ts';

const hour = (index: number, krPerKwh: number): PowerHour => ({
  start: `2026-10-16T${String(index).padStart(2, '0')}:00:00.000Z`,
  label: String(index).padStart(2, '0'),
  krPerKwh,
  quarters: 4,
});

/** Hour 18 is the day's maximum, hour 2 is negative; hours 3-5 are the cheap window, hour 4 is now. */
const dayPrices = [
  0.6, 0.5, -0.1, 0.3, 0.4, 0.5, 0.8, 1.0, 1.2, 1.1, 0.9, 0.7, 0.6, 0.5, 0.4, 0.5, 0.6, 0.8, 2.0, 1.6, 1.4, 1.2, 1.0, 0.8,
];

const okDay = (): Extract<PowerDay, { status: 'ok' }> => ({
  status: 'ok',
  day: '2026-10-16',
  hours: dayPrices.map((krPerKwh, index) => hour(index, krPerKwh)),
  averageKrPerKwh: 0.8,
  minKrPerKwh: -0.1,
  maxKrPerKwh: 2.0,
  cheapestWindow: null,
});

const cheapWindow = (): PowerWindow => ({
  day: '2026-10-16',
  start: '2026-10-16T03:00:00.000Z',
  end: '2026-10-16T06:00:00.000Z',
  label: '03-06',
  averageKrPerKwh: 0.4,
});

const okResponse = (nowHour: PowerHour | null, upcomingWindow: PowerWindow | null): PowerResponse => ({
  status: 'ok',
  now: '2026-10-16T14:05:00.000Z',
  fetchedAt: '2026-10-16T13:00:00.000Z',
  area: 'DK2',
  today: okDay(),
  tomorrow: { status: 'not-published', day: '2026-10-17' },
  nowHour,
  upcomingWindow,
  co2: null,
});

describe('powerSummary', () => {
  it('joins the current price with the cheapest upcoming window', () => {
    expect(powerSummary(okResponse(hour(14, 1.12), cheapWindow()))).toBe('Now 1.12 kr · cheapest 03-06 0.40 kr');
  });

  it('without a current hour keeps only the window, capitalised', () => {
    expect(powerSummary(okResponse(null, cheapWindow()))).toBe('Cheapest 03-06 0.40 kr');
  });

  it('without an upcoming window keeps only the current price', () => {
    expect(powerSummary(okResponse(hour(14, 1.12), null))).toBe('Now 1.12 kr');
  });

  it('with neither says the prices are unavailable', () => {
    expect(powerSummary(okResponse(null, null))).toBe('Prices unavailable');
  });
});

describe('formatKr', () => {
  it('keeps two decimals with a dot', () => {
    expect(formatKr(0.6)).toBe('0.60');
    expect(formatKr(1.12)).toBe('1.12');
  });
});

describe('powerFreshTime', () => {
  it('renders the fetch stamp as a Copenhagen HH:mm clock time', () => {
    expect(powerFreshTime('2026-10-16T14:05:00.000Z')).toBe('16:05');
  });
});

describe('powerStale', () => {
  it('is stale only after 45 minutes', () => {
    const response = okResponse(hour(14, 1.12), cheapWindow());
    expect(powerStale(response, Date.parse('2026-10-16T13:46:00.000Z'))).toBe(true);
    expect(powerStale(response, Date.parse('2026-10-16T13:44:00.000Z'))).toBe(false);
  });
});

describe('powerBars', () => {
  const bars = powerBars(okDay(), '2026-10-16T04:00:00.000Z', cheapWindow());

  it('draws one bar per hour of the day', () => {
    expect(bars).toHaveLength(24);
  });

  it('gives the day maximum a full bar and negatives a zero bar', () => {
    expect(bars[18]!.ratio).toBe(1);
    expect(bars[2]!.ratio).toBe(0);
  });

  it('marks the window hours cheap, and the now hour now even inside the window', () => {
    expect(bars[3]!.kind).toBe('cheap');
    expect(bars[5]!.kind).toBe('cheap');
    expect(bars[4]!.kind).toBe('now');
    expect(bars[0]!.kind).toBe('normal');
  });
});

describe('co2Line', () => {
  const at = '2026-10-16T14:00:00.000Z';

  it('labels measured intensity as now', () => {
    const measured: PowerCo2 = { at, gPerKwh: 123.4, kind: 'measured' };
    expect(co2Line(measured)).toBe('123 g/kWh now');
  });

  it('labels forecast intensity as forecast', () => {
    const forecast: PowerCo2 = { at, gPerKwh: 210.6, kind: 'forecast' };
    expect(co2Line(forecast)).toBe('211 g/kWh forecast');
  });

  it('says CO2 is not available rather than guessing', () => {
    expect(co2Line(null)).toBe('CO₂ not available');
  });
});
