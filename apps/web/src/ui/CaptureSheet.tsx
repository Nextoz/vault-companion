import { useRef, useState } from 'react';
import { captureNote, captureTask } from '../commands.ts';
import { prefs, type CaptureKind } from '../prefs.ts';
import type { PendingQueue } from '../queue/queue.ts';

const LIMIT: Record<CaptureKind, number> = { task: 2000, note: 50_000 };

interface Props {
  queue: PendingQueue;
  accountKey: string | null;
  baseRevision: string | null;
  /** Why tasks cannot be captured now (the task list is write-blocked); notes still can. */
  taskBlocked?: string | null;
  onClose: () => void;
}

/** Works offline: the envelope is minted and persisted on the device; the queue sends it later. */
export function CaptureSheet({ queue, accountKey, baseRevision, taskBlocked = null, onClose }: Props) {
  const [chosen, setKind] = useState<CaptureKind>(prefs.captureKind);
  // The remembered choice stays; only this sheet falls back to a note while tasks cannot be written.
  const kind: CaptureKind = taskBlocked ? 'note' : chosen;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const ready = accountKey !== null && baseRevision !== null;
  const canSave = ready && text.trim().length > 0 && !saving;

  const choose = (next: CaptureKind) => {
    setKind(next);
    prefs.setCaptureKind(next);
  };

  const save = async () => {
    // Synchronous guard: a double tap on Save mints exactly one envelope (A40).
    if (savingRef.current || !canSave || accountKey === null || baseRevision === null) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const ctx = { baseRevision };
      const envelope = kind === 'task' ? captureTask(ctx, { text }) : captureNote(ctx, { text });
      const label = text.length > 80 ? `${text.slice(0, 79)}…` : text;
      await queue.enqueue(envelope, { accountKey, label: label.replace(/\s+/g, ' ') });
      setText('');
      onClose();
    } catch {
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
          <button type="button" aria-pressed={kind === 'task'} disabled={taskBlocked !== null} onClick={() => choose('task')}>
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
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        {taskBlocked && <p className="muted small">{taskBlocked} Notes still work.</p>}
        {!ready && <p className="muted small">Connect once to set up this device before capturing.</p>}
        {error && <p className="error">{error}</p>}
        <div className="sheet-buttons">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
