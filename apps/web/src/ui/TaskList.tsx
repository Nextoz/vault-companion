import type { CompleteTaskCommand, TaskView } from '@vault-companion/contracts';
import { UNRESOLVED_TEXT } from '../attention.ts';
import { plainWikilinks, readOnlyText, taskSegments } from '../text.ts';
import { occurrenceKey, type Row } from '../view.ts';
import { attentionText } from './ActionsPanel.tsx';
import type { OpenLink } from './NoteView.tsx';
import { StateChip } from './StateChip.tsx';

interface Props {
  title: string;
  rows: Row[];
  /** Occurrence keys of tapped checkboxes (`occurrenceKey`). */
  tapped: ReadonlySet<string>;
  /** No completion from this list (Done today, or the file is write-blocked). */
  blocked: boolean;
  onComplete: (task: TaskView) => void;
  onOpenLink: (link: OpenLink) => void;
  /** Undo a saved app completion from its Done today row (P4-B); rows without `undo` offer none. */
  onUndo?: (target: CompleteTaskCommand, label: string) => void;
  overdue?: boolean;
  empty?: string;
  /** The task list has a sync conflict: rows are shown as last read, not as actionable tasks (writeBlock.ts). */
  frozen?: boolean;
  /** A group that starts collapsed behind a summary such as "3 overdue" (ADR-0012). */
  collapsible?: { open: boolean; summary: string; onToggle: () => void };
}

export function TaskList({
  title,
  rows,
  tapped,
  blocked,
  onComplete,
  onUndo,
  onOpenLink,
  overdue = false,
  empty,
  frozen = false,
  collapsible,
}: Props) {
  if (rows.length === 0 && !empty) return null;
  const shown = collapsible?.open ?? true;
  return (
    <section className={frozen ? 'group group-frozen' : 'group'} aria-label={title}>
      {collapsible ? (
        <h2>
          <button type="button" className="link group-toggle" aria-expanded={collapsible.open} onClick={collapsible.onToggle}>
            {collapsible.summary}
          </button>
        </h2>
      ) : (
        <h2>{title}</h2>
      )}
      {!shown ? null : rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="tasks">
          {rows.map((row) => (
            <TaskRow
              key={row.key}
              row={row}
              tapped={tapped}
              blocked={blocked}
              overdue={overdue}
              onComplete={onComplete}
              onUndo={onUndo}
              onOpenLink={onOpenLink}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskRow({
  row,
  tapped,
  blocked,
  overdue,
  onComplete,
  onUndo,
  onOpenLink,
}: {
  row: Row;
  tapped: ReadonlySet<string>;
  blocked: boolean;
  overdue: boolean;
  onComplete: (t: TaskView) => void;
  onUndo: Props['onUndo'];
  onOpenLink: (link: OpenLink) => void;
}) {
  const { task, action, undo } = row;
  const busy = action !== null && action.state !== 'attention' && action.state !== 'saved';
  const readOnly = task?.readOnlyReason ?? null;
  const canComplete =
    !row.done && task !== null && readOnly === null && !blocked && !busy && !tapped.has(occurrenceKey(task.locator));
  const text = plainWikilinks(row.description);

  return (
    <li className={`task${row.done ? ' task-done' : ''}`} data-testid="task">
      {canComplete ? (
        <button
          type="button"
          className="check"
          aria-label={`Complete: ${text}`}
          onClick={(e) => {
            e.currentTarget.disabled = true; // synchronous: a second tap cannot mint a second envelope
            onComplete(task);
          }}
        />
      ) : (
        <span className={`check check-static${row.done ? ' check-on' : ''}`} aria-hidden="true" />
      )}
      <div className="task-body">
        <span className="task-text">
          {task === null
            ? text
            : taskSegments(row.description, task.links).map((seg, i) =>
                seg.kind === 'text' ? (
                  <span key={i}>{seg.text}</span>
                ) : (
                  <button
                    key={i}
                    type="button"
                    className="wikilink"
                    aria-label={`Open note: ${seg.text}`}
                    onClick={(e) => onOpenLink({ task, linkIndex: seg.linkIndex, label: seg.text, invoker: e.currentTarget })}
                  >
                    {seg.text}
                  </button>
                ),
              )}
        </span>
        <span className="task-meta">
          {task?.due && !row.done && <span className={overdue ? 'due due-over' : 'due'}>{task.due}</span>}
          {readOnly && <span className="readonly">{readOnlyText(readOnly)}</span>}
          {action && <StateChip state={action.state} />}
        </span>
        {action?.state === 'attention' && action.error ? (
          <span className="error">{attentionText(action)}</span>
        ) : (
          row.unresolved && <span className="error">{UNRESOLVED_TEXT}</span>
        )}
      </div>
      {undo && onUndo && (
        <button
          type="button"
          className="link"
          aria-label={`Undo: ${text}`}
          onClick={(e) => {
            e.currentTarget.disabled = true; // synchronous, like the checkbox
            onUndo(undo, action?.label ?? text);
          }}
        >
          Undo
        </button>
      )}
    </li>
  );
}
