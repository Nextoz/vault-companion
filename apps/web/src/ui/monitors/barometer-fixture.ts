// Barometer fixture shared by the BarometerMonitor unit tests and the e2e specs (the app project cannot import from
// e2e/, rootDir is src). The numbers come from the real DMI capture of 17 Oct 2026 (apps/worker/test/fixtures/monitors):
// Kastrup 1020.2 and Jaegersborg 1020.27 hPa at 06:40Z, weighted by distance to Trianglen = 1020.2; three hours earlier 1018.9.
import type { BarometerResponse } from '@vault-companion/contracts';

export type BarometerOkFixture = Extract<BarometerResponse, { status: 'ok' }>;

export function barometerFixture(over: Partial<BarometerOkFixture> = {}): BarometerOkFixture {
  return {
    status: 'ok',
    now: '2026-09-30T12:00:00.000Z',
    fetchedAt: '2026-09-30T11:58:00.000Z',
    source: 'dmi',
    place: 'Trianglen',
    hPa: 1020.2,
    observedAt: '2026-09-30T11:50:00.000Z',
    hPaThreeHoursAgo: 1018.9,
    changeHpa: 1.3,
    trend: 'rising',
    zone: 'Fair',
    ...over,
  };
}
