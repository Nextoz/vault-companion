import { useEffect, useRef, useState } from 'react';
import { captureNote, captureTask } from '../commands.ts';
import { DraftKeeper, type DraftStatus, type DraftStore } from '../draft.ts';
import { prefs, type CaptureKind } from '../prefs.ts';
import type { PendingQueue } from '../queue/queue.ts';

const LIMIT: Record<CaptureKind, number> = { task: 2000, note: 50_000 };

const DRAFT_NOTICE: Partial<Record<DraftStatus, string>> = {
  unavailable: 'This draft cannot be kept on this device.',
  elsewhere: 'Another window is keeping a draft, so this text is not kept as a draft.',
  superseded: 'This draft was saved or changed in another window. Close and reopen Capture to continue.',
};

interface Props {
  queue: PendingQueue;
  drafts: DraftStore;
  /** Drafts are kept under this account; on a change to another account the sheet shows only that one's draft. */
  accountKey: string | null;
  baseRevision: string | null;
  onClose: () => void;
}

/**
 * Works offline: the envelope is minted and persisted on the device; the queue sends it later. Unsaved text is kept
 * as this account's draft (P4-C) and restored on reopen; closing keeps it, only "Discard draft" or Save removes it.
 * With several windows open, each draft is saved at most once: see draft.ts.
 */
export function CaptureSheet({ queue, drafts, accountKey, baseRevision, onClose }: Props) {
  const [kind, setKind] = useState<CaptureKind>(prefs.captureKind);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>('kept');
  const savingRef = useRef(false);
  const keeperRef = useRef<DraftKeeper | null>(null);
  const typedRef = useRef(false);
  const boundRef = useRef(accountKey);
  const contentRef = useRef({ kind, text });
  contentRef.current = { kind, text };

  useEffect(() => {
    const keeper = new DraftKeeper({ store: drafts, accountKey, onStatus: setDraftStatus });
    setDraftStatus('kept');
    keeperRef.current = keeper;
    const previous = boundRef.current;
    boundRef.current = accountKey;
    if (previous !== null && previous !== accountKey) {
      // Another account: the previous keeper has written the text under its own account; none of it is shown here.
      typedRef.current = false;
      setText('');
      setError(null);
    } else if (typedRef.current) {
      // First confirmed account: what was typed before it is now kept under it.
      keeper.change(contentRef.current);
    }
    let live = true;
    void keeper.restore().then((draft) => {
      // Text typed before the draft arrived wins; restoring never sends or enqueues anything.
      if (!live || !draft || typedRef.current) return;
      setKind(draft.kind);
      setText(draft.text);
    });
    const flush = () => void keeper.flush();
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
      void keeper.dispose();
      if (keeperRef.current === keeper) keeperRef.current = null;
    };
  }, [drafts, accountKey]);

  const ready = accountKey !== null && baseRevision !== null;
  const canSave = ready && text.trim().length > 0 && !saving && draftStatus !== 'superseded';

  const choose = (next: CaptureKind) => {
    setKind(next);
    prefs.setCaptureKind(next);
    keeperRef.current?.change({ kind: next, text });
  };

  const edit = (next: string) => {
    typedRef.current = true;
    setText(next);
    setError(null);
    keeperRef.current?.change({ kind, text: next });
  };

  const discard = () => {
    typedRef.current = true;
    setText('');
    setError(null);
    void keeperRef.current?.discard();
  };

  const save = async () => {
    // Synchronous guard: a double tap on Save mints exactly one envelope (A40).
    if (savingRef.current || !canSave || accountKey === null || baseRevision === null) return;
    savingRef.current = true;
    setSaving(true);
    const keeper = keeperRef.current;
    try {
      // Every draft write this sheet started has finished: `basis` is the version this Save claims.
      await keeper?.suspend();
      if (keeper?.superseded) return;
      const ctx = { baseRevision };
      const envelope = kind === 'task' ? captureTask(ctx, { text }) : captureNote(ctx, { text });
      const label = text.length > 80 ? `${text.slice(0, 79)}…` : text;
      // One transaction: the draft is still that version, the command is kept and the draft is gone; or nothing.
      const result = await queue.enqueue(envelope, {
        accountKey,
        label: label.replace(/\s+/g, ' '),
        ...(keeper ? { draft: keeper.basis } : {}),
      });
      if (result === 'draft-conflict') {
        keeper?.supersede();
        return;
      }
      setText('');
      onClose();
    } catch {
      keeper?.resume({ kind, text });
      setError('Could not keep this on the device. Your text is still here.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    // A stray tap outside must not throw away typed text; Cancel still closes explicitly.
    <div className="sheet-backdrop" role="presentation" onClick={() => text.length === 0 && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Capture" onClick={(e) => e.stopPropagation()}>
        <div className="segmented" role="group" aria-label="Capture type">
          <button type="button" aria-pressed={kind === 'task'} onClick={() => choose('task')}>
            Task
          </button>
          <button type="button" aria-pressed={kind === 'note'} onClick={() => choose('note')}>
            Note
          </button>
        </div>
        <textarea
          aria-label={kind === 'task' ? 'Task text' : 'Note text'}
          placeholder={kind === 'task' ? 'What needs doing?' : 'What is on your mind?'}
          value={text}
          maxLength={LIMIT[kind]}
          rows={kind === 'task' ? 3 : 8}
          autoFocus
          onChange={(e) => edit(e.target.value)}
        />
        {!ready && <p className="muted small">Connect once to set up this device before capturing.</p>}
        {DRAFT_NOTICE[draftStatus] && (
          <p className={draftStatus === 'superseded' ? 'error' : 'muted small'} role="status">
            {DRAFT_NOTICE[draftStatus]}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="sheet-buttons">
          {text.length > 0 && (
            <button type="button" onClick={discard} disabled={saving}>
              Discard draft
            </button>
          )}
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
