// Ordering and evidence for task reads (commands.md F10, gate rerun N3, gate run 3 G3-1).
//
// - Reads can overlap and their responses can arrive out of order: a response older than the newest one already
//   applied is dropped, so a late stale read never replaces a newer screen.
// - Every retained receipt is asked about on every read, acknowledged or not: whether the screen reflects a saved
//   action is decided by the `known` map of the response being rendered. Acknowledgement only permits eviction.
// - Receipts evicted in any tab are covered by the shared watermark instead: a read is rendered only if it shows the
//   watermark commit `included`. One that does not is stale; the screen keeps the last good read, or says it is
//   refreshing. Every read asks about the watermark first.
import type { ActiveWorkResponse, TasksResponse } from '@vault-companion/contracts';
import type { Fetched } from './api.ts';
import type { Watermark } from './queue/db.ts';
import { satisfiesWatermark, type QueueItem } from './queue/queue.ts';

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

/** A read that passed the watermark current when it arrived. */
export interface RenderedRead {
  data: TasksResponse;
  /** The watermark version it was checked against (0: none yet). */
  watermarkVersion: number;
}

/**
 * Whether a read may stay on screen next to the queue snapshot. The snapshot's receipts and watermark are loaded
 * together, so a receipt missing from the snapshot is covered by a watermark at least this new. A read checked
 * against an older one may predate the evicted commits: it is not renderable, and must be re-read.
 */
export function renderable(read: RenderedRead, watermark: Watermark | null): boolean {
  return read.watermarkVersion >= (watermark?.version ?? 0);
}

export type ReadOutcome =
  | { kind: 'apply'; read: RenderedRead }
  /** A newer read's response was already applied. */
  | { kind: 'superseded' }
  /**
   * The read does not show the watermark included. `retry`: it was requested before that watermark existed (or
   * before this tab knew it), so a new read, which asks about it, can settle the question.
   */
  | { kind: 'stale'; retry: boolean }
  | Exclude<Fetched<TasksResponse>, { kind: 'ok' }>;

export interface TaskReadsDeps {
  getTasks(known: readonly string[]): Promise<Fetched<TasksResponse>>;
  /** Read from IndexedDB at the time of the call, not a cache: another tab may have just moved it. */
  watermark(): Promise<Watermark | null>;
  /** The commits of this tab's retained receipts (`knownCommits` of the queue snapshot). */
  receipts(): readonly string[];
}

/** The read path of `App.refreshTasks`: ordering and the watermark check, apart from React. */
export class TaskReads {
  readonly #deps: TaskReadsDeps;
  readonly #order = new ReadSequencer();

  constructor(deps: TaskReadsDeps) {
    this.#deps = deps;
  }

  async read(): Promise<ReadOutcome> {
    const ticket = this.#order.begin();
    const asked = await this.#deps.watermark();
    const known = [...new Set([...(asked ? [asked.commitSha] : []), ...this.#deps.receipts()])].slice(0, MAX_KNOWN);
    const res = await this.#deps.getTasks(known);
    const current = res.kind === 'ok' ? await this.#deps.watermark() : null;
    if (!this.#order.accept(ticket)) return { kind: 'superseded' };
    if (res.kind !== 'ok') return res;
    if (!satisfiesWatermark(res.data, current)) {
      return { kind: 'stale', retry: current?.commitSha !== asked?.commitSha };
    }
    return { kind: 'apply', read: { data: res.data, watermarkVersion: current?.version ?? 0 } };
  }
}

/**
 * What the Active Work card shows for a read. Quiet by design: loading, absent and failures never block the task lists;
 * an absent file hides the card, anything else shows one muted line.
 */
export type ActiveWorkState =
  | { kind: 'hidden' }
  | { kind: 'message'; text: string }
  | { kind: 'content'; markdown: string };

export function activeWorkState(res: Fetched<ActiveWorkResponse> | null): ActiveWorkState {
  if (res === null) return { kind: 'message', text: 'Loading…' };
  if (res.kind === 'offline') return { kind: 'message', text: 'Offline.' };
  if (res.kind !== 'ok') return { kind: 'message', text: 'Not available right now.' };
  switch (res.data.status) {
    case 'absent':
      return { kind: 'hidden' };
    case 'refused':
      return { kind: 'message', text: res.data.code === 'too-large' ? 'Too large to show here.' : 'Cannot be displayed.' };
    case 'ok':
      return { kind: 'content', markdown: res.data.markdown };
  }
}
