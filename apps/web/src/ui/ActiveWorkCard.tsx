import type { ActiveWorkResponse, ReviewActiveWorkCommand } from '@vault-companion/contracts';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getActiveWork, type Fetched } from '../api.ts';
import { activeWorkRows, type ActiveWorkItem } from '../active-work.ts';
import { reviewActiveWork, undoActiveWork, undoActiveWorkDraft } from '../commands.ts';
import { prefs } from '../prefs.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { activeWorkState } from '../reads.ts';
import { ActiveWorkEditSheet } from './ActiveWorkEditSheet.tsx';
import type { OpenLink } from './NoteView.tsx';
import { StateChip } from './StateChip.tsx';

export function ActiveWorkCard({ revision, queue, accountKey, onOpenLink }: {
  revision: string | null; queue: PendingQueue; accountKey: string | null; onOpenLink: (link: OpenLink) => void;
}) {
  const [res, setRes] = useState<Fetched<ActiveWorkResponse> | null>(null);
  const [collapsed, setCollapsed] = useState(prefs.activeWorkCollapsed);
  const [editing, setEditing] = useState<ActiveWorkItem | null>(null);
  const [dropping, setDropping] = useState<ActiveWorkItem | null>(null);
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState<{ target: ReviewActiveWorkCommand; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  useEffect(() => {
    let live = true;
    void getActiveWork().then((r) => { if (live) setRes(r); });
    return () => { live = false; };
  }, [revision]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast]);
  const state = activeWorkState(res);
  const read = res?.kind === 'ok' && res.data.status === 'ok' ? res.data : null;
  const review = async (item: ActiveWorkItem, action: ReviewActiveWorkCommand['payload']['action']) => {
    if (!read || !accountKey || guard.current) return;
    guard.current = true; setBusy(true); setError(null);
    try {
      const target = reviewActiveWork({ baseRevision: read.revision }, action === 'drop'
        ? { item: item.locator, action, reason: reason.trim() } : { item: item.locator, action });
      await queue.enqueue(target, { accountKey, label: item.name, taskKey: 'active-work' });
      setToast({ target, label: item.name }); setDropping(null);
    } catch { setError('Could not keep this action on the device.'); }
    finally { guard.current = false; setBusy(false); }
  };
  const undo = async () => {
    if (!toast || !read || !accountKey || guard.current) return;
    guard.current = true; setBusy(true);
    try {
      const { target, label } = toast;
      const items = queue.getSnapshot().items;
      if (items.some((q) => q.envelope.type === 'UndoActiveWork' && q.envelope.payload.target.operationId === target.operationId)) return;
      const receipt = items.find((q) => q.operationId === target.operationId)?.receipt;
      const ctx = { baseRevision: read.revision };
      await queue.undoCompletion(target, receipt ? undoActiveWork(ctx, target, receipt.commitSha) : undoActiveWorkDraft(ctx, target),
        { accountKey, label, taskKey: 'active-work' });
      setToast(null);
    } catch { setError('Could not keep this Undo on the device.'); }
    finally { guard.current = false; setBusy(false); }
  };
  if (state.kind === 'hidden') return null;
  return <>
    <section className="group active-work" aria-label="Active work">
      <h2><button type="button" className="active-work-toggle" aria-expanded={!collapsed} aria-controls="active-work-content"
        onClick={() => { setCollapsed(!collapsed); prefs.setActiveWorkCollapsed(!collapsed); }}>Active work</button></h2>
      {!collapsed && <div id="active-work-content" data-testid="active-work-body">
        {state.kind === 'message' && <p className="muted">{state.text}</p>}
        {read && activeWorkRows(read, snapshot.items, accountKey).map(({ item, action, blocked }) => <article className="active-work-item" key={item.locator.lineIndex + ':' + item.locator.lineText}>
          <button type="button" className="link" disabled={busy || blocked || !accountKey} aria-label={'Edit: ' + item.name} onClick={() => setEditing(item)}>{item.name}</button>
          {item.next && <p>Next: {item.next}</p>}
          {item.review && <p className="muted small">Review: {item.review}</p>}
          {item.link && <button type="button" className="link" aria-label={'Open note: ' + item.link} onClick={(e) => onOpenLink({
            task: { locator: item.locator }, linkIndex: Math.max(0, [...item.locator.lineText.matchAll(/\[\[[^[\]]+\]\]/g)].findIndex((m) => m[0] === item.link)), label: item.link ?? '', invoker: e.currentTarget,
          })}>{item.link}</button>}
          {action && <StateChip state={action.state} />}
          {item.needsReview && <span className="chip">Needs review</span>}
          {/* C2: Done, Park and Drop any time (finishing early); Keep (+7 days) only makes sense once review is due. */}
          <div className="action-buttons">{(item.needsReview ? (['keep', 'done', 'park', 'drop'] as const) : (['done', 'park', 'drop'] as const)).map((a) =>
            <button type="button" key={a} aria-label={`${a[0]?.toUpperCase()}${a.slice(1)}: ${item.name}`}
              disabled={busy || blocked || !accountKey} onClick={() => a === 'drop' ? (setDropping(item), setReason('')) : void review(item, a)}>
              {a[0]?.toUpperCase()}{a.slice(1)}</button>)}</div>
        </article>)}
        {read && read.unknownNowLines.length > 0 && <div className="active-work-unknown"><p className="muted small">edited in Obsidian</p>
          <pre>{read.unknownNowLines.join('\n')}</pre></div>}
        {error && <p role="alert" className="error">{error}</p>}
      </div>}
    </section>
    {editing && read && accountKey && <ActiveWorkEditSheet item={editing} queue={queue} accountKey={accountKey} revision={read.revision} onClose={() => setEditing(null)} />}
    {dropping && <div className="sheet-backdrop" role="presentation"><div className="sheet" role="dialog" aria-modal="true" aria-label="Drop Active Work">
      <h2>Drop {dropping.name}</h2>
      <label>Reason<input autoFocus maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="sheet-buttons"><button type="button" disabled={busy} onClick={() => setDropping(null)}>Cancel</button>
        <button type="button" disabled={busy || !reason.trim() || reason.trim().length > 200} onClick={() => void review(dropping, 'drop')}>Drop</button></div>
    </div></div>}
    {toast && <div className="toast" role="status"><span>Review queued: {toast.label}</span><button type="button" disabled={busy} onClick={() => void undo()}>Undo</button></div>}
  </>;
}
