export type TriageDecision = 'go' | 'skip' | 'maybe';
export type SkipReason = 'topic' | 'too-far' | 'bad-time' | 'too-basic' | 'busy';
/** Local presentation contract only; intentionally independent of the future feed schema. */
export interface TriageCardView {
  eventId: string;
  start: string;
  end: string;
  title: string;
  location: string;
  why: string;
  cost: string;
  registration: { state: 'open' | 'closed' | 'not-required' | 'unknown'; deadline: string | null };
  aiScore: number;
  explore: boolean;
  calendar: {
    inCalendar: null | 'auto' | 'go';
    clash: null | { title: string; start: string; end: string };
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
  if (inCalendar) chips.push({ label: inCalendar === 'auto' ? 'In Calendar (auto)' : 'In Calendar (go)', tone: 'ok' });
  else if (clash) chips.push({ label: `⚠ ${clash.title} ${timeInCopenhagen(clash.start)}–${timeInCopenhagen(clash.end)}`, tone: 'warn' });
  else if (freeThatEvening) chips.push({ label: '✓ Free that evening', tone: 'ok' });
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
