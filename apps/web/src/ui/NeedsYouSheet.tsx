// NY1: the "Needs you" sheet - the rows only the owner can decide. Each row opens an existing screen; an Active
// Work row opens that item's existing edit sheet in place. No new command and no write path of its own.
import { useEffect, useRef, useState } from 'react';
import type { ActiveWorkItem } from '../active-work.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { ActiveWorkEditSheet } from './ActiveWorkEditSheet.tsx';
import type { NeedsYouRow, NeedsYouTarget } from './needs-you.ts';

export function NeedsYouSheet({ rows, queue, accountKey, onNavigate, onDismiss, onClose }: {
  rows: readonly NeedsYouRow[];
  queue: PendingQueue;
  accountKey: string | null;
  onNavigate: (target: NeedsYouTarget) => void;
  /** NY3: a scout row's "Got it" - device-held dismissal, keyed by row id and its error text. */
  onDismiss: (row: NeedsYouRow) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<{ item: ActiveWorkItem; revision: string } | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const dismissed = useRef(false);
  // Move focus into the dialog on open, so the Tab-trap below keeps the background unreachable, and return it to
  // the control that opened the sheet on close (same lifecycle as EditSheet).
  useEffect(() => {
    const invoker = document.activeElement;
    dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => { if (invoker instanceof HTMLElement) invoker.focus(); };
  }, []);
  // NY3: "Got it" removes the focused row, so keep keyboard focus inside the sheet on the next row or the Close button.
  useEffect(() => {
    if (!dismissed.current) return;
    dismissed.current = false;
    const next = dialog.current?.querySelector<HTMLElement>('.needs-you-row:not(:disabled)')
      ?? dialog.current?.querySelector<HTMLElement>('.sheet-buttons button:not(:disabled)');
    next?.focus();
  }, [rows]);

  // An Active Work row reuses the item's own edit sheet; every other row hands its target to the caller and closes.
  function open(row: NeedsYouRow) {
    if (row.target.kind === 'active-work') {
      if (accountKey !== null) setEditing({ item: row.target.item, revision: row.target.revision });
      return;
    }
    onNavigate(row.target);
    onClose();
  }

  if (editing !== null && accountKey !== null) {
    return <ActiveWorkEditSheet item={editing.item} queue={queue} accountKey={accountKey}
      revision={editing.revision} onClose={() => setEditing(null)} />;
  }

  return (
    <div className="sheet-backdrop" role="presentation">
      <div ref={dialog} className="sheet needs-you-sheet" role="dialog" aria-modal="true" aria-label="Needs you"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key !== 'Tab') return;
          const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
          const first = controls?.[0];
          const last = controls?.[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }}>
        <h2>Needs you</h2>
        {rows.length === 0
          ? <p className="muted">Nothing needs you</p>
          : (
            <ul className="needs-you-list">
              {rows.map((row) => (
                <li key={row.id} className="needs-you-item">
                  <button type="button" className="needs-you-row" onClick={() => open(row)}>
                    <span className="needs-you-title">{row.title}</span>
                    <span className="muted small">{row.why}</span>
                  </button>
                  {row.target.kind === 'scouts' && (
                    <button type="button" className="needs-you-dismiss"
                      onClick={() => { dismissed.current = true; onDismiss(row); }}>Got it</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        <div className="sheet-buttons">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
