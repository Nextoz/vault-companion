import { useRef, useState } from 'react';
import { moodCheckin } from '../commands.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { CHECKIN_START, checkinCopy, checkinNext, checkinOptions, targetName, targetText, type CheckinStep } from './checkin-step.ts';
import { localDate } from './MoodCard.tsx';

/**
 * R3b (review #7): Today's one-tap check-in. A row of five round targets asks for mood, then turns into "Energy?" and
 * "Sleep?"; the sleep tap enqueues one ordinary MoodCheckin (same command, label and queue path as the form), and the
 * card hides the row once today's check-in exists (UX6). Undo stays in the Actions list. "Other" opens the full sheet,
 * seeded with the answers so far, for the scale ends or a half hour.
 */
export function CheckinRow({ queue, accountKey, baseRevision, blocked, onOther }: {
  queue: PendingQueue;
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
  onOther: (seed: { mood: number; energy: number }) => void;
}) {
  const [state, setState] = useState<CheckinStep>(CHECKIN_START);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);
  const usable = accountKey !== null && baseRevision !== null && !blocked;
  const copy = checkinCopy(state);

  const pick = async (value: number) => {
    const next = checkinNext(state, { kind: 'pick', value });
    if (next.step !== 'ready') { setState(next); return; }
    if (!usable || guard.current || !accountKey || !baseRevision) return;
    guard.current = true; setSaving(true); setError(null);
    // The day of the tap, not of the last render: the app may have stayed open past midnight.
    const day = localDate();
    try {
      await queue.enqueue(
        moodCheckin({ baseRevision }, { date: day, mood: next.mood, energy: next.energy, sleep: next.sleep, checkinAt: new Date().toISOString() }),
        { accountKey, label: `Mood · ${day}`, taskKey: 'mood' },
      );
    } catch {
      setError('Could not keep this check-in on the device.');
    } finally {
      guard.current = false; setSaving(false);
    }
  };

  return (
    <section className="checkin-row" aria-label="Check-in" data-step={state.step}>
      <div className="checkin-row-head">
        <p className="checkin-row-prompt">{copy.prompt}</p>
        {copy.answered !== null && (
          <button type="button" className="link checkin-row-back" aria-label={`Back: ${copy.answered}`}
            onClick={() => setState((s) => checkinNext(s, { kind: 'back' }))}>
            <span aria-hidden="true">{'‹'} </span>{copy.answered}
          </button>
        )}
      </div>
      <div className="checkin-targets" role="group" aria-label={copy.kind}>
        {checkinOptions(state).map((value) => (
          <button key={`${state.step}:${value}`} type="button" className="checkin-target" aria-label={targetName(copy.kind, value)}
            disabled={!usable || saving} onClick={() => void pick(value)}>
            {targetText(copy.kind, value)}
          </button>
        ))}
      </div>
      <div className="checkin-ends">
        <span>{copy.ends[0]}</span>
        {state.step === 'sleep'
          ? <button type="button" className="link checkin-other" onClick={() => onOther({ mood: state.mood, energy: state.energy })}>Other{'…'}</button>
          : <span>{copy.ends[1]}</span>}
      </div>
      {(!accountKey || !baseRevision) && <p className="muted small">Connect once to set up this device before checking in.</p>}
      {blocked && <p className="muted small">The vault is locked until the conflict is resolved in Obsidian.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
