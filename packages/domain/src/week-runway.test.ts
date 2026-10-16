// Week runway projection tests. Synthetic fixtures only: titles like "Synthetic workshop", no vault text.
import { describe, expect, it } from 'vitest';
import {
  WeekRunwayResponse,
  type TriageCard,
  type TriageResponse,
  type WeatherWeekDay,
} from '@vault-companion/contracts';
import { projectWeekRunway, type BusyInterval } from './week-runway.ts';

const NOW = new Date('2026-10-16T14:05:00Z');
const TZ = 'Europe/Copenhagen';
// CEST (UTC+2) until 25 Oct 2026: every evening 17:00-23:00 is 15:00Z-21:00Z before that Sunday.

/** `seed` padded with '0' to a 20-hex-char event id. */
const eid = (seed: string): string => seed.padEnd(20, '0');
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type DecisionLine = TriageResponse['decisions'][number];

function decision(
  n: number,
  eventId: string,
  at: string,
  overrides: Partial<Pick<DecisionLine, 'decision' | 'title' | 'start' | 'undoes'>> = {},
): DecisionLine {
  return {
    decisionId: uuid(n),
    eventId,
    decision: 'go',
    outcome: null,
    undoes: null,
    at,
    title: null,
    start: null,
    ...overrides,
  };
}

function card(eventId: string, title: string, start: string, end: string | null): TriageCard {
  return {
    eventId,
    rank: 1,
    explore: false,
    resurfaced: false,
    summary: '',
    title,
    start,
    end,
    location: 'Synthetic spot',
    online: false,
    cost: '',
    registration: { state: 'unknown', deadline: null },
    aiScore: 50,
    why: 'Synthetic why line',
    category: 'meetup',
    scouts: [],
    sourceName: 'Synthetic source',
    sourceUrl: 'https://example.com/synthetic',
    calendar: { inCalendar: null, clash: null, freeThatEvening: true },
  };
}

function triage(cards: readonly TriageCard[], decisions: readonly DecisionLine[]): TriageResponse {
  return {
    revision: 'a'.repeat(40),
    now: '2026-10-16T14:05:00.000Z',
    feedState: 'ok',
    generatedAt: null,
    cards: [...cards],
    checkins: [],
    droppedCards: 0,
    droppedCheckins: 0,
    decisions: [...decisions],
    applied: {},
    appliedUpdatedAt: null,
  };
}

function weekDay(day: string, highTemperatureC: number | null, weatherCode: number | null): WeatherWeekDay {
  return {
    day,
    lowTemperatureC: null,
    highTemperatureC,
    rainMm: null,
    precipitationProbabilityPct: null,
    weatherCode,
    models: 1,
    partial: false,
    runWindow: null,
  };
}

describe('projectWeekRunway', () => {
  it('marks free / busy / pick evenings with weather and counts, and satisfies the contract', () => {
    const result = projectWeekRunway({
      now: NOW,
      timeZone: TZ,
      week: [weekDay('2026-10-16', 14.5, 3), weekDay('2026-10-18', null, 61)],
      busy: [
        // 22:30-23:30 local on 16 Oct overlaps 17:00-23:00.
        { start: '2026-10-16T20:30:00Z', end: '2026-10-16T21:30:00Z' },
        // 16:00-17:00 local on 17 Oct only touches the window edge: not busy.
        { start: '2026-10-17T14:00:00Z', end: '2026-10-17T15:00:00Z' },
      ],
      triage: triage(
        [card(eid('a1'), 'Synthetic workshop', '2026-10-18T15:30:00Z', '2026-10-18T17:00:00Z')],
        [decision(1, eid('a1'), '2026-10-15T09:00:00Z')],
      ),
    });

    expect(result.now).toBe('2026-10-16T14:05:00.000Z');
    expect(result.sources).toEqual({ calendar: 'ok', weather: 'ok', triage: 'ok' });
    expect(result.evenings.map((evening) => evening.day)).toEqual([
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
    ]);
    expect(result.evenings[0]).toMatchObject({ state: 'busy', highTemperatureC: 14.5, weatherCode: 3, picks: [] });
    expect(result.evenings[1]).toMatchObject({ state: 'free', highTemperatureC: null, weatherCode: null, picks: [] });
    expect(result.evenings[2]).toEqual({
      day: '2026-10-18',
      highTemperatureC: null,
      weatherCode: 61,
      state: 'pick',
      picks: [{ eventId: eid('a1'), title: 'Synthetic workshop', start: '2026-10-18T15:30:00Z', end: '2026-10-18T17:00:00Z' }],
    });
    expect(result.evenings.slice(3).map((evening) => evening.state)).toEqual(['free', 'free', 'free', 'free']);
    expect(result.counts).toEqual({ free: 5, busy: 1, picked: 1 });
    expect(WeekRunwayResponse.safeParse(result).success).toBe(true);
  });

  it('drops undone decisions and events whose latest decision is not go', () => {
    const result = projectWeekRunway({
      now: NOW,
      timeZone: TZ,
      week: null,
      busy: [],
      triage: triage(
        [
          card(eid('a1'), 'Synthetic undone workshop', '2026-10-18T15:30:00Z', '2026-10-18T17:00:00Z'),
          card(eid('c3'), 'Synthetic twice-decided workshop', '2026-10-19T15:30:00Z', '2026-10-19T17:00:00Z'),
        ],
        // Scrambled file order on purpose; the projection sorts by `at`.
        [
          decision(2, eid('a1'), '2026-10-15T10:00:00Z', { decision: 'undo', undoes: uuid(1) }),
          decision(4, eid('b2'), '2026-10-15T11:00:00Z', { decision: 'skip' }),
          decision(1, eid('a1'), '2026-10-15T09:00:00Z'),
          decision(3, eid('b2'), '2026-10-15T09:30:00Z'),
          decision(6, eid('c3'), '2026-10-15T12:00:00Z'),
          decision(5, eid('c3'), '2026-10-14T08:00:00Z'),
        ],
      ),
    });

    // 'a1' is undone; 'b2' ends in skip; only 'c3' (latest of two go lines) stays.
    expect(result.counts).toEqual({ free: 6, busy: 0, picked: 1 });
    const pickEvenings = result.evenings.filter((evening) => evening.state === 'pick');
    expect(pickEvenings.map((evening) => evening.day)).toEqual(['2026-10-19']);
  });

  it('uses the decision title and a null end when the feed card is missing, and skips picks without a start', () => {
    const result = projectWeekRunway({
      now: NOW,
      timeZone: TZ,
      week: null,
      busy: [],
      triage: triage(
        [],
        [
          decision(1, eid('d4'), '2026-10-15T09:00:00Z', { title: 'Synthetic decision-title workshop', start: '2026-10-20T15:30:00Z' }),
          decision(2, eid('e5'), '2026-10-15T09:00:00Z', { title: 'Synthetic startless workshop', start: null }),
        ],
      ),
    });

    expect(result.counts).toEqual({ free: 6, busy: 0, picked: 1 });
    expect(result.evenings[4]).toEqual({
      day: '2026-10-20',
      highTemperatureC: null,
      weatherCode: null,
      state: 'pick',
      picks: [{ eventId: eid('d4'), title: 'Synthetic decision-title workshop', start: '2026-10-20T15:30:00Z', end: null }],
    });
  });

  it('reports unavailable sources and unknown evenings when every input is null', () => {
    const result = projectWeekRunway({ now: NOW, timeZone: TZ, week: null, busy: null, triage: null });

    expect(result.sources).toEqual({ calendar: 'unavailable', weather: 'unavailable', triage: 'unavailable' });
    expect(result.evenings).toHaveLength(7);
    for (const evening of result.evenings) {
      expect(evening).toMatchObject({ state: 'unknown', highTemperatureC: null, weatherCode: null, picks: [] });
    }
    expect(result.counts).toEqual({ free: 0, busy: 0, picked: 0 });
  });

  it('shifts the evening window across the October DST change (16:00Z-22:00Z after 25 Oct)', () => {
    const busy: readonly BusyInterval[] = [
      // 15:00-16:30 local on 26 Oct (CET): before the 17:00 window, busy only under a stale +02:00 offset.
      { start: '2026-10-26T14:00:00Z', end: '2026-10-26T15:30:00Z' },
      // 17:00-18:00 local on 26 Oct: inside the window.
      { start: '2026-10-26T16:00:00Z', end: '2026-10-26T17:00:00Z' },
      // 23:00-23:30 local on 24 Oct (CEST): past the window end, busy only under a wrong post-DST offset.
      { start: '2026-10-24T21:00:00Z', end: '2026-10-24T21:30:00Z' },
    ];
    const result = projectWeekRunway({ now: new Date('2026-10-23T10:00:00Z'), timeZone: TZ, week: null, busy, triage: null });

    expect(result.evenings.map((evening) => evening.day)).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
    ]);
    expect(result.evenings.map((evening) => evening.state)).toEqual([
      'free',
      'free',
      'free',
      'busy',
      'free',
      'free',
      'free',
    ]);
    expect(result.counts).toEqual({ free: 6, busy: 1, picked: 0 });
    expect(WeekRunwayResponse.safeParse(result).success).toBe(true);
  });
});
