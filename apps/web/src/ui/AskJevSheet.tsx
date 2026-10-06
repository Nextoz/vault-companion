import type { JevAnswer } from '@vault-companion/contracts';
import { useEffect, useRef, useState } from 'react';
import { askJev } from '../api.ts';
import {
  emptyAskJevDraft,
  jevBars,
  MAX_ASK_JEV_QUESTIONS,
  validateAskJevDrafts,
  type AskJevDraft,
} from '../ask-jev.ts';

export function AskJevSheet({ path, accountKey, onClose }: { path: string; accountKey: string; onClose: () => void }) {
  const [drafts, setDrafts] = useState<AskJevDraft[]>([emptyAskJevDraft()]);
  const [phase, setPhase] = useState<'editing' | 'loading' | 'done' | 'error'>('editing');
  const [answers, setAnswers] = useState<JevAnswer[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const invoker = document.activeElement;
    dialog.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => {
      if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus();
    };
  }, []);

  const update = (index: number, next: Partial<AskJevDraft>) => {
    setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, ...next } as AskJevDraft : draft)));
  };

  const changeKind = (index: number, kind: AskJevDraft['kind']) => {
    setDrafts((current) => current.map((draft, at) => {
      if (at !== index) return draft;
      if (kind === 'yes-no') return { kind, question: draft.question };
      if (kind === 'choose') return { kind, question: draft.question, optionsText: draft.kind === 'choose' ? draft.optionsText : '' };
      return { kind, question: draft.question, levelsText: draft.kind === 'rate' ? draft.levelsText : '' };
    }));
  };

  const submit = async () => {
    const validation = validateAskJevDrafts(drafts);
    if (!validation.ok) {
      setPhase('error');
      setMessage(validation.message);
      return;
    }
    setPhase('loading');
    setMessage(null);
    const result = await askJev(path, validation.questions, accountKey);
    if (result.kind === 'ok') {
      setAnswers(result.data.answers);
      setPhase('done');
    } else {
      setPhase('error');
      setMessage(result.kind === 'offline' ? 'Offline. Jev is only available while connected.'
        : result.kind === 'signed-out' ? 'Signed out — reload to sign in.' : result.message);
    }
  };

  const canAdd = drafts.length < MAX_ASK_JEV_QUESTIONS;

  return <div className="sheet-backdrop" role="presentation">
    <div ref={dialog} className="sheet ask-jev-sheet" role="dialog" aria-modal="true" aria-labelledby="ask-jev-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && phase !== 'loading') onClose();
      }}>
      <h2 id="ask-jev-title">Ask Jev</h2>
      {phase === 'loading' && <p role="status">Asking Jev…</p>}
      {phase === 'editing' && <>
        <div className="jev-questions">
          {drafts.map((draft, index) => <div className="jev-question" key={index}>
            <div className="jev-question-head">
              <label>
                <span>Type</span>
                <select aria-label={`Question ${index + 1} type`} value={draft.kind}
                  onChange={(event) => changeKind(index, event.target.value as AskJevDraft['kind'])}>
                  <option value="yes-no">Yes/No</option>
                  <option value="choose">Choose</option>
                  <option value="rate">Rate</option>
                </select>
              </label>
              {drafts.length > 1 && <button type="button" aria-label={`Remove question ${index + 1}`}
                onClick={() => setDrafts((current) => current.filter((_, at) => at !== index))}>Remove</button>}
            </div>
            <label>
              <span>Question</span>
              <textarea rows={2} aria-label={`Question ${index + 1}`} value={draft.question}
                onChange={(event) => update(index, { question: event.target.value })} />
            </label>
            {draft.kind === 'choose' && <label>
              <span>Options, comma-separated</span>
              <input type="text" aria-label={`Question ${index + 1} options`} value={draft.optionsText}
                onChange={(event) => update(index, { optionsText: event.target.value })} />
            </label>}
            {draft.kind === 'rate' && <label>
              <span>Scale labels, comma-separated</span>
              <input type="text" aria-label={`Question ${index + 1} scale labels`} value={draft.levelsText}
                onChange={(event) => update(index, { levelsText: event.target.value })} />
            </label>}
          </div>)}
        </div>
        {message && <p role="alert" className="error">{message}</p>}
        <div className="sheet-buttons">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!canAdd} onClick={() => setDrafts((current) => [...current, emptyAskJevDraft()])}>Add question</button>
          <button type="button" className="primary" onClick={() => void submit()}>Ask Jev</button>
        </div>
      </>}
      {phase === 'error' && <>
        <p role="alert" className="error">{message}</p>
        <div className="sheet-buttons">
          <button type="button" onClick={() => { setPhase('editing'); setMessage(null); }}>Back</button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </>}
      {phase === 'done' && answers && <>
        <div className="jev-answers">
          {answers.map((answer, index) => <section className="jev-answer" key={index} aria-label={`Answer ${index + 1}`}>
            <h3>{answer.question}</h3>
            <div className="jev-bars">
              {jevBars(answer).map((bar) => <div className="jev-bar-row" key={bar.label}>
                <span className="jev-bar-label">{bar.label}</span>
                <span className="jev-bar-track">
                  <span className="jev-bar-fill" style={{ width: `${bar.percent}%` }} />
                </span>
                <span className="jev-bar-percent">{bar.percent}%</span>
              </div>)}
            </div>
          </section>)}
        </div>
        <div className="sheet-buttons">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </>}
      <p className="muted small">Based on this note only; a hint, not a verdict.</p>
    </div>
  </div>;
}
