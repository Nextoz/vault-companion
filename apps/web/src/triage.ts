import type { TriageCard, TriageResponse } from '@vault-companion/contracts';
import type { QueueItem } from './queue/queue.ts';

export type TriageDecision = 'go' | 'skip' | 'maybe';
export type SkipReason = 'topic' | 'too-far' | 'bad-time' | 'too-basic' | 'busy';
/** Presentation fields of the feed card. */
export interface TriageCardView {
  eventId: string;
  start: string;
  end: string | null;
  title: string;
  summary: string;
  location: string;
  why: string;
  cost: string;
  registration: { state: 'open' | 'closed' | 'not-required' | 'unknown'; deadline: string | null };
  aiScore: number;
  explore: boolean;
  calendar: {
    inCalendar: null | 'auto' | 'own' | 'go';
    clash: null | { title: string; start: string; end: string; kind: 'go' | 'own' };
    freeThatEvening: boolean;
  };
}
export function decideFromGesture({ dx, dy, vx }: { dx: number; dy: number; vx: number }): TriageDecision | null {
  if (dx > 110 || (vx > 0.6 && dx > 30)) return 'go';
  if (dx < -110 || (vx < -0.6 && dx < -30)) return 'skip';
  if (dy < -110 && Math.abs(dx) < 60) return 'maybe';
  return null;
}
const zone = 'Europe/Copenhagen';
export function dateBlockParts(iso: string): { dow: string; dom: string; mon: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { dow: part('weekday'), dom: part('day'), mon: part('month') };
}
export function timeInCopenhagen(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
export interface TriageChip { label: string; tone: 'plain' | 'ok' | 'warn' | 'explore' }
export function chipsFor(card: TriageCardView): TriageChip[] {
  const chips: TriageChip[] = [];
  const { inCalendar, clash, freeThatEvening } = card.calendar;
  if (inCalendar) chips.push({ label: `In Calendar (${inCalendar})`, tone: 'ok' });
  if (clash) chips.push({ label: `${clash.kind === 'go' ? 'Overlaps your Go' : 'Overlaps'}: ${clash.title}`, tone: 'warn' });
  else if (!inCalendar && freeThatEvening) chips.push({ label: '✓ Free that evening', tone: 'ok' });
  const registration = { open: 'Registration open', closed: 'Registration closed', 'not-required': 'No registration', unknown: 'Registration unknown' }[card.registration.state];
  const deadline = card.registration.deadline ? dateBlockParts(card.registration.deadline) : null;
  chips.push({ label: card.cost, tone: 'plain' }, {
    label: deadline ? `Deadline ${deadline.dow} ${deadline.dom} ${deadline.mon}` : registration, tone: 'plain',
  }, { label: `AI ${card.aiScore}`, tone: 'plain' });
  if (card.explore) chips.push({ label: '🧭 Explore', tone: 'explore' });
  return chips;
}
export function defaultSkipReason(card: TriageCardView): SkipReason | undefined {
  return card.calendar.clash ? 'busy' : undefined;
}

export const toTriageCardView = (card: TriageCard): TriageCardView => ({ ...card });
export function copenhagenDay(at: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  return ['year', 'month', 'day'].map((type) => parts.find((p) => p.type === type)!.value).join('-');
}
export function deriveTriage(read: TriageResponse, items: readonly QueueItem[] = [], accountKey: string | null = null) {
  const byId = new Map(read.decisions.map((d) => [d.decisionId, d]));
  for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    if (item.accountKey !== accountKey || item.accountMismatch || item.state === 'attention' || item.envelope.type !== 'TriageDecide') continue;
    const { payload: p, occurredAt: at } = item.envelope;
    byId.set(item.operationId, { decisionId: item.operationId, eventId: p.eventId, decision: p.decision, outcome: p.outcome, undoes: p.undoes, at });
  }
  const decisions = [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const undone = new Set(decisions.filter((d) => d.decision === 'undo').map((d) => d.undoes));
  const effective = decisions.filter((d) => d.decision !== 'undo' && !undone.has(d.decisionId));
  const latest = new Map(effective.map((d) => [d.eventId, d]));
  const today = copenhagenDay(read.now);
  const remaining = Math.max(0, 10 - effective.filter((d) => d.decision !== 'attended' && copenhagenDay(d.at) === today).length);
  const goCards = [...latest.values()].filter((d) => d.decision === 'go').map((d) => read.cards.find((c) => c.eventId === d.eventId)).filter((c): c is TriageCard => !!c);
  const overlaps = (a: TriageCard, b: TriageCard) => Date.parse(a.start) < Date.parse(b.end ?? b.start) && Date.parse(b.start) < Date.parse(a.end ?? a.start);
  const cards = read.cards.filter((c) => !latest.has(c.eventId) && Date.parse(c.start) > Date.parse(read.now))
    .sort((a, b) => a.rank - b.rank).slice(0, remaining).map((card) => {
      const go = goCards.find((candidate) => candidate.eventId !== card.eventId && overlaps(card, candidate));
      return go ? { ...card, calendar: { ...card.calendar, clash: { title: go.title, start: go.start, end: go.end ?? go.start, kind: 'go' as const } } } : card;
    });
  const checkins = read.checkins.filter((checkin) => !effective.some((d) => d.eventId === checkin.eventId && d.decision === 'attended'));
  const statuses = decisions.map((d) => ({ ...d, status: calendarStatus(read.applied[d.decisionId]) }));
  const waiting = statuses.some((d) => d.status === 'pending') &&
    (read.appliedUpdatedAt === null || Date.parse(read.now) - Date.parse(read.appliedUpdatedAt) > 60 * 60 * 1000);
  const staleFeed = read.generatedAt !== null && Date.parse(read.now) - Date.parse(read.generatedAt) > 36 * 60 * 60 * 1000;
  return { checkins, cards, decisions, statuses, waiting, staleFeed, remaining };
}
export function calendarStatus(applied: TriageResponse['applied'][string] | undefined): 'pending' | 'applied' | 'failed' {
  return !applied ? 'pending' : applied.status === 'failed' ? 'failed' : 'applied';
}
