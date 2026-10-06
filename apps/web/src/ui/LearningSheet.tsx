import { SheetHeader } from './SheetHeader.tsx';
import { LearningSession, type LearningResponse } from '@vault-companion/contracts';
import { useRef, useState } from 'react';
import { getLearning } from '../api.ts';
import { logLearning } from '../commands.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { copenhagenDay } from '../triage.ts';
import { applyPasteLine, draftToSession, kindName, newLearningDraft, type LearningDraft } from '../learning.ts';
import { useLastCopy } from './useLastCopy.tsx';

/** LG1b: the "Add session" sheet. Two taps (a kind chip on the default date) are a valid save; every other field is optional. */
export function LearningSheet({ queue, accountKey, baseRevision, onClose, now = new Date() }: {
  queue: PendingQueue; accountKey: string | null; baseRevision: string | null; onClose: () => void; now?: Date;
}) {
  const [draft, setDraft] = useState<LearningDraft>(() => newLearningDraft(copenhagenDay(now.toISOString())));
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);
  const view = useLastCopy<LearningResponse>(accountKey, 'learning', getLearning, null);
  const read = view.res?.kind === 'ok' ? view.res.data : null;
  const kinds = read?.status === 'ok' ? read.kinds : [];
  const set = <K extends keyof LearningDraft>(key: K, value: LearningDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const parsed = LearningSession.safeParse(draftToSession(draft));
  const onPasteChange = (value: string) => {
    setPaste(value);
    if (value.trim() === '') { setPasteError(null); return; }
    const result = applyPasteLine(draft, value);
    if (result.error) { setPasteError(result.error); return; }
    setDraft(result.draft);
    setPaste('');
    setPasteError(null);
  };
  const save = async () => {
    if (!parsed.success || !accountKey || !baseRevision || guard.current) return;
    guard.current = true; setSaving(true); setError(null);
    try {
      const session = parsed.data;
      const envelope = logLearning({ baseRevision }, session);
      await queue.enqueue(envelope, { accountKey, label: `${kindName(kinds, session.kind)} · ${session.date}`, taskKey: 'learning' });
      onClose();
    } catch { setError('Could not keep this on the device. Your session is still here.'); }
    finally { guard.current = false; setSaving(false); }
  };
  return <div className="sheet-backdrop" role="presentation"><form className="sheet learning-sheet" role="dialog" aria-modal="true" aria-label="Add session"
    onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <SheetHeader title="Add session" onClose={onClose} disabled={saving} />
    <label>Paste line<input type="text" value={paste} placeholder="LG | kind | date | min n | score n | topic: text" onChange={(e) => onPasteChange(e.target.value)} /></label>
    {pasteError && <p className="muted small" role="alert">{pasteError}</p>}
    <label>Date<input type="date" required value={draft.date} onChange={(e) => set('date', e.target.value)} /></label>
    <div className="chip-group" role="group" aria-label="Kind">
      {kinds.map((kind) => <button key={kind.id} type="button" aria-pressed={draft.kind === kind.id} onClick={() => set('kind', kind.id)}>{kind.name}</button>)}
    </div>
    {kinds.length === 0 && <p className="muted small">Kinds could not be loaded from the Learning Gym Log.</p>}
    <label>Minutes (optional)<input type="number" inputMode="numeric" min="0" max="600" step="1" value={draft.minutes} onChange={(e) => set('minutes', e.target.value)} /></label>
    <label>Score (optional)<input type="text" maxLength={8} value={draft.score} onChange={(e) => set('score', e.target.value)} /></label>
    <label>Detail (optional)<input type="text" maxLength={280} value={draft.detail} onChange={(e) => set('detail', e.target.value)} /></label>
    <label>Topic (optional)<input type="text" maxLength={280} value={draft.topic} onChange={(e) => set('topic', e.target.value)} /></label>
    <label>Note (optional)<textarea maxLength={280} rows={2} value={draft.note} onChange={(e) => set('note', e.target.value)} /></label>
    {(!accountKey || !baseRevision) && <p>Connect once to set up this device before logging a session.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="sheet-buttons">
      <button type="submit" className="primary" disabled={saving || !parsed.success || !accountKey || !baseRevision}>Save</button></div>
  </form></div>;
}
