// Completion history (ADR-0021): day grouping and which rows may Reopen through the existing Undo (ADR-0013).
import type { CompleteTaskCommand, HistoryItem } from '@vault-companion/contracts';
import type { QueueItem } from './queue/queue.ts';

export interface HistoryDay {
  date: string;
  heading: string;
  items: HistoryItem[];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sat 26 Sep" for a Markdown date as written: calendar arithmetic only, never the device time zone. */
export function dayHeading(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Consecutive items with one date form a day; the server already sorts newest first. */
export function groupByDay(items: readonly HistoryItem[]): HistoryDay[] {
  const days: HistoryDay[] = [];
  for (const item of items) {
    const last = days.at(-1);
    if (last?.date === item.doneDate) last.items.push(item);
    else days.push({ date: item.doneDate, heading: dayHeading(item.doneDate), items: [item] });
  }
  return days;
}

export type Reopen = { kind: 'undo'; target: CompleteTaskCommand } | { kind: 'reopening' } | { kind: 'obsidian' };

/**
 * A To-Do item this device completed and still holds the receipt for may Reopen via Undo. As in Done today, a done
 * line and a receipt pair only when each is the only one with that text; an Undo already queued shows as reopening.
 */
export function reopenFor(item: HistoryItem, all: readonly HistoryItem[], queued: readonly QueueItem[], accountKey: string | null): Reopen {
  if (item.source !== 'todo' || accountKey === null) return { kind: 'obsidian' };
  const text = item.locator.lineText;
  const candidates = queued.filter((i) => i.type === 'CompleteTask' && i.receipt?.effect.kind === 'completed' && i.receipt.effect.completedLineText === text);
  const [completion] = candidates;
  const twins = all.filter((h) => h.source === 'todo' && h.locator.lineText === text).length;
  if (!completion || candidates.length !== 1 || twins !== 1 || completion.accountKey !== accountKey || completion.envelope.type !== 'CompleteTask') {
    return { kind: 'obsidian' };
  }
  const undone = queued.some((i) => i.envelope.type === 'UndoCompleteTask' && i.envelope.payload.target.operationId === completion.operationId);
  return undone ? { kind: 'reopening' } : { kind: 'undo', target: completion.envelope };
}
