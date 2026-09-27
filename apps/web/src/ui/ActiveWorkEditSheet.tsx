import { useEffect, useRef, useState } from 'react';
import { activeWorkChanges, type ActiveWorkItem } from '../active-work.ts';
import { editActiveWork } from '../commands.ts';
import type { PendingQueue } from '../queue/queue.ts';

export function ActiveWorkEditSheet({ item, queue, accountKey, revision, onClose }: {
  item: ActiveWorkItem; queue: PendingQueue; accountKey: string; revision: string; onClose: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [next, setNext] = useState(item.next ?? '');
  const [review, setReview] = useState(item.review ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const invoker = document.activeElement;
    dialog.current?.querySelector('input')?.focus();
    return () => { if (invoker instanceof HTMLElement) invoker.focus(); };
  }, []);
  const changes = activeWorkChanges(item, name, next, review);
  const canSave = !saving && name.trim().length > 0 && Object.keys(changes).length > 0;
  const save = async () => {
    if (!canSave || guard.current) return;
    guard.current = true;
    setSaving(true);
    try {
      await queue.enqueue(editActiveWork({ baseRevision: revision }, item.locator, changes), {
        accountKey, label: name.trim(), taskKey: 'active-work',
      });
      onClose();
    } catch {
      setError('Could not keep this edit on the device. Your text is still here.');
    } finally { guard.current = false; setSaving(false); }
  };
  return <div className="sheet-backdrop" role="presentation">
    <div ref={dialog} className="sheet edit-sheet" role="dialog" aria-modal="true" aria-label="Edit Active Work"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !saving) onClose();
        if (e.key !== 'Tab') return;
        const controls = dialog.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)');
        const first = controls?.[0]; const last = controls?.[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }}>
      <h2>Edit Active Work</h2>
      <label>Name<input value={name} maxLength={500} onChange={(e) => setName(e.target.value)} /></label>
      <label>Next action<input value={next} maxLength={500} onChange={(e) => setNext(e.target.value)} /></label>
      <label>Review date<input type="date" value={review} onChange={(e) => setReview(e.target.value)} /></label>
      <button type="button" disabled={!review} onClick={() => setReview('')}>Clear review date</button>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="sheet-buttons">
        <button type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>Save</button>
      </div>
    </div>
  </div>;
}
