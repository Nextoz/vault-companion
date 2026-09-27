import { describe, expect, it } from 'vitest';
import { chipsFor, dateBlockParts, decideFromGesture, defaultSkipReason, timeInCopenhagen, type TriageCardView } from './triage.ts';
const card: TriageCardView = {
  eventId: 'invented', start: '2026-09-29T16:30:00Z', end: '2026-09-29T18:00:00Z', title: 'Invented workshop',
  location: 'Example hall', why: 'Try a new topic', cost: '75 kr', registration: { state: 'open', deadline: null },
  aiScore: 88, explore: false, calendar: { inCalendar: null, clash: null, freeThatEvening: true },
};
describe('gesture thresholds', () => {
  it.each([
    [110, 0, 0, null], [111, 0, 0, 'go'], [-110, 0, 0, null], [-111, 0, 0, 'skip'],
    [31, 0, .6, null], [31, 0, .601, 'go'], [30, 0, 1, null],
    [-31, 0, -.6, null], [-31, 0, -.601, 'skip'], [-30, 0, -1, null],
    [31, 0, -1, null], [-31, 0, 1, null], [0, -110, 0, null], [0, -111, 0, 'maybe'],
    [59, -111, 0, 'maybe'], [-59, -111, 0, 'maybe'], [60, -111, 0, null], [-60, -111, 0, null],
    [111, -200, 0, 'go'], [31, -111, 1, 'go'], [0, 200, 0, null], [0, 0, 0, null],
  ])('dx=%s dy=%s vx=%s => %s', (dx, dy, vx, result) => {
    expect(decideFromGesture({ dx: dx as number, dy: dy as number, vx: vx as number })).toBe(result);
  });
});
describe('presentation', () => {
  it('orders calendar, cost, registration, AI, exploration', () => {
    expect(chipsFor({ ...card, explore: true }).map((chip) => chip.label)).toEqual([
      '✓ Free that evening', '75 kr', 'Registration open', 'AI 88', '🧭 Explore',
    ]);
  });
  it('prioritizes calendar membership, formats clashes, defaults busy only for clashes', () => {
    const clash = { title: 'Invented rehearsal', start: '2026-09-29T16:00:00Z', end: '2026-09-29T17:00:00Z' };
    const busy = { ...card, calendar: { ...card.calendar, clash } };
    expect(chipsFor(busy)[0]).toEqual({ label: '⚠ Invented rehearsal 18:00–19:00', tone: 'warn' });
    expect(defaultSkipReason(busy)).toBe('busy');
    expect(defaultSkipReason(card)).toBeUndefined();
    for (const inCalendar of ['auto', 'go'] as const) {
      expect(chipsFor({ ...busy, calendar: { ...busy.calendar, inCalendar } })[0]?.label).toBe(`In Calendar (${inCalendar})`);
    }
  });
  it('does not assert availability when unknown', () => {
    expect(chipsFor({ ...card, calendar: { ...card.calendar, freeThatEvening: false } })[0]?.label).toBe('75 kr');
  });
  it('formats registration states and deadlines', () => {
    for (const [state, label] of [['closed', 'Registration closed'], ['not-required', 'No registration'], ['unknown', 'Registration unknown']] as const) {
      expect(chipsFor({ ...card, registration: { state, deadline: null } })[2]?.label).toBe(label);
    }
    expect(chipsFor({ ...card, registration: { state: 'open', deadline: '2026-09-28T12:00:00Z' } })[2]?.label).toBe('Deadline Mon 28 Sept');
  });
  it('uses Copenhagen dates across midnight and daylight saving boundaries', () => {
    expect(dateBlockParts('2026-09-30T22:30:00Z')).toEqual({ dow: 'Thu', dom: '1', mon: 'Oct' });
    expect(dateBlockParts('2026-12-31T23:30:00Z')).toEqual({ dow: 'Fri', dom: '1', mon: 'Jan' });
    expect(timeInCopenhagen('2026-03-29T00:30:00Z')).toBe('01:30');
    expect(timeInCopenhagen('2026-03-29T01:30:00Z')).toBe('03:30');
  });
});
