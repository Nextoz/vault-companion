import type { ActiveWorkResponse } from '@vault-companion/contracts';
import type { ActiveWorkChanges } from './commands.ts';
import type { QueueItem } from './queue/queue.ts';
import { dateIn } from './time.ts';

export type ActiveWorkRead = Extract<ActiveWorkResponse, { status: 'ok' }>;
export type ActiveWorkItem = ActiveWorkRead['items'][number];

/** Calendar arithmetic after selecting Copenhagen's date, including across DST changes. */
export function reviewInSevenDays(now = new Date()): string {
  const day = new Date(dateIn(now.toISOString(), 'Europe/Copenhagen') + 'T12:00:00Z');
  day.setUTCDate(day.getUTCDate() + 7);
  return day.toISOString().slice(0, 10);
}

export function activeWorkChanges(item: ActiveWorkItem, name: string, next: string, review: string): ActiveWorkChanges {
  return {
    ...(name.trim() !== item.name ? { name: name.trim() } : {}),
    ...(next.trim() !== (item.next ?? '') ? { next: next.trim() || null } : {}),
    ...(review !== (item.review ?? '') ? { review: review || null } : {}),
  };
}

/** Keep the read visible while a write is pending and disable repeat actions. */
export function activeWorkRows(read: ActiveWorkRead, queued: readonly QueueItem[], account: string | null) {
  return read.items.map((item) => {
    const action = [...queued].reverse().find((q) => {
      if (q.accountKey !== account || q.state === 'saved') return false;
      const e = q.envelope;
      const loc = e.type === 'ReviewActiveWork' || e.type === 'EditActiveWork' ? e.payload.item
        : e.type === 'UndoActiveWork' ? e.payload.target.payload.item : null;
      return loc && loc.lineText === item.locator.lineText &&
        (loc.blobSha === item.locator.blobSha ? loc.lineIndex === item.locator.lineIndex
          : loc.occurrencesAtRead === 1 && read.items.filter((i) => i.locator.lineText === loc.lineText).length === 1);
    });
    return { item, action, blocked: action !== undefined };
  });
}
