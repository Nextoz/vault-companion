import type { CompleteTaskCommand, TaskView } from '@vault-companion/contracts';
import { UNRESOLVED_TEXT } from '../attention.ts';
import { plainWikilinks, readOnlyText, taskSegments } from '../text.ts';
import { occurrenceKey, type Row } from '../view.ts';
import { attentionText } from './ActionsPanel.tsx';
import { CalendarGlyph } from './CalendarSheet.tsx';
import { taskCalendarKey } from './calendar-sheet.ts';
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
  onEdit?: (task: TaskView) => void;
  onOpenLink: (link: OpenLink) => void;
  /** Undo a saved app completion from its Done today row (P4-B); rows without `undo` offer none. */
  onUndo?: (target: CompleteTaskCommand, label: string) => void;
  overdue?: boolean;
  empty?: string;
  /** The task list has a sync conflict: rows are shown as last read, not as actionable tasks (writeBlock.ts). */
  frozen?: boolean;
  /** A group that starts collapsed behind a summary such as "3 overdue" (ADR-0012). */
  collapsible?: { open: boolean; summary: string; onToggle: () => void };
  /** CAL-b: item keys already linked to a Google event; absent means no calendar affordance is shown. */
  calendarLinks?: ReadonlySet<string>;
  /** CAL-b: open the Add to Calendar / In Calendar sheet for a row. */
  onCalendar?: (task: TaskView) => void;
}

export function TaskList({
  title,
  rows,
  tapped,
  blocked,
  onComplete,
  onEdit,
  onUndo,
  onOpenLink,
  overdue = false,
  empty,
  frozen = false,
  collapsible,
  calendarLinks,
  onCalendar,
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
              onEdit={onEdit}
              onUndo={onUndo}
              onOpenLink={onOpenLink}
              calendarLinks={calendarLinks}
              onCalendar={onCalendar}
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
  onEdit,
  onUndo,
  onOpenLink,
  calendarLinks,
  onCalendar,
}: {
  row: Row;
  tapped: ReadonlySet<string>;
  blocked: boolean;
  overdue: boolean;
  onComplete: (t: TaskView) => void;
  onUndo: Props['onUndo'];
  onEdit: Props['onEdit'];
  onOpenLink: (link: OpenLink) => void;
  calendarLinks: Props['calendarLinks'];
  onCalendar: Props['onCalendar'];
}) {
  const { task, action, undo } = row;
  const busy = action !== null && action.state !== 'attention' && (action.state !== 'saved' || action.type === 'EditTask');
  const readOnly = task?.readOnlyReason ?? null;
  const canComplete =
    !row.done && task !== null && readOnly === null && !blocked && !busy && !tapped.has(occurrenceKey(task.locator));
  // ADR-0017: open tasks only; recurring/on-completion tasks are editable (no completion semantics involved).
  const canEdit = !row.done && task !== null && !blocked && !busy && onEdit !== undefined &&
    (readOnly === null || readOnly === 'refused:recurring' || readOnly === 'refused:on-completion');
  const text = plainWikilinks(row.description);
  // A description made only of wikilinks has no text segment to tap: offer a named Edit button instead (CodeRabbit #26).
  const textTappable = task !== null && taskSegments(row.description, task.links).some((seg) => seg.kind === 'text' && seg.text.trim() !== '');
  // CAL-b: the link state is read from the item key; the key itself is stable for the read's locator.
  const calendarKey = task ? taskCalendarKey(task.locator) : null;
  const inCalendar = calendarKey !== null && (calendarLinks?.has(calendarKey) ?? false);

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
          {task === null || action?.type === 'EditTask'
            ? text
            : taskSegments(row.description, task.links).map((seg, i) =>
                seg.kind === 'text' ? (
                  canEdit ? (
                    <button key={i} type="button" className="task-edit" aria-label={`Edit: ${text}`} onClick={() => onEdit?.(task)}>{seg.text}</button>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  )
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
          {canEdit && !textTappable && task && (
            <button type="button" className="task-edit-link" aria-label={`Edit: ${text}`} onClick={() => onEdit?.(task)}>
              Edit
            </button>
          )}
          {!row.done && task && onCalendar && (
            inCalendar ? (
              <button type="button" className="calendar-link" aria-label={`In Calendar: ${text}`} onClick={() => onCalendar(task)}>
                In Calendar
              </button>
            ) : (
              <button type="button" className="calendar-glyph" aria-label={`Add to Calendar: ${text}`} onClick={() => onCalendar(task)}>
                <CalendarGlyph />
              </button>
            )
          )}
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
