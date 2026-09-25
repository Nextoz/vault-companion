import type { TaskView } from '@vault-companion/contracts';
import { plainWikilinks, readOnlyText, taskSegments } from '../text.ts';
import type { Row } from '../view.ts';
import type { OpenLink } from './NoteView.tsx';
import { StateChip } from './StateChip.tsx';

interface Props {
  title: string;
  rows: Row[];
  tapped: ReadonlySet<string>;
  /** No completion from this list (Done today, or the file is write-blocked). */
  blocked: boolean;
  onComplete: (task: TaskView) => void;
  onOpenLink: (link: OpenLink) => void;
  overdue?: boolean;
  empty?: string;
}

export function TaskList({ title, rows, tapped, blocked, onComplete, onOpenLink, overdue = false, empty }: Props) {
  if (rows.length === 0 && !empty) return null;
  return (
    <section className="group" aria-label={title}>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="tasks">
          {rows.map((row) => (
            <TaskRow key={row.key} row={row} tapped={tapped} blocked={blocked} overdue={overdue} onComplete={onComplete} onOpenLink={onOpenLink} />
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
  onOpenLink,
}: {
  row: Row;
  tapped: ReadonlySet<string>;
  blocked: boolean;
  overdue: boolean;
  onComplete: (t: TaskView) => void;
  onOpenLink: (link: OpenLink) => void;
}) {
  const { task, action } = row;
  const busy = action !== null && action.state !== 'attention' && action.state !== 'saved';
  const readOnly = task?.readOnlyReason ?? null;
  const canComplete = !row.done && task !== null && readOnly === null && !blocked && !busy && !tapped.has(task.locator.lineText);
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
                    onClick={() => onOpenLink({ task, linkIndex: seg.linkIndex, label: seg.text })}
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
        {action?.state === 'attention' && action.error && <span className="error">{action.error.message}</span>}
      </div>
    </li>
  );
}
