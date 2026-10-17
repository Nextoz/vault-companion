// Test fixture for the Power card, shared by the unit test and the e2e specs (e2e/power-fixture.ts re-exports it).
import { PowerResponse } from '@vault-companion/contracts';

// Hourly DK2 spot prices (kr/kWh) for 16 Oct 2026 and 17 Oct 2026, from the real Energi Data Service capture.
const TODAY = [1.4117, 1.396, 1.4137, 1.4299, 1.424, 1.4032, 1.6924, 1.8416, 1.9589, 1.8699, 1.6654, 1.4954, 1.2816, 1.1426, 1.2012, 1.3256, 1.5014, 1.7926, 1.8927, 1.9616, 1.8346, 1.6072, 1.519, 1.4252];
const TOMORROW = [1.4768, 1.3428, 1.2096, 1.1232, 1.1065, 1.1222, 1.1212, 1.1506, 1.299, 1.2652, 1.1953, 1.067, 0.949, 0.9102, 0.9508, 1.0194, 1.1433, 1.2921, 1.4498, 1.2799, 1.1919, 1.1671, 1.1767, 1.134];
const MIDNIGHT = { today: '2026-10-15T22:00:00.000Z', tomorrow: '2026-10-16T22:00:00.000Z' };
const HOUR_MS = 3_600_000;

function day(date: string, midnightUtc: string, prices: number[], windowFrom: number) {
  const start = Date.parse(midnightUtc);
  const mean = (list: number[]) => Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10_000) / 10_000;
  return {
    status: 'ok' as const,
    day: date,
    hours: prices.map((krPerKwh, hour) => ({ start: new Date(start + hour * HOUR_MS).toISOString(), label: String(hour).padStart(2, '0'), krPerKwh, quarters: 4 })),
    averageKrPerKwh: mean(prices),
    minKrPerKwh: Math.min(...prices),
    maxKrPerKwh: Math.max(...prices),
    cheapestWindow: {
      day: date,
      start: new Date(start + windowFrom * HOUR_MS).toISOString(),
      end: new Date(start + (windowFrom + 3) * HOUR_MS).toISOString(),
      label: `${String(windowFrom).padStart(2, '0')}-${String(windowFrom + 3).padStart(2, '0')}`,
      averageKrPerKwh: mean(prices.slice(windowFrom, windowFrom + 3)),
    },
  };
}

/** A parsed, ok power response at 19:15 Copenhagen on 16 Oct 2026; tomorrow is published unless `tomorrowPublished` is false. */
export function powerFixture(options: { tomorrowPublished?: boolean } = {}): PowerResponse {
  const today = day('2026-10-16', MIDNIGHT.today, TODAY, 12);
  const tomorrow = options.tomorrowPublished === false
    ? { status: 'not-published' as const, day: '2026-10-17' }
    : day('2026-10-17', MIDNIGHT.tomorrow, TOMORROW, 12);
  return PowerResponse.parse({
    status: 'ok',
    now: '2026-10-16T17:15:00.000Z',
    // Fresh against the page's real clock, so the card never shows "stale" in tests.
    fetchedAt: new Date().toISOString(),
    area: 'DK2',
    today,
    tomorrow,
    nowHour: today.hours[19],
    upcomingWindow: tomorrow.status === 'ok' ? tomorrow.cheapestWindow : null,
    co2: { at: '2026-10-16T17:10:00.000Z', gPerKwh: 39, kind: 'measured' },
  });
}
