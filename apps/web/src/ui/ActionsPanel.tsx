import type { CommandType, TasksResponse } from '@vault-companion/contracts';
import { useState } from 'react';
import { exportText, undoEditTraining, undoEditTrainingDraft, undoLogTraining, undoLogTrainingDraft, undoMoodCheckin, undoMoodCheckinDraft, undoReportFeedback, undoReportFeedbackDraft } from '../commands.ts';
import { prefs } from '../prefs.ts';
import { knownNotApplied } from '../queue/classify.ts';
import type { PendingQueue, QueueItem, ReadEvidence } from '../queue/queue.ts';
import { StateChip } from './StateChip.tsx';

const VERB: Record<CommandType, string> = {
  LogTraining: 'Training',
  UndoLogTraining: 'Undo training',
  EditTraining: 'Edit training',
  UndoEditTraining: 'Undo training edit',
  LogLearning: 'Learning',
  UndoLogLearning: 'Undo learning',
  MoodCheckin: 'Mood check-in',
  UndoMoodCheckin: 'Undo mood check-in',
  ReportFeedback: 'Report',
  UndoReportFeedback: 'Undo report',
  CompleteTask: 'Complete',
  EditTask: 'Edit',
  UndoCompleteTask: 'Undo',
  CaptureTask: 'Task',
  CaptureNote: 'Note',
  EditNote: 'Edit note',
  CaptureActiveWork: 'Active Work',
  EditActiveWork: 'Edit Active Work',
  ReviewActiveWork: 'Review Active Work',
  UndoActiveWork: 'Undo Active Work',
  TriageDecide: 'Event decision',
};

/** The action's time is too far from the server's; the stored bytes carry that time, so only a redo can pass. */
export const CLOCK_SKEW_TEXT = "Check your phone's date and time, then redo the action.";

export const UNDO_UNKNOWN_TEXT = 'This Undo may already have been applied. Check the task before you retry or discard it.';

/** The line shown for an action that needs attention: the conflict in plain words, else the server's message. */
export function attentionText(item: QueueItem): string | null {
  if ((item.type === 'UndoActiveWork' || item.type === 'UndoLogTraining' || item.type === 'UndoEditTraining' || item.type === 'UndoMoodCheckin') && item.error && knownNotApplied(item.error)) return 'Cannot restore the exact previous file; undo it in Obsidian.';
  if (item.error?.code === 'conflict:task-changed') return 'This task changed on another device.';
  if (item.error?.code === 'conflict:training-changed') return 'That session changed in Obsidian — refresh and edit again.';
  if (item.error?.code === 'clock-skew') return CLOCK_SKEW_TEXT;
  // Review O5: the outcome is unknown, not refused — never tell the owner to redo something that may have happened.
  if (item.error?.code === 'dedupe-unknown' && (item.type === 'UndoCompleteTask' || item.type === 'UndoActiveWork' || item.type === 'UndoLogTraining' || item.type === 'UndoEditTraining' || item.type === 'UndoMoodCheckin')) return UNDO_UNKNOWN_TEXT;
  return item.error?.message ?? null;
}

/**
 * Whether sending the same bytes again can succeed. A refusal known not to have applied (`refused:*`, `conflict:*`,
 * …) is final for these bytes: the server will refuse them again, so Retry is not offered (P4-B). Except a refusal
 * for Git conflict markers in the file: once the owner resolves the conflict on the desktop, the same bytes may apply.
 * `clock-skew` is final too: the stored envelope keeps its `occurredAt`, so identical bytes are refused again.
 * While the read on screen is write-blocked, a task-list action would be refused again: no Retry until a fresh
 * unblocked read. A note never touches the task list.
 */
export function canRetry(item: QueueItem, read: Pick<TasksResponse, 'writeBlock'> | null = null): boolean {
  if (item.accountMismatch || item.error?.code === 'clock-skew') return false;
  if (read?.writeBlock && ['CompleteTask', 'UndoCompleteTask', 'EditTask', 'CaptureTask'].includes(item.type)) return false;
  return item.error?.code === 'refused:vault-conflict' || !knownNotApplied(item.error);
}

/** Every action on this device with its honest state. Saved entries can be cleared. */
export function ActionsPanel({
  queue,
  items,
  read,
  onRefresh,
  onDiscard,
}: {
  queue: PendingQueue;
  items: readonly QueueItem[];
  /** The read on screen: clearing uses it as the watermark (G3-1); its writeBlock withholds Retry. */
  read: (ReadEvidence & Pick<TasksResponse, 'writeBlock'>) | null;
  /** Re-read the tasks, so the user can act on the current row after a conflict. */
  onRefresh: () => void;
  /** Remove the action from the device (the App remembers that its task still needs attention). */
  onDiscard: (item: QueueItem) => void;
}) {
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<QueueItem | null>(null);
  // A capture is discarded only from the dialog that shows its text: nothing typed is lost unseen.
  const [discarding, setDiscarding] = useState<QueueItem | null>(null);
  // B2: one summary line by default; a problem is never hidden (the line names it in the error colour).
  const [open, setOpen] = useState(prefs.actionsOpen);
  if (items.length === 0) return null;
  const attention = items.filter((i) => i.state === 'attention').length;
  // Only acknowledged receipts may be cleared (the watermark the read on screen satisfies covers them, O1); the rest
  // still keep the screen honest (A9, G3-1).
  const saved = read
    ? items.filter((i) => i.state === 'saved' && i.acknowledged && read.known[i.receipt?.commitSha ?? ''] !== 'not-included')
    : [];

  return (
    <section className="group actions" aria-label="Actions on this device">
      <h2>
        <button type="button" className="link actions-toggle" aria-expanded={open} onClick={() => {
          prefs.setActionsOpen(!open);
          setOpen(!open);
        }}>
          Actions · {items.length}
        </button>
        {attention > 0 && <span className="error small"> · {attention} needs attention</span>}
        {open && saved.length > 0 && (
          <button type="button" className="link" onClick={() => read && void queue.forgetSaved(saved.map((i) => i.operationId), read)}>
            Clear saved
          </button>
        )}
      </h2>
      {undoError && <p role="alert" className="error">{undoError}</p>}
      {open && <>
      <ul className="action-list">
        {items.map((item) => (
          <li key={item.operationId} className="action" data-testid="action">
            <div className="action-head">
              <span className="action-verb">{VERB[item.type]}</span>
              <span className="action-label">{item.label}</span>
              <StateChip state={item.state} />
            </div>
            {item.state === 'saved' && <p className="muted small">{item.type === 'CaptureNote' && 'Saved to the vault; '}reaches Obsidian at your next desktop sync</p>}
            {item.envelope.type === 'LogTraining' && !item.accountMismatch && item.state !== 'attention' &&
              !items.some((q) => q.envelope.type === 'UndoLogTraining' && q.envelope.payload.target.operationId === item.operationId) &&
              <button type="button" disabled={undoing !== null} onClick={() => {
                if (item.envelope.type !== 'LogTraining' || undoing !== null) return;
                setUndoing(item.operationId); setUndoError(null);
                const target = item.envelope;
                const ctx = { baseRevision: read?.revision ?? target.baseRevision };
                const undo = item.receipt ? undoLogTraining(ctx, target, item.receipt.commitSha) : undoLogTrainingDraft(ctx, target);
                void queue.undoCompletion(target, undo, { accountKey: item.accountKey, label: item.label, taskKey: 'training' })
                  .catch(() => setUndoError('Could not keep this Undo on the device.'))
                  .finally(() => setUndoing(null));
              }}>Undo</button>}
            {item.envelope.type === 'EditTraining' && !item.accountMismatch && item.state !== 'attention' &&
              !items.some((q) => q.envelope.type === 'UndoEditTraining' && q.envelope.payload.target.operationId === item.operationId) &&
              <button type="button" disabled={undoing !== null} onClick={() => {
                if (item.envelope.type !== 'EditTraining' || undoing !== null) return;
                setUndoing(item.operationId); setUndoError(null);
                const target = item.envelope;
                const ctx = { baseRevision: read?.revision ?? target.baseRevision };
                const undo = item.receipt ? undoEditTraining(ctx, target, item.receipt.commitSha) : undoEditTrainingDraft(ctx, target);
                void queue.undoCompletion(target, undo, { accountKey: item.accountKey, label: item.label, taskKey: 'training' })
                  .catch(() => setUndoError('Could not keep this Undo on the device.'))
                  .finally(() => setUndoing(null));
              }}>Undo</button>}
            {item.envelope.type === 'MoodCheckin' && !item.accountMismatch && item.state !== 'attention' &&
              !items.some((q) => q.envelope.type === 'UndoMoodCheckin' && q.envelope.payload.target.operationId === item.operationId) &&
              <button type="button" disabled={undoing !== null} onClick={() => {
                if (item.envelope.type !== 'MoodCheckin' || undoing !== null) return;
                setUndoing(item.operationId); setUndoError(null);
                const target = item.envelope;
                const ctx = { baseRevision: read?.revision ?? target.baseRevision };
                const undo = item.receipt ? undoMoodCheckin(ctx, target, item.receipt.commitSha) : undoMoodCheckinDraft(ctx, target);
                void queue.undoCompletion(target, undo, { accountKey: item.accountKey, label: item.label, taskKey: 'mood' })
                  .catch(() => setUndoError('Could not keep this Undo on the device.'))
                  .finally(() => setUndoing(null));
              }}>Undo</button>}
            {item.envelope.type === 'ReportFeedback' && !item.accountMismatch && item.state !== 'attention' &&
              !items.some((q) => q.envelope.type === 'UndoReportFeedback' && q.envelope.payload.target.operationId === item.operationId) &&
              <button type="button" disabled={undoing !== null} onClick={() => {
                if (item.envelope.type !== 'ReportFeedback' || undoing !== null) return;
                setUndoing(item.operationId); setUndoError(null);
                const target = item.envelope;
                const ctx = { baseRevision: read?.revision ?? target.baseRevision };
                const undo = item.receipt ? undoReportFeedback(ctx, target, item.receipt.commitSha) : undoReportFeedbackDraft(ctx, target);
                void queue.undoCompletion(target, undo, { accountKey: item.accountKey, label: item.label, taskKey: 'report' })
                  .catch(() => setUndoError('Could not keep this Undo on the device.'))
                  .finally(() => setUndoing(null));
              }}>Undo</button>}
            {item.state === 'attention' && (
              <>
                {item.error && <p className="error">{attentionText(item)}</p>}
                {isTaskAction(item) && (
                  <p className="muted small">Discarding removes only this action; the task will still need attention.</p>
                )}
                <div className="action-buttons">
                  {canRetry(item, read) && (
                    <button type="button" onClick={() => void queue.retry(item.operationId)}>
                      Retry
                    </button>
                  )}
                  {item.error?.code.startsWith('conflict:') && (
                    <button type="button" onClick={onRefresh}>
                      Refresh tasks
                    </button>
                  )}
                  <button type="button" onClick={() => setExporting(item)}>
                    Copy text
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => (isTaskAction(item) ? onDiscard(item) : setDiscarding(item))}
                  >
                    Discard
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">Pending actions are kept on this device while possible.</p>
      </>}
      {exporting && <ExportDialog text={exportText(exporting.envelope)} onClose={() => setExporting(null)} />}
      {discarding && (
        <ExportDialog
          text={exportText(discarding.envelope)}
          onClose={() => setDiscarding(null)}
          onDiscard={() => {
            onDiscard(discarding);
            setDiscarding(null);
          }}
        />
      )}
    </section>
  );
}

const isTaskAction = (item: QueueItem) => item.type === 'CompleteTask' || item.type === 'UndoCompleteTask';

/** Shows an action's text to copy; with `onDiscard`, it is also where a capture is discarded. */
function ExportDialog({ text, onClose, onDiscard }: { text: string; onClose: () => void; onDiscard?: () => void }) {
  const [copied, setCopied] = useState(false);
  const title = onDiscard ? 'Discard this capture?' : 'Copy text';
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {onDiscard && <p className="muted small">It will not be saved. Copy the text first if you still need it.</p>}
        <textarea readOnly value={text} rows={6} aria-label="Exported text" onFocus={(e) => e.currentTarget.select()} />
        <div className="sheet-buttons">
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(text).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          {onDiscard && (
            <button type="button" className="danger" onClick={onDiscard}>
              Discard
            </button>
          )}
          <button type="button" onClick={onClose}>
            {onDiscard ? 'Keep' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
