import { TrainingSession } from '@vault-companion/contracts';
import { useRef, useState } from 'react';
import { logTraining } from '../commands.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { isoWithOffset } from '../time.ts';
import { trainingLocalTime } from '../training.ts';

/**
 * B1: a kilo or kilometre value with at most one decimal, typed with a dot or a Danish comma (`84.5`, `84,5`).
 * Anything else is NaN, so the schema refuses it and Save stays disabled. A number input rejects the comma outright.
 */
export function parseDecimal(text: string): number {
  const t = text.trim();
  return /^\d{1,3}(?:[.,]\d)?$/.test(t) ? Number(t.replace(',', '.')) : Number.NaN;
}

export function TrainingSheet({ queue, accountKey, baseRevision, onClose }: {
  queue: PendingQueue; accountKey: string | null; baseRevision: string | null; onClose: () => void;
}) {
  const [type, setType] = useState<'Gym' | 'Run'>('Gym');
  const [when, setWhen] = useState(trainingLocalTime);
  const [duration, setDuration] = useState('');
  const [distance, setDistance] = useState('');
  const [weight, setWeight] = useState('');
  const [split, setSplit] = useState<'Bicep' | 'Tricep' | 'Legs'>('Bicep');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);
  const date = new Date(when);
  const parsed = TrainingSession.safeParse({ type, when: Number.isFinite(date.getTime()) ? isoWithOffset(date) : '', duration: Number(duration), note,
    ...(type === 'Run' ? { distance: parseDecimal(distance) } : { split, ...(weight === '' ? {} : { weight: parseDecimal(weight) }) }) });
  const save = async () => {
    if (!parsed.success || !accountKey || !baseRevision || guard.current) return;
    guard.current = true; setSaving(true); setError(null);
    try {
      await queue.enqueue(logTraining({ baseRevision }, parsed.data), { accountKey, label: `${type} · ${when.replace('T', ' ')}`, taskKey: 'training' });
      onClose();
    } catch { setError('Could not keep this on the device. Your session is still here.'); }
    finally { guard.current = false; setSaving(false); }
  };
  return <div className="sheet-backdrop" role="presentation"><form className="sheet training-sheet" role="dialog" aria-modal="true" aria-label="Log training"
    onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <h2>Log training</h2>
    <div className="segmented" role="group" aria-label="Training type">
      {(['Gym', 'Run'] as const).map((t) => <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}>{t}</button>)}
    </div>
    <label>When<input type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} /></label>
    {type === 'Run' ? <label>Distance (km)<input type="text" inputMode="decimal" required value={distance} onChange={(e) => setDistance(e.target.value)} /></label> : <>
      <label>Split<select value={split} onChange={(e) => setSplit(e.target.value as typeof split)}>{['Bicep', 'Tricep', 'Legs'].map((s) => <option key={s}>{s}</option>)}</select></label>
      <label>Weight (kg, optional)<input type="text" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
    </>}
    <label>Duration (min)<input type="number" inputMode="numeric" required min="1" max="600" step="1" value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
    <label>Note (optional)<textarea maxLength={280} rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
    {(!accountKey || !baseRevision) && <p>Connect once to set up this device before logging training.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="sheet-buttons"><button type="button" disabled={saving} onClick={onClose}>Close</button>
      <button type="submit" className="primary" disabled={saving || !parsed.success || !accountKey || !baseRevision}>Save</button></div>
  </form></div>;
}
