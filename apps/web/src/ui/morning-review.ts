// NY2: the guided morning review's pure core - the four steps, the calendar projection, and the max-3 pick rule.
// Nothing here writes: the sheet mints the EXISTING EditTask command (scheduled = today) through the normal queue.
import type { TaskView } from '@vault-companion/contracts';
import { occurrenceKey } from '../view.ts';
import type { BriefLine } from './morning-card.ts';

/** The owner walks these in order; `done` is the post-confirm summary, not another form. */
export const REVIEW_STEPS = ['calendar', 'needs', 'pick', 'done'] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];

/** At most three Today tasks, counting the ones already scheduled today. */
export const MAX_PICKS = 3;

/** Honest empty states - the sheet renders these instead of inventing data. */
export const NO_CALENDAR = 'No calendar data today';
export const NOTHING_NEEDS_YOU = 'Nothing needs you';
export const NO_OPEN_TASKS = 'No open tasks';

/** The next step; the last (done) stays put. */
export function nextStep(step: ReviewStep): ReviewStep {
  const i = REVIEW_STEPS.indexOf(step);
  return REVIEW_STEPS[Math.min(i + 1, REVIEW_STEPS.length - 1)] as ReviewStep;
}

/** The previous step; the first (calendar) stays put. */
export function prevStep(step: ReviewStep): ReviewStep {
  const i = REVIEW_STEPS.indexOf(step);
  return REVIEW_STEPS[Math.max(i - 1, 0)] as ReviewStep;
}

/**
 * Step 1's lines: the brief's day line and its free-block rows ("gap-…"), in the brief's own order. No usable
 * brief for today reads as the single honest empty line, never a made-up schedule. Pure.
 */
export function calendarLines(brief: readonly BriefLine[] | null): readonly string[] {
  if (brief === null) return [NO_CALENDAR];
  const lines = brief.filter((line) => line.id === 'day' || line.id.startsWith('gap-')).map((line) => line.text);
  return lines.length > 0 ? lines : [NO_CALENDAR];
}

/** A pickable task row: `alreadyToday` rows are shown but can never be picked again (no duplicate schedule). */
export interface PickRow {
  readonly id: string;
  readonly text: string;
  readonly task: TaskView;
  readonly alreadyToday: boolean;
}

/** Step 3's rows: every open task, flagging the ones already scheduled today. Pure; order follows the read. */
export function pickRows(open: readonly TaskView[], today: string): PickRow[] {
  return open.map((task) => ({
    id: occurrenceKey(task.locator),
    text: task.description,
    task,
    alreadyToday: task.scheduled === today,
  }));
}

const idSet = (marked: ReadonlySet<string> | readonly string[]): Set<string> =>
  marked instanceof Set ? new Set(marked) : new Set(marked);

/** Today's plan so far: an already-scheduled row and each marked row take one of the three slots. */
export function plannedCount(rows: readonly PickRow[], marked: ReadonlySet<string> | readonly string[]): number {
  const set = idSet(marked);
  return rows.filter((row) => row.alreadyToday || set.has(row.id)).length;
}

/** The owner's own picks (never the already-today rows), for the counter and the Confirm write. */
export function pickedTasks(rows: readonly PickRow[], marked: ReadonlySet<string> | readonly string[]): TaskView[] {
  const set = idSet(marked);
  return rows.filter((row) => !row.alreadyToday && set.has(row.id)).map((row) => row.task);
}

/** "2 of 3": the whole plan, capped at three so a fourth never reads as room for more. */
export function pickCounter(rows: readonly PickRow[], marked: ReadonlySet<string> | readonly string[]): string {
  return `${Math.min(plannedCount(rows, marked), MAX_PICKS)} of ${MAX_PICKS}`;
}

/** True only for an eligible row that fits: an already-today or unpickable row is never a candidate. */
export function canPick(rows: readonly PickRow[], marked: ReadonlySet<string> | readonly string[], id: string): boolean {
  const row = rows.find((r) => r.id === id);
  if (!row || row.alreadyToday) return false;
  if (idSet(marked).has(id)) return false;
  return plannedCount(rows, marked) < MAX_PICKS;
}

/** Toggle a pick: unmarking always works; marking past the cap or for an already-today row is a no-op. */
export function togglePick(
  rows: readonly PickRow[],
  marked: ReadonlySet<string> | readonly string[],
  id: string,
): ReadonlySet<string> {
  const set = idSet(marked);
  if (set.has(id)) {
    set.delete(id);
    return set;
  }
  if (!canPick(rows, set, id)) return set;
  set.add(id);
  return set;
}
