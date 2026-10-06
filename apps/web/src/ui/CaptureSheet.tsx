import { SheetHeader } from './SheetHeader.tsx';
import { useEffect, useRef, useState } from 'react';
import { captureActiveWork, captureNote, captureTask } from '../commands.ts';
import { DraftKeeper, type DraftStatus, type DraftStore } from '../draft.ts';
import { reviewInSevenDays } from '../active-work.ts';
import { prefs, type CaptureKind } from '../prefs.ts';
import type { PendingQueue } from '../queue/queue.ts';

const LIMIT: Record<CaptureKind, number> = { task: 2000, note: 50_000, 'active-work': 500 };

const DRAFT_NOTICE: Partial<Record<DraftStatus, string>> = {
  unavailable: 'This draft cannot be kept on this device.',
  elsewhere: 'Another window is keeping a draft, so this text is not kept as a draft.',
  superseded: 'This draft was saved or changed in another window. Close and reopen Capture to continue.',
};

interface Props {
  defaultKind?: CaptureKind | undefined;
  queue: PendingQueue;
  drafts: DraftStore;
  /** Drafts are kept under this account; on a change to another account the sheet shows only that one's draft. */
  accountKey: string | null;
  baseRevision: string | null;
  /** Why tasks cannot be captured now (the task list is write-blocked); notes still can. */
  taskBlocked?: string | null;
  onClose: () => void;
}

/**
 * Works offline: the envelope is minted and persisted on the device; the queue sends it later. Unsaved text is kept
 * as this account's draft (P4-C) and restored on reopen; closing keeps it, only "Discard draft" or Save removes it.
 * With several windows open, each draft is saved at most once: see draft.ts.
 */
export function CaptureSheet({ queue, drafts, accountKey, baseRevision, defaultKind, taskBlocked = null, onClose }: Props) {
  // Only fresh sheets use the view default; recovery below restores the draft's own kind and fields.
  const [chosen, setKind] = useState<CaptureKind>(() => defaultKind ?? prefs.captureKind());
  // The remembered choice stays; only this sheet falls back to a note while tasks cannot be written.
  const kind: CaptureKind = taskBlocked && chosen === 'task' ? 'note' : chosen;
  const [text, setText] = useState('');
  const [activeWork, setActiveWork] = useState(() => ({ next: '', review: reviewInSevenDays(), link: '' }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>('kept');
  const savingRef = useRef(false);
  const keeperRef = useRef<DraftKeeper | null>(null);
  const typedRef = useRef(false);
  const boundRef = useRef(accountKey);
  const contentRef = useRef({ kind, text, activeWork });
  contentRef.current = { kind, text, activeWork };

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
      setActiveWork({ next: '', review: reviewInSevenDays(), link: '' });
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
      if (draft.activeWork) setActiveWork(draft.activeWork);
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
  const validActiveWork = kind !== 'active-work' || (!/[\r\n]/.test(text) && (!activeWork.link.trim() || /^\[\[[^[\]]+\]\]$/.test(activeWork.link.trim())));
  const canSave = validActiveWork && ready && text.trim().length > 0 && !saving && draftStatus !== 'superseded';

  const choose = (next: CaptureKind) => {
    setKind(next);
    prefs.setCaptureKind(next);
    keeperRef.current?.change({ kind: next, text, activeWork });
  };

  const edit = (next: string) => {
    typedRef.current = true;
    setText(next);
    setError(null);
    keeperRef.current?.change({ kind, text: next, activeWork });
  };

  const editActiveWork = (field: keyof typeof activeWork, value: string) => {
    typedRef.current = true;
    const updated = { ...activeWork, [field]: value };
    setActiveWork(updated);
    keeperRef.current?.change({ kind, text, activeWork: updated });
  };

  const discard = () => {
    typedRef.current = true;
    setText('');
    setError(null);
    setActiveWork({ next: '', review: reviewInSevenDays(), link: '' });
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
      const envelope = kind === 'active-work' ? captureActiveWork(ctx, {
        name: text.trim(),
        ...(activeWork.next.trim() ? { next: activeWork.next.trim() } : {}),
        ...(activeWork.review ? { review: activeWork.review } : {}),
        ...(activeWork.link.trim() ? { link: activeWork.link.trim() } : {}),
      }) : kind === 'task' ? captureTask(ctx, { text }) : captureNote(ctx, { text });
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
      keeper?.resume({ kind, text, activeWork });
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
        <SheetHeader title="Capture" onClose={onClose} />
        <div className="segmented" role="group" aria-label="Capture type">
          <button type="button" aria-pressed={kind === 'task'} disabled={taskBlocked !== null} onClick={() => choose('task')}>
            Task
          </button>
          <button type="button" aria-pressed={kind === 'note'} onClick={() => choose('note')}>
            Note
          </button>
          <button type="button" aria-pressed={kind === 'active-work'} onClick={() => choose('active-work')}>Active Work</button>
        </div>
        <textarea
          aria-label={kind === 'active-work' ? 'Name' : kind === 'task' ? 'Task text' : 'Note text'}
          placeholder={kind === 'active-work' ? 'Name of this work' : kind === 'task' ? 'What needs doing?' : 'What is on your mind?'}
          value={text}
          maxLength={LIMIT[kind]}
          rows={kind === 'task' ? 3 : 8}
          autoFocus
          onChange={(e) => edit(e.target.value)}
        />
        {kind === 'active-work' && <>
          <label>Next action<input value={activeWork.next} maxLength={500} onChange={(e) => editActiveWork('next', e.target.value)} /></label>
          <label>Review date<input type="date" value={activeWork.review} onChange={(e) => editActiveWork('review', e.target.value)} /></label>
          <button type="button" disabled={!activeWork.review} onClick={() => editActiveWork('review', '')}>Clear review date</button>
          <label>Link<input placeholder="[[Note name]]" value={activeWork.link} onChange={(e) => editActiveWork('link', e.target.value)} /></label>
        </>}
        {taskBlocked && <p className="muted small">{taskBlocked} Notes still work.</p>}
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

          <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
