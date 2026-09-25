// Screen model: the last server read plus the optimistic overlay of queued actions (brief F, commands.md F10).
//
// - A completion that is pending, saving, or saved-but-not-yet-in-the-read moves the task to Done today.
// - A completion that needs attention leaves the task where the server has it, carrying the error.
// - A live Undo shows the task open again, carrying its state.
// - A saved action stops overlaying only while the read being rendered says its commit is `included`. A receipt's
//   `acknowledged` flag is not consulted: a later read that says `not-included` (or does not answer) overlays again
//   (gate rerun N3). Acknowledgement only lets the queue evict the receipt.
//
// Identity (P4-B): identical task lines are different tasks. An action belongs to the row its envelope's locator
// names — never to "the task with this text". Against a read of another blob the locator is resolved the way the
// server resolves it (vault-contract §3): only a unique line with identical text, and only if it was unique when
// read. When that cannot tell which row an action belongs to, the action gets a row of its own and no task is hidden.
import type { CompleteTaskCommand, TaskLocator, TaskView, TasksResponse } from '@vault-companion/contracts';
import type { QueueItem } from './queue/queue.ts';

export interface Row {
  key: string;
  description: string;
  /** The live server task; null for an overlay row reconstructed from a queued action. */
  task: TaskView | null;
  done: boolean;
  /** The latest queued action on this task, if any. */
  action: QueueItem | null;
  /** The saved app completion this Done today row can undo (its receipt is still on the device); else null. */
  undo: CompleteTaskCommand | null;
}

export interface ScreenView {
  overdue: Row[];
  today: Row[];
  all: Row[];
  doneToday: Row[];
}

/**
 * One task occurrence as a read saw it: the queue's per-task FIFO key and the tap-guard key. Two identical lines
 * in one read differ by index; the same line in two reads may differ by blob, and ordering between those is left
 * to the server's locator check and the Undo dependency.
 */
export function occurrenceKey(locator: TaskLocator): string {
  return `${locator.blobSha}:${locator.lineIndex}:${locator.lineText}`;
}

const isTaskAction = (i: QueueItem) => i.type === 'CompleteTask' || i.type === 'UndoCompleteTask';

/** The open line an action is about: a completion's task, or the task an Undo re-opens. */
function locatorOf(item: QueueItem): TaskLocator | null {
  const e = item.envelope;
  if (e.type === 'CompleteTask') return e.payload.task;
  if (e.type === 'UndoCompleteTask') return e.payload.target.payload.task;
  return null;
}

type Match = { kind: 'row'; task: TaskView } | { kind: 'none' } | { kind: 'ambiguous' };

/** Which open row `locator` names in this read, by the server's resolution rule; never a guess. */
function resolve(locator: TaskLocator, open: readonly TaskView[]): Match {
  const exact = open.find(
    (t) =>
      t.locator.blobSha === locator.blobSha &&
      t.locator.lineIndex === locator.lineIndex &&
      t.locator.lineText === locator.lineText,
  );
  if (exact) return { kind: 'row', task: exact };
  const same = open.filter((t) => t.locator.lineText === locator.lineText);
  if (same.length === 0) return { kind: 'none' };
  const [only] = same;
  return same.length === 1 && only && locator.occurrencesAtRead === 1 ? { kind: 'row', task: only } : { kind: 'ambiguous' };
}

export function buildView(
  tasks: TasksResponse | null,
  items: readonly QueueItem[],
  /** The confirmed session's account: only its own saved completions can be undone from Done today. */
  accountKey: string | null = null,
): ScreenView {
  const reflected = (i: QueueItem) =>
    i.state === 'saved' && i.receipt !== null && tasks?.known[i.receipt.commitSha] === 'included';
  /** Still ahead of the server read: pending, saving, or saved-but-not-included. */
  const live = (i: QueueItem) => i.state !== 'attention' && !reflected(i);

  // Items arrive in seq order, so the last action per occurrence is the user's latest intent. An Undo shares its
  // completion's occurrence (it names the completion's locator).
  const latest = new Map<string, QueueItem>();
  const byId = new Map<string, QueueItem>();
  for (const item of items) {
    if (!isTaskAction(item)) continue;
    const locator = locatorOf(item);
    if (!locator) continue;
    latest.set(occurrenceKey(locator), item);
    byId.set(item.operationId, item);
  }

  const allOpen = tasks?.allOpen ?? [];
  // A write-blocked list refuses every mutation, Undo included (writeBlock.ts).
  const writable = !tasks?.writeBlock;
  const rowKey = (t: TaskView) => `${t.locator.lineIndex}:${t.locator.lineText}`;
  const row = (t: TaskView, action: QueueItem | null, done = false, undo: CompleteTaskCommand | null = null): Row => ({
    key: rowKey(t),
    description: t.description,
    task: t,
    done,
    action,
    undo,
  });
  const overlay = (a: QueueItem, done: boolean): Row => ({
    key: `op:${a.operationId}`,
    description: a.label,
    task: null,
    done,
    action: a,
    undo: null,
  });

  // Each action (latest per occurrence) attached to the open row it names; a later action wins a shared row.
  const onRow = new Map<string, QueueItem>();
  const ownOpen: Row[] = [];
  const ownDone: Row[] = [];
  for (const a of [...latest.values()].sort((x, y) => x.seq - y.seq)) {
    const locator = locatorOf(a);
    if (!locator) continue;
    if (a.type === 'CompleteTask') {
      const match = resolve(locator, allOpen);
      if (match.kind === 'row') onRow.set(rowKey(match.task), a);
      if (live(a)) ownDone.push(overlay(a, true));
      // A refusal that no single row can carry is shown on its own; one whose task is gone lives in Actions.
      else if (a.state === 'attention' && match.kind === 'ambiguous') ownOpen.push(overlay(a, false));
      continue;
    }
    if (!live(a)) continue;
    // A live Undo: its completion is in the read (or its receipt was evicted under the watermark, so it is), so
    // the line it re-opens cannot be open in the read yet: its own row. Otherwise it may name a row still open.
    const target = byId.get(a.envelope.type === 'UndoCompleteTask' ? a.envelope.payload.target.operationId : '');
    const completionInRead = !target || reflected(target);
    const match = completionInRead ? ({ kind: 'none' } as const) : resolve(locator, allOpen);
    if (match.kind === 'row') onRow.set(rowKey(match.task), a);
    else ownOpen.push(overlay(a, false));
  }

  const openRow = (t: TaskView): Row | null => {
    const a = onRow.get(rowKey(t)) ?? null;
    if (a?.type === 'CompleteTask' && live(a)) return null;
    return row(t, a);
  };
  const openRows = (list: readonly TaskView[]) => list.map(openRow).filter((r): r is Row => r !== null);

  const view: ScreenView = {
    overdue: openRows(tasks?.overdue ?? []),
    today: [...ownOpen, ...openRows(tasks?.todayTasks ?? [])],
    all: [...ownOpen, ...openRows(allOpen)],
    doneToday: ownDone,
  };

  // Done today: a done line and a completion receipt are paired only when each is the only one with that text.
  const doneToday = tasks?.doneToday ?? [];
  const receipts = new Map<string, QueueItem[]>();
  for (const i of items) {
    if (i.type !== 'CompleteTask' || i.receipt?.effect.kind !== 'completed') continue;
    const text = i.receipt.effect.completedLineText;
    receipts.set(text, [...(receipts.get(text) ?? []), i]);
  }
  for (const t of doneToday) {
    const text = t.locator.lineText;
    const candidates = receipts.get(text) ?? [];
    const [completion] = candidates;
    const unique = candidates.length === 1 && doneToday.filter((d) => d.locator.lineText === text).length === 1;
    const locator = unique && completion ? locatorOf(completion) : null;
    const a = locator ? (latest.get(occurrenceKey(locator)) ?? null) : null;
    // A live completion already has its overlay row; a live Undo shows the task re-opened.
    if (a && live(a)) continue;
    const undoable =
      a !== null &&
      a === completion &&
      a.envelope.type === 'CompleteTask' &&
      accountKey !== null &&
      a.accountKey === accountKey &&
      writable;
    view.doneToday.push(row(t, a, true, undoable && a.envelope.type === 'CompleteTask' ? a.envelope : null));
  }

  return view;
}
