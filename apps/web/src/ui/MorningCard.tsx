// UX2: the Today cockpit's compact morning card. A "Needs you" line (NY1), then up to four one-liners plus the tasks
// line, each tapping through to its detail; weather opens its panel inline, scouts and events open the Scouts tab, and
// the one research entry opens Research Radar as its own screen. Below it the check-in line, once there is no check-in.
// UX7 replaces "Review my morning" with a Morning Brief button that opens the whole brief, its Reading section and a
// link to Research Radar.
import type { ActiveWorkResponse, HealthResponse, MorningBriefReadResponse, MorningResponse, RadarResponse, ScoutsResponse, TriageResponse, WeatherResponse } from '@vault-companion/contracts';
import { useEffect, useRef, useState } from 'react';
import { getActiveWork, getMorning, getMorningBrief, getRadar, getScouts, getTriage, getWeather, type Fetched } from '../api.ts';
import { lastCopies } from '../lastCopy.ts';
import { prefs } from '../prefs.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { dateIn } from '../time.ts';
import { deriveTriage } from '../triage.ts';
import { localDate, MoodCard } from './MoodCard.tsx';
import { Morning } from './Morning.tsx';
import { NeedsYouSheet } from './NeedsYouSheet.tsx';
import { liveDismissals, needsYou, sameDismissals, type NeedsYouFacts, type NeedsYouRow, type NeedsYouTarget } from './needs-you.ts';
import { SinceIWasHere } from './SinceIWasHere.tsx';
import { sinceIWasHereFacts, type SiwhTarget } from './since-i-was-here.ts';
import { WeatherMorning } from './WeatherLab.tsx';
import { checkinDue, isMissingBrief, morningBriefSheet, morningLines, radarHighlights, type MorningBriefSheetState, type MorningLineId } from './morning-card.ts';

export interface MorningCardProps {
  queue: PendingQueue;
  items: readonly QueueItem[];
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
  refreshKey: number | null;
  tasksToday: number;
  onOpenTasks: () => void;
  onOpenScouts: () => void;
  onOpenRadar: () => void;
  onOpenHealth: () => void;
  onOpenStatus: () => void;
}

export function MorningCard({ queue, items, accountKey, baseRevision, blocked, refreshKey, tasksToday, onOpenTasks, onOpenScouts, onOpenRadar, onOpenHealth, onOpenStatus }: MorningCardProps) {
  const [weather, setWeather] = useState<Fetched<WeatherResponse> | null>(null);
  const [scouts, setScouts] = useState<Fetched<ScoutsResponse> | null>(null);
  const [morning, setMorning] = useState<Fetched<MorningResponse> | null>(null);
  const [brief, setBrief] = useState<Fetched<MorningBriefReadResponse> | null>(null);
  const [radar, setRadar] = useState<Fetched<RadarResponse> | null>(null);
  const [triage, setTriage] = useState<TriageResponse | null>(null);
  const [activeWork, setActiveWork] = useState<Fetched<ActiveWorkResponse> | null>(null);
  const [open, setOpen] = useState<MorningLineId | null>(null);
  const [checkinOpen, setCheckinOpen] = useState(false);
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
  // UX7: the Morning Brief sheet's own state - a usable brief for today, or the ADR-0055 "No brief yet" reason.
  const briefData = brief !== null && brief.kind === 'ok' ? brief.data : null;
  const briefFile = briefData !== null && !isMissingBrief(briefData) ? briefData : null;
  const briefSheet = morningBriefSheet(briefData, localDate());
  const eventsToTriage = triageView ? triageView.cards.length + triageView.checkins.length : 0;
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
    eventsToTriage,
    actionsNeedingAttention: items.filter((item) => item.state === 'attention').length,
    dismissedScouts,
  };
  const needsRows = needsYou(needsFacts, dateIn(new Date().toISOString(), 'Europe/Copenhagen'));
  const lines = morningLines({
    weather: weather?.kind === 'ok' ? weather.data : null,
    weatherFailed: weather !== null && weather.kind !== 'ok',
    scouts: scouts?.kind === 'ok' ? scouts.data : null,
    eventsToTriage,
    tasksToday,
    researchHighlights: radar?.kind === 'ok' ? radarHighlights(radar.data) : null,
    needs: needsRows,
  });
  // SIWH: the same reads the card already holds, narrowed to counts and keys. No read is added for the pane; the health
  // day comes from the app's in-memory last copy (populated when the Health screen has been visited this session).
  const siwhFacts = sinceIWasHereFacts({
    // Event ids, not just the count: a card handled elsewhere then replaced by a new one on the same count is new.
    triage: triageView ? [...triageView.cards.map((card) => card.eventId), ...triageView.checkins.map((checkin) => checkin.eventId)] : null,
    scouts: scoutData,
    brief: briefFile,
    morning: morning !== null && morning.kind === 'ok' ? morning.data : null,
    health: lastCopies.get<HealthResponse>(accountKey, 'health')?.data ?? null,
    today: localDate(),
  });

  function openLine(id: MorningLineId) {
    if (id === 'needs') return setNeedsOpen(true);
    if (id === 'tasks') return onOpenTasks();
    if (id === 'scouts' || id === 'triage') return onOpenScouts();
    if (id === 'research') return onOpenRadar();
    setOpen((current) => (current === id ? null : id));
  }

  function openNeedsTarget(target: NeedsYouTarget) {
    if (target.kind === 'scouts' || target.kind === 'triage') return onOpenScouts();
    if (target.kind === 'actions') return onOpenStatus();
  }

  function openSiwh(target: SiwhTarget) {
    if (target === 'health') return onOpenHealth();
    if (target === 'papers') return setBriefOpen(true);
    onOpenScouts();
  }

  // NY3: "Got it" remembers the row id and the error text; the row returns only when that text changes.
  function dismissNeedsRow(row: NeedsYouRow) {
    const next = { ...dismissedScouts, [row.id]: row.why };
    prefs.setNeedsYouDismissed(next);
    setDismissedScouts(next);
  }

  const due = checkinDue(items);
  return <>
    <SinceIWasHere facts={siwhFacts} onOpen={openSiwh} />
    <section className="group morning-card" aria-label="Today at a glance">
      <button type="button" className="morning-line morning-brief-open" onClick={() => setBriefOpen(true)}>Morning Brief</button>
      {lines.map((line) => {
        const expands = line.id === 'weather';
        return <button key={line.id} type="button" className={`morning-line morning-line-${line.id}`}
          aria-expanded={expands ? open === line.id : undefined} onClick={() => openLine(line.id)}>{line.text}</button>;
      })}
      {open === 'weather' && <WeatherMorning refreshKey={refreshKey} accountKey={accountKey} blocked={blocked} />}
    </section>
    {needsOpen && <NeedsYouSheet rows={needsRows} queue={queue} accountKey={accountKey} onNavigate={openNeedsTarget} onDismiss={dismissNeedsRow} onClose={() => setNeedsOpen(false)} />}
    {briefOpen && <MorningBriefSheet state={briefSheet} refreshKey={refreshKey} onOpenTasks={onOpenTasks}
      onOpenRadar={onOpenRadar} onClose={() => setBriefOpen(false)} />}
    {due && !checkinOpen
      ? <button type="button" className="checkin-line" onClick={() => setCheckinOpen(true)}>How are you today? Check in</button>
      : <MoodCard queue={queue} items={items} accountKey={accountKey} baseRevision={baseRevision} blocked={blocked} />}
  </>;
}

/**
 * UX7: the Morning Brief sheet. It shows the whole brief (day, state, gaps, to-dos, encouragement) or the "No brief
 * yet" reason, plus a Reading section (the day's reading brief and explanations, the content the old card line opened)
 * and a link to Research Radar. To-dos open Tasks; the Radar link opens the Radar screen. No new read: the card passes
 * its already-loaded brief state, and Reading reuses the existing read-only panel.
 */
function MorningBriefSheet({ state, refreshKey, onOpenTasks, onOpenRadar, onClose }: {
  state: MorningBriefSheetState;
  refreshKey: number | null;
  onOpenTasks: () => void;
  onOpenRadar: () => void;
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
          const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
          const first = controls?.[0];
          const last = controls?.[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }}>
        <h2>Morning Brief</h2>
        {state.missing !== null
          ? <p className="muted">{state.missing}</p>
          : state.lines.map((row) => (row.todo
            ? <button key={row.id} type="button" className="morning-line morning-brief-line"
                onClick={() => { onOpenTasks(); onClose(); }}>{row.text}</button>
            : <p key={row.id} className={`morning-line morning-brief-line${row.marker ? ' morning-brief-marker' : ''}`}>{row.text}</p>))}
        <section className="morning-brief-reading" aria-label="Reading">
          <h3>Reading</h3>
          <Morning refreshKey={refreshKey} startOpen />
          <button type="button" className="link morning-brief-radar" onClick={() => { onOpenRadar(); onClose(); }}>Research Radar</button>
        </section>
        <div className="sheet-buttons">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
