import type { CommandType } from '@vault-companion/contracts';
import { useState } from 'react';
import { exportText } from '../commands.ts';
import type { PendingQueue, QueueItem, ReadEvidence } from '../queue/queue.ts';
import { StateChip } from './StateChip.tsx';

const VERB: Record<CommandType, string> = {
  CompleteTask: 'Complete',
  UndoCompleteTask: 'Undo',
  CaptureTask: 'Task',
  CaptureNote: 'Note',
};

/** Every action on this device with its honest state. Saved entries can be cleared. */
export function ActionsPanel({
  queue,
  items,
  read,
}: {
  queue: PendingQueue;
  items: readonly QueueItem[];
  /** The read on screen: clearing uses it as the watermark (G3-1). */
  read: ReadEvidence | null;
}) {
  const [exporting, setExporting] = useState<QueueItem | null>(null);
  if (items.length === 0) return null;
  // Only receipts a read has acknowledged, and the read on screen includes, may be cleared; the rest still keep
  // the screen honest (A9, G3-1).
  const saved = read
    ? items.filter((i) => i.state === 'saved' && i.acknowledged && read.known[i.receipt?.commitSha ?? ''] === 'included')
    : [];

  return (
    <section className="group actions" aria-label="Actions on this device">
      <h2>
        Actions
        {saved.length > 0 && (
          <button type="button" className="link" onClick={() => read && void queue.forgetSaved(saved.map((i) => i.operationId), read)}>
            Clear saved
          </button>
        )}
      </h2>
      <ul className="action-list">
        {items.map((item) => (
          <li key={item.operationId} className="action" data-testid="action">
            <div className="action-head">
              <span className="action-verb">{VERB[item.type]}</span>
              <span className="action-label">{item.label}</span>
              <StateChip state={item.state} />
            </div>
            {item.state === 'attention' && (
              <>
                {item.error && <p className="error">{item.error.message}</p>}
                <div className="action-buttons">
                  {!item.accountMismatch && (
                    <button type="button" onClick={() => void queue.retry(item.operationId)}>
                      Retry
                    </button>
                  )}
                  <button type="button" onClick={() => setExporting(item)}>
                    Export text
                  </button>
                  <button type="button" className="danger" onClick={() => void queue.discard(item.operationId)}>
                    Discard
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">Pending actions are kept on this device while possible.</p>
      {exporting && <ExportDialog text={exportText(exporting.envelope)} onClose={() => setExporting(null)} />}
    </section>
  );
}

function ExportDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Export text" onClick={(e) => e.stopPropagation()}>
        <h2>Export text</h2>
        <textarea readOnly value={text} rows={6} aria-label="Exported text" onFocus={(e) => e.currentTarget.select()} />
        <div className="sheet-buttons">
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(text).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
