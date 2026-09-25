import type { CompleteTaskCommand, TaskView } from '@vault-companion/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getSession, getTasks } from '../api.ts';
import { completeTask, undoCompleteTask } from '../commands.ts';
import { prefs } from '../prefs.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { knownCommits, renderable, TaskReads, type RenderedRead } from '../reads.ts';
import { plainWikilinks } from '../text.ts';
import { buildView } from '../view.ts';
import { ActionsPanel } from './ActionsPanel.tsx';
import { CaptureSheet } from './CaptureSheet.tsx';
import { TaskList } from './TaskList.tsx';

type Tab = 'today' | 'all';
/** `refreshing`: the last read was stale against the watermark (G3-1); the last good read stays, if any. */
type Connection = 'loading' | 'online' | 'offline' | 'error' | 'refreshing';
interface Toast {
  target: CompleteTaskCommand;
  label: string;
}

const UNDO_WINDOW_MS = 8000;
/** Re-reads after a stale response that predates the watermark; each asks about the newest one. */
const STALE_REREADS = 3;

export function App({ queue, receipts }: { queue: PendingQueue; receipts: EventTarget }) {
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [rendered, setRendered] = useState<RenderedRead | null>(null);
  const [connection, setConnection] = useState<Connection>('loading');
  const [sessionSignedOut, setSessionSignedOut] = useState(false);
  const [accountKey, setAccountKey] = useState<string | null>(() => prefs.lastAccountKey());
  const [tab, setTab] = useState<Tab>('today');
  const [captureOpen, setCaptureOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Tasks whose checkbox was tapped: disabled synchronously, before the envelope is even persisted (F19).
  const [tapped, setTapped] = useState<ReadonlySet<string>>(new Set());
  const tappedRef = useRef(new Set<string>());

  const signedOut = sessionSignedOut || snapshot.signedOut;
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

  const wake = useCallback(async () => {
    const session = await refreshSession();
    if (session === 'ok') {
      void queue.kick();
      await refreshTasks();
    } else if (session === 'offline') {
      setConnection('offline');
    }
  }, [queue, refreshSession, refreshTasks]);

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

  const view = useMemo(() => buildView(tasks, snapshot.items), [tasks, snapshot.items]);

  const complete = useCallback(
    async (task: TaskView) => {
      const key = task.locator.lineText;
      if (tappedRef.current.has(key)) return;
      if (!accountKey || !tasks) {
        setNotice('Connect once to set up this device.');
        return;
      }
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

  const undo = useCallback(
    async (target: CompleteTaskCommand, label: string) => {
      setToast(null);
      if (!accountKey || !revision) return;
      const envelope = undoCompleteTask({ baseRevision: revision }, target);
      await queue.undoCompletion(target, envelope, { accountKey, label, taskKey: target.payload.task.lineText });
    },
    [accountKey, queue, revision],
  );

  const writeBlocked = tasks?.writeBlock ?? null;
  // Calm by default: the actions list sits below the tasks unless something needs the user.
  const needsAttention = snapshot.items.some((i) => i.state === 'attention');

  return (
    <div className="app">
      <header className="top">
        <nav className="tabs" aria-label="Views">
          <button type="button" aria-pressed={tab === 'today'} onClick={() => setTab('today')}>
            Today
          </button>
          <button type="button" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>
            All
          </button>
        </nav>
      </header>

      <main className="content">
        {signedOut && (
          <div className="banner banner-warn" role="alert">
            <span>Signed out — reload to sign in. Your pending actions stay on this device.</span>
            <button type="button" onClick={() => window.location.reload()}>
              Sign in again
            </button>
          </div>
        )}
        {!signedOut && connection === 'offline' && (
          <div className="banner" role="status">
            Offline. Captures are kept on this device and sent when you are back online.
          </div>
        )}
        {!signedOut && connection === 'error' && (
          <div className="banner banner-warn" role="status">
            <span>Could not load tasks.</span>
            <button type="button" onClick={() => void wake()}>
              Retry
            </button>
          </div>
        )}
        {!signedOut && connection === 'refreshing' && tasks && (
          <div className="banner" role="status">
            Refreshing…
          </div>
        )}
        {writeBlocked && (
          <div className="banner banner-warn" role="alert">
            {writeBlocked.message}
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

        {needsAttention && <ActionsPanel queue={queue} items={snapshot.items} read={tasks} />}

        {connection === 'loading' && !tasks && <p className="muted">Loading…</p>}
        {connection !== 'loading' && !tasks && (connection === 'refreshing' || rendered) && (
          <p className="muted">Refreshing…</p>
        )}

        {tasks &&
          (tab === 'today' ? (
            <>
              <TaskList title="Overdue" rows={view.overdue} tapped={tapped} blocked={!!writeBlocked} onComplete={complete} overdue />
              <TaskList title="Today" rows={view.today} tapped={tapped} blocked={!!writeBlocked} onComplete={complete} empty="Nothing due today." />
              <TaskList title="Done today" rows={view.doneToday} tapped={tapped} blocked onComplete={complete} />
            </>
          ) : (
            <TaskList title="All tasks" rows={view.all} tapped={tapped} blocked={!!writeBlocked} onComplete={complete} empty="No open tasks." />
          ))}

        {!needsAttention && <ActionsPanel queue={queue} items={snapshot.items} read={tasks} />}
      </main>

      <button type="button" className="fab" onClick={() => setCaptureOpen(true)} aria-label="Capture">
        +
      </button>

      {captureOpen && (
        <CaptureSheet
          queue={queue}
          accountKey={accountKey}
          baseRevision={revision}
          onClose={() => setCaptureOpen(false)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>Done</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={() => void undo(toast.target, toast.label)}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
