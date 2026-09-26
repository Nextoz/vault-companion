import type { CompleteTaskCommand, TaskView } from '@vault-companion/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getSession, getTasks } from '../api.ts';
import { notRedoneBy, stillUnresolved, UNRESOLVED_TEXT, unresolvedFrom, type Unresolved } from '../attention.ts';
import { completeTask, undoCompleteTask, undoDraft } from '../commands.ts';
import { unreachableText, wake as wakeUp, type Connection } from '../connection.ts';
import { prefs } from '../prefs.ts';
import type { DraftStore } from '../draft.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { knownCommits, renderable, TaskReads, type RenderedRead } from '../reads.ts';
import { plainWikilinks } from '../text.ts';
import { buildView, occurrenceKey, overdueSummary } from '../view.ts';
import { FROZEN_NOTE, taskListLock } from '../writeBlock.ts';
import { ActionsPanel } from './ActionsPanel.tsx';
import { ActiveWorkCard } from './ActiveWorkCard.tsx';
import { CaptureSheet } from './CaptureSheet.tsx';
import { NoteView, type OpenLink } from './NoteView.tsx';
import { TaskList } from './TaskList.tsx';

type Tab = 'today' | 'all';
interface Toast {
  target: CompleteTaskCommand;
  label: string;
}

const UNDO_WINDOW_MS = 8000;
/** Re-reads after a stale response that predates the watermark; each asks about the newest one. */
const STALE_REREADS = 3;

export function App({ queue, drafts, receipts }: { queue: PendingQueue; drafts: DraftStore; receipts: EventTarget }) {
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [rendered, setRendered] = useState<RenderedRead | null>(null);
  const [connection, setConnection] = useState<Connection>('loading');
  const [sessionSignedOut, setSessionSignedOut] = useState(false);
  const [accountKey, setAccountKey] = useState<string | null>(() => prefs.lastAccountKey());
  const [tab, setTab] = useState<Tab>('today');
  const [captureOpen, setCaptureOpen] = useState(false);
  // The open note is bound to the account it was opened under: signing out or switching account closes it (the
  // render guard below hides it in the same frame; the effect drops the state).
  const [openLink, setOpenLink] = useState<(OpenLink & { account: string | null }) | null>(null);
  const closeNote = useCallback(() => setOpenLink(null), []);
  // ADR-0012: Overdue is its own group below Today, collapsed until the user opens it.
  const [overdueOpen, setOverdueOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Discarded refusals whose tasks still need attention (attention.ts).
  const [unresolved, setUnresolved] = useState<readonly Unresolved[]>([]);
  // Task occurrences whose checkbox was tapped: disabled synchronously, before the envelope is even persisted (F19).
  // Keyed by occurrence, so an identical line elsewhere stays tappable (P4-B).
  const [tapped, setTapped] = useState<ReadonlySet<string>>(new Set());
  const tappedRef = useRef(new Set<string>());

  const signedOut = sessionSignedOut || snapshot.signedOut;
  const noteOpen = openLink !== null && !signedOut && openLink.account === accountKey;
  useEffect(() => {
    if (openLink && !noteOpen) setOpenLink(null);
  }, [openLink, noteOpen]);
  const openNote = useCallback((link: OpenLink) => setOpenLink({ ...link, account: accountKey }), [accountKey]);
  // A read checked against an older watermark than the snapshot's may predate receipts evicted since (G3-1).
  const fresh = rendered !== null && renderable(rendered, snapshot.watermark);
  const tasks = fresh ? rendered.data : null;
  const revision = tasks?.revision ?? prefs.lastRevision();

  const knownRef = useRef<string[]>([]);
  // Every retained receipt: the rendered read alone says whether it reflects them (A9, N3).
  knownRef.current = knownCommits(snapshot.items);
  // Out-of-order responses (N3) and the shared watermark (G3-1): see reads.ts.
  const readsRef = useRef<TaskReads | null>(null);
  readsRef.current ??= new TaskReads({
    getTasks,
    watermark: () => queue.readWatermark(),
    receipts: () => knownRef.current,
  });

  const refreshSession = useCallback(async () => {
    const res = await getSession();
    if (res.kind === 'ok') {
      prefs.setLastAccountKey(res.data.accountKey);
      setAccountKey(res.data.accountKey);
      setSessionSignedOut(false);
      queue.setSession(res.data.accountKey);
    } else if (res.kind === 'signed-out') {
      setSessionSignedOut(true);
      queue.setSignedOut();
    }
    return res.kind;
  }, [queue]);

  const refreshTasks = useCallback(async () => {
    const reads = readsRef.current;
    if (!reads) return;
    for (let attempt = 0; ; attempt++) {
      const out = await reads.read();
      switch (out.kind) {
        case 'apply':
          prefs.setLastRevision(out.read.data.revision);
          setRendered(out.read);
          void queue.acknowledge(out.read.data);
          setConnection('online');
          return;
        case 'superseded':
          return;
        case 'stale':
          setConnection('refreshing');
          if (out.retry && attempt < STALE_REREADS) continue;
          return;
        case 'signed-out':
          setSessionSignedOut(true);
          queue.setSignedOut();
          return;
        default:
          setConnection(out.kind === 'offline' ? 'offline' : 'error');
          return;
      }
    }
  }, [queue]);

  const wake = useCallback(
    () =>
      wakeUp({
        session: refreshSession,
        kick: () => void queue.kick(),
        tasks: refreshTasks,
        setConnection,
      }),
    [queue, refreshSession, refreshTasks],
  );

  // Start, `online`, focus: re-confirm the session, then retry the queue immediately.
  useEffect(() => {
    void wake();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void wake();
    };
    const onOffline = () => setConnection('offline');
    window.addEventListener('online', wake);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [wake]);

  // A receipt means the server read may now include (or trail) the commit: re-read with `known=`.
  useEffect(() => {
    const onReceipt = () => void refreshTasks();
    receipts.addEventListener('receipt', onReceipt);
    return () => receipts.removeEventListener('receipt', onReceipt);
  }, [receipts, refreshTasks]);

  // Another tab evicted receipts under a newer watermark than the screen was checked against: read again.
  useEffect(() => {
    if (rendered && !fresh) void refreshTasks();
  }, [rendered, fresh, refreshTasks]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), UNDO_WINDOW_MS);
    return () => clearTimeout(id);
  }, [toast]);

  // A fresh read that shows the task changed state settles it for good.
  const pending = useMemo(() => unresolved.filter((u) => stillUnresolved(u, tasks)), [unresolved, tasks]);
  useEffect(() => {
    if (pending.length !== unresolved.length) setUnresolved(pending);
  }, [pending, unresolved]);

  const view = useMemo(
    () => buildView(tasks, snapshot.items, accountKey, pending),
    [tasks, snapshot.items, accountKey, pending],
  );

  const discard = useCallback(
    async (item: QueueItem) => {
      if (!(await queue.discard(item.operationId))) return;
      const envelope = item.envelope;
      if (envelope.type !== 'CompleteTask') return;
      setUnresolved((list) => [...list.filter((u) => u.operationId !== item.operationId), unresolvedFrom(envelope, item.label, tasks)]);
    },
    [queue, tasks],
  );

  const complete = useCallback(
    async (task: TaskView) => {
      const key = occurrenceKey(task.locator);
      if (tappedRef.current.has(key)) return;
      if (!accountKey || !tasks) {
        setNotice('Connect once to set up this device.');
        return;
      }
      if (tasks.writeBlock) return; // every task-list write would be refused (writeBlock.ts)
      // Redoing the action on the task settles a discarded refusal of it.
      setUnresolved((list) => list.filter((u) => notRedoneBy(u, task, tasks.allOpen)));
      tappedRef.current.add(key);
      setTapped(new Set(tappedRef.current));
      try {
        const envelope = completeTask({ baseRevision: tasks.revision }, task.locator);
        const label = plainWikilinks(task.description);
        await queue.enqueue(envelope, { accountKey, label, taskKey: key });
        setToast({ target: envelope, label });
      } catch {
        setNotice('Could not keep this action on the device.');
      } finally {
        tappedRef.current.delete(key);
        setTapped(new Set(tappedRef.current));
      }
    },
    [accountKey, queue, tasks],
  );

  // Completions with an Undo being minted: the toast and the Done today row cannot mint a second one (P4-B).
  const undoingRef = useRef(new Set<string>());
  const lock = taskListLock(tasks);
  const undo = useCallback(
    async (target: CompleteTaskCommand, label: string) => {
      setToast(null);
      // The server refuses every task-list write while it is blocked (writeBlock.ts).
      if (!accountKey || !revision || tasks?.writeBlock) return;
      const items = queue.getSnapshot().items;
      const undone = items.some((i) => i.envelope.type === 'UndoCompleteTask' && i.envelope.payload.target.operationId === target.operationId);
      if (undone || undoingRef.current.has(target.operationId)) return;
      undoingRef.current.add(target.operationId);
      try {
        // The completion's commit is the Undo's token (ADR-0013). Without a receipt yet, the queue fills it in later.
        const receipt = items.find((i) => i.operationId === target.operationId)?.receipt ?? null;
        const ctx = { baseRevision: revision };
        const envelope = receipt ? undoCompleteTask(ctx, target, receipt.commitSha) : undoDraft(ctx, target);
        await queue.undoCompletion(target, envelope, { accountKey, label, taskKey: occurrenceKey(target.payload.task) });
      } catch {
        setNotice('Could not keep this action on the device.');
      } finally {
        undoingRef.current.delete(target.operationId);
      }
    },
    [accountKey, queue, revision, tasks],
  );

  const writeBlocked = lock !== null;
  const frozen = lock?.conflict ?? false;
  // Calm by default: the actions list sits below the tasks unless something needs the user.
  const needsAttention = snapshot.items.some((i) => i.state === 'attention');

  return (
    <div className="app">
      <header className="top" inert={noteOpen}>
        <nav className="tabs" aria-label="Views">
          <button type="button" aria-pressed={tab === 'today'} onClick={() => setTab('today')}>
            Today
          </button>
          <button type="button" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>
            All
          </button>
        </nav>
      </header>

      <main className="content" inert={noteOpen}>
        {lock && (
          <div className="banner banner-warn" role="alert">
            {lock.banner}
          </div>
        )}
        {signedOut && (
          <div className="banner banner-warn" role="alert">
            <span>Signed out — reload to sign in. Your pending actions stay on this device.</span>
            <button type="button" onClick={() => window.location.reload()}>
              Sign in again
            </button>
          </div>
        )}
        {!signedOut && (connection === 'offline' || connection === 'error') && (
          <div className={connection === 'error' ? 'banner banner-warn' : 'banner'} role="status">
            <span>{unreachableText(connection)}</span>
            <button type="button" onClick={() => void wake()}>
              Try again
            </button>
          </div>
        )}
        {!signedOut && connection === 'refreshing' && tasks && (
          <div className="banner" role="status">
            Refreshing…
          </div>
        )}
        {notice && (
          <div className="banner" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)}>
              OK
            </button>
          </div>
        )}

        {view.unresolved.map((u) => (
          <div key={u.operationId} className="banner banner-warn" role="status">
            <span>
              “{u.label}”: {UNRESOLVED_TEXT}
            </span>
          </div>
        ))}

        {needsAttention && (
          <ActionsPanel queue={queue} items={snapshot.items} read={tasks} onRefresh={refreshTasks} onDiscard={discard} />
        )}

        {tab === 'today' && <ActiveWorkCard revision={tasks?.revision ?? null} />}

        {connection === 'loading' && !tasks && <p className="muted">Loading…</p>}
        {connection !== 'loading' && !tasks && (connection === 'refreshing' || rendered) && (
          <p className="muted">Refreshing…</p>
        )}

        {tasks && lock?.conflict && <p className="muted small">{FROZEN_NOTE}</p>}
        {tasks &&
          (tab === 'today' ? (
            <>
              <TaskList title="Today" rows={view.today} tapped={tapped} blocked={writeBlocked} frozen={frozen} onComplete={complete} onOpenLink={openNote} empty="Nothing due today." />
              <TaskList
                title="Overdue"
                rows={view.overdue}
                tapped={tapped}
                blocked={writeBlocked}
                frozen={frozen}
                onComplete={complete}
                onOpenLink={openNote}
                overdue
                collapsible={{
                  open: overdueOpen,
                  summary: overdueSummary(view.overdue.length),
                  onToggle: () => setOverdueOpen((open) => !open),
                }}
              />
              <TaskList title="Done today" rows={view.doneToday} tapped={tapped} blocked frozen={frozen} onComplete={complete} onUndo={undo} onOpenLink={openNote} />
            </>
          ) : (
            <TaskList title="All tasks" rows={view.all} tapped={tapped} blocked={writeBlocked} frozen={frozen} onComplete={complete} onOpenLink={openNote} empty="No open tasks." />
          ))}

        {!needsAttention && (
          <ActionsPanel queue={queue} items={snapshot.items} read={tasks} onRefresh={refreshTasks} onDiscard={discard} />
        )}
      </main>

      <button type="button" className="fab" inert={noteOpen} onClick={() => setCaptureOpen(true)} aria-label="Capture">
        +
      </button>

      {captureOpen && (
        <CaptureSheet
          queue={queue}
          drafts={drafts}
          accountKey={accountKey}
          baseRevision={revision}
          taskBlocked={lock ? lock.banner : null}
          onClose={() => setCaptureOpen(false)}
        />
      )}

      {noteOpen && <NoteView link={openLink} onClose={closeNote} />}

      {toast && (
        <div className="toast" role="status">
          <span>Done</span>
          {!writeBlocked && (
            <>
              <span aria-hidden="true">·</span>
              <button type="button" onClick={() => void undo(toast.target, toast.label)}>
                Undo
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
