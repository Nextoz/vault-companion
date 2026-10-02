import { TrainingSession, type TrainingResponse, type TrainingRow } from '@vault-companion/contracts';
import { useRef, useState } from 'react';
import { getTraining } from '../api.ts';
import { editTraining, logTraining } from '../commands.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { isoWithOffset } from '../time.ts';
import { groupClassSuggestions, rowToDraft, trainingLocalTime, type TrainingDraft } from '../training.ts';
import { useLastCopy } from './useLastCopy.tsx';

/**
 * B1: a kilo or kilometre value with at most one decimal, typed with a dot or a Danish comma (`84.5`, `84,5`).
 * Anything else is NaN, so the schema refuses it and Save stays disabled. A number input rejects the comma outright.
 */
export function parseDecimal(text: string): number {
  const t = text.trim();
  return /^\d{1,3}(?:[.,]\d)?$/.test(t) ? Number(t.replace(',', '.')) : Number.NaN;
}

export function TrainingSheet({ queue, accountKey, baseRevision, onClose, edit }: {
  queue: PendingQueue; accountKey: string | null; baseRevision: string | null; onClose: () => void;
  /** B12: editing an existing Run/Gym row; absent for a new session. */
  edit?: { row: TrainingRow } | undefined;
}) {
  const draft: TrainingDraft | null = edit ? rowToDraft(edit.row) : null;
  const [type, setType] = useState<'Gym' | 'Run'>(draft?.type ?? 'Gym');
  // A new session defaults to now; an edited row keeps the read's time, even when it is empty (then Save waits).
  const [when, setWhen] = useState(draft ? draft.when : trainingLocalTime);
  const [duration, setDuration] = useState(draft?.duration ?? '');
  const [distance, setDistance] = useState(draft?.distance ?? '');
  const [weight, setWeight] = useState(draft?.weight ?? '');
  const [split, setSplit] = useState<TrainingDraft['split']>(draft?.split ?? 'Bicep');
  const [className, setClassName] = useState(draft?.className ?? '');
  const [note, setNote] = useState(draft?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);
  const view = useLastCopy<TrainingResponse>(accountKey, 'training', getTraining, null);
  const read = view.res?.kind === 'ok' ? view.res.data : null;
  const suggestions = read?.status === 'ok' ? groupClassSuggestions(read.rows) : [];
  const date = new Date(when);
  const parsed = TrainingSession.safeParse({ type, when: Number.isFinite(date.getTime()) ? isoWithOffset(date) : '', duration: Number(duration), note,
    ...(type === 'Run' ? { distance: parseDecimal(distance) } : { split, ...(split === 'Group' ? { className } : {}), ...(weight === '' ? {} : { weight: parseDecimal(weight) }) }) });
  const save = async () => {
    if (!parsed.success || !accountKey || !baseRevision || guard.current) return;
    guard.current = true; setSaving(true); setError(null);
    try {
      const envelope = edit ? editTraining({ baseRevision }, edit.row, parsed.data) : logTraining({ baseRevision }, parsed.data);
      await queue.enqueue(envelope, { accountKey, label: `${type} · ${when.replace('T', ' ')}`, taskKey: 'training' });
      onClose();
    } catch { setError('Could not keep this on the device. Your session is still here.'); }
    finally { guard.current = false; setSaving(false); }
  };
  return <div className="sheet-backdrop" role="presentation"><form className="sheet training-sheet" role="dialog" aria-modal="true" aria-label={edit ? 'Edit session' : 'Log training'}
    onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <h2>{edit ? 'Edit session' : 'Log training'}</h2>
    <div className="segmented" role="group" aria-label="Training type">
      {(['Gym', 'Run'] as const).map((t) => <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}>{t}</button>)}
    </div>
    <label>When<input type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} /></label>
    {type === 'Run' ? <><label>Distance (km)<input type="text" inputMode="decimal" required value={distance} onChange={(e) => setDistance(e.target.value)} /></label>
      {draft?.distanceWas && distance === '' && <p className="muted small">Was: {draft.distanceWas}</p>}</> : <>
      <label>Workout<select value={split} onChange={(e) => setSplit(e.target.value as typeof split)}><option value="" disabled>Choose a workout</option>{(['Bicep', 'Tricep', 'Legs', 'Group'] as const).map((s) => <option key={s} value={s}>{s === 'Group' ? 'Group training' : s}</option>)}</select></label>
      {split === 'Group' && <>
        <label>Class name<input type="text" required maxLength={60} value={className} onChange={(e) => setClassName(e.target.value)} /></label>
        {suggestions.length > 0 && <div className="class-suggestions" role="group" aria-label="Class name suggestions">
          {suggestions.map((s) => <button key={s} type="button" onClick={() => setClassName(s)}>{s}</button>)}
        </div>}
      </>}
      <label>Weight (kg, optional)<input type="text" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
      {draft?.weightWas && weight === '' && <p className="muted small">Was: {draft.weightWas}</p>}
    </>}
    <label>Duration (min)<input type="number" inputMode="numeric" required min="1" max="600" step="1" value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
    {draft?.durationWas && duration === '' && <p className="muted small">Was: {draft.durationWas}</p>}
    <label>Note (optional)<textarea maxLength={280} rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
    {(!accountKey || !baseRevision) && <p>Connect once to set up this device before logging training.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="sheet-buttons"><button type="button" disabled={saving} onClick={onClose}>Close</button>
      <button type="submit" className="primary" disabled={saving || !parsed.success || !accountKey || !baseRevision}>{edit ? 'Save changes' : 'Save'}</button></div>
  </form></div>;
}
