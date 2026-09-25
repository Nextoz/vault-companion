// A task list the server will not write (TasksResponse.writeBlock): Git conflict markers or a broken structure.
// While it is set every task-list mutation would be refused, so the app offers none — no completion, no Undo, no task
// capture. Notes still work: CaptureNote never touches the task list.
//
// During a committed conflict the read still lists the lines between the markers as tasks (both sides, possibly a
// done copy too), and the response does not say which lines those are. So no listed task is presented as actionable:
// the lists are shown as last read, marked as such.
import type { TasksResponse } from '@vault-companion/contracts';

export interface TaskListLock {
  /** The banner that leads the screen. */
  banner: string;
  /** Git conflict markers: the listed tasks may include both sides. */
  conflict: boolean;
}

export const CONFLICT_BANNER = 'Your task list has a sync conflict — resolve it in Obsidian on your computer.';
export const FROZEN_NOTE = "Tasks are shown as last read and may include both sides of the conflict. They can't be changed here until it is resolved.";

export function taskListLock(read: Pick<TasksResponse, 'writeBlock'> | null): TaskListLock | null {
  const block = read?.writeBlock ?? null;
  if (!block) return null;
  const conflict = block.code === 'refused:vault-conflict';
  return { banner: conflict ? CONFLICT_BANNER : block.message, conflict };
}
