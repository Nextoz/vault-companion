import type { MoodCheckinPayload } from '@vault-companion/contracts';
import { useRef, useState } from 'react';
import { moodCheckin } from '../commands.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';

const SCALE = [-3, -2, -1, 0, 1, 2, 3] as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** The device's local calendar date (YYYY-MM-DD): the day a check-in belongs to. */
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Hours 0…24 in 0.5 steps, typed with a dot or a Danish comma (`7.5`, `7,5`). Anything else is NaN, so Save stays
 * disabled; a number input would reject the comma outright.
 */
export function parseSleep(text: string): number {
  const t = text.trim();
  if (!/^\d{1,2}(?:[.,][05])?$/.test(t)) return Number.NaN;
  const hours = Number(t.replace(',', '.'));
  return hours >= 0 && hours <= 24 ? hours : Number.NaN;
}

/** Chip copy with the same minus sign the mood contract uses: `Mood −3` … `Mood +3`. */
export function chipLabel(kind: 'Mood' | 'Energy', value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  return `${kind} ${sign}${Math.abs(value)}`;
}

/**
 * The newest check-in this device still holds for `date`, unless an UndoMoodCheckin already targets it (the Undo
 * removes it from the count, so the form returns).
 */
export function latestCheckin(items: readonly QueueItem[], date: string): MoodCheckinPayload | null {
  const undone = new Set<string>();
  for (const item of items) {
    if (item.envelope.type === 'UndoMoodCheckin') undone.add(item.envelope.payload.target.operationId);
  }
  let best: { seq: number; payload: MoodCheckinPayload } | null = null;
  for (const item of items) {
    const envelope = item.envelope;
    if (envelope.type !== 'MoodCheckin' || envelope.payload.date !== date || undone.has(item.operationId)) continue;
    if (!best || item.seq > best.seq) best = { seq: item.seq, payload: envelope.payload };
  }
  return best?.payload ?? null;
}

/** What the ends of each −3…+3 scale mean (B8: the rows were unlabelled numbers). */
const SCALE_ENDS = { Mood: ['low', 'great'], Energy: ['drained', 'energised'] } as const;

/** One labelled chip row; the visible label and end hints sit outside the group so its accessible name stays `kind`. */
function ScaleRow({ kind, value, onPick }: { kind: 'Mood' | 'Energy'; value: number | null; onPick: (v: number) => void }) {
  const chip = (v: number) => chipLabel(kind, v).slice(kind.length + 1);
  return <div className="scale-row">
    <span className="scale-label">{kind}</span>
    <div className="segmented" role="group" aria-label={kind}>
      {SCALE.map((v) => <button key={v} type="button" aria-label={chipLabel(kind, v)} aria-pressed={value === v} onClick={() => onPick(v)}>{chip(v)}</button>)}
    </div>
    <p className="muted small scale-ends"><span>{chip(SCALE[0])} {SCALE_ENDS[kind][0]}</span><span>{chip(SCALE[6])} {SCALE_ENDS[kind][1]}</span></p>
  </div>;
}

export interface MoodCheckinFormProps {
  queue: PendingQueue;
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
  /** The day the check-in belongs to; the device's local date at save time when omitted (today's check-in). */
  date?: string;
  /** Seed values when editing a check-in the device already holds. */
  initial?: Pick<MoodCheckinPayload, 'mood' | 'energy' | 'sleep'> | null;
  onSaved?: () => void;
  onCancel?: () => void;
}

/**
 * The one-minute mood/energy/sleep form (ADR-0036), shared by Today's MoodCard and the Log's edit of today's entry.
 * It owns only the draft; the caller decides the day and what happens after a save (UX6).
 */
export function MoodCheckinForm({ queue, accountKey, baseRevision, blocked, date, initial, onSaved, onCancel }: MoodCheckinFormProps) {
  const [mood, setMood] = useState<number | null>(initial?.mood ?? null);
  const [energy, setEnergy] = useState<number | null>(initial?.energy ?? null);
  const [sleepText, setSleepText] = useState(initial ? String(initial.sleep) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);

  const sleep = parseSleep(sleepText);
  const ready = mood !== null && energy !== null && Number.isFinite(sleep) && accountKey !== null && baseRevision !== null && !blocked;
  const save = async () => {
    if (!ready || guard.current || mood === null || energy === null || !baseRevision || !accountKey) return;
    guard.current = true; setSaving(true); setError(null);
    // The day of the tap, not of the last render: the app may have stayed open past midnight.
    const day = date ?? localDate();
    try {
      await queue.enqueue(
        moodCheckin({ baseRevision }, { date: day, mood, energy, sleep, checkinAt: new Date().toISOString() }),
        { accountKey, label: `Mood \u00b7 ${day}`, taskKey: 'mood' },
      );
      onSaved?.();
    } catch { setError('Could not keep this check-in on the device.'); }
    finally { guard.current = false; setSaving(false); }
  };

  return <div className="group mood" role="region" aria-label="Mood check-in">
    <h2>Mood check-in</h2>
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <ScaleRow kind="Mood" value={mood} onPick={setMood} />
      <ScaleRow kind="Energy" value={energy} onPick={setEnergy} />
      <label>Sleep (hours)<input type="text" inputMode="decimal" value={sleepText} onChange={(e) => setSleepText(e.target.value)} /></label>
      {(!accountKey || !baseRevision) && <p className="muted small">Connect once to set up this device before checking in.</p>}
      {blocked && <p className="muted small">The vault is locked until the conflict is resolved in Obsidian.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={saving || !ready}>Check in</button>
      {onCancel && <button type="button" className="link" onClick={onCancel}>Cancel</button>}
    </form>
  </div>;
}

/**
 * UX6: today's check-in line is gone for the rest of the day. Once a check-in is saved (and not undone) the card
 * renders nothing at all - no collapsed row, no empty wrapper. Undoing drops it from `latestCheckin`, so the form
 * returns; a check-in from another day never hides it (the row is back next morning).
 */
export function MoodCard({ queue, items, accountKey, baseRevision, blocked }: {
  queue: PendingQueue;
  items: readonly QueueItem[];
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
}) {
  if (latestCheckin(items, localDate()) !== null) return null;
  return <MoodCheckinForm queue={queue} accountKey={accountKey} baseRevision={baseRevision} blocked={blocked} />;
}
