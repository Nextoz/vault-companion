import type { CompleteTaskCommand, TaskView } from '@vault-companion/contracts';
import { plainWikilinks, readOnlyText } from '../text.ts';
import { occurrenceKey, type Row } from '../view.ts';
import { attentionText } from './ActionsPanel.tsx';
import { StateChip } from './StateChip.tsx';

interface Props {
  title: string;
  rows: Row[];
  /** Occurrence keys of tapped checkboxes (`occurrenceKey`). */
  tapped: ReadonlySet<string>;
  /** No completion from this list (Done today, or the file is write-blocked). */
  blocked: boolean;
  onComplete: (task: TaskView) => void;
  /** Undo a saved app completion from its Done today row (P4-B); rows without `undo` offer none. */
  onUndo?: (target: CompleteTaskCommand, label: string) => void;
  overdue?: boolean;
  empty?: string;
  /** The task list has a sync conflict: rows are shown as last read, not as actionable tasks (writeBlock.ts). */
  frozen?: boolean;
}

export function TaskList({ title, rows, tapped, blocked, onComplete, onUndo, overdue = false, empty, frozen = false }: Props) {
  if (rows.length === 0 && !empty) return null;
  return (
    <section className={frozen ? 'group group-frozen' : 'group'} aria-label={title}>
      <h2>{title}</h2>
      {rows.length === 0 ? (
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
}: {
  row: Row;
  tapped: ReadonlySet<string>;
  blocked: boolean;
  overdue: boolean;
  onComplete: (t: TaskView) => void;
  onUndo: Props['onUndo'];
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
        <span className="task-text">{text}</span>
        <span className="task-meta">
          {task?.due && !row.done && <span className={overdue ? 'due due-over' : 'due'}>{task.due}</span>}
          {readOnly && <span className="readonly">{readOnlyText(readOnly)}</span>}
          {action && <StateChip state={action.state} />}
        </span>
        {action?.state === 'attention' && action.error && <span className="error">{attentionText(action)}</span>}
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
