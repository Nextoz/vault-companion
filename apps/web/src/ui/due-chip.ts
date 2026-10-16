// Redesign R5 (quick win b): a task's due state as one short chip on the title line, not an ISO date on a second line.
// Pure: both dates are YYYY-MM-DD in the same zone, so whole days are counted on UTC midnights.

export interface DueChip {
  readonly text: string;
  readonly tone: 'over' | 'today' | 'soon';
}

const DAY_MS = 86_400_000;
const utcDay = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

/** "Today", "3d late", "Tomorrow", "in 5d"; null when there is no (valid) due date. */
export function dueChip(due: string | null | undefined, today: string): DueChip | null {
  if (!due) return null;
  const days = Math.round((utcDay(due) - utcDay(today)) / DAY_MS);
  if (!Number.isFinite(days)) return null;
  if (days === 0) return { text: 'Today', tone: 'today' };
  if (days < 0) return { text: `${-days}d late`, tone: 'over' };
  if (days === 1) return { text: 'Tomorrow', tone: 'soon' };
  return { text: `in ${days}d`, tone: 'soon' };
}
