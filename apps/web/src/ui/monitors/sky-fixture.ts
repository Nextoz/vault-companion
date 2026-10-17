// Test fixture for the Sky card, shared by the unit test and the e2e specs (e2e/sky-fixture.ts re-exports it).
// Kp rows are the real NOAA SWPC capture of 16 Oct 2026 (three-hour slots).
import { SkyResponse } from '@vault-companion/contracts';

const POINTS = [
  { time: '2026-10-16T09:00:00.000Z', kp: 2.67, kind: 'observed' },
  { time: '2026-10-16T12:00:00.000Z', kp: 2.33, kind: 'observed' },
  { time: '2026-10-16T15:00:00.000Z', kp: 3, kind: 'estimated' },
  { time: '2026-10-16T18:00:00.000Z', kp: 3.33, kind: 'predicted' },
] as const;

/** An ok sky response whose current slot is Kp 3; fetched "now" so the card never shows stale. */
export function skyFixture(): SkyResponse {
  return SkyResponse.parse({
    status: 'ok',
    now: '2026-10-16T17:15:00.000Z',
    fetchedAt: new Date().toISOString(),
    points: POINTS,
    current: POINTS[2],
    next24hMax: POINTS[3],
  });
}
