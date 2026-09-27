import type { Command, TriageCard, TriageResponse } from '@vault-companion/contracts';
import { useEffect, useRef, useState } from 'react';
import { getTriage } from '../api.ts';
import { triageDecide } from '../commands.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { deriveTriage, toTriageCardView, type SkipReason, type TriageDecision } from '../triage.ts';
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
  const last = useRef<Extract<Command, { type: 'TriageDecide' }> | null>(null);
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
  async function enqueue(command: Extract<Command, { type: 'TriageDecide' }>) {
    if (!accountKey) return;
    setSaving(true);
    try {
      await queue.enqueue(command, { accountKey, label: command.payload.card.title, taskKey: `triage:${command.payload.eventId}` });
      last.current = command.payload.decision === 'undo' ? null : command;
      setError(null);
    } catch {
      setError('The decision could not be saved. Please try again.');
      setStackVersion((v) => v + 1);
    } finally { setSaving(false); }
  }
  function decide(eventId: string, decision: TriageDecision, reason?: SkipReason) {
    const card = read?.cards.find((c) => c.eventId === eventId);
    if (!card || !read || blocked || saving) return;
    const { title, category, sourceName, aiScore, start } = card;
    void enqueue(triageDecide({ baseRevision: read.revision }, { eventId, decision, reason: reason ?? null, undoes: null,
      explore: card.explore, card: { title, category, sourceName, aiScore, start } }));
  }
  function undo() {
    if (!last.current || !read || blocked || saving) return;
    const target = last.current;
    void enqueue(triageDecide({ baseRevision: read.revision }, { ...target.payload, decision: 'undo', reason: null, undoes: target.operationId }));
  }
  return <>
    {!!view?.cards.length && <button className="triage-indicator" onClick={() => setOpen(true)}>{view.cards.length} new events</button>}
    {error && <p role="status">{error}</p>}
    {open && read && view && <div className="triage-screen" role="dialog" aria-modal="true" aria-label="Event triage stack">
      <header><h1>Events</h1><button onClick={() => setOpen(false)}>Close events</button></header>
      {view.waiting && <p role="status">Waiting for your PC to apply Calendar changes</p>}
      {view.staleFeed && <small>Event feed from {read.generatedAt}</small>}
      {read.feedState === 'unreadable' && <p>Event feed could not be read.</p>}
      {!!read.droppedCards && <small>{read.droppedCards} invalid event cards omitted.</small>}
      {error && <p role="alert">{error}</p>}
      {detail && <section className="triage-details" aria-label="Event details">
        <button onClick={() => setDetail(null)}>Back to events</button><h2>{detail.title}</h2>
        <p>{detail.why}</p><p>{detail.location}{detail.online ? ' · Online' : ''}</p>
        <p>{detail.start}{detail.end ? ` – ${detail.end}` : ''}</p><p>{detail.cost} · {detail.category}</p>
        {/^https?:\/\//i.test(detail.sourceUrl) && <a href={detail.sourceUrl} target="_blank" rel="noreferrer">Source: {detail.sourceName}</a>}
      </section>}
      <div hidden={detail !== null}><TriageStack key={stackVersion} cards={view.cards.map(toTriageCardView)} onDecide={decide} onUndo={undo}
        disabled={blocked || saving || !accountKey} onDetails={(id) => setDetail(read.cards.find((c) => c.eventId === id) ?? null)} /></div>
      <ul className="triage-statuses" aria-label="Calendar decisions">{view.statuses.slice(-10).reverse().map((d) =>
        <li key={d.decisionId}>{read.cards.find((c) => c.eventId === d.eventId)?.title ?? 'Event'} · {d.decision} · Calendar: {d.status}</li>)}</ul>
    </div>}
  </>;
}
