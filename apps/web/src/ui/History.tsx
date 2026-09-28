// Completion history (ADR-0021): completed tasks by day, newest first. No counts, scores or streaks.
import type { CompleteTaskCommand, HistoryResponse } from '@vault-companion/contracts';
import type { Fetched } from '../api.ts';
import { groupByDay, reopenFor } from '../history.ts';
import type { QueueItem } from '../queue/queue.ts';
import { plainWikilinks, taskSegments } from '../text.ts';
import type { OpenLink } from './NoteView.tsx';

/** The day list inside Progress (ADR-0027); Progress owns the read so it is fetched once. */
export function History({ result, queued, accountKey, blocked, onReopen, onOpenLink }: {
  result: Fetched<HistoryResponse> | null;
  queued: readonly QueueItem[];
  accountKey: string | null;
  blocked: boolean;
  onReopen: (target: CompleteTaskCommand, label: string) => void;
  onOpenLink: (link: OpenLink) => void;
}) {
  const data = result?.kind === 'ok' ? result.data : null;
  return <section aria-label="History" className="history">
    {!data && <p role="status">{!result ? 'Loading history…' : result.kind === 'error' ? result.message : result.kind === 'signed-out' ? 'Sign in to view history.' : 'History unavailable offline.'}</p>}
    {data?.items.length === 0 && <p className="muted">No completed tasks yet.</p>}
    {data && groupByDay(data.items).map((day) => <section key={day.date} className="group" aria-label={day.heading}>
      <h2>{day.heading}</h2>
      <ul className="tasks">
        {day.items.map((item) => {
          const reopen = reopenFor(item, data.items, queued, accountKey);
          const label = plainWikilinks(item.description);
          return <li key={`${item.source}:${item.locator.lineIndex}`} className="task task-done" data-testid="history-item">
            <span className="check check-static check-on" aria-hidden="true" />
            <div className="task-body">
              <span className="task-text">{taskSegments(item.description, item.links).map((seg, i) => seg.kind === 'text'
                ? <span key={i}>{seg.text}</span>
                : <button key={i} type="button" className="wikilink" aria-label={`Open note: ${seg.text}`}
                  onClick={(e) => onOpenLink({ task: { locator: item.locator }, linkIndex: seg.linkIndex, label: seg.text, invoker: e.currentTarget })}>{seg.text}</button>)}
              </span>
              <span className="task-meta">
                {!(reopen.kind === 'undo' && !blocked) && <span className="muted small">{reopen.kind === 'reopening' ? 'Reopening…' : 'reopen in Obsidian'}</span>}
              </span>
            </div>
            {reopen.kind === 'undo' && !blocked && <button type="button" className="link" aria-label={`Reopen: ${label}`}
              onClick={(e) => { e.currentTarget.disabled = true; onReopen(reopen.target, label); }}>Reopen</button>}
          </li>;
        })}
      </ul>
    </section>)}
  </section>;
}
