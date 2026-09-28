import type { Command, TriageCard, TriageResponse } from '@vault-companion/contracts';
import { useEffect, useRef, useState } from 'react';
import { getTriage } from '../api.ts';
import { triageDecide } from '../commands.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { dateBlockParts, deriveTriage, timeInCopenhagen, toTriageCardView, type SkipReason, type TriageDecision } from '../triage.ts';
import { TriageStack } from './TriageStack.tsx';

export function Triage({ queue, items, accountKey, refreshKey, blocked }: {
  queue: PendingQueue; items: readonly QueueItem[]; accountKey: string | null; refreshKey: number | null; blocked: boolean;
}) {
  const [read, setRead] = useState<TriageResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TriageCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [stackVersion, setStackVersion] = useState(0);
  const [answeredCheckins, setAnsweredCheckins] = useState<string[]>([]);
  const [lastCheckin, setLastCheckin] = useState<string | null>(null);
  // Decisions are serialized (never dropped while an earlier one is still saving) and recorded the moment they are
  // made, newest last, so Undo always targets the card the stack just undid (CodeRabbit #35).
  const chain = useRef<Promise<void>>(Promise.resolve());
  const history = useRef<Extract<Command, { type: 'TriageDecide' }>[]>([]);
  useEffect(() => {
    let live = true;
    void getTriage().then((result) => {
      if (!live) return;
      if (result.kind === 'ok') { setRead(result.data); setError(null); }
      else if (result.kind === 'signed-out') { setRead(null); setOpen(false); }
      else setError('Events could not be refreshed.');
    });
    return () => { live = false; };
  }, [refreshKey]);
  const view = read ? deriveTriage(read, items, accountKey) : null;
  function enqueue(command: Extract<Command, { type: 'TriageDecide' }>) {
    if (!accountKey) return;
    const key = accountKey;
    if (command.payload.decision !== 'undo') history.current.push(command);
    chain.current = chain.current.then(async () => {
      setSaving(true);
      try {
        await queue.enqueue(command, { accountKey: key, label: command.payload.card.title, taskKey: `triage:${command.payload.eventId}` });
        setError(null);
      } catch {
        history.current = history.current.filter((c) => c !== command);
        if (command.payload.decision === 'attended') {
          const { eventId } = command.payload;
          setAnsweredCheckins((ids) => ids.filter((id) => id !== eventId));
          setLastCheckin((id) => (id === eventId ? null : id));
        }
        setError('The decision could not be saved. Please try again.');
        setStackVersion((v) => v + 1);
      } finally { setSaving(false); }
    });
  }
  function decide(eventId: string, decision: TriageDecision, reason?: SkipReason) {
    const card = read?.cards.find((c) => c.eventId === eventId);
    if (!card || !read || blocked) return;
    setLastCheckin(null);
    const { title, category, sourceName, aiScore, start } = card;
    enqueue(triageDecide({ baseRevision: read.revision }, { eventId, decision, outcome: null, reason: reason ?? null, undoes: null,
      explore: card.explore, card: { title, category, sourceName, aiScore, start } }));
  }
  function answerCheckin(eventId: string, outcome: 'worth' | 'not-worth' | 'missed') {
    const checkin = read?.checkins.find((item) => item.eventId === eventId);
    if (!checkin || !read || blocked) return;
    setAnsweredCheckins((ids) => [...ids, eventId]); setLastCheckin(eventId);
    enqueue(triageDecide({ baseRevision: read.revision }, { eventId, decision: 'attended', outcome, reason: null, undoes: null,
      explore: false, card: { title: checkin.title, category: null, sourceName: null, aiScore: null, start: checkin.start } }));
  }
  function undo() {
    const target = history.current.pop();
    if (!target || !read || blocked) return;
    enqueue(triageDecide({ baseRevision: read.revision }, { ...target.payload, decision: 'undo', outcome: null, reason: null, undoes: target.operationId }));
    return target;
  }
  const checkins = view?.checkins.filter((item) => !answeredCheckins.includes(item.eventId)) ?? [];
  const checkin = checkins[0];
  return <>
    {!!view && !!(view.cards.length + view.checkins.length) && <button className="triage-indicator" onClick={() => setOpen(true)}>{view.cards.length + view.checkins.length} new events</button>}
    {error && <p role="status">{error}</p>}
    {open && read && view && <div className="triage-screen" role="dialog" aria-modal="true" aria-label="Event triage stack" aria-busy={saving}>
      <header><h1>Events</h1><button onClick={() => setOpen(false)}>Close events</button></header>
      {view.waiting && <p role="status">Waiting for your PC to apply Calendar changes</p>}
      {view.staleFeed && <small>Event feed from {read.generatedAt}</small>}
      {read.feedState === 'unreadable' && <p>Event feed could not be read.</p>}
      {!!read.droppedCards && <small>{read.droppedCards} invalid event cards omitted.</small>}
      {!!read.droppedCheckins && <small>{read.droppedCheckins} invalid event check-ins omitted.</small>}
      {error && <p role="alert">{error}</p>}
      {detail && <section className="triage-details" aria-label="Event details">
        <button onClick={() => setDetail(null)}>Back to events</button><h2>{detail.title}</h2>
        <p>{detail.why}</p><p>{detail.location}{detail.online ? ' · Online' : ''}</p>
        <p>{detail.start}{detail.end ? ` – ${detail.end}` : ''}</p><p>{detail.cost} · {detail.category}</p>
        {/^https?:\/\//i.test(detail.sourceUrl) && <a href={detail.sourceUrl} target="_blank" rel="noreferrer">Source: {detail.sourceName}</a>}
      </section>}
      <div hidden={detail !== null}>{checkin ? <section className="triage-checkin" aria-label="Event check-in">
        <p className="triage-meta">Did you go?</p><h2>{checkin.title}</h2><time dateTime={checkin.start}>{(({ dow, dom, mon }) => `${dow} ${dom} ${mon}`)(dateBlockParts(checkin.start))} · {timeInCopenhagen(checkin.start)}</time>
        <div className="triage-actions"><button disabled={blocked || !accountKey} onClick={() => answerCheckin(checkin.eventId, 'worth')}>Worth it</button>
          <button disabled={blocked || !accountKey} onClick={() => answerCheckin(checkin.eventId, 'not-worth')}>Not worth it</button>
          <button disabled={blocked || !accountKey} onClick={() => answerCheckin(checkin.eventId, 'missed')}>Didn't go</button></div>
      </section> : <TriageStack key={stackVersion} cards={view.cards.map(toTriageCardView)} onDecide={decide} onUndo={undo}
        disabled={blocked || !accountKey} onDetails={(id) => setDetail(read.cards.find((c) => c.eventId === id) ?? null)} />}
      {lastCheckin && <div className="triage-undo"><span role="status">Check-in saved</span><button type="button" onClick={() => {
        const target = undo(); if (target?.payload.eventId === lastCheckin) setAnsweredCheckins((ids) => ids.filter((id) => id !== lastCheckin)); setLastCheckin(null);
      }}>Undo</button></div>}</div>
      <ul className="triage-statuses" aria-label="Calendar decisions">{view.statuses.slice(-10).reverse().map((d) =>
        <li key={d.decisionId}>{read.cards.find((c) => c.eventId === d.eventId)?.title ?? 'Event'} · {d.decision} · Calendar: {d.status}</li>)}</ul>
    </div>}
  </>;
}
