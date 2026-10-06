import { SheetHeader } from './SheetHeader.tsx';
import type { Priority, TaskView } from '@vault-companion/contracts';
import { useEffect, useRef, useState } from 'react';
import { editTask, type TaskChanges } from '../commands.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { occurrenceKey } from '../view.ts';

interface Props {
  queue: PendingQueue;
  task: TaskView;
  accountKey: string | null;
  baseRevision: string;
  blocked: boolean;
  onClose: () => void;
}

export function EditSheet({ queue, task, accountKey, baseRevision, blocked, onClose }: Props) {
  const [text, setText] = useState(task.description);
  const [due, setDue] = useState(task.due ?? '');
  const [scheduled, setScheduled] = useState(task.scheduled ?? '');
  const [priority, setPriority] = useState<Priority | ''>(task.priority ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const invoker = document.activeElement;
    dialog.current?.querySelector('textarea')?.focus();
    return () => { if (invoker instanceof HTMLElement) invoker.focus(); };
  }, []);
  // The kernel compares the parsed (trimmed) description with changes.text; a trailing space from a phone keyboard
  // would otherwise always be refused as invalid-edit (CodeRabbit #26).
  const normalized = text.trim();
  const changes: TaskChanges = {
    ...(normalized !== task.description ? { text: normalized } : {}),
    ...(due !== (task.due ?? '') ? { due: due || null } : {}),
    ...(scheduled !== (task.scheduled ?? '') ? { scheduled: scheduled || null } : {}),
    ...(priority !== (task.priority ?? '') ? { priority: priority || null } : {}),
  };
  const canSave = accountKey !== null && !blocked && !saving && normalized.length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text) && Object.keys(changes).length > 0;
  const save = async () => {
    if (!canSave || savingRef.current || accountKey === null) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await queue.enqueue(editTask({ baseRevision }, task.locator, changes), {
        accountKey, label: normalized, taskKey: occurrenceKey(task.locator),
      });
      onClose();
    } catch {
      setError('Could not keep this edit on the device. Your text is still here.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="sheet-backdrop" role="presentation">
      <div ref={dialog} className="sheet edit-sheet" role="dialog" aria-modal="true" aria-label="Edit task"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !saving) onClose();
          if (e.key !== 'Tab') return;
          const controls = dialog.current?.querySelectorAll<HTMLElement>('textarea, input, select, button:not(:disabled)');
          const first = controls?.[0];
          const last = controls?.[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }}>
        <SheetHeader title="Edit task" onClose={onClose} disabled={saving} closeLabel="Cancel" />
        <textarea aria-label="Task text" value={text} maxLength={2000} rows={3} onChange={(e) => setText(e.target.value)} />
        <label>Due<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <button type="button" onClick={() => setDue('')} disabled={!due}>Clear due</button>
        <label>Scheduled<input type="date" value={scheduled} onChange={(e) => setScheduled(e.target.value)} /></label>
        <button type="button" onClick={() => setScheduled('')} disabled={!scheduled}>Clear scheduled</button>
        <label>Priority<select value={priority} onChange={(e) => setPriority(e.target.value as Priority | '')}>
          <option value="">None</option>
          {(['highest', 'high', 'medium', 'low', 'lowest'] as const).map((p) => <option key={p} value={p}>{p}</option>)}
        </select></label>
        {blocked && <p role="status">Task editing is currently unavailable.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-buttons">
          <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  );
}
