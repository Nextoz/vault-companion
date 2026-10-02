// UX2: the Today cockpit's compact morning card. Up to four one-liners plus the tasks line, each tapping through to
// its detail; weather and papers open the existing panels inline, scouts and events open the Scouts tab where their
// detail (and triage) now lives. Below it the check-in line, hidden once today already holds a check-in.
import type { MorningResponse, ScoutsResponse, TriageResponse, WeatherResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getMorning, getScouts, getTriage, getWeather, type Fetched } from '../api.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { deriveTriage } from '../triage.ts';
import { MoodCard } from './MoodCard.tsx';
import { Morning } from './Morning.tsx';
import { WeatherMorning } from './WeatherLab.tsx';
import { checkinDue, morningLines, type MorningLineId } from './morning-card.ts';

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
}

export function MorningCard({ queue, items, accountKey, baseRevision, blocked, refreshKey, tasksToday, onOpenTasks, onOpenScouts }: MorningCardProps) {
  const [weather, setWeather] = useState<Fetched<WeatherResponse> | null>(null);
  const [scouts, setScouts] = useState<Fetched<ScoutsResponse> | null>(null);
  const [morning, setMorning] = useState<Fetched<MorningResponse> | null>(null);
  const [triage, setTriage] = useState<TriageResponse | null>(null);
  const [open, setOpen] = useState<MorningLineId | null>(null);
  const [checkinOpen, setCheckinOpen] = useState(false);

  // The same reads the four panels used to make on Today; no new endpoint is introduced here.
  useEffect(() => {
    if (!accountKey) return;
    let live = true;
    void getScouts().then((value) => { if (live) setScouts(value); });
    void getMorning().then((value) => { if (live) setMorning(value); });
    void getTriage().then((value) => { if (live && value.kind === 'ok') setTriage(value.data); });
    return () => { live = false; };
  }, [refreshKey, accountKey]);
  useEffect(() => {
    if (!accountKey || blocked || document.visibilityState === 'hidden' || !navigator.onLine) return;
    let live = true;
    void getWeather().then((value) => { if (live) setWeather(value); });
    return () => { live = false; };
  }, [refreshKey, accountKey, blocked]);

  const triageView = triage ? deriveTriage(triage, items, accountKey) : null;
  const lines = morningLines({
    weather: weather?.kind === 'ok' ? weather.data : null,
    weatherFailed: weather !== null && weather.kind !== 'ok',
    scouts: scouts?.kind === 'ok' ? scouts.data : null,
    morning: morning?.kind === 'ok' ? morning.data : null,
    eventsToTriage: triageView ? triageView.cards.length + triageView.checkins.length : 0,
    tasksToday,
  });

  function openLine(id: MorningLineId) {
    if (id === 'tasks') return onOpenTasks();
    if (id === 'scouts' || id === 'triage') return onOpenScouts();
    setOpen((current) => (current === id ? null : id));
  }

  const due = checkinDue(items);
  return <>
    <section className="group morning-card" aria-label="Today at a glance">
      {lines.map((line) => {
        const expands = line.id === 'weather' || line.id === 'papers';
        return <button key={line.id} type="button" className={`morning-line morning-line-${line.id}`}
          aria-expanded={expands ? open === line.id : undefined} onClick={() => openLine(line.id)}>{line.text}</button>;
      })}
      {open === 'weather' && <WeatherMorning refreshKey={refreshKey} accountKey={accountKey} blocked={blocked} />}
      {open === 'papers' && <Morning refreshKey={refreshKey} />}
    </section>
    {due && !checkinOpen
      ? <button type="button" className="checkin-line" onClick={() => setCheckinOpen(true)}>How are you today? Check in</button>
      : <MoodCard queue={queue} items={items} accountKey={accountKey} baseRevision={baseRevision} blocked={blocked} />}
  </>;
}
