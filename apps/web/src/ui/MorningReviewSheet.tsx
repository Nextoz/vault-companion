// NY2: the "Review my morning" step-through. Steps 1-2 are read-only projections of data the Today card already
// holds; the last step mints the EXISTING EditTask command (scheduled = today) per confirmed pick, through the same
// queue/Undo path TaskList/EditSheet use. No new API, command or write target.
import type { TaskView } from '@vault-companion/contracts';
import { useEffect, useRef, useState } from 'react';
import type { ActiveWorkItem } from '../active-work.ts';
import { editTask } from '../commands.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { occurrenceKey } from '../view.ts';
import { ActiveWorkEditSheet } from './ActiveWorkEditSheet.tsx';
import {
  calendarLines, canPick, nextStep, NO_OPEN_TASKS, NOTHING_NEEDS_YOU, pickCounter, pickedTasks, pickRows, prevStep,
  togglePick, type PickRow, type ReviewStep,
} from './morning-review.ts';
import type { BriefLine } from './morning-card.ts';
import type { NeedsYouRow, NeedsYouTarget } from './needs-you.ts';

export function MorningReviewSheet({ brief, needs, open, today, queue, accountKey, baseRevision, blocked, onNavigate, onClose }: {
  /** The already-loaded Morning Brief rows (null when there is no usable brief for today). */
  brief: readonly BriefLine[] | null;
  /** The NY1 rows the card already built; rendered in place, never refetched. */
  needs: readonly NeedsYouRow[];
  /** The vault's open tasks from the read the App already holds. */
  open: readonly TaskView[];
  /** The vault's calendar date; a pick is scheduled to exactly this day. */
  today: string;
  queue: PendingQueue;
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
  onNavigate: (target: NeedsYouTarget) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<ReviewStep>('calendar');
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<{ item: ActiveWorkItem; revision: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [planned, setPlanned] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on open (the Tab-trap below keeps the background unreachable) and return it to the
  // control that opened the sheet on close - the same lifecycle NeedsYouSheet/EditSheet use.
  useEffect(() => {
    const invoker = document.activeElement;
    dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => { if (invoker instanceof HTMLElement) invoker.focus(); };
  }, []);

  const rows = pickRows(open, today);
  const picked = pickedTasks(rows, marked);

  // An Active Work row reuses the item's own edit sheet; every other row hands its target to the caller and closes.
  function openRow(row: NeedsYouRow) {
    if (row.target.kind === 'active-work') {
      if (accountKey !== null) setEditing({ item: row.target.item, revision: row.target.revision });
      return;
    }
    onNavigate(row.target);
    onClose();
  }

  // Confirm: one existing EditTask envelope per marked task, scheduled to the vault's today, through the queue.
  async function confirm() {
    if (accountKey === null || baseRevision === null || blocked || savingRef.current || picked.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    let done = 0;
    try {
      for (const task of picked) {
        await queue.enqueue(editTask({ baseRevision }, task.locator, { scheduled: today }), {
          accountKey, label: task.description, taskKey: occurrenceKey(task.locator),
        });
        done += 1;
        // Drop each task from marked as soon as it is enqueued: a later failure must not resubmit it.
        const id = occurrenceKey(task.locator);
        setMarked((current) => new Set([...current].filter((key) => key !== id)));
      }
      setPlanned(done);
      setStep('done');
    } catch {
      setError('Could not keep this plan on the device. Your picks are still here.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (editing !== null && accountKey !== null) {
    return <ActiveWorkEditSheet item={editing.item} queue={queue} accountKey={accountKey}
      revision={editing.revision} onClose={() => setEditing(null)} />;
  }

  const calendar = calendarLines(brief);
  const canConfirm = picked.length > 0 && accountKey !== null && baseRevision !== null && !blocked && !saving;
  return (
    <div className="sheet-backdrop" role="presentation">
      <div ref={dialog} className="sheet morning-review-sheet" role="dialog" aria-modal="true" aria-label="Review my morning"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !saving) onClose();
          if (e.key !== 'Tab') return;
          const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
          const first = controls?.[0];
          const last = controls?.[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }}>
        <h2>Review my morning</h2>
        <p className="muted small">{stepLabel(step)}</p>

        {step === 'calendar' && (
          <div className="needs-you-list">
            {calendar.map((line, i) => <p key={i} className="morning-line">{line}</p>)}
          </div>
        )}

        {step === 'needs' && (needs.length === 0
          ? <p className="muted">{NOTHING_NEEDS_YOU}</p>
          : (
            <ul className="needs-you-list">
              {needs.map((row) => (
                <li key={row.id}>
                  <button type="button" className="needs-you-row" onClick={() => openRow(row)}>
                    <span className="needs-you-title">{row.title}</span>
                    <span className="muted small">{row.why}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))}

        {step === 'pick' && (rows.length === 0
          ? <p className="muted">{NO_OPEN_TASKS}</p>
          : (
            <>
              <p className="muted" role="status">{pickCounter(rows, marked)}</p>
              <ul className="needs-you-list">
                {rows.map((row) => {
                  const markedNow = marked.has(row.id);
                  return <PickTaskRow key={row.id} row={row} marked={markedNow}
                    disabled={saving || (!markedNow && !canPick(rows, marked, row.id))}
                    onToggle={() => setMarked((current) => togglePick(rows, current, row.id))} />;
                })}
              </ul>
            </>
          ))}

        {step === 'done' && (
          <p role="status">{planned === 1 ? '1 task scheduled for today.' : `${planned} tasks scheduled for today.`}</p>
        )}

        {step === 'pick' && blocked && <p role="status">Task editing is currently unavailable.</p>}
        {error && <p className="error" role="alert">{error}</p>}

        <div className="sheet-buttons">
          {step === 'needs' || step === 'pick' ? <button type="button" onClick={() => setStep(prevStep(step))}>Back</button> : null}
          {step === 'calendar' || step === 'needs'
            ? <button type="button" className="primary" onClick={() => setStep(nextStep(step))}>Next</button>
            : null}
          {step === 'pick'
            ? <button type="button" className="primary" disabled={!canConfirm} onClick={() => void confirm()}>{saving ? 'Saving…' : 'Confirm'}</button>
            : null}
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function PickTaskRow({ row, marked, disabled, onToggle }: {
  row: PickRow; marked: boolean; disabled: boolean; onToggle: () => void;
}) {
  return (
    <li>
      <button type="button" className="needs-you-row" aria-pressed={marked} disabled={disabled} onClick={onToggle}>
        <span className="needs-you-title">{row.text}</span>
        {row.alreadyToday ? <span className="muted small">Already today</span> : null}
      </button>
    </li>
  );
}

function stepLabel(step: ReviewStep): string {
  if (step === 'calendar') return '1 of 4 · Calendar';
  if (step === 'needs') return '2 of 4 · Needs you';
  if (step === 'pick') return '3 of 4 · Pick tasks';
  return '4 of 4 · Done';
}
