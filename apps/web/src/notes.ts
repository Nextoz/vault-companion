// Inbox notes (ADR-0022): the queue side of a note edit, kept out of the components so it can be tested.
import type { QueueItem } from './queue/queue.ts';

/** Edits of one note share a key, so the queue sends them one after another, never concurrently. */
export const noteTaskKey = (path: string) => `note:${path}`;

/** The newest queued edit of the note at `path` for this account, if any. */
export function latestNoteEdit(items: readonly QueueItem[], path: string, accountKey: string | null): QueueItem | null {
  let latest: QueueItem | null = null;
  for (const item of items) {
    if (item.envelope.type !== 'EditNote' || item.envelope.payload.note.path !== path || item.accountKey !== accountKey) continue;
    if (!latest || item.seq > latest.seq) latest = item;
  }
  return latest;
}

/**
 * Another edit may start only from a read that already contains the previous one: while an edit is on its way (or needs
 * attention), a second one would be based on the old blob and could only conflict.
 */
export function canStartEdit(latest: QueueItem | null, readBlobSha: string): boolean {
  if (!latest) return true;
  if (latest.state !== 'saved') return false;
  return latest.receipt?.blobSha === readBlobSha;
}
