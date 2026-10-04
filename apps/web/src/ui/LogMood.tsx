// Log - Mood (UX5): recent mood/energy/sleep check-ins, newest first. Presentation only: it reads the check-ins the
// device already holds in its local queue (pending items and saved receipts). There is no server read for mood
// history, so anything evicted under the saved-actions watermark is simply not here.
import type { MoodCheckinPayload } from '@vault-companion/contracts';
import { useState } from 'react';
import { dayHeading } from '../history.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { chipLabel, localDate, MoodCheckinForm } from './MoodCard.tsx';

/** How many check-ins the Log shows. */
export const MOOD_HISTORY_LIMIT = 14;

export interface MoodEntry {
  operationId: string;
  seq: number;
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
    entries.push({ operationId: item.operationId, seq: item.seq, payload: item.envelope.payload });
  }
  entries.sort((a, b) => b.payload.checkinAt.localeCompare(a.payload.checkinAt));
  return entries.slice(0, limit);
}

export interface MoodHistoryProps {
  items: readonly QueueItem[];
  queue: PendingQueue;
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
}

/**
 * Recent check-ins for the Progress view. The rows are evidence; only today's entry carries an Edit control (UX6),
 * which opens the shared check-in form prefilled and enqueues a normal MoodCheckin on save.
 */
export function MoodHistory({ items, queue, accountKey, baseRevision, blocked }: MoodHistoryProps) {
  const entries = recentCheckins(items);
  const today = localDate();
  // Only today's effective check-in is editable: the newest queue sequence for the day, the same rule latestCheckin
  // uses, so a later edit of the day does not leave the superseded row with its own Edit control.
  const activeToday = entries
    .filter((e) => e.payload.date === today)
    .reduce<MoodEntry | null>((best, e) => (!best || e.seq > best.seq ? e : best), null);
  const [editing, setEditing] = useState<string | null>(null);
  const editingEntry = entries.find((e) => e.operationId === editing) ?? null;
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
            {activeToday?.operationId === entry.operationId && <button type="button" className="link" onClick={() => setEditing(entry.operationId)}>Edit</button>}
          </li>)}
        </ul>
      </>}
    {editingEntry && <MoodCheckinForm key={editingEntry.operationId} queue={queue} accountKey={accountKey} baseRevision={baseRevision}
      blocked={blocked} date={editingEntry.payload.date} initial={editingEntry.payload}
      onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
  </section>;
}
