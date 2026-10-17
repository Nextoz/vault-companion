import type { AiBudgetResponse, AiUsageResponse, CompleteTaskCommand, LeaderboardResponse, TaskView } from '@vault-companion/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getAiBudget, getAiUsage, getCalendarLinks, getLeaderboard, getSession, getTasks, type Fetched } from '../api.ts';
import type { ActiveWorkItem } from '../active-work.ts';
import { coalescedRead, type ReadReason } from '../coalescedRead.ts';
import { notRedoneBy, stillUnresolved, UNRESOLVED_TEXT, unresolvedFrom, type Unresolved } from '../attention.ts';
import { completeTask, undoCompleteTask, undoDraft } from '../commands.ts';
import { unreachableText, wake as wakeUp, type Connection } from '../connection.ts';
import { captureDefaultForTab, prefs } from '../prefs.ts';
import { browserPrefetchDeps, createPrefetcher } from '../prefetch.ts';
import { getUpdateReady, subscribeUpdateReady } from '../update-ready.ts';
import type { DraftStore } from '../draft.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { lastCopies } from '../lastCopy.ts';
import { knownCommits, renderable, TaskReads, type RenderedRead } from '../reads.ts';
import { plainWikilinks } from '../text.ts';
import { buildView, occurrenceKey, overdueSummary } from '../view.ts';
import { FROZEN_NOTE, taskListLock } from '../writeBlock.ts';
import { ActionsPanel } from './ActionsPanel.tsx';
import { ActiveWorkCard } from './ActiveWorkCard.tsx';
import { CalendarSheet } from './CalendarSheet.tsx';
import { activeWorkCalendarKey, taskCalendarKey, type CalendarTarget } from './calendar-sheet.ts';
import { Dashboard } from './Dashboard.tsx';
import { HealthPanel } from './HealthPanel.tsx';
import { EditSheet } from './EditSheet.tsx';
import { CaptureSheet } from './CaptureSheet.tsx';
import { NoteView, type OpenLink } from './NoteView.tsx';
import { Progress } from './Progress.tsx';
import { MorningCard } from './MorningCard.tsx';
import { ResearchRadar } from './ResearchRadar.tsx';
import { ReportSheet, screenName } from './ReportSheet.tsx';
import { Notes } from './Notes.tsx';
import { Scouts } from './Scouts.tsx';
import { ScoutDiagnostics } from './ScoutDiagnostics.tsx';
import { StatusSheet } from './StatusSheet.tsx';
import { Training } from './Training.tsx';
import { TrainingSheet } from './TrainingSheet.tsx';
import { Learning } from './Learning.tsx';
import { LearningSheet } from './LearningSheet.tsx';
import { Reading } from './Reading.tsx';
import { CharacterCard } from './CharacterCard.tsx';
import { CharacterRead } from './CharacterRead.tsx';
import { CaptureFab } from './CaptureFab.tsx';
import { CheckinSheet } from './CheckinSheet.tsx';
import { LargeTitle, LargeTitleProvider, useLargeTitleHost } from './LargeTitle.tsx';
import { TopBar } from './TopBar.tsx';
import { useHeldWhileHidden } from './useHeldWhileHidden.ts';
import { XpStrip, type StripLanding } from './XpStrip.tsx';
import { CharacterSheet } from './CharacterSheet.tsx';
import { RewardLayer } from './RewardLayer.tsx';
import { Triage } from './Triage.tsx';
import { TaskList } from './TaskList.tsx';
import { TabBar, type Tab } from './TabBar.tsx';
import { LogViewChips } from './LogViewChips.tsx';
import { isLogView, type LogView } from '../log-view.ts';

interface Toast {
  target: CompleteTaskCommand;
  label: string;
}

const UNDO_WINDOW_MS = 8000;
/** Re-reads after a stale response that predates the watermark; each asks about the newest one. */
const STALE_REREADS = 3;
/** Review O6: consecutive stale reads after which the device offers to reset its saved-actions history. */
export const STALE_BEFORE_RESET = 3;

const ACTION_TABS: ReadonlySet<string> = new Set(['today', 'tasks', 'all', 'notes', 'training', 'learning', 'reading', 'history']);
const prefetcher = createPrefetcher(browserPrefetchDeps);

export function App({ queue, drafts, receipts }: { queue: PendingQueue; drafts: DraftStore; receipts: EventTarget }) {
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [rendered, setRendered] = useState<RenderedRead | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [readsInFlight, setReadsInFlight] = useState(0);
  const [connection, setConnection] = useState<Connection>('loading');
  const [sessionSignedOut, setSessionSignedOut] = useState(false);
  const [accountKey, setAccountKey] = useState<string | null>(() => prefs.lastAccountKey());
  const [tab, setTab] = useState<Tab>('today');
  // UX8: which Today layout is showing; Overview (the pick + tiles) leads, Boards holds the dashboard stack.
  const [todayView, setTodayView] = useState<'overview' | 'boards'>('overview');
  // Where the header's Status screen returns to (the tab that opened it).
  const [statusReturn, setStatusReturn] = useState<Tab>('today');
  // Where the full-screen Research Radar returns to (the screen that opened it).
  const [radarReturn, setRadarReturn] = useState<Tab>('today');
  // GAM1-B: the Character screen opened from the Log card; `logFromCharacter` marks a Log view reached from a ring,
  // so its Back returns to the Character screen rather than Today.
  const [characterOpen, setCharacterOpen] = useState(false);
  const [logFromCharacter, setLogFromCharacter] = useState(false);
  const [editing, setEditing] = useState<{ task: TaskView; account: string | null; revision: string } | null>(null);
  // CAL-b: the item keys the calendar link file names, and the row whose sheet is open.
  const [calendarLinks, setCalendarLinks] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [calendar, setCalendar] = useState<CalendarTarget | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  // C3: Capture's Training and Check-in types open their own sheets from any screen.
  const [quickSheet, setQuickSheet] = useState<'training' | 'checkin' | null>(null);
  // D2: the value the last "+XP" float landed on the XP strip.
  const [xpLanding, setXpLanding] = useState<StripLanding | null>(null);
  const barRef = useRef<HTMLElement>(null);
  const largeTitle = useLargeTitleHost(barRef);
  // Review #8: every screen opens at its large title, not at the previous screen's scroll position.
  useEffect(() => { window.scrollTo(0, 0); }, [tab]);
  // ADR-0040: one bug/wish report from any screen; enqueued like every capture, so it works offline.
  const [reportOpen, setReportOpen] = useState(false);
  // The open note is bound to the account it was opened under: signing out or switching account closes it (the
  // render guard below hides it in the same frame; the effect drops the state).
  const [openLink, setOpenLink] = useState<(OpenLink & { account: string | null }) | null>(null);
  const closeNote = useCallback(() => setOpenLink(null), []);
  // ADR-0012: Overdue is its own group below Today, collapsed until the user opens it.
  const [overdueOpen, setOverdueOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const updateReady = useSyncExternalStore(subscribeUpdateReady, getUpdateReady);
  const [notice, setNotice] = useState<string | null>(null);
  // Discarded refusals whose tasks still need attention (attention.ts).
  const [unresolved, setUnresolved] = useState<readonly Unresolved[]>([]);
  // Task occurrences whose checkbox was tapped: disabled synchronously, before the envelope is even persisted (F19).
  // Keyed by occurrence, so an identical line elsewhere stays tappable (P4-B).
  const [tapped, setTapped] = useState<ReadonlySet<string>>(new Set());
  const tappedRef = useRef(new Set<string>());
  // AB3b: the Dashboard's AI usage panel is fed from App, so the Dashboard stays a pure read of what it is handed.
  const [aiUsage, setAiUsage] = useState<Fetched<AiUsageResponse> | null>(null);
  const [aiBudget, setAiBudget] = useState<Fetched<AiBudgetResponse> | null>(null);
  const [leaderboard, setLeaderboard] = useState<Fetched<LeaderboardResponse> | null>(null);

  const signedOut = sessionSignedOut || snapshot.signedOut;
  const noteOpen = openLink !== null && !signedOut && openLink.account === accountKey;
  useEffect(() => {
    if (openLink && !noteOpen) setOpenLink(null);
  }, [openLink, noteOpen]);
  useEffect(() => {
    if (editing && (signedOut || editing.account !== accountKey)) setEditing(null);
  }, [editing, signedOut, accountKey]);
  // SP3 (ADR-0038): any signed-out answer, not only one a read-only screen saw, drops every last copy.
  useEffect(() => { if (signedOut) lastCopies.clear(); }, [signedOut]);
  // AB3b: read the usage summary and the budget rows while the Boards view is on screen (only Boards shows them);
  // both are read-only. The old answer stays until the new one arrives, so a refresh never blanks the panel.
  useEffect(() => {
    if (signedOut) { setAiUsage(null); setAiBudget(null); setLeaderboard(null); return; }
    if (tab !== 'today' || todayView !== 'boards') return;
    let live = true;
    void getAiUsage().then((result) => { if (live) setAiUsage(result); });
    void getAiBudget().then((result) => { if (live) setAiBudget(result); });
    void getLeaderboard().then((result) => { if (live) setLeaderboard(result); });
    return () => { live = false; };
  }, [checkedAt, signedOut, tab, todayView]);
  // PERF-B: the Overview card stays mounted while Boards shows; it holds the last refresh it displayed, so a hidden
  // Overview re-reads once when shown again (if the refresh moved meanwhile), never on refreshes it never displayed.
  const overviewRefresh = useHeldWhileHidden(checkedAt, todayView === 'overview');
  // CAL-b: the calendar affordance exists only on the Tasks screens (Today/All) and only while signed in. The read is
  // re-checked whenever the task read is, so a link written elsewhere appears after the next refresh.
  const refreshCalendarLinks = useCallback(async () => {
    const res = await getCalendarLinks();
    setCalendarLinks(new Set(res.kind === 'ok' ? Object.keys(res.data.links) : []));
  }, []);
  useEffect(() => {
    if (!accountKey || signedOut || (tab !== 'tasks' && tab !== 'all')) return;
    void refreshCalendarLinks();
  }, [accountKey, signedOut, tab, checkedAt, refreshCalendarLinks]);
  const openCalendarForTask = useCallback((task: TaskView) => {
    const itemKey = taskCalendarKey(task.locator);
    setCalendar({ itemKey, text: task.description, due: task.due, scheduled: task.scheduled, linked: calendarLinks.has(itemKey) });
  }, [calendarLinks]);
  const openCalendarForActiveWork = useCallback((item: ActiveWorkItem) => {
    const itemKey = activeWorkCalendarKey(item.locator);
    setCalendar({ itemKey, text: item.name, due: item.review, scheduled: null, linked: calendarLinks.has(itemKey) });
  }, [calendarLinks]);
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

  const refreshSession = useMemo(() => coalescedRead(async () => {
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
  }), [queue]);

  // Consecutive stale reads (O6): a watermark no read ever contains again (e.g. history rewritten) would stall for ever.
  const staleRef = useRef(0);
  const [staleStreak, setStaleStreak] = useState(0);
  const refreshTasks = useMemo(() => coalescedRead(async () => {
    const reads = readsRef.current;
    if (!reads) return;
    setReadsInFlight((n) => n + 1);
    try {
      for (let attempt = 0; ; attempt++) {
        const out = await reads.read();
        switch (out.kind) {
          case 'apply': {
            setCheckedAt(Date.now());
            setReadFailed(false);
            prefs.setLastRevision(out.read.data.revision);
            prefetcher.maybePrefetch(prefs.lastAccountKey() ?? '', out.read.data.revision);
            staleRef.current = 0;
            setStaleStreak(0);
            const read = out.read;
            setRendered(read);
            // Acknowledging moves the watermark to this read's own revision (O1): the read still satisfies it.
            void queue.acknowledge(read.data).then((version) => {
              if (version !== null) setRendered((r) => (r === read ? { ...r, watermarkVersion: version } : r));
            });
            setConnection('online');
            return;
          }
          case 'superseded':
            return;
          case 'stale':
            setReadFailed(true);
            staleRef.current += 1;
            setStaleStreak(staleRef.current);
            setConnection('refreshing');
            if (out.retry && attempt < STALE_REREADS) continue;
            return;
          case 'signed-out':
            setReadFailed(true);
            setSessionSignedOut(true);
            queue.setSignedOut();
            return;
          default:
            setReadFailed(true);
            setConnection(out.kind === 'offline' ? 'offline' : 'error');
            return;
        }
      }
    } catch {
      setReadFailed(true);
      setConnection('error');
    } finally {
      setReadsInFlight((n) => n - 1);
    }
  }), [queue]);

  const wake = useCallback(
    (reason: ReadReason = 'wake') =>
      wakeUp({
        session: () => refreshSession(reason),
        kick: () => void queue.kick(),
        tasks: () => refreshTasks(reason),
        setConnection,
      }),
    [queue, refreshSession, refreshTasks],
  );

  // Start, `online`, focus: re-confirm the session, then retry the queue immediately.
  useEffect(() => {
    const onWake = () => void wake();
    onWake();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void wake();
    };
    const onOffline = () => setConnection('offline');
    window.addEventListener('online', onWake);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onWake);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [wake]);

  // A receipt means the server read may now include (or trail) the commit: re-read with `known=`.
  useEffect(() => {
    const onReceipt = () => void refreshTasks('receipt');
    receipts.addEventListener('receipt', onReceipt);
    return () => receipts.removeEventListener('receipt', onReceipt);
  }, [receipts, refreshTasks]);

  // Another tab evicted receipts under a newer watermark than the screen was checked against: read again.
  useEffect(() => {
    if (rendered && !fresh) void refreshTasks('receipt');
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

  // R2: refusals answer `false` synchronously, so the list plays its done moment only for an accepted completion;
  // the promise says whether the write was kept on the device.
  const complete = useCallback(
    (task: TaskView): boolean | Promise<boolean> => {
      const key = occurrenceKey(task.locator);
      if (tappedRef.current.has(key)) return false;
      if (!accountKey || !tasks) {
        setNotice('Connect once to set up this device.');
        return false;
      }
      if (tasks.writeBlock) return false; // every task-list write would be refused (writeBlock.ts)
      // Redoing the action on the task settles a discarded refusal of it.
      setUnresolved((list) => list.filter((u) => notRedoneBy(u, task, tasks.allOpen)));
      tappedRef.current.add(key);
      setTapped(new Set(tappedRef.current));
      return (async () => {
        try {
          const envelope = completeTask({ baseRevision: tasks.revision }, task.locator);
          const label = plainWikilinks(task.description);
          await queue.enqueue(envelope, { accountKey, label, taskKey: key });
          setToast({ target: envelope, label });
          return true;
        } catch {
          setNotice('Could not keep this action on the device.');
          return false;
        } finally {
          tappedRef.current.delete(key);
          setTapped(new Set(tappedRef.current));
        }
      })();
    },
    [accountKey, queue, tasks],
  );

  // UX8: Start on the Next up task opens that task's detail (the Tasks tab's ordinary edit sheet).
  const startTask = useCallback((task: TaskView) => {
    if (tasks) setEditing({ task, account: accountKey, revision: tasks.revision });
  }, [tasks, accountKey]);

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
  // GAM1-B: the four Log views share one segmented switch and the Character card above it.
  const logView = isLogView(tab);
  const selectLogView = (next: LogView) => { setLogFromCharacter(false); setTab(next); };
  // R3b: the Log tab reopens on the view last shown on this device (a chip, a Character ring or the tab itself).
  useEffect(() => { if (isLogView(tab)) prefs.setLogView(tab); }, [tab]);
  // ADR-0037 tokens: red = cannot work, yellow = something to see, green = settled.
  const statusDot = signedOut || readFailed || connection === 'error' || connection === 'offline'
    ? 'red'
    : needsAttention || readsInFlight > 0 || snapshot.items.some((i) => i.state !== 'saved')
      ? 'yellow'
      : 'green';
  const openStatus = () => {
    setStatusReturn((prev) => (tab === 'status' ? prev : tab));
    setTab('status');
  };
  // Review #8: Status and Radar are pushed screens; their Back sits in the bar where the status dot is.
  const barBack = tab === 'status' ? () => setTab(statusReturn)
    : tab === 'radar' ? () => { if (logFromCharacter) { setLogFromCharacter(false); setCharacterOpen(true); setTab('training'); } else setTab(radarReturn); }
    : null;
  // UX7: Research Radar is its own screen (no bottom-bar button), reached from Today or the Scouts link.
  const openRadar = useCallback(() => {
    setRadarReturn((prev) => (tab === 'radar' ? prev : tab));
    setTab('radar');
  }, [tab]);

  return (
    <LargeTitleProvider value={largeTitle.register}>
    <div className="app" data-tab={tab}>
      {/* Review #8: one bar on every tab. A stale or failed read is a chip there (it opens Status); pull to refresh. */}
      <TopBar barRef={barRef} back={barBack} dot={statusDot} busy={readsInFlight > 0} checkedAt={checkedAt} failed={readFailed}
        signedOut={signedOut} title={largeTitle.title} collapsed={largeTitle.collapsed}
        inert={noteOpen || editing !== null || characterOpen} reportDisabled={signedOut || writeBlocked || frozen}
        onStatus={openStatus} onReport={() => setReportOpen(true)} onRefresh={() => void refreshTasks()} />

      <main className="content" inert={noteOpen || editing !== null || characterOpen}>
        {(tab === 'tasks' || tab === 'all') && !signedOut && <LargeTitle>{tab === 'all' ? 'All tasks' : 'Tasks'}</LargeTitle>}
        {updateReady && <div className="banner" role="status"><button type="button" onClick={() => window.location.reload()}>New version — tap to reload</button></div>}
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
            <button type="button" onClick={() => void wake('refresh')}>
              Try again
            </button>
          </div>
        )}
        {!signedOut && staleStreak >= STALE_BEFORE_RESET && (
          <div className="banner banner-warn" role="alert">
            <span>
              Tasks can't be refreshed on this device: its saved-actions history no longer matches the vault. Resetting
              it keeps every pending action; a recently saved action may briefly show as not yet reflected.
            </span>
            <button
              type="button"
              onClick={() =>
                void queue.resetHistory().then(() => {
                  staleRef.current = 0;
                  setStaleStreak(0);
                  return refreshTasks();
                })
              }
            >
              Reset saved-actions history on this device
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

        {needsAttention && tab !== 'status' && tab !== 'radar' && (
          <ActionsPanel queue={queue} items={snapshot.items} read={tasks} onRefresh={() => refreshTasks()} onDiscard={discard} />
        )}

        {tab === 'status' && !signedOut && (
          <>
            <StatusSheet read={tasks} checkedAt={checkedAt} failed={readFailed} busy={readsInFlight > 0}
              onRefresh={() => refreshTasks()} accountKey={accountKey} queue={queue} items={snapshot.items} onDiscard={discard} />
          </>
        )}

        {tab === 'radar' && !signedOut && (
          <>
            <ResearchRadar accountKey={accountKey} refreshKey={checkedAt} blocked={writeBlocked || frozen} defaultOpen />
          </>
        )}

        {logView && !signedOut && (
          <>
            {logFromCharacter && <Back onBack={() => { setLogFromCharacter(false); setCharacterOpen(true); }} />}
            {/* R3b (review #9): one "Log" title, the Character strip, then the views as chips; no title repeats the chip. */}
            <LargeTitle className="log-title">Log</LargeTitle>
            <CharacterCard refreshKey={checkedAt} accountKey={accountKey} onOpen={() => setCharacterOpen(true)} />
            <LogViewChips view={isLogView(tab) ? tab : null} onSelect={selectLogView} />
          </>
        )}

        {tab === 'training' && !signedOut && <Training key={`training:${accountKey}`} refreshKey={checkedAt} accountKey={accountKey} queue={queue} baseRevision={revision} onAdd={() => setCaptureOpen(true)} />}
        {tab === 'history' && !signedOut && (
          <Progress key={`history:${accountKey}`} refreshKey={checkedAt} queue={queue} queued={snapshot.items}
            accountKey={accountKey} baseRevision={revision} blocked={writeBlocked} onReopen={(target, label) => void undo(target, label)} onOpenLink={openNote} />
        )}

        {tab === 'health' && !signedOut && <HealthPanel key={`health:${accountKey}`} refreshKey={checkedAt} accountKey={accountKey} />}

        {tab === 'learning' && !signedOut && <Learning key={`learning:${accountKey}`} refreshKey={checkedAt} accountKey={accountKey} onAdd={() => setCaptureOpen(true)} />}

        {tab === 'reading' && !signedOut && <Reading key={`reading:${accountKey}`} refreshKey={checkedAt} accountKey={accountKey} queue={queue} baseRevision={revision} open={captureOpen} onClose={() => setCaptureOpen(false)} />}

        {tab === 'notes' && !signedOut && <Notes key={`notes:${accountKey}`} refreshKey={checkedAt} queue={queue} items={snapshot.items}
          accountKey={accountKey} baseRevision={revision} />}

        {/* Scouts is now also where triage lives (UX2), so its indicator and dialog mount here. */}
        {tab === 'scouts' && !signedOut && (
          <>
            <Scouts key={`scouts:${accountKey}`} page onOpen={() => setTab('scouts')} refreshKey={checkedAt} accountKey={accountKey} blocked={writeBlocked || frozen} onOpenRadar={openRadar}
              belowTitle={<Triage key={`triage:${accountKey}`} queue={queue} items={snapshot.items} accountKey={accountKey} refreshKey={checkedAt} blocked={writeBlocked || frozen} />} />
          </>
        )}

        {/* UX8 layout C: the Today title with the Overview/Boards switch. Overview leads with the Next up pick and the
            data-driven tile grid; Boards holds the dashboard stack (markets/watchlist, detailed weather, AI usage) and
            the scout diagnostics entry. Nothing was deleted: every detail the old card linked to is still reachable. */}
        {tab === 'today' && !signedOut && (
          <>
            <div className="today-head">
              <LargeTitle className="today-title">Today</LargeTitle>
              <div className="segmented today-view" role="group" aria-label="Today view">
                <button type="button" aria-pressed={todayView === 'overview'} onClick={() => setTodayView('overview')}>Overview</button>
                <button type="button" aria-pressed={todayView === 'boards'} onClick={() => setTodayView('boards')}>Boards</button>
              </div>
            </div>
            {/* PERF-B: always mounted, hidden while Boards shows - switching back does not remount it; the held refresh
                key re-reads it once when it is shown again. */}
            <div hidden={todayView !== 'overview'}>
              <MorningCard key={`morning-card:${accountKey}`} queue={queue} items={snapshot.items} accountKey={accountKey}
                baseRevision={revision} blocked={writeBlocked || frozen} refreshKey={overviewRefresh} tasks={view.today}
                onStartTask={startTask} onAdd={() => setCaptureOpen(true)}
                onOpenTasks={() => setTab('tasks')} onOpenScouts={() => setTab('scouts')} onOpenRadar={openRadar}
                onOpenHealth={() => setTab('health')} onOpenStatus={openStatus} />
            </div>
            {todayView === 'boards' && (
              <>
                {/* After the first read settles: mounted earlier, its reads repeat as the account and checkedAt arrive. */}
                {(checkedAt !== null || readFailed) && <Dashboard key={`dashboard:${accountKey}`} refreshKey={checkedAt} accountKey={accountKey} aiUsage={aiUsage} aiBudget={aiBudget} leaderboard={leaderboard} />}
                <ScoutDiagnostics key={`scout-diagnostics:${accountKey}`} refreshKey={checkedAt} accountKey={accountKey} onOpenScouts={() => setTab('scouts')} />
              </>
            )}
          </>
        )}

        {connection === 'loading' && !tasks && <p className="muted">Loading…</p>}
        {connection !== 'loading' && !tasks && (connection === 'refreshing' || rendered) && (
          <p className="muted">Refreshing…</p>
        )}

        {tasks && lock?.conflict && <p className="muted small">{FROZEN_NOTE}</p>}
        {(tab === 'tasks' || tab === 'all') && !signedOut && (
          <div className="segmented task-view" role="group" aria-label="Task view">
            <button type="button" aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}>Today</button>
            <button type="button" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>All</button>
          </div>
        )}
        {tab === 'tasks' && !signedOut && <ActiveWorkCard key={accountKey} revision={tasks?.revision ?? null} queue={queue} accountKey={accountKey} onOpenLink={openNote} calendarLinks={calendarLinks} onCalendar={openCalendarForActiveWork} />}
        {tasks && tab === 'tasks' && (
          <>
            <TaskList title="Today" rows={view.today} tapped={tapped} blocked={writeBlocked} frozen={frozen} onComplete={complete} onEdit={(task) => tasks && setEditing({ task, account: accountKey, revision: tasks.revision })} onOpenLink={openNote} calendarLinks={calendarLinks} onCalendar={openCalendarForTask} empty="Nothing due today." />
            <TaskList
              title="Overdue"
              rows={view.overdue}
              tapped={tapped}
              blocked={writeBlocked}
              frozen={frozen}
              onComplete={complete} onEdit={(task) => tasks && setEditing({ task, account: accountKey, revision: tasks.revision })}
              onOpenLink={openNote}
              calendarLinks={calendarLinks}
              onCalendar={openCalendarForTask}
              overdue
              collapsible={{
                open: overdueOpen,
                summary: overdueSummary(view.overdue.length),
                onToggle: () => setOverdueOpen((open) => !open),
              }}
            />
            <TaskList title="Done today" rows={view.doneToday} tapped={tapped} blocked frozen={frozen} onComplete={complete} onEdit={(task) => tasks && setEditing({ task, account: accountKey, revision: tasks.revision })} onUndo={undo} onOpenLink={openNote} />
          </>
        )}
        {tasks && tab === 'all' && (
          <TaskList title="All tasks" rows={view.all} tapped={tapped} blocked={writeBlocked} frozen={frozen} onComplete={complete} onEdit={(task) => tasks && setEditing({ task, account: accountKey, revision: tasks.revision })} onOpenLink={openNote} calendarLinks={calendarLinks} onCalendar={openCalendarForTask} empty="No open tasks." />
        )}

        {/* B2: on the tabs where actions are taken; an action needing attention shows on every tab (above). */}
        {!needsAttention && ACTION_TABS.has(tab) && (
          <ActionsPanel queue={queue} items={snapshot.items} read={tasks} onRefresh={() => refreshTasks()} onDiscard={discard} />
        )}
      </main>

      {/* D2: the XP strip rides on the tab bar on every screen, fed by the same /api/game read as the Log card. */}
      <CharacterRead refreshKey={checkedAt} accountKey={accountKey}>
        {({ data }) => (
          <TabBar tab={tab} onSelect={(next) => { setLogFromCharacter(false); setTab(next); }} inert={noteOpen || editing !== null || characterOpen}
            level={signedOut ? null : data?.character.level ?? null}
            strip={!signedOut && <XpStrip read={data?.character ?? null} landing={xpLanding} />}
            onHoldLog={signedOut ? undefined : () => setCharacterOpen(true)} logTo={prefs.logView()} />
        )}
      </CharacterRead>

      <CaptureFab tab={tab} inert={noteOpen || editing !== null || characterOpen} onClick={() => setCaptureOpen(true)} />

      {editing && editing.account === accountKey && !signedOut && (
        <EditSheet queue={queue} task={editing.task} accountKey={accountKey} baseRevision={editing.revision}
          blocked={writeBlocked} onClose={() => setEditing(null)} />
      )}
      {characterOpen && !signedOut && (
        <CharacterSheet refreshKey={checkedAt} accountKey={accountKey}
          onClose={() => setCharacterOpen(false)}
          onOpenProfession={(destination) => { setCharacterOpen(false); setLogFromCharacter(true); setTab(destination as Tab); }} />
      )}
      {((captureOpen && tab === 'training') || quickSheet === 'training') && !signedOut && <TrainingSheet key={accountKey} queue={queue} accountKey={accountKey} baseRevision={revision} onClose={() => { setCaptureOpen(false); setQuickSheet(null); }} />}
      {quickSheet === 'checkin' && !signedOut && (
        <CheckinSheet key={accountKey} queue={queue} items={snapshot.items} accountKey={accountKey} baseRevision={revision}
          blocked={writeBlocked || frozen} onClose={() => setQuickSheet(null)} />
      )}
      {captureOpen && tab === 'learning' && !signedOut && <LearningSheet key={accountKey} queue={queue} accountKey={accountKey} baseRevision={revision} onClose={() => setCaptureOpen(false)} />}
      {reportOpen && !signedOut && (
        <ReportSheet key={accountKey} queue={queue} accountKey={accountKey} baseRevision={revision} screen={screenName(tab)} onClose={() => setReportOpen(false)} />
      )}
      {captureOpen && tab !== 'training' && tab !== 'learning' && tab !== 'reading' && (
        <CaptureSheet
          defaultKind={captureDefaultForTab(tab)}
          queue={queue}
          drafts={drafts}
          accountKey={accountKey}
          baseRevision={revision}
          taskBlocked={lock ? lock.banner : null}
          onSwitch={signedOut ? undefined : (to) => { setCaptureOpen(false); setQuickSheet(to); }}
          onClose={() => setCaptureOpen(false)}
        />
      )}

      {calendar && !signedOut && (
        <CalendarSheet key={calendar.itemKey} target={calendar} accountKey={accountKey}
          onClose={() => setCalendar(null)}
          onSaved={() => { setCalendar(null); void refreshCalendarLinks(); }} />
      )}

      {noteOpen && <NoteView link={openLink} onClose={closeNote} />}

      {/* GAM1-C: a quiet achievements toast on any tab; it reads /api/game once per open and never takes focus. */}
      <RewardLayer accountKey={accountKey} signedOut={signedOut} items={snapshot.items} onOpenCharacter={() => setCharacterOpen(true)}
        onXpLanded={(value) => setXpLanding({ value, at: Date.now() })} />
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
    </LargeTitleProvider>
  );
}

/** The one way back from a header screen (Status). */
function Back({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="link back" onClick={onBack}>
      ‹ Back
    </button>
  );
}
