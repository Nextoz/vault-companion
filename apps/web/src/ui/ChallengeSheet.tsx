import { SaveFollowUpPayload } from '@vault-companion/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { askFollowUp } from '../api.ts';
import { saveFollowUp } from '../commands.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { SheetHeader } from './SheetHeader.tsx';

/**
 * READ1-B (ADR-0063): "Challenge me" on one saved reflection. Opening it spends one capped AI call; nothing is saved
 * unless the owner writes an answer, and that answer draft lives only while this sheet is open (closing discards it).
 */
export function ChallengeSheet({ title, date, ordinal, text, accountKey, queue, baseRevision, onClose }: {
  title: string;
  date: string;
  ordinal: number;
  text: string;
  accountKey: string | null;
  queue: PendingQueue;
  baseRevision: string | null;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<'loading' | 'asked' | 'error'>('loading');
  const [question, setQuestion] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const asked = useRef(false);
  const guard = useRef(false);

  const ask = useCallback(async () => {
    if (!accountKey) { setPhase('error'); setMessage('Connect once to set up this device before asking.'); return; }
    setPhase('loading'); setQuestion(null); setMessage(null);
    const result = await askFollowUp({ title, date, ordinal }, accountKey);
    if (result.kind === 'ok') { setQuestion(result.data.question); setPhase('asked'); return; }
    setPhase('error');
    setMessage(result.kind === 'offline' ? 'Offline. AI questions need a connection.'
      : result.kind === 'signed-out' ? 'Signed out — reload to sign in.' : result.message);
  }, [accountKey, title, date, ordinal]);

  // One call per open: a retry is an explicit tap, because every call spends a capped one (StrictMode-safe).
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void ask();
  }, [ask]);

  const parsed = SaveFollowUpPayload.safeParse({ title, date, ordinal, question: question ?? '', answer });
  const canSave = answer.trim() !== '' && question !== null && parsed.success && accountKey !== null && baseRevision !== null;

  const save = async () => {
    if (!canSave || !parsed.success || !accountKey || !baseRevision || guard.current) return;
    guard.current = true; setSaving(true); setSaveError(null);
    try {
      // The answer is private vault text: it travels verbatim in the envelope, never in the label or an error string.
      await queue.enqueue(saveFollowUp({ baseRevision }, parsed.data),
        { accountKey, label: `${title} · follow-up`, taskKey: 'reading' });
      onClose();
    } catch { setSaveError('Could not keep this on the device. Your answer is still here.'); }
    finally { guard.current = false; setSaving(false); }
  };

  return <div className="sheet-backdrop" role="presentation"><form className="sheet challenge-sheet" role="dialog" aria-modal="true" aria-label="Challenge me"
    onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <SheetHeader title="Challenge me" onClose={onClose} disabled={saving} />
    <p className="muted small">{title} · {date}</p>
    <blockquote className="challenge-reflection">{text}</blockquote>
    {phase === 'loading' && <p role="status">Asking an AI question…</p>}
    {phase === 'asked' && question !== null && <>
      <p className="ai-badge">AI question</p>
      <p className="challenge-question">{question}</p>
      <label>Your answer<textarea rows={5} maxLength={20000} value={answer} onChange={(e) => setAnswer(e.target.value)} /></label>
      {(!accountKey || !baseRevision) && <p>Connect once to set up this device before saving.</p>}
      {saveError && <p className="error" role="alert">{saveError}</p>}
      <div className="sheet-buttons">
        <button type="submit" className="primary" disabled={saving || !canSave}>Save answer</button>
      </div>
    </>}
    {phase === 'error' && <>
      <p className="error" role="alert">{message}</p>
      <div className="sheet-buttons">
        <button type="button" onClick={onClose}>Close</button>
        <button type="button" disabled={!accountKey} onClick={() => void ask()}>Retry</button>
      </div>
    </>}
  </form></div>;
}
