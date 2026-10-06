import { SheetHeader } from './SheetHeader.tsx';
import { useRef, useState } from 'react';
import { reportFeedback } from '../commands.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { localDate } from './MoodCard.tsx';

/** The contract's ceiling for `text` (ADR-0040); the textarea never lets it grow past this. */
export const REPORT_TEXT_LIMIT = 1000;

/**
 * The build commit as the payload carries it. A missing or unusable stamp (e.g. a source checkout without Git)
 * falls back to `dev`, so the field always satisfies the contract's `/^[0-9A-Za-z.+-]{1,40}$/`.
 */
export function appVersion(): string {
  const commit = typeof __APP_BUILD__ === 'undefined' ? 'dev' : __APP_BUILD__.commit;
  return /^[0-9A-Za-z.+-]{1,40}$/.test(commit) ? commit : 'dev';
}

/** The visible name of each tab, matching the `screen` field's `/^[A-Za-z][A-Za-z0-9 -]{0,30}$/`. */
const SCREEN: Record<string, string> = {
  today: 'Today',
  tasks: 'Tasks',
  all: 'All',
  notes: 'Notes',
  training: 'Log',
  scouts: 'Scouts',
  history: 'Progress',
  health: 'Health',
  status: 'Status',
};

export function screenName(tab: string): string {
  return SCREEN[tab] ?? 'Today';
}

/**
 * One bug/wish report (ADR-0040). Works offline: the envelope is minted and persisted on the device like every
 * capture, and the queue sends it later. The typed text is never logged or put in the row label.
 */
export function ReportSheet({ queue, accountKey, baseRevision, screen, onClose }: {
  queue: PendingQueue;
  accountKey: string | null;
  baseRevision: string | null;
  screen: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'bug' | 'wish'>('bug');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);

  const connected = accountKey !== null && baseRevision !== null;
  const ready = connected && text.trim().length > 0;
  const save = async () => {
    if (!ready || guard.current || accountKey === null || baseRevision === null) return;
    guard.current = true; setSaving(true); setError(null);
    // The day of the tap, not of the last render: the app may have stayed open past midnight.
    const day = localDate();
    try {
      await queue.enqueue(
        reportFeedback({ baseRevision }, { kind, text: text.trim(), screen, appVersion: appVersion(), date: day }),
        { accountKey, label: `Report \u00b7 ${day}`, taskKey: 'report' },
      );
      onClose();
    } catch { setError('Could not keep this report on the device.'); }
    finally { guard.current = false; setSaving(false); }
  };

  return (
    // A stray tap outside must not throw away typed text; Cancel still closes explicitly.
    <div className="sheet-backdrop" role="presentation" onClick={() => text.length === 0 && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Report" onClick={(e) => e.stopPropagation()}>
        <SheetHeader title="Report" onClose={onClose} closeLabel="Cancel" />
        <div className="segmented" role="group" aria-label="Kind">
          <button type="button" aria-pressed={kind === 'bug'} onClick={() => setKind('bug')}>Bug</button>
          <button type="button" aria-pressed={kind === 'wish'} onClick={() => setKind('wish')}>Wish</button>
        </div>
        <textarea
          aria-label="What happened?"
          placeholder="What happened?"
          value={text}
          maxLength={REPORT_TEXT_LIMIT}
          rows={4}
          autoFocus
          onChange={(e) => { setText(e.target.value); setError(null); }}
        />
        {!connected && <p className="muted small">Connect once to set up this device before reporting.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-buttons">
          <button type="button" className="primary" disabled={saving || !ready} onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  );
}
