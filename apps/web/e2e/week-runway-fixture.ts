// Synthetic M8 week-runway response for the Playwright tour: seven Copenhagen evenings from the tour clock
// (2026-09-30), 3 free / 2 busy / 2 picks. Every title and id below is synthetic — never vault text.
import type { WeekRunwayEvening, WeekRunwayResponse } from '@vault-companion/contracts';

const evening = (
  day: string,
  highTemperatureC: number,
  weatherCode: number,
  state: WeekRunwayEvening['state'],
  picks: WeekRunwayEvening['picks'] = [],
): WeekRunwayEvening => ({ day, highTemperatureC, weatherCode, state, picks });

/** Wed 30 Sep - Tue 6 Oct 2026, all CEST (UTC+2): the workshop is 17:00-21:00 local, the talk starts 18:30 local. */
export const weekRunwayFixture = (): WeekRunwayResponse => ({
  now: '2026-09-30T12:00:00Z',
  sources: { calendar: 'ok', weather: 'ok', triage: 'ok' },
  evenings: [
    evening('2026-09-30', 12, 2, 'free'),
    evening('2026-10-01', 11, 61, 'free'),
    evening('2026-10-02', 10, 0, 'busy'),
    evening('2026-10-03', 9, 61, 'free'),
    evening('2026-10-04', 11, 2, 'pick', [
      {
        eventId: 'e0000000000000000001',
        title: 'Synthetic open workshop',
        start: '2026-10-04T15:00:00Z',
        end: '2026-10-04T19:00:00Z',
      },
    ]),
    evening('2026-10-05', 12, 3, 'busy'),
    evening('2026-10-06', 13, 0, 'pick', [
      { eventId: 'e0000000000000000002', title: 'Synthetic talk', start: '2026-10-06T16:30:00Z', end: null },
    ]),
  ],
  counts: { free: 3, busy: 2, picked: 2 },
});
