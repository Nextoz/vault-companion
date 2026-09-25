// Screen model: the last server read plus the optimistic overlay of queued actions (brief F, commands.md F10).
//
// - A completion that is pending, saving, or saved-but-not-yet-in-the-read moves the task to Done today.
// - A completion that needs attention leaves the task where the server has it, carrying the error.
// - A live Undo shows the task open again, carrying its state.
// - A saved action stops overlaying once a read has said its commit is `included` (then it is acknowledged).
import type { TaskView, TasksResponse } from '@vault-companion/contracts';
import type { QueueItem } from './queue/queue.ts';

export interface Row {
  key: string;
  description: string;
  /** The live server task; null for an overlay row reconstructed from a queued action. */
  task: TaskView | null;
  done: boolean;
  /** The latest queued action on this task, if any. */
  action: QueueItem | null;
}

export interface ScreenView {
  overdue: Row[];
  today: Row[];
  all: Row[];
  doneToday: Row[];
}

const isTaskAction = (i: QueueItem) => i.type === 'CompleteTask' || i.type === 'UndoCompleteTask';

export function buildView(tasks: TasksResponse | null, items: readonly QueueItem[]): ScreenView {
  const reflected = (i: QueueItem) =>
    i.state === 'saved' &&
    i.receipt !== null &&
    (i.acknowledged || tasks?.known[i.receipt.commitSha] === 'included');
  /** Still ahead of the server read: pending, saving, or saved-but-not-included. */
  const live = (i: QueueItem) => i.state !== 'attention' && !reflected(i);

  // Items arrive in seq order, so the last write per task key is the user's latest intent.
  const latest = new Map<string, QueueItem>();
  const completedLine = new Map<string, QueueItem>();
  for (const item of items) {
    if (!isTaskAction(item) || item.taskKey === null) continue;
    latest.set(item.taskKey, item);
    if (item.receipt?.effect.kind === 'completed') completedLine.set(item.receipt.effect.completedLineText, item);
  }

  const row = (t: TaskView, action: QueueItem | null, done = false): Row => ({
    key: `${t.locator.lineIndex}:${t.locator.lineText}`,
    description: t.description,
    task: t,
    done,
    action,
  });
  const overlay = (a: QueueItem, done: boolean): Row => ({
    key: `op:${a.operationId}`,
    description: a.label,
    task: null,
    done,
    action: a,
  });

  const openRow = (t: TaskView): Row | null => {
    const a = latest.get(t.locator.lineText) ?? null;
    if (a?.type === 'CompleteTask' && live(a)) return null;
    return row(t, a);
  };
  const openRows = (list: readonly TaskView[]) => list.map(openRow).filter((r): r is Row => r !== null);

  const view: ScreenView = {
    overdue: openRows(tasks?.overdue ?? []),
    today: openRows(tasks?.todayTasks ?? []),
    all: openRows(tasks?.allOpen ?? []),
    doneToday: [],
  };

  const serverOpen = new Set((tasks?.allOpen ?? []).map((t) => t.locator.lineText));
  const reopened: Row[] = [];
  for (const [key, a] of latest) {
    if (!live(a)) continue;
    if (a.type === 'CompleteTask') view.doneToday.push(overlay(a, true));
    else if (!serverOpen.has(key)) reopened.push(overlay(a, false));
  }
  view.today.unshift(...reopened);
  view.all.unshift(...reopened);

  for (const t of tasks?.doneToday ?? []) {
    const completion = completedLine.get(t.locator.lineText);
    const a = completion?.taskKey ? (latest.get(completion.taskKey) ?? null) : null;
    // A live completion already has its overlay row; a live Undo shows the task re-opened.
    if (a && live(a)) continue;
    view.doneToday.push(row(t, a, true));
  }

  return view;
}
