import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { TriageResponse } from '@vault-companion/contracts';
import { deriveTriage, toTriageCardView, calendarStatus, copenhagenDay } from './triage.ts';
import { getTriage } from './api.ts';
import { triageDecide } from './commands.ts';
import type { QueueItem } from './queue/queue.ts';
import { chipsFor, dateBlockParts, decideFromGesture, defaultSkipReason, timeInCopenhagen, type TriageCardView } from './triage.ts';
const card: TriageCardView = {
  eventId: 'invented', start: '2026-09-29T16:30:00Z', end: '2026-09-29T18:00:00Z', title: 'Invented workshop',
  location: 'Example hall', why: 'Try a new topic', cost: '75 kr', registration: { state: 'open', deadline: null },
  aiScore: 88, explore: false, calendar: { inCalendar: null, clash: null, freeThatEvening: true },
};

const now = '2026-09-30T22:30:00Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function triageRead(): TriageResponse {
  return TriageResponse.parse({ revision: 'a'.repeat(40), now, feedState: 'ok', generatedAt: now, droppedCards: 0, decisions: [], applied: {}, appliedUpdatedAt: now,
    cards: Array.from({ length: 15 }, (_, rank) => ({ ...card, eventId: rank.toString(16).padStart(20, '0'), rank, resurfaced: false,
      start: '2026-10-03T16:00:00+02:00', end: null, online: false, category: 'community', scouts: ['city-events'], sourceName: 'Example source', sourceUrl: 'https://example.org/e1' })) });
}
describe('feed derivation and API', () => {
  it('caps at ten minus today’s non-undone decisions using Copenhagen midnight, hides past and decided events, and sorts ranks', () => {
    const read = triageRead();
    read.cards[0]!.start = now;
    read.decisions = [1, 2, 3].map((n) => ({ decisionId: id(n), eventId: read.cards[n]!.eventId, decision: 'go', undoes: null, at: '2026-09-30T22:00:00Z' }));
    read.cards.reverse();
    const view = deriveTriage(read);
    expect(copenhagenDay(now)).toBe('2026-10-01');
    expect(view.cards).toHaveLength(7);
    expect(view.cards.map((c) => c.rank)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(toTriageCardView(view.cards[0]!)).toMatchObject({ end: null, registration: { state: 'open' } });
    read.decisions = Array.from({ length: 11 }, (_, n) => ({ decisionId: id(n), eventId: n.toString(16).padStart(20, '0'), decision: 'skip', undoes: null, at: now }));
    expect(deriveTriage(read).cards).toEqual([]);
  });
  it('undo cancels only its named decision, restores the slot, and leaves older non-undone decisions effective', () => {
    const read = triageRead(); const eventId = read.cards[0]!.eventId;
    const go = { decisionId: id(1), eventId, decision: 'go' as const, undoes: null, at: now };
    read.decisions = [go, { ...go, decisionId: id(2), decision: 'undo', undoes: id(1) }];
    expect(deriveTriage(read).cards[0]?.eventId).toBe(eventId);
    expect(deriveTriage(read).remaining).toBe(10);
    read.decisions.unshift({ ...go, decisionId: id(3), decision: 'skip', at: '2026-09-30T20:00:00Z' });
    expect(deriveTriage(read).cards.some((c) => c.eventId === eventId)).toBe(false);
    expect(deriveTriage(read).remaining).toBe(10);
  });
  it('overlays durable queued decisions once, keeps accounts separate, and uses card snapshots for undo', () => {
    const read = triageRead(); const c = read.cards[0]!;
    const { title, category, sourceName, aiScore, start } = c;
    const envelope = triageDecide({ baseRevision: read.revision, now: new Date(now), newId: () => id(1) }, {
      eventId: c.eventId, decision: 'go', reason: null, undoes: null, explore: c.explore, card: { title, category, sourceName, aiScore, start },
    });
    const item: QueueItem = { operationId: envelope.operationId, seq: 1, type: envelope.type, envelope, accountKey: 'account', accountMismatch: false,
      label: title, taskKey: 'triage', state: 'pending', everSent: false, error: null, receipt: null, acknowledged: false };
    const view = deriveTriage(read, [item], 'account');
    expect(view.remaining).toBe(9);
    expect(view.cards.some((card) => card.eventId === c.eventId)).toBe(false);
    read.decisions = view.decisions;
    expect(deriveTriage(read, [item], 'account').remaining).toBe(9);
    read.decisions = [];
    expect(deriveTriage(read, [item], 'other').remaining).toBe(10);
    expect(deriveTriage(read, [{ ...item, state: 'attention' }], 'account').remaining).toBe(10);
    const undo = triageDecide({ baseRevision: read.revision, newId: () => id(2) }, { ...envelope.payload, decision: 'undo', undoes: envelope.operationId });
    expect(undo.operationId).not.toBe(envelope.operationId);
    expect(undo.payload.card).toEqual(envelope.payload.card);
  });
  it('maps applied/failed/skipped, warns only after one hour pending, and dates a feed older than 36 hours', () => {
    const read = triageRead();
    expect(calendarStatus(undefined)).toBe('pending');
    for (const status of ['applied', 'failed', 'skipped'] as const) expect(calendarStatus({ status, at: now, message: 'ok' })).toBe(status === 'failed' ? 'failed' : 'applied');
    read.decisions = [{ decisionId: id(1), eventId: read.cards[0]!.eventId, decision: 'go', undoes: null, at: now }];
    read.appliedUpdatedAt = '2026-09-30T21:30:00Z';
    read.generatedAt = '2026-09-29T10:30:00Z';
    expect(deriveTriage(read)).toMatchObject({ waiting: false, staleFeed: false });
    read.appliedUpdatedAt = '2026-09-30T21:29:59Z';
    read.generatedAt = '2026-09-29T10:29:59Z';
    expect(deriveTriage(read)).toMatchObject({ waiting: true, staleFeed: true });
    read.applied[id(1)] = { status: 'failed', at: now, message: 'failed' };
    expect(deriveTriage(read)).toMatchObject({ waiting: false, statuses: [{ status: 'failed' }] });
  });
  it('getTriage strips future top-level fields and sends no-store requests', async () => {
    const read = triageRead();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...read, future: true })));
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await getTriage()).toEqual({ kind: 'ok', data: read });
      expect(fetch).toHaveBeenCalledWith('/api/triage', expect.objectContaining({ cache: 'no-store' }));
    } finally { vi.unstubAllGlobals(); }
  });
});
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
