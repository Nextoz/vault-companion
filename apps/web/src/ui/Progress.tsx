// Progress Wall (ADR-0027): "This week", "Earlier weeks", then the unchanged day-by-day History list. Read-only.
// Each source loads on its own; a failed one says "… unavailable" and the rest still counts. Evidence, not scores.
import type { CompleteTaskCommand, HistoryItem, HistoryResponse, NotesResponse, TrainingResponse, TriageResponse } from '@vault-companion/contracts';
import { useId, useState } from 'react';
import { getHistory, getNotes, getTraining, getTriage, type Fetched } from '../api.ts';
import { dayHeading } from '../history.ts';
import { combineViews } from '../lastCopy.ts';
import { progressWeeks, weekRange, weekSummary, type ProgressInputs, type ProgressWeek } from '../progress.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { plainWikilinks, taskSegments } from '../text.ts';
import { trainingSummary } from '../training.ts';
import { copenhagenDay } from '../triage.ts';
import { weekdayBars } from '../week-chart.ts';
import { BarChart } from './BarChart.tsx';
import { History } from './History.tsx';
import { MoodHistory } from './LogMood.tsx';
import { NoteScreen } from './Notes.tsx';
import { CopyNote, useLastCopy } from './useLastCopy.tsx';
import type { OpenLink } from './NoteView.tsx';

type Note = NotesResponse['notes'][number];
const ok = <T,>(r: Fetched<T> | null): T | null | undefined => (r === null ? undefined : r.kind === 'ok' ? r.data : null);

export function Progress({ refreshKey, queue, queued, accountKey, baseRevision, blocked, onReopen, onOpenLink }: {
  refreshKey: number | null;
  queue: PendingQueue;
  queued: readonly QueueItem[];
  accountKey: string | null;
  baseRevision: string | null;
  blocked: boolean;
  onReopen: (target: CompleteTaskCommand, label: string) => void;
  onOpenLink: (link: OpenLink) => void;
}) {
  // SP3 (ADR-0038): each source opens from its last copy (shared keys with the Training and Notes tabs).
  const historyView = useLastCopy<HistoryResponse>(accountKey, 'history', getHistory, refreshKey);
  const trainingView = useLastCopy<TrainingResponse>(accountKey, 'training', getTraining, refreshKey);
  const triageView = useLastCopy<TriageResponse>(accountKey, 'triage', getTriage, refreshKey);
  const notesView = useLastCopy<NotesResponse>(accountKey, 'notes', getNotes, refreshKey);
  const history = historyView.res;
  const training = trainingView.res;
  const triage = triageView.res;
  const notes = notesView.res;
  const [openNote, setOpenNote] = useState<Note | null>(null);

  if (openNote) {
    return <NoteScreen entry={openNote} refreshKey={refreshKey} queue={queue} items={queued} accountKey={accountKey}
      baseRevision={baseRevision} onBack={() => setOpenNote(null)} />;
  }
  const h = ok(history);
  const t = ok(training);
  const d = ok(triage);
  const n = ok(notes);
  // Settled sources render at once; `undefined` = still loading, `null` = failed (shown per source, never as empty).
  const loading = [h, t, d, n].every((s) => s === undefined);
  const missing = ([['Tasks', h], ['Training', t], ['Events', d], ['Notes', n]] as const)
    .flatMap(([name, s]) => s === undefined ? [`${name} loading…`] : s === null ? [`${name} unavailable`] : []);
  const inputs: ProgressInputs = {
    history: h?.items ?? null,
    training: t ? (t.status === 'ok' ? t.rows : t.status === 'absent' ? [] : null) : null,
    decisions: d?.decisions ?? null,
    notes: n?.notes ?? null,
  };
  const today = h?.today ?? (d ? copenhagenDay(d.now) : copenhagenDay(new Date().toISOString()));
  const [week, ...earlier] = loading ? [] : progressWeeks(inputs, today);
  const evidence = { onOpenLink, onOpenNote: setOpenNote };
  return <section aria-label="Progress" className="progress">
    <h1>Progress</h1>
    <MoodHistory items={queued} />
    <CopyNote view={combineViews([historyView, trainingView, triageView, notesView])} />
    {loading && <p role="status">Loading progress…</p>}
    {week && <section aria-label="This week" className="progress-card">
      <h2>This week <span className="muted small">{weekRange(week)}</span></h2>
      <p className="progress-summary" data-testid="week-summary">{weekSummary(week, true, missing)}</p>
      {h && <BarChart title="Tasks done this week" testId="week-tasks-chart" bars={weekdayBars(h.items.map((i) => i.doneDate), today)} />}
      <Expandable label="Show what happened" closeLabel="Hide what happened"><Evidence week={week} {...evidence} /></Expandable>
    </section>}
    {earlier.length > 0 && <section aria-label="Earlier weeks" className="progress-earlier">
      <h2>Earlier weeks</h2>
      <ul>
        {earlier.map((w) => <li key={w.monday}>
          <Expandable label={`${weekRange(w)}: ${weekSummary(w, false, missing)}`} row>
            <Evidence week={w} {...evidence} />
          </Expandable>
        </li>)}
      </ul>
    </section>}
    <h2 className="progress-days">Day by day</h2>
    {/* A copy is never actionable: Reopen waits for this read's own answer. */}
    <History result={history} queued={queued} accountKey={accountKey} blocked={blocked || historyView.copyAt !== null} onReopen={onReopen} onOpenLink={onOpenLink} />
  </section>;
}

function Expandable({ label, closeLabel, row, children }: { label: string; closeLabel?: string; row?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <>
    <button type="button" className={row ? 'progress-week' : 'link progress-toggle'} aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(!open)}>{open && closeLabel ? closeLabel : label}</button>
    {open && <div id={id} className="progress-evidence">{children}</div>}
  </>;
}

const day = (date: string) => dayHeading(date);
function Evidence({ week, onOpenLink, onOpenNote }: { week: ProgressWeek; onOpenLink: (link: OpenLink) => void; onOpenNote: (n: Note) => void }) {
  const events = week.events ? [...week.events.go, ...week.events.attended].sort((a, b) => (a.start ?? a.at).localeCompare(b.start ?? b.at)) : [];
  const groups = [
    week.tasks?.length ? <Group key="tasks" title="Tasks">{week.tasks.map((item, i) => <TaskEvidence key={i} item={item} onOpenLink={onOpenLink} />)}</Group> : null,
    week.activeWork?.length ? <Group key="aw" title="Active Work">{week.activeWork.map((item, i) => <li key={i}>{plainWikilinks(item.description)} <span className="muted small">{day(item.doneDate)}</span></li>)}</Group> : null,
    week.runs?.count ? <Group key="runs" title="Runs">{week.runs.items.map((r, i) => <li key={i}>{day(r.date)} · {trainingSummary(r) || 'Run'}</li>)}</Group> : null,
    week.gym?.count ? <Group key="gym" title="Gym">{week.gym.items.map((r, i) => <li key={i}>{day(r.date)} · {trainingSummary(r) || 'Gym'}</li>)}</Group> : null,
    events.length ? <Group key="events" title="Events">{events.map((e) => <li key={e.decisionId}>
      {e.title ?? 'Event'} <span className="muted small">{day(copenhagenDay(e.start ?? e.at))} · {e.decision === 'go' ? 'Go' : e.outcome === 'worth' ? 'Attended, worth it' : 'Attended, not worth it'}</span>
    </li>)}</Group> : null,
    week.notes?.length ? <Group key="notes" title="Notes">{week.notes.map((note) => <li key={note.path}>
      <button type="button" className="link progress-note" onClick={() => onOpenNote(note)}>{note.title}</button> <span className="muted small">{note.date && day(note.date)}</span>
    </li>)}</Group> : null,
  ].filter(Boolean);
  return groups.length ? <>{groups}</> : <p className="muted small">Nothing recorded.</p>;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <section aria-label={title}><h3>{title}</h3><ul>{children}</ul></section>;
}

function TaskEvidence({ item, onOpenLink }: { item: HistoryItem; onOpenLink: (link: OpenLink) => void }) {
  return <li>
    {taskSegments(item.description, item.links).map((seg, i) => seg.kind === 'text'
      ? <span key={i}>{seg.text}</span>
      : <button key={i} type="button" className="wikilink" aria-label={`Open note: ${seg.text}`}
        onClick={(e) => onOpenLink({ task: { locator: item.locator }, linkIndex: seg.linkIndex, label: seg.text, invoker: e.currentTarget })}>{seg.text}</button>)}
    {' '}<span className="muted small">{day(item.doneDate)}</span>
  </li>;
}
