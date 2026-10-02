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

/** Local HH:MM of an instant, for the collapsed "Checked in HH:MM". */
export function localTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

/** One-minute mood/energy/sleep check-in on Today (ADR-0036). Collapses to the last check-in's time. */
export function MoodCard({ queue, items, accountKey, baseRevision, blocked }: {
  queue: PendingQueue;
  items: readonly QueueItem[];
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
}) {
  const date = localDate();
  const saved = latestCheckin(items, date);
  const [reopened, setReopened] = useState(false);
  const [mood, setMood] = useState<number | null>(saved?.mood ?? null);
  const [energy, setEnergy] = useState<number | null>(saved?.energy ?? null);
  const [sleepText, setSleepText] = useState(saved ? String(saved.sleep) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);

  if (saved && !reopened) {
    return <div className="group mood" role="region" aria-label="Mood check-in">
      <button type="button" onClick={() => {
        setMood(saved.mood); setEnergy(saved.energy); setSleepText(String(saved.sleep)); setReopened(true);
      }}>Checked in {localTime(saved.checkinAt)}</button>
    </div>;
  }

  const sleep = parseSleep(sleepText);
  const ready = mood !== null && energy !== null && Number.isFinite(sleep) && accountKey !== null && baseRevision !== null && !blocked;
  const save = async () => {
    if (!ready || guard.current || mood === null || energy === null || !baseRevision || !accountKey) return;
    guard.current = true; setSaving(true); setError(null);
    // The day of the tap, not of the last render: the app may have stayed open past midnight.
    const day = localDate();
    try {
      await queue.enqueue(
        moodCheckin({ baseRevision }, { date: day, mood, energy, sleep, checkinAt: new Date().toISOString() }),
        { accountKey, label: `Mood \u00b7 ${day}`, taskKey: 'mood' },
      );
      setReopened(false);
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
    </form>
  </div>;
}
