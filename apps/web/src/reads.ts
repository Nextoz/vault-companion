// Ordering and evidence for task reads (commands.md F10, gate rerun N3).
//
// - Reads can overlap and their responses can arrive out of order: a response older than the newest one already
//   applied is dropped, so a late stale read never replaces a newer screen.
// - Every retained receipt is asked about on every read, acknowledged or not: whether the screen reflects a saved
//   action is decided by the `known` map of the response being rendered. Acknowledgement only permits eviction.
import type { QueueItem } from './queue/queue.ts';

/** The Worker answers at most this many `known=` commits (apps/worker `GET /api/tasks`). */
export const MAX_KNOWN = 50;

export class ReadSequencer {
  #issued = 0;
  #applied = 0;

  /** Call as a read starts; pass the ticket to `accept` when its response (of any kind) arrives. */
  begin(): number {
    return ++this.#issued;
  }

  /** True if this response is newer than every response applied so far; it then becomes the newest. */
  accept(ticket: number): boolean {
    if (ticket <= this.#applied) return false;
    this.#applied = ticket;
    return true;
  }
}

/**
 * The commits of retained receipts, unacknowledged first (they still gate eviction), newest first within each.
 * A commit beyond the Worker's limit gets no answer, and an unanswered receipt keeps overlaying: the safe side.
 */
export function knownCommits(items: readonly QueueItem[]): string[] {
  const saved = items.filter((i) => i.receipt !== null);
  const ordered = [
    ...saved.filter((i) => !i.acknowledged).reverse(),
    ...saved.filter((i) => i.acknowledged).reverse(),
  ];
  return [...new Set(ordered.map((i) => i.receipt?.commitSha ?? ''))].slice(0, MAX_KNOWN);
}
