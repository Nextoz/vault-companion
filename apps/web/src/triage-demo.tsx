import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TriageStack } from './ui/TriageStack.tsx';
import type { TriageCardView } from './triage.ts';
import './styles.css';
const cards: TriageCardView[] = ['Invented tool meetup', 'Invented writing workshop', 'Invented harbour film'].map((title, index) => ({
  eventId: `example-${index}`, title, start: `2026-09-${28 + index}T16:30:00Z`, end: `2026-09-${28 + index}T18:00:00Z`,
  location: 'Example hall, Copenhagen', why: 'An invented event for testing the local swipe stack.', cost: index === 1 ? '75 kr' : 'Free',
  registration: { state: 'open', deadline: null }, aiScore: 96 - index * 12, explore: index === 2,
  calendar: { inCalendar: index === 0 ? 'auto' : null, freeThatEvening: index === 2,
    clash: index === 1 ? { title: 'Example rehearsal', start: '2026-09-29T16:00:00Z', end: '2026-09-29T17:00:00Z' } : null },
}));
function Fixture() {
  const [calls, setCalls] = useState<string[]>([]);
  return <><TriageStack cards={cards} onDecide={(id, decision, reason) => setCalls((items) => [...items, `${id}:${decision}:${reason ?? ''}`])}
    onUndo={() => setCalls((items) => [...items, 'undo'])} /><output data-testid="calls">{calls.join('|')}</output></>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);

