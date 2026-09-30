import type { ScoutStatus, ScoutsResponse } from '@vault-companion/contracts';
import { useEffect, useMemo, useState } from 'react';
import { getScoutOutput, getScouts, type Fetched } from '../api.ts';
import { attentionCount, displayState, exactTime, lastRun, type DisplayState } from '../scouts.ts';
import { Insights } from './Insights.tsx';
import { ScoutTime } from './ScoutTime.tsx';
import './Scouts.css';

type ScoutEntry = ScoutsResponse['scouts'][number];
/** The calendar-sync tracker never belongs in the health list; only a failed or stale run deserves a line. */
const TRIAGE_APPLIER_ID = 'triage-applier';

const stateClass = (state: string) => `scout-state-${state.toLowerCase().replaceAll(' ', '-')}`;
/** Owner wording (B3): a degraded run "ran with problems"; Healthy/Failed keep their plain names. */
const stateLabel = (state: DisplayState) => state === 'Degraded' ? 'Ran with problems' : state;
const entryState = (entry: ScoutEntry, now: string) => displayState(entry.state === 'ok' ? entry.status : null, now);
const isTriageApplier = (entry: ScoutEntry) => entry.state === 'ok' && entry.status.scoutId === TRIAGE_APPLIER_ID;

function Sparkline({ history }: { history: ScoutStatus['history'] }) {
  const ordered = [...history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const max = Math.max(1, ...ordered.map((run) => run.findings ?? 0));
  return <svg className="scout-sparkline" viewBox="0 0 160 40" role="img" aria-label="Findings history">
    {ordered.map((run, i) => {
      if (run.findings === null) return null;
      const x = 4 + i * 152 / Math.max(1, ordered.length - 1);
      const y = 36 - run.findings / max * 32;
      const previous = ordered[i - 1];
      return <g key={i}><circle cx={x} cy={y} r="2" />{previous?.findings != null &&
        <line x1={4 + (i - 1) * 152 / Math.max(1, ordered.length - 1)} y1={36 - previous.findings / max * 32} x2={x} y2={y} />}</g>;
    })}
  </svg>;
}
function FindingsNote({ id }: { id: string }) {
  const [content, setContent] = useState<{ html: string } | { message: string }>({ message: 'Loading findings…' });
  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await getScoutOutput(id);
      if (!live) return;
      if (result.kind !== 'ok') {
        setContent({ message: result.kind === 'error' ? result.message : result.kind === 'signed-out' ? 'Sign in to read findings.' : 'Findings unavailable offline.' });
      } else if (result.data.status !== 'ok') {
        setContent({ message: result.data.message });
      } else {
        try {
          const { createScoutRenderer } = await import('../note/scout-render.ts');
          const render = createScoutRenderer(window);
          if (live) setContent({ html: render(result.data.markdown) });
        } catch { if (live) setContent({ message: 'Findings could not be displayed.' }); }
      }
    })();
    return () => { live = false; };
  }, [id]);
  return 'html' in content ? <article className="note-body scout-findings" data-testid="scout-findings" dangerouslySetInnerHTML={{ __html: content.html }} /> : <p role="status">{content.message}</p>;
}
export function Scouts({ page, onOpen, refreshKey }: { page: boolean; onOpen: () => void; refreshKey: number | null }) {
  const [result, setResult] = useState<Fetched<ScoutsResponse> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setResult(null);
    void getScouts().then((value) => { if (live) setResult(value); });
    return () => { live = false; };
  }, [refreshKey, page]);
  const data = result?.kind === 'ok' ? result.data : null;
  // Stable references: Insights restarts its preview reads whenever the `data` prop identity changes.
  const listed = useMemo(() => data ? data.scouts.filter((candidate) => !isTriageApplier(candidate)) : [], [data]);
  const insightsData = useMemo(() => data ? { ...data, scouts: listed } : null, [data, listed]);
  if (!page) {
    const count = data ? attentionCount(data) : 0;
    return count > 0 ? <button className="scout-attention" onClick={onOpen}>{count} scouts need attention</button> : null;
  }
  const entry = data?.scouts.find((candidate) => candidate.file === selected);
  const detail = entry?.state === 'ok' ? entry.status : null;
  const detailState = detail && data ? displayState(detail, data.now) : null;
  // The triage-applier is identified by scoutId (never by display name); malformed records keep their file name.
  const triage = data?.scouts.find(isTriageApplier) ?? null;
  const triageState = triage && data ? entryState(triage, data.now) : null;
  const triageAttention = triageState === 'Failed' || triageState === 'Stale';
  // Count the attention line too, so the summary never contradicts what is on screen.
  const summarised = triageAttention && triage ? [...listed, triage] : listed;
  const states = data ? summarised.map((candidate) => entryState(candidate, data.now)) : [];
  const okCount = states.filter((state) => state === 'Healthy').length;
  // An ongoing run is neither ok nor a problem, so it gets its own part of the summary (and only when nonzero).
  const runningCount = states.filter((state) => state === 'Running').length;
  const problemCount = states.filter((state) => state !== 'Healthy' && state !== 'Running').length;
  const summary = [`${okCount} ok`];
  if (problemCount > 0) summary.push(`${problemCount} with problems`);
  if (runningCount > 0) summary.push(`${runningCount} running`);
  return <section aria-label="Scouts" className="scouts">
    <h1>Scouts</h1>
    {!data && <p role="status">{!result ? 'Loading scouts…' : result.kind === 'error' ? result.message : result.kind === 'signed-out' ? 'Sign in to view scouts.' : 'Scouts unavailable offline.'}</p>}
    {data?.scouts.length === 0 && <p>No status yet</p>}
    {data && (detail ? <div className="scout-detail">
      <button type="button" className="scout-back" onClick={() => setSelected(null)}>Back to scouts</button>
      <h2>{detail.displayName}</h2>
      <p className={stateClass(detailState!)}>{stateLabel(detailState!)}</p>
      <div className="scout-history" role="list" aria-label="Run history, oldest to newest">
        {[...detail.history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((run, i) =>
          <span key={i} role="listitem" className={`scout-run ${stateClass(run.status === 'success' ? 'Healthy' : run.status)}`}
            aria-label={`${exactTime(run.at)}: ${run.status}, findings ${run.findings ?? 'unknown'}`} title={`${exactTime(run.at)}: ${run.status}`} />)}
      </div>
      <Sparkline history={detail.history} />
      <dl><dt>Last success</dt><dd><ScoutTime at={detail.lastSuccessAt} now={data.now} /></dd><dt>Last attempt</dt><dd><ScoutTime at={detail.lastAttemptAt} now={data.now} /></dd>
        <dt>Last error</dt><dd>{detail.lastError?.replace(/\s+/g, ' ').slice(0, 200) || '—'}</dd></dl>
      <p className="scout-chips"><span>Sources {detail.sources ? `${detail.sources.successful}/${detail.sources.configured}` : '—'}</span><span>AI {detail.aiHealth ?? '—'}</span></p>
      <h3>Findings note</h3>
      {detail.latestOutput ? <FindingsNote key={detail.scoutId} id={detail.scoutId} /> : <p>No findings note yet.</p>}
    </div> : <>
      <p className="scout-summary" data-testid="scout-summary">{summary.join(' · ')}</p>
      {triageAttention && triage && <button type="button" className={`scout-triage-attention ${stateClass(triageState!)}`} onClick={() => setSelected(triage.file)}>
        <span className={`scout-dot ${stateClass(triageState!)}`} aria-hidden="true" />
        <span>{triageState === 'Stale' ? 'Calendar sync stale' : 'Calendar sync failed'}</span>
        <span className="scout-triage-more" aria-hidden="true">Details</span>
      </button>}
      <ul className="scout-list" aria-label="Scout health">
        {listed.map((candidate) => {
          const status = candidate.state === 'ok' ? candidate.status : null;
          const state = entryState(candidate, data.now);
          const run = status ? lastRun(status) : null;
          const label = status
            ? `${status.displayName}, ${stateLabel(state)}, ${status.findings === null ? 'findings unknown' : `${status.findings} findings`}, last run ${run ? exactTime(run) : 'never'}`
            : `${candidate.file}, No status yet`;
          return <li key={candidate.file}>
            <button type="button" className="scout-row" disabled={!status} aria-label={label} onClick={() => setSelected(candidate.file)}>
              <span className={`scout-dot ${stateClass(state)}`} aria-hidden="true" />
              {' '}
              <span className="scout-row-name">{status?.displayName ?? candidate.file}</span>
              {' '}
              <span className="scout-row-time">{status ? <>Last run <ScoutTime at={run} now={data.now} /></> : 'No run yet'}</span>
              {' '}
              <span className="scout-row-meta">
                <span className={stateClass(state)}>{stateLabel(state)}</span>
                <span className="scout-row-findings"><strong>{status?.findings ?? '—'}</strong> findings</span>
              </span>
            </button>
          </li>;
        })}
      </ul>
    </>)}
    {insightsData && <Insights data={insightsData} hidden={!!detail} onSelect={setSelected} />}
  </section>;
}
