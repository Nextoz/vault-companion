// UX2: the Today cockpit's compact morning card. A "Needs you" line (NY1), then up to four one-liners plus the tasks
// line, each tapping through to its detail; weather and papers open the existing panels inline, scouts and events open
// the Scouts tab where their detail (and triage) now lives. Below it the check-in line, once today has no check-in.
// NY2 adds "Review my morning": a guided step-through sheet over the brief, the NY1 rows and today's open tasks.
import type { ActiveWorkResponse, MorningBriefResponse, MorningResponse, ScoutsResponse, TaskView, TriageResponse, WeatherResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getActiveWork, getMorning, getMorningBrief, getScouts, getTriage, getWeather, type Fetched } from '../api.ts';
import { prefs } from '../prefs.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { dateIn } from '../time.ts';
import { deriveTriage } from '../triage.ts';
import { localDate, MoodCard } from './MoodCard.tsx';
import { Morning } from './Morning.tsx';
import { MorningReviewSheet } from './MorningReviewSheet.tsx';
import { NeedsYouSheet } from './NeedsYouSheet.tsx';
import { liveDismissals, needsYou, sameDismissals, type NeedsYouFacts, type NeedsYouRow, type NeedsYouTarget } from './needs-you.ts';
import { WeatherMorning } from './WeatherLab.tsx';
import { briefLines, checkinDue, morningLines, type MorningLineId } from './morning-card.ts';

export interface MorningCardProps {
  queue: PendingQueue;
  items: readonly QueueItem[];
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
  refreshKey: number | null;
  tasksToday: number;
  /** The vault's open tasks and calendar date, from the read the App already holds (NY2 pick step). */
  openTasks: readonly TaskView[];
  today: string;
  onOpenTasks: () => void;
  onOpenScouts: () => void;
  onOpenStatus: () => void;
}

export function MorningCard({ queue, items, accountKey, baseRevision, blocked, refreshKey, tasksToday, openTasks, today, onOpenTasks, onOpenScouts, onOpenStatus }: MorningCardProps) {
  const [weather, setWeather] = useState<Fetched<WeatherResponse> | null>(null);
  const [scouts, setScouts] = useState<Fetched<ScoutsResponse> | null>(null);
  const [morning, setMorning] = useState<Fetched<MorningResponse> | null>(null);
  const [brief, setBrief] = useState<Fetched<MorningBriefResponse> | null>(null);
  const [triage, setTriage] = useState<TriageResponse | null>(null);
  const [activeWork, setActiveWork] = useState<Fetched<ActiveWorkResponse> | null>(null);
  const [open, setOpen] = useState<MorningLineId | null>(null);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [needsOpen, setNeedsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // NY3: device-held dismissals for the Needs you scout rows; copied out of prefs so a dismissal re-renders at once.
  const [dismissedScouts, setDismissedScouts] = useState<Record<string, string>>(() => prefs.needsYouDismissed());

  // The Today panels' own reads, plus the Tasks tab's Active Work read (reused for Needs you); no new endpoint.
  useEffect(() => {
    if (!accountKey) return;
    let live = true;
    void getScouts().then((value) => { if (live) setScouts(value); });
    void getMorning().then((value) => { if (live) setMorning(value); });
    void getMorningBrief().then((value) => { if (live) setBrief(value); });
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
  // A failed, stale or absent brief yields no rows: the card keeps its existing lines, never a placeholder.
  const briefRows = brief !== null && brief.kind === 'ok' ? briefLines(brief.data, localDate()) : null;
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
    morning: morning?.kind === 'ok' ? morning.data : null,
    eventsToTriage,
    tasksToday,
    needs: needsRows,
  });

  function openLine(id: MorningLineId) {
    if (id === 'needs') return setNeedsOpen(true);
    if (id === 'tasks') return onOpenTasks();
    if (id === 'scouts' || id === 'triage') return onOpenScouts();
    setOpen((current) => (current === id ? null : id));
  }

  function openNeedsTarget(target: NeedsYouTarget) {
    if (target.kind === 'scouts' || target.kind === 'triage') return onOpenScouts();
    if (target.kind === 'actions') return onOpenStatus();
  }

  // NY3: "Got it" remembers the row id and the error text; the row returns only when that text changes.
  function dismissNeedsRow(row: NeedsYouRow) {
    const next = { ...dismissedScouts, [row.id]: row.why };
    prefs.setNeedsYouDismissed(next);
    setDismissedScouts(next);
  }

  const due = checkinDue(items);
  return <>
    <section className="group morning-card" aria-label="Today at a glance">
      {briefRows?.map((row) => (row.todo
        ? <button key={row.id} type="button" className="morning-line morning-brief-line" onClick={onOpenTasks}>{row.text}</button>
        : <p key={row.id} className={`morning-line morning-brief-line${row.marker ? ' morning-brief-marker' : ''}`}>{row.text}</p>))}
      {lines.map((line) => {
        const expands = line.id === 'weather' || line.id === 'papers';
        return <button key={line.id} type="button" className={`morning-line morning-line-${line.id}`}
          aria-expanded={expands ? open === line.id : undefined} onClick={() => openLine(line.id)}>{line.text}</button>;
      })}
      {open === 'weather' && <WeatherMorning refreshKey={refreshKey} accountKey={accountKey} blocked={blocked} />}
      {open === 'papers' && <Morning refreshKey={refreshKey} />}
      <button type="button" className="morning-line morning-review-open" onClick={() => setReviewOpen(true)}>Review my morning</button>
    </section>
    {needsOpen && <NeedsYouSheet rows={needsRows} queue={queue} accountKey={accountKey} onNavigate={openNeedsTarget} onDismiss={dismissNeedsRow} onClose={() => setNeedsOpen(false)} />}
    {reviewOpen && <MorningReviewSheet brief={briefRows} needs={needsRows} open={openTasks} today={today}
      queue={queue} accountKey={accountKey} baseRevision={baseRevision} blocked={blocked}
      onNavigate={openNeedsTarget} onClose={() => setReviewOpen(false)} />}
    {due && !checkinOpen
      ? <button type="button" className="checkin-line" onClick={() => setCheckinOpen(true)}>How are you today? Check in</button>
      : <MoodCard queue={queue} items={items} accountKey={accountKey} baseRevision={baseRevision} blocked={blocked} />}
  </>;
}
