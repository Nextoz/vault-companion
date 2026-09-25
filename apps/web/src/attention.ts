// A discarded action is not a resolved task (P4-B, owner addendum). Discarding a refused completion only removes the
// action from this device; the task itself still needs the user. The app keeps saying so — on the task's row, or on
// its own when no single row is the task — until a fresh read shows the task changed state (it is no longer open where
// the action named it: done, edited or removed) or the user redoes the action on it.
//
// Kept in memory for this app session: after a reload the task simply shows as open, which is the honest state.
import type { CompleteTaskCommand, TaskLocator, TaskView, TasksResponse } from '@vault-companion/contracts';
import { resolve } from './view.ts';

export interface Unresolved {
  /** The discarded action. */
  operationId: string;
  locator: TaskLocator;
  label: string;
  /** Revision of the read on screen when it was discarded; null if none. A read of another revision is fresh. */
  revision: string | null;
}

export const UNRESOLVED_TEXT = 'Not completed — this task still needs attention.';

export function unresolvedFrom(envelope: CompleteTaskCommand, label: string, read: Pick<TasksResponse, 'revision'> | null): Unresolved {
  return { operationId: envelope.operationId, locator: envelope.payload.task, label, revision: read?.revision ?? null };
}

/** False once a fresh read no longer has the task open where the discarded action named it. */
export function stillUnresolved(u: Unresolved, read: Pick<TasksResponse, 'revision' | 'allOpen'> | null): boolean {
  if (read === null || read.revision === u.revision) return true;
  return resolve(u.locator, read.allOpen).kind !== 'none';
}

/** False when `task` (just redone by the user) is the task `u` names. */
export function notRedoneBy(u: Unresolved, task: TaskView, open: readonly TaskView[]): boolean {
  const match = resolve(u.locator, open);
  return !(match.kind === 'row' && match.task === task);
}
