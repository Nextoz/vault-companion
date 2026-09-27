import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { chipsFor, dateBlockParts, decideFromGesture, defaultSkipReason, timeInCopenhagen, type SkipReason, type TriageCardView, type TriageDecision } from '../triage.ts';

export interface TriageStackProps {
  cards: readonly TriageCardView[];
  onDecide: (eventId: string, decision: TriageDecision, reason?: SkipReason) => void;
  onUndo: () => void;
}
type Choice = { card: TriageCardView; decision: TriageDecision; reason: SkipReason | undefined; sent: boolean };
const reasons: [SkipReason, string][] = [['topic', 'Not my topic'], ['too-far', 'Too far'], ['bad-time', 'Bad time'], ['too-basic', 'Too basic'], ['busy', 'Busy']];
const origin = { dx: 0, dy: 0 };

/** Owns the local stack. Skip emits once after its two-second reason window (or before the next decision).
 * Undo during that window cancels the unsent choice; otherwise it calls onUndo. No persistence or Calendar IO. */
export function TriageStack({ cards, onDecide, onUndo }: TriageStackProps) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [last, setLast] = useState<Choice | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [position, setPosition] = useState(origin);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [reduce, setReduce] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const active = useRef<{ id: number; x: number; y: number; lastX: number; time: number; vx: number; dx: number; dy: number } | null>(null);
  const pending = useRef<Choice | null>(null);
  const busy = useRef(false);
  const animationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reasonTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stage = useRef<HTMLDivElement>(null);
  const decideCallback = useRef(onDecide);
  useEffect(() => { decideCallback.current = onDecide; }, [onDecide]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduce(media.matches);
    media.addEventListener('change', change);
    return () => {
      media.removeEventListener('change', change);
      clearTimeout(animationTimer.current);
      clearTimeout(reasonTimer.current);
    };
  }, []);
  const queue = cards.filter((card) => !dismissed.includes(card.eventId));
  const card = queue[0];
  function flushReason() {
    clearTimeout(reasonTimer.current);
    const choice = pending.current;
    pending.current = null;
    setReasonOpen(false);
    if (choice && !choice.sent) {
      choice.sent = true;
      setLast({ ...choice });
      decideCallback.current(choice.card.eventId, choice.decision, choice.reason);
    }
  }
  function decide(decision: TriageDecision, vx = 0) {
    if (!card || busy.current) return;
    busy.current = true;
    active.current = null;
    setDragging(false);
    flushReason();
    const choice: Choice = { card, decision, reason: decision === 'skip' ? defaultSkipReason(card) : undefined, sent: false };
    const momentum = Math.max(1, Math.min(2, Math.abs(vx)));
    setPosition(decision === 'maybe' ? { dx: 0, dy: -(stage.current?.clientHeight ?? 470) * 1.2 } : {
      dx: (decision === 'go' ? 1 : -1) * (stage.current?.clientWidth ?? 420) * 1.4 * momentum, dy: 40,
    });
    setLeaving(true);
    const settle = () => {
      setDismissed((ids) => [...ids, card.eventId]);
      setLast(choice);
      setPosition(origin);
      setLeaving(false);
      busy.current = false;
      if (decision === 'skip') {
        pending.current = choice;
        setReasonOpen(true);
        reasonTimer.current = setTimeout(flushReason, 2000);
      } else {
        choice.sent = true;
        decideCallback.current(card.eventId, decision);
      }
    };
    if (reduce) settle();
    else animationTimer.current = setTimeout(settle, 260);
  }
  function down(event: PointerEvent<HTMLElement>) {
    if (busy.current || active.current || !event.isPrimary || event.button !== 0) return;
    active.current = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, time: event.timeStamp, vx: 0, dx: 0, dy: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const drag = active.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dt = event.timeStamp - drag.time;
    if (dt > 0) drag.vx = (event.clientX - drag.lastX) / dt;
    drag.lastX = event.clientX; drag.time = event.timeStamp;
    drag.dx = event.clientX - drag.x; drag.dy = event.clientY - drag.y;
    setPosition({ dx: drag.dx, dy: drag.dy });
  }
  function end(event: PointerEvent<HTMLElement>, cancel = false) {
    const drag = active.current;
    if (!drag || drag.id !== event.pointerId) return;
    active.current = null;
    setDragging(false);
    const decision = cancel ? null : decideFromGesture({ dx: event.clientX - drag.x, dy: event.clientY - drag.y, vx: event.timeStamp - drag.time > 100 ? 0 : drag.vx });
    if (decision) decide(decision, drag.vx);
    else setPosition(origin);
  }
  function undo() {
    if (!last || busy.current) return;
    clearTimeout(reasonTimer.current);
    pending.current = null;
    setReasonOpen(false);
    setDismissed((ids) => ids.filter((id) => id !== last.card.eventId));
    setLast(null);
    if (last.sent) onUndo();
  }
  const fade = (distance: number) => Math.max(0, Math.min(1, distance / 110));
  return <section className="triage-stack" aria-label="Event triage">
    <p className="triage-meta" aria-live="polite">{card ? `Card ${dismissed.length + 1} of ${cards.length}` : `${dismissed.length} decided`}</p>
    <div className="triage-stage" ref={stage}>
      {queue.slice(0, 2).reverse().map((item) => {
        const next = item !== card;
        const date = dateBlockParts(item.start);
        const style = next ? undefined : { '--triage-x': `${position.dx}px`, '--triage-y': `${position.dy}px`, '--triage-tilt': `${reduce ? 0 : position.dx * 0.04}deg`, opacity: leaving ? 0 : 1 } as CSSProperties;
        return <article key={item.eventId} className={`triage-card${next ? ' triage-next' : ''}${dragging ? ' triage-dragging' : ''}`} style={style}
          aria-hidden={next || undefined} aria-label={`${item.title}, ${date.dow} ${date.dom} ${date.mon} ${timeInCopenhagen(item.start)}`}
          onPointerDown={next ? undefined : down} onPointerMove={next ? undefined : move} onPointerUp={next ? undefined : end}
          onPointerCancel={(event) => end(event, true)} onLostPointerCapture={(event) => end(event, true)}>
          <div className="triage-datehead"><div className="triage-dateblock"><span>{date.dow}</span><strong>{date.dom}</strong><span>{date.mon}</span></div>
            <div><div className="triage-time">{timeInCopenhagen(item.start)}</div><p className="triage-where">{item.location}</p></div></div>
          <h2>{item.title}</h2><p className="triage-why">{item.why}</p>
          <div className="triage-chips">{chipsFor(item).map((chip, i) => <span key={i} className={`triage-chip triage-${chip.tone}`}>{chip.label}</span>)}</div>
          {!next && <div aria-hidden="true"><span className="triage-stamp triage-go" style={{ opacity: fade(position.dx) }}>GO</span>
            <span className="triage-stamp triage-skip" style={{ opacity: fade(-position.dx) }}>SKIP</span>
            <span className="triage-stamp triage-maybe" style={{ opacity: Math.abs(position.dx) < 60 ? fade(-position.dy) : 0 }}>MAYBE</span></div>}
        </article>;
      })}
      {!card && <div className="triage-done"><strong>All caught up</strong></div>}
    </div>
    {reasonOpen && last && <div className="triage-reasons" role="group" aria-label="Skip reason"><span>Why?</span>{reasons.map(([reason, label]) =>
      <button key={reason} type="button" aria-pressed={last.reason === reason} onClick={() => {
        if (pending.current) { pending.current.reason = reason; setLast({ ...pending.current }); }
      }}>{label}</button>)}</div>}
    {card && <div className="triage-actions">
      <button type="button" className="triage-skip" aria-label="Skip this event" disabled={leaving} onClick={() => decide('skip')}>Skip</button>
      <button type="button" className="triage-maybe" aria-label="Ask me later" disabled={leaving} onClick={() => decide('maybe')}>Maybe</button>
      <button type="button" className="triage-go" aria-label="Go: add to Calendar" disabled={leaving} onClick={() => decide('go')}>Go</button>
    </div>}
    {last && <div className="triage-undo"><span role="status">{{ go: 'Going', skip: 'Skipped', maybe: 'Asking again later' }[last.decision]}: {last.card.title}
      <small>Local preview — nothing sent to Calendar</small></span><button type="button" disabled={leaving} onClick={undo}>Undo</button></div>}
  </section>;
}

