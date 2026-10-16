import type { CompleteTaskCommand, TaskView } from '@vault-companion/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import { UNRESOLVED_TEXT } from '../attention.ts';
import { plainWikilinks, readOnlyText, taskSegments } from '../text.ts';
import { occurrenceKey, type Row } from '../view.ts';
import { attentionText } from './ActionsPanel.tsx';
import { CalendarGlyph } from './CalendarSheet.tsx';
import { taskCalendarKey } from './calendar-sheet.ts';
import type { OpenLink } from './NoteView.tsx';
import { duration, easing, play, prefersReducedMotion } from './motion.ts';
import { dueChip } from './due-chip.ts';
import { copenhagenDay } from '../triage.ts';
import { StateChip } from './StateChip.tsx';

/**
 * R2 (review #3): the done moment. The tapped ring fills, the tick draws, the text is struck through, and after a
 * hold the row folds away while it unfolds in Done today. The write is not delayed: the completion is queued on the
 * tap exactly as before (and the checkbox disabled synchronously); only the leaving row is kept on screen, inert, for
 * the hold and the fold. Under reduced motion the change is instant with a short fade.
 */
const justCompleted = new Map<string, number>();
/** The task occurrence a row is about: Done today rows are queue overlays keyed by operation, so ask their envelope. */
function occurrenceOf(row: Row): string | null {
  const envelope = row.action?.envelope;
  if (envelope?.type === 'CompleteTask') return occurrenceKey(envelope.payload.task);
  return row.task ? occurrenceKey(row.task.locator) : null;
}
const tappedAt = (row: Row) => { const key = occurrenceOf(row); return key === null ? undefined : justCompleted.get(key); };
/** ms: a Done today row that appears longer than this after its tap is a read, not this tap: it does not unfold. */
const ARRIVAL_WINDOW = 3000;

interface Leaving {
  row: Row;
  index: number;
  animation: Animation | null;
}

/** A row's full box and its folded box, for animating height (with padding, border and margin) to and from 0. */
function boxFrames(el: HTMLElement): { full: Keyframe; folded: Keyframe } {
  const cs = getComputedStyle(el);
  const full: Keyframe = {
    height: `${el.getBoundingClientRect().height}px`, opacity: 1, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
    borderTopWidth: cs.borderTopWidth, marginTop: cs.marginTop, marginBottom: cs.marginBottom,
  };
  const folded: Keyframe = { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', marginTop: '0px', marginBottom: '0px' };
  return { full, folded };
}

/** Clip and size by the border box while folding, so the measured height is the animated height. */
function clip(el: HTMLElement, on: boolean) {
  el.style.overflow = on ? 'hidden' : '';
  el.style.boxSizing = on ? 'border-box' : '';
}

/** A done row (or a whole Done today group) unfolds into place once the tapped row has had its hold. */
function arrive(el: HTMLElement, delay: number) {
  if (prefersReducedMotion()) {
    play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: duration('--dur-fade'), easing: 'linear' });
    return;
  }
  const { full, folded } = boxFrames(el);
  clip(el, true);
  const { done } = play(el, [folded, full], { duration: duration('--dur-base'), delay, easing: easing('--ease-ui'), fill: 'backwards' });
  void done.then(() => clip(el, false));
}

/** Live rows plus the rows still leaving (no longer in `rows`), each kept where it was. */
function withLeaving(rows: Row[], leaving: ReadonlyMap<string, Leaving>): Row[] {
  const live = new Set(rows.map((r) => r.key));
  const shown = [...rows];
  [...leaving.entries()]
    .filter(([key]) => !live.has(key))
    .sort(([, a], [, b]) => a.index - b.index)
    .forEach(([, entry]) => shown.splice(Math.min(entry.index, shown.length), 0, entry.row));
  return shown;
}

/** The done mark: a green disc that fills from the centre and a tick drawn by `stroke-dashoffset` (motion.css). */
export function CheckMark() {
  return (
    <svg className="check-mark" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <circle className="check-fill" cx="11" cy="11" r="11" />
      <path className="check-tick" d="M6.5 11.5l3.1 3.1 5.9-6.4" pathLength={1} />
    </svg>
  );
}

interface Props {
  title: string;
  rows: Row[];
  /** Occurrence keys of tapped checkboxes (`occurrenceKey`). */
  tapped: ReadonlySet<string>;
  /** No completion from this list (Done today, or the file is write-blocked). */
  blocked: boolean;
  /**
   * Queues the completion. `false` (at once) means it was refused before anything was queued; a promise settles to
   * whether the write was kept. The done moment plays only for an accepted completion and is undone if it fails.
   */
  onComplete: (task: TaskView) => boolean | Promise<boolean>;
  onEdit?: (task: TaskView) => void;
  onOpenLink: (link: OpenLink) => void;
  /** Undo a saved app completion from its Done today row (P4-B); rows without `undo` offer none. */
  onUndo?: (target: CompleteTaskCommand, label: string) => void;
  /** Kept for callers; the due chip now derives overdue from the date itself. */
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
  empty,
  frozen = false,
  collapsible,
  calendarLinks,
  onCalendar,
}: Props) {
  const [leaving, setLeaving] = useState<ReadonlyMap<string, Leaving>>(() => new Map());
  const live = useRef(new Set<string>());
  const departed = useRef(new Set<string>());
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const section = useRef<HTMLElement>(null);
  const sectionWasShown = useRef(false);
  const visible = withLeaving(rows, leaving);

  const drop = (key: string) => {
    departed.current.delete(key);
    setLeaving((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  };

  // The tapped row holds, then folds; the write was already queued by onComplete (`kept` says whether it was kept).
  const startLeaving = (row: Row, li: HTMLLIElement, kept: Promise<boolean>) => {
    const occurrence = occurrenceOf(row);
    if (occurrence !== null) justCompleted.set(occurrence, performance.now());
    const index = visible.findIndex((r) => r.key === row.key);
    let motion: ReturnType<typeof play>;
    if (prefersReducedMotion()) {
      motion = play(li, [{ opacity: 1 }, { opacity: 0 }], { duration: duration('--dur-fade'), easing: 'linear', fill: 'forwards' });
    } else {
      const { full, folded } = boxFrames(li);
      clip(li, true);
      motion = play(li, [full, folded], {
        duration: duration('--dur-base'), delay: duration('--dur-hold'), easing: easing('--ease-ui'), fill: 'forwards',
      });
    }
    setLeaving((prev) => new Map(prev).set(row.key, { row, index: Math.max(index, 0), animation: motion.animation }));
    void kept.then((ok) => {
      if (ok) return;
      // The completion could not be kept on the device: the row stays, whole, as it was.
      if (occurrence !== null) justCompleted.delete(occurrence);
      motion.animation?.cancel();
      clip(li, false);
      drop(row.key);
    });
    void motion.done.then(() => {
      // Still a live row after the fold (an unusually slow write): show it again, whole.
      if (live.current.has(row.key)) {
        motion.animation?.cancel();
        clip(li, false);
      }
      drop(row.key);
    });
  };

  useLayoutEffect(() => {
    const keys = new Set(rows.map((r) => r.key));
    live.current = keys;
    for (const [key, entry] of leaving) {
      if (!keys.has(key)) departed.current.add(key);
      else if (departed.current.has(key)) {
        // Back before its fold ended (Undo): it stays, whole.
        entry.animation?.cancel();
        const el = rowEls.current.get(key);
        if (el) clip(el, false);
        drop(key);
      }
    }
    // Rows just completed elsewhere on this screen unfold here once the tapped row has had its hold.
    const now = performance.now();
    const arriving = rows.filter((r) => r.done && now - (tappedAt(r) ?? -Infinity) < ARRIVAL_WINDOW);
    if (arriving.length > 0) {
      const delayOf = (r: Row) => prefersReducedMotion() ? 0 : Math.max(0, duration('--dur-hold') - (now - (tappedAt(r) ?? now)));
      const first = arriving[0];
      if (!sectionWasShown.current && section.current && first && arriving.length === rows.length) arrive(section.current, delayOf(first));
      else arriving.forEach((r) => { const el = rowEls.current.get(r.key); if (el) arrive(el, delayOf(r)); });
      arriving.forEach((r) => { const key = occurrenceOf(r); if (key !== null) justCompleted.delete(key); });
    }
    sectionWasShown.current = section.current !== null;
  }, [rows, leaving]);

  if (visible.length === 0 && !empty) return null;
  const shown = collapsible?.open ?? true;
  return (
    <section ref={section} className={frozen ? 'group group-frozen' : 'group'} aria-label={title}>
      {collapsible ? (
        <h2>
          <button type="button" className="link group-toggle" aria-expanded={collapsible.open} onClick={collapsible.onToggle}>
            {collapsible.summary}
          </button>
        </h2>
      ) : (
        <h2>{title}</h2>
      )}
      {!shown ? null : visible.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="tasks">
          {visible.map((row) => (
            <TaskRow
              key={row.key}
              row={row}
              leaving={leaving.has(row.key)}
              onLeaving={startLeaving}
              liRef={(el) => { if (el) rowEls.current.set(row.key, el); else rowEls.current.delete(row.key); }}
              tapped={tapped}
              blocked={blocked}
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
  leaving,
  onLeaving,
  liRef,
  tapped,
  blocked,
  onComplete,
  onEdit,
  onUndo,
  onOpenLink,
  calendarLinks,
  onCalendar,
}: {
  row: Row;
  /** Tapped done here and on its way out: the done moment plays, the row is inert. */
  leaving: boolean;
  onLeaving: (row: Row, li: HTMLLIElement, kept: Promise<boolean>) => void;
  liRef: (el: HTMLLIElement | null) => void;
  tapped: ReadonlySet<string>;
  blocked: boolean;
  onComplete: Props['onComplete'];
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
  const chip = task && !row.done ? dueChip(task.due, copenhagenDay(new Date().toISOString())) : null;
  const inCalendar = calendarKey !== null && (calendarLinks?.has(calendarKey) ?? false);

  return (
    <li ref={liRef} className={`task${row.done ? ' task-done' : ''}${leaving ? ' task-leaving' : ''}`} data-testid="task" inert={leaving}>
      {leaving ? (
        <span className="check check-done-now" aria-hidden="true"><CheckMark /></span>
      ) : canComplete ? (
        <button
          type="button"
          className="check"
          aria-label={`Complete: ${text}`}
          onClick={(e) => {
            e.currentTarget.disabled = true; // synchronous: a second tap cannot mint a second envelope
            const li = e.currentTarget.closest('li');
            const accepted = onComplete(task);
            if (accepted !== false && li) onLeaving(row, li, Promise.resolve(accepted));
          }}
        />
      ) : (
        <span className={`check check-static${row.done ? ' check-on' : ''}`} aria-hidden="true">{row.done && <CheckMark />}</span>
      )}
      <div className="task-body">
        <span className="task-title-line">
        <span className="task-text">
          {leaving ? <span className="task-strike">{text}</span> : task === null || action?.type === 'EditTask'
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
        <span className="task-trail">
        {chip && <span className={`due due-${chip.tone}`} data-testid="due-chip">{chip.text}</span>}
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
        </span>
        <span className="task-meta">
          {readOnly && <span className="readonly">{readOnlyText(readOnly)}</span>}
          {action && <StateChip state={action.state} />}
          {canEdit && !textTappable && task && (
            <button type="button" className="task-edit-link" aria-label={`Edit: ${text}`} onClick={() => onEdit?.(task)}>
              Edit
            </button>
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
