import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { latestCheckin, localDate, MoodCheckinForm } from './MoodCard.tsx';
import { SheetHeader } from './SheetHeader.tsx';

/**
 * C3: Capture -> Check-in. The existing mood/energy/sleep form (ADR-0036) in a sheet, so a check-in is two taps from
 * any screen. Today's saved check-in seeds the form; saving enqueues an ordinary MoodCheckin (the newest one wins).
 */
export function CheckinSheet({ queue, items, accountKey, baseRevision, blocked, onClose }: {
  queue: PendingQueue;
  items: readonly QueueItem[];
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
  onClose: () => void;
}) {
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="sheet checkin-sheet" role="dialog" aria-modal="true" aria-label="Check-in" onClick={(e) => e.stopPropagation()}>
        <SheetHeader title="Check-in" onClose={onClose} />
        <MoodCheckinForm queue={queue} accountKey={accountKey} baseRevision={baseRevision} blocked={blocked}
          initial={latestCheckin(items, localDate())} onSaved={onClose} />
      </div>
    </div>
  );
}
