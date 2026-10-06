// UX2/UX7/UX8: the Today Overview (layout C). A single "Next up" card, then a data-driven two-column tile grid
// (Morning Brief, Needs you, Weather, Research), the collapsed Since I was here pane above it, and the check-in line.
// Each tile opens a detail the app already has (the brief sheet, the Needs you sheet, the morning weather panel, the
// Radar screen); the grid renders the pure `todayTiles` list, so more tiles need no layout change. No new read: the
// card projects the reads it already holds.
import type { ActiveWorkResponse, HealthResponse, MorningBriefReadResponse, MorningResponse, RadarResponse, ScoutsResponse, TaskView, TriageResponse, WeatherResponse } from '@vault-companion/contracts';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getActiveWork, getMorning, getMorningBrief, getRadar, getScouts, getTriage, getWeather, type Fetched } from '../api.ts';
import { lastCopies } from '../lastCopy.ts';
import { prefs } from '../prefs.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { deriveTriage } from '../triage.ts';
import { localDate, MoodCard } from './MoodCard.tsx';
import { SheetHeader } from './SheetHeader.tsx';
import { NeedsYouSheet } from './NeedsYouSheet.tsx';
import { liveDismissals, needsYou, needsYouText, sameDismissals, type NeedsYouFacts, type NeedsYouRow, type NeedsYouTarget } from './needs-you.ts';
import { SinceIWasHere } from './SinceIWasHere.tsx';
import { sinceIWasHereFacts, type SiwhTarget } from './since-i-was-here.ts';
import { WeatherMorning } from './WeatherLab.tsx';
import { checkinDue, isMissingBrief, morningBriefSheet, radarHighlights, researchHighlightsText, weatherLine, type MorningBriefSheetState } from './morning-card.ts';
import { moreTasksText, selectNextUp, todayTiles, tileTitleColors, type NextUp, type NextUpEvent } from './today.ts';

export interface MorningCardProps {
  queue: PendingQueue;
  items: readonly QueueItem[];
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
  refreshKey: number | null;
  /** Today's task rows, in the app's own order; reused for the pick and the "more tasks" line, never listed here. */
  tasks: readonly TodayTaskRow[];
  onStartTask: (task: TaskView) => void;
  onAdd: () => void;
  onOpenTasks: () => void;
  onOpenScouts: () => void;
  onOpenRadar: () => void;
  onOpenHealth: () => void;
  onOpenStatus: () => void;
}

/** The slice of a Today row the pick needs: a description and, when the row is a live server task, its TaskView. */
export interface TodayTaskRow {
  readonly key: string;
  readonly description: string;
  readonly task: TaskView | null;
}

/** The event row's wall clock in its own offset; never the device's zone (the brief does the same for its gaps). */
const eventTime = (start: string): string => start.slice(11, 16);

export function MorningCard({ queue, items, accountKey, baseRevision, blocked, refreshKey, tasks, onStartTask, onAdd, onOpenTasks, onOpenScouts, onOpenRadar, onOpenHealth, onOpenStatus }: MorningCardProps) {
  const [weather, setWeather] = useState<Fetched<WeatherResponse> | null>(null);
  const [scouts, setScouts] = useState<Fetched<ScoutsResponse> | null>(null);
  const [morning, setMorning] = useState<Fetched<MorningResponse> | null>(null);
  const [brief, setBrief] = useState<Fetched<MorningBriefReadResponse> | null>(null);
  const [radar, setRadar] = useState<Fetched<RadarResponse> | null>(null);
  const [triage, setTriage] = useState<TriageResponse | null>(null);
  const [activeWork, setActiveWork] = useState<Fetched<ActiveWorkResponse> | null>(null);
  const [open, setOpen] = useState<'weather' | null>(null);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [today, setToday] = useState(localDate);
  useEffect(() => {
    const update = () => setToday(localDate());
    const timer = window.setInterval(update, 1000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  const [needsOpen, setNeedsOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  // NY3: device-held dismissals for the Needs you scout rows; copied out of prefs so a dismissal re-renders at once.
  const [dismissedScouts, setDismissedScouts] = useState<Record<string, string>>(() => prefs.needsYouDismissed());

  // The Today panels' own reads, plus the Tasks tab's Active Work read (reused for Needs you); no new endpoint.
  useEffect(() => {
    if (!accountKey) return;
    let live = true;
    void getScouts().then((value) => { if (live) setScouts(value); });
    void getMorning().then((value) => { if (live) setMorning(value); });
    void getMorningBrief().then((value) => { if (live) setBrief(value); });
    void getRadar().then((value) => { if (live) setRadar(value); });
    void getTriage().then((value) => { if (live && value.kind === 'ok') setTriage(value.data); });
    void getActiveWork().then((value) => { if (live) setActiveWork(value); });
    return () => { live = false; };
  }, [refreshKey, accountKey]);
  useEffect(() => {
    if (!accountKey || blocked || document.visibilityState === 'hidden' || !navigator.onLine) return;
    let live = true;
    void getWeather().then((value) => { if (live) setWeather(value); });
    return () => { live = false; };
  }, [refreshKey, accountKey, blocked]);

  const triageView = triage ? deriveTriage(triage, items, accountKey) : null;
  // UX8: the pick's event slice (the triage cards, which carry the event's own start) and the ids the pane tracks.
  const triageEvents: NextUpEvent[] = triageView
    ? triageView.cards.map((card) => ({ eventId: card.eventId, title: card.title, start: card.start }))
    : [];
  // Event ids, not just the count: a card handled elsewhere then replaced by a new one on the same count is new.
  const triageIds = triageView ? [...triageView.cards.map((card) => card.eventId), ...triageView.checkins.map((checkin) => checkin.eventId)] : [];
  // UX7: the Morning Brief sheet's own state - a usable brief for today, or the ADR-0055 "No brief yet" reason.
  const briefData = brief !== null && brief.kind === 'ok' ? brief.data : null;
  const briefFile = briefData !== null && !isMissingBrief(briefData) ? briefData : null;
  const briefSheet = morningBriefSheet(briefData, localDate());
  const scoutData = scouts?.kind === 'ok' ? scouts.data : null;
  // NY3: drop a stored dismissal once its scout recovers (or its text changes), so a later failure shows again.
  useEffect(() => {
    const live = liveDismissals(dismissedScouts, scoutData);
    if (sameDismissals(dismissedScouts, live)) return;
    prefs.setNeedsYouDismissed(live);
    setDismissedScouts(live);
  }, [dismissedScouts, scoutData]);
  // NY1: the same `attention` state the Actions panel counts; the queue read itself is not repeated here.
  const needsFacts: NeedsYouFacts = {
    scouts: scoutData,
    activeWork: activeWork?.kind === 'ok' && activeWork.data.status === 'ok' ? activeWork.data : null,
    eventsToTriage: triageIds.length,
    actionsNeedingAttention: items.filter((item) => item.state === 'attention').length,
    dismissedScouts,
  };
  const needsRows = needsYou(needsFacts, localDate());
  // UX8: the single pick - the next commitment today, else today's first task, else a quiet empty state.
  const pick: NextUp<TodayTaskRow> = selectNextUp(triageEvents, tasks, localDate(), new Date().toISOString());
  const moreCount = pick.kind === 'task' ? tasks.length - 1 : tasks.length;
  const weatherTile = weather?.kind === 'ok'
    ? (weather.data.status === 'ok' ? weatherLine(weather.data.projection) : weather.data.message)
    : weather !== null ? 'Weather unavailable' : null;
  const researchCount = radar?.kind === 'ok' ? radarHighlights(radar.data) : null;
  const tiles = todayTiles({
    brief: briefFile ? briefFile.brief.dayLine : briefSheet.missing ?? 'No brief yet',
    needs: needsRows.length > 0 ? needsYouText(needsRows.length) : null,
    weather: weatherTile,
    research: researchCount === null ? null : researchHighlightsText(researchCount),
  });
  // SIWH: the same reads the card already holds, narrowed to counts and keys. No read is added for the pane; the health
  // day comes from the app's in-memory last copy (populated when the Health screen has been visited this session).
  const siwhFacts = sinceIWasHereFacts({
    triage: triageView ? triageIds : null,
    scouts: scoutData,
    brief: briefFile,
    morning: morning !== null && morning.kind === 'ok' ? morning.data : null,
    health: lastCopies.get<HealthResponse>(accountKey, 'health')?.data ?? null,
    today: localDate(),
  });

  function openTile(id: string) {
    if (id === 'brief') return setBriefOpen(true);
    if (id === 'needs') return setNeedsOpen(true);
    if (id === 'research') return onOpenRadar();
    setOpen((current) => (current === 'weather' ? null : 'weather'));
  }

  function openNeedsTarget(target: NeedsYouTarget) {
    if (target.kind === 'scouts' || target.kind === 'triage') return onOpenScouts();
    if (target.kind === 'actions') return onOpenStatus();
  }

  function openSiwh(target: SiwhTarget) {
    if (target === 'health') return onOpenHealth();
    if (target === 'papers') return onOpenRadar();
    onOpenScouts();
  }

  // NY3: "Got it" remembers the row id and the error text; the row returns only when that text changes.
  function dismissNeedsRow(row: NeedsYouRow) {
    const next = { ...dismissedScouts, [row.id]: row.why };
    prefs.setNeedsYouDismissed(next);
    setDismissedScouts(next);
  }

  const due = checkinDue(items, today);
  useEffect(() => { if (!due) setCheckinOpen(false); }, [due]);
  return <>
    <SinceIWasHere facts={siwhFacts} onOpen={openSiwh} />
    <section className="group morning-card today-overview" aria-label="Today at a glance">
      <NextUpCard pick={pick} moreText={moreTasksText(moreCount)} onStartTask={onStartTask} onStartEvent={() => onOpenScouts()} onOpenTasks={onOpenTasks} onAdd={onAdd} />
      {due && (!checkinOpen
        ? <button type="button" className="checkin-line" onClick={() => setCheckinOpen(true)}>How are you today? Check in</button>
        : <MoodCard queue={queue} items={items} accountKey={accountKey} baseRevision={baseRevision} blocked={blocked} />)}
      <div className="tile-grid" role="group" aria-label="Today tiles">
        {tiles.map((tile) => (
          <button key={tile.id} type="button" className={`tile tile-${tile.id}`} aria-label={tile.label} style={tileTitleColors(tile.id) as CSSProperties} onClick={(event) => { event.currentTarget.focus(); openTile(tile.id); }}>
            <span className="tile-title">{tile.title}</span>
            <span className="tile-text">{tile.text}</span>
          </button>
        ))}
      </div>
      {open === 'weather' && <WeatherMorning refreshKey={refreshKey} accountKey={accountKey} blocked={blocked} />}
    </section>
    {needsOpen && <NeedsYouSheet rows={needsRows} queue={queue} accountKey={accountKey} onNavigate={openNeedsTarget} onDismiss={dismissNeedsRow} onClose={() => setNeedsOpen(false)} />}
    {briefOpen && <MorningBriefSheet state={brief === null ? { missing: 'Loading brief…', lines: [] } : brief.kind !== 'ok' ? { missing: 'Brief unavailable. Try Refresh in Status.', lines: [] } : briefSheet} onOpenTasks={onOpenTasks}
      onClose={() => setBriefOpen(false)} />}

  </>;
}

/** The one prominent card: the pick and its Start action, then the quiet "N more tasks today" line to the Tasks tab. */
function NextUpCard({ pick, moreText, onStartTask, onStartEvent, onOpenTasks, onAdd }: {
  pick: NextUp<TodayTaskRow>; moreText: string; onStartTask: (task: TaskView) => void; onStartEvent: () => void;
  onOpenTasks: () => void; onAdd: () => void;
}) {
  return (
    <section className="next-up" aria-label="Next up">
      {pick.kind === 'none'
        ? <>
            <p className="next-up-empty">Nothing planned</p>
            <button type="button" className="link next-up-add" onClick={onAdd}>Add a task</button>
          </>
        : <>
            <p className="next-up-eyebrow">Next up</p>
            <p className="next-up-title">{pick.kind === 'event' ? pick.event.title : pick.task.description}</p>
            {pick.kind === 'event' && <p className="next-up-time muted small">{eventTime(pick.event.start)}</p>}
            <button type="button" className="next-up-start" onClick={() => {
              if (pick.kind === 'event') return onStartEvent();
              // An overlay row has no live TaskView to edit; the Tasks tab is its detail instead.
              return pick.task.task ? onStartTask(pick.task.task) : onOpenTasks();
            }}>Start</button>
          </>}
      <button type="button" className="link next-up-more" onClick={onOpenTasks}>{moreText}</button>
    </section>
  );
}

/** The brief only; all content uses the reads already held by Today. */
function MorningBriefSheet({ state, onOpenTasks, onClose }: {
  state: MorningBriefSheetState;
  onOpenTasks: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const invoker = document.activeElement;
    dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => { if (invoker instanceof HTMLElement) invoker.focus(); };
  }, []);
  return (
    <div className="sheet-backdrop" role="presentation">
      <div ref={dialog} className="sheet morning-brief-sheet" role="dialog" aria-modal="true" aria-label="Morning Brief"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key !== 'Tab') return;
          const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
          const first = controls?.[0];
          const last = controls?.[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }}>
        <SheetHeader title="Morning Brief" onClose={onClose} />
        {state.missing !== null
          ? <p className="muted">{state.missing}</p>
          : state.lines.map((row) => (row.todo
            ? <button key={row.id} type="button" className="morning-line morning-brief-line"
                onClick={() => { onOpenTasks(); onClose(); }}>{row.text}</button>
            : row.heading ? <h3 key={row.id}>{row.text}</h3>
            : <div key={row.id} className={`morning-line morning-brief-line${row.marker ? ' morning-brief-marker' : ''}`}
                style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                {row.text}
                {row.clash && <div><strong>{row.clash}</strong></div>}
                {row.link && <a href={row.link} target="_blank" rel="noopener noreferrer"
                  style={{ display: 'flex', alignItems: 'center', minHeight: 44 }}>Open in Calendar</a>}
              </div>))}

      </div>
    </div>
  );
}
