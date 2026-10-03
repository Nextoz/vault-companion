// Log - Mood (UX5): recent mood/energy/sleep check-ins, newest first. Presentation only: it reads the check-ins the
// device already holds in its local queue (pending items and saved receipts). There is no server read for mood
// history, so anything evicted under the saved-actions watermark is simply not here.
import type { MoodCheckinPayload } from '@vault-companion/contracts';
import { dayHeading } from '../history.ts';
import type { QueueItem } from '../queue/queue.ts';
import { chipLabel } from './MoodCard.tsx';

/** How many check-ins the Log shows. */
export const MOOD_HISTORY_LIMIT = 14;

export interface MoodEntry {
  operationId: string;
  payload: MoodCheckinPayload;
}

/**
 * The newest check-ins this device still holds, newest first by `checkinAt`. An UndoMoodCheckin drops its target.
 * Only the queue items the app already has are read; never a new endpoint.
 */
export function recentCheckins(items: readonly QueueItem[], limit: number = MOOD_HISTORY_LIMIT): MoodEntry[] {
  const undone = new Set<string>();
  for (const item of items) {
    if (item.envelope.type === 'UndoMoodCheckin') undone.add(item.envelope.payload.target.operationId);
  }
  const entries: MoodEntry[] = [];
  for (const item of items) {
    if (item.envelope.type !== 'MoodCheckin' || undone.has(item.operationId)) continue;
    entries.push({ operationId: item.operationId, payload: item.envelope.payload });
  }
  entries.sort((a, b) => b.payload.checkinAt.localeCompare(a.payload.checkinAt));
  return entries.slice(0, limit);
}

/** Recent check-ins for the Progress view. Read-only and tap-free: the rows are evidence, not controls. */
export function MoodHistory({ items }: { items: readonly QueueItem[] }) {
  const entries = recentCheckins(items);
  return <section aria-label="Mood" className="progress-card log-mood">
    <h2>Mood</h2>
    {entries.length === 0
      ? <p className="muted small">No check-ins on this device yet.</p>
      : <>
        <p className="muted small">Newest {entries.length} kept on this device.</p>
        <ul className="log-mood-list">
          {entries.map((entry) => <li key={entry.operationId} className="log-mood-row">
            <span className="log-mood-date">{dayHeading(entry.payload.date)}</span>
            <span className="log-mood-values">
              {chipLabel('Mood', entry.payload.mood)} · {chipLabel('Energy', entry.payload.energy)} · Sleep {entry.payload.sleep} h
            </span>
          </li>)}
        </ul>
      </>}
  </section>;
}
