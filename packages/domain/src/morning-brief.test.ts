import { describe, expect, it } from 'vitest';
import type { HealthCompare, HealthMetric, HealthMetricKey } from '@vault-companion/contracts';
import { findClashes, rankTodos, stateLine, freeBlocks, type BriefEvent, type BriefTodo } from './morning-brief.ts';

// All data synthetic. Europe/Copenhagen on 2026-06-15 is CEST (UTC+02:00), so local 07:00 = 05:00Z, 22:00 = 20:00Z.
const DAY = '2026-06-15';
const ev = (start: string, end: string, over: Partial<BriefEvent> = {}): BriefEvent => ({
  title: 'event',
  start,
  end,
  allDay: false,
  ...over,
});

describe('freeBlocks', () => {
  it('returns one 900-minute block for an empty calendar', () => {
    expect(freeBlocks([], DAY)).toEqual([
      { start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T20:00:00.000Z', minutes: 900, long: true },
    ]);
  });

  it('merges overlapping and touching events', () => {
    const events = [
      ev('2026-06-15T07:00:00.000Z', '2026-06-15T08:00:00.000Z'), // 09:00-10:00
      ev('2026-06-15T07:30:00.000Z', '2026-06-15T09:00:00.000Z'), // 09:30-11:00 overlaps
      ev('2026-06-15T09:00:00.000Z', '2026-06-15T10:00:00.000Z'), // 11:00-12:00 touching
    ];
    expect(freeBlocks(events, DAY)).toEqual([
      { start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T07:00:00.000Z', minutes: 120, long: true },
      { start: '2026-06-15T10:00:00.000Z', end: '2026-06-15T20:00:00.000Z', minutes: 600, long: true },
    ]);
  });

  it('clips events that cross 07:00 and 22:00', () => {
    const events = [
      ev('2026-06-15T04:00:00.000Z', '2026-06-15T05:30:00.000Z'), // 06:00-07:30, clips at window start
      ev('2026-06-15T19:30:00.000Z', '2026-06-15T21:00:00.000Z'), // 21:30-23:00, clips at window end
    ];
    expect(freeBlocks(events, DAY)).toEqual([
      { start: '2026-06-15T05:30:00.000Z', end: '2026-06-15T19:30:00.000Z', minutes: 840, long: true },
    ]);
  });

  it('ignores all-day events and REGISTRATION CHECK reminders, but not lookalikes', () => {
    const ignored = [
      ev('2026-06-15T07:00:00.000Z', '2026-06-15T08:00:00.000Z', { allDay: true }),
      ev('2026-06-15T08:00:00.000Z', '2026-06-15T09:00:00.000Z', { title: 'REGISTRATION CHECK' }),
      ev('2026-06-15T08:00:00.000Z', '2026-06-15T09:00:00.000Z', { title: '  REGISTRATION CHECK  ' }),
    ];
    expect(freeBlocks(ignored, DAY)).toEqual([
      { start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T20:00:00.000Z', minutes: 900, long: true },
    ]);

    const withParty = [...ignored, ev('2026-06-15T10:00:00.000Z', '2026-06-15T11:00:00.000Z', { title: 'Registration check-in party' })];
    expect(freeBlocks(withParty, DAY)).toEqual([
      { start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T10:00:00.000Z', minutes: 300, long: true },
      { start: '2026-06-15T11:00:00.000Z', end: '2026-06-15T20:00:00.000Z', minutes: 540, long: true },
    ]);
  });

  it('uses the local window on DST transition days', () => {
    // 2026-10-25: clocks fall back at 03:00; 07:00-22:00 is CET (UTC+01:00).
    expect(freeBlocks([], '2026-10-25')).toEqual([
      { start: '2026-10-25T06:00:00.000Z', end: '2026-10-25T21:00:00.000Z', minutes: 900, long: true },
    ]);
    // 2026-03-29: clocks jump forward at 02:00; 07:00-22:00 is CEST (UTC+02:00).
    expect(freeBlocks([], '2026-03-29')).toEqual([
      { start: '2026-03-29T05:00:00.000Z', end: '2026-03-29T20:00:00.000Z', minutes: 900, long: true },
    ]);
  });

  it('marks 89 minutes not long and 90 minutes long', () => {
    const short = freeBlocks([ev('2026-06-15T06:29:00.000Z', '2026-06-15T20:00:00.000Z')], DAY);
    expect(short).toEqual([{ start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T06:29:00.000Z', minutes: 89, long: false }]);

    const exactly = freeBlocks([ev('2026-06-15T06:30:00.000Z', '2026-06-15T20:00:00.000Z')], DAY);
    expect(exactly).toEqual([{ start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T06:30:00.000Z', minutes: 90, long: true }]);
  });

  it('drops a 14-minute gap and keeps a 15-minute one', () => {
    const dropped = [
      ev('2026-06-15T05:00:00.000Z', '2026-06-15T08:00:00.000Z'), // 07:00-10:00
      ev('2026-06-15T08:14:00.000Z', '2026-06-15T20:00:00.000Z'), // 10:14-22:00, 14-min gap
    ];
    expect(freeBlocks(dropped, DAY)).toEqual([]);

    const kept = [
      ev('2026-06-15T05:00:00.000Z', '2026-06-15T07:00:00.000Z'), // 07:00-09:00
      ev('2026-06-15T07:15:00.000Z', '2026-06-15T20:00:00.000Z'), // 09:15-22:00, 15-min gap
    ];
    expect(freeBlocks(kept, DAY)).toEqual([
      { start: '2026-06-15T07:00:00.000Z', end: '2026-06-15T07:15:00.000Z', minutes: 15, long: false },
    ]);
  });
});

const todo = (text: string, due: string | null, bill = false): BriefTodo => ({ text, due, bill });

describe('rankTodos', () => {
  it('orders bill/due-soon first, then overdue oldest-first, caps at 5', () => {
    const todos = [
      todo('overdue-1', '2026-06-14'),
      todo('undated', null),
      todo('bill', '2026-06-15', true),
      todo('overdue-old', '2026-06-10'),
      todo('tomorrow', '2026-06-16'),
    ];
    expect(rankTodos(todos, DAY).map((t) => t.text)).toEqual(['bill', 'tomorrow', 'overdue-old', 'overdue-1', 'undated']);
  });

  it('sorts the due-soon group by earliest due, keeps input order on ties, and caps', () => {
    const todos = [
      todo('d17', '2026-06-17'),
      todo('d15', '2026-06-15'),
      todo('d16a', '2026-06-16'),
      todo('d16b', '2026-06-16'),
    ];
    expect(rankTodos(todos, DAY).map((t) => t.text)).toEqual(['d15', 'd16a', 'd16b', 'd17']);
  });

  it('treats any bill as top priority even when undated or overdue', () => {
    const todos = [todo('overdue', '2026-06-01'), todo('plain', null), todo('undated-bill', null, true)];
    expect(rankTodos(todos, DAY).map((t) => t.text)).toEqual(['undated-bill', 'overdue', 'plain']);
  });
});

const metric = (key: HealthMetricKey, compare: HealthCompare): HealthMetric => ({
  key,
  value: 1,
  baseline: 1,
  compare,
  series: [],
});

describe('stateLine', () => {
  it('flags only above/below metrics and ignores usual/unknown', () => {
    const metrics = [
      metric('steps', 'above'),
      metric('headphone_min', 'usual'),
      metric('first_move', 'unknown'),
      metric('last_move', 'below'),
    ];
    expect(stateLine(metrics, null)).toEqual({
      flags: [
        { key: 'steps', compare: 'above' },
        { key: 'last_move', compare: 'below' },
      ],
      mood: null,
      low: false,
    });
  });

  it('sets low at the -2 edges and passes mood through', () => {
    const mood = { mood: -1, energy: -2, sleep: 0 };
    expect(stateLine([], mood)).toEqual({ flags: [], mood, low: true });
    expect(stateLine([], { mood: -2, energy: 0, sleep: 0 }).low).toBe(true);
    expect(stateLine([], { mood: -1, energy: -1, sleep: 0 }).low).toBe(false);
  });
});

it('clashes exclude all-day events, zero duration and touching endpoints; input stays unchanged', () => {
  const event = (title: string, start: string, end: string, allDay = false): BriefEvent => ({ title,
    start: `2026-06-15T${start}:00Z`, end: `2026-06-15T${end}:00Z`, allDay });
  const events = [event('B', '10:00', '11:00'), event('A', '09:00', '10:00'),
    event('All day', '00:00', '23:59', true), event('Zero', '09:30', '09:30')];
  const before = JSON.stringify(events);
  expect(findClashes(events).every((m) => !m.clash && m.clashWith === undefined)).toBe(true);
  expect(findClashes(events).map((m) => m.title)).toEqual(['All day', 'A', 'Zero', 'B']);
  expect(JSON.stringify(events)).toBe(before);
  expect(findClashes([])).toEqual([]);
  expect(rankTodos(Array.from({ length: 7 }, (_, i) => todo(`T${i}`, null)), DAY)).toHaveLength(5);
});
