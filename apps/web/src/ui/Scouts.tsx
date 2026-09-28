import type { ScoutStatus, ScoutsResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getScoutOutput, getScouts, type Fetched } from '../api.ts';
import { attentionCount, displayState, exactTime } from '../scouts.ts';
import { Insights } from './Insights.tsx';
import { ScoutTime } from './ScoutTime.tsx';

const stateClass = (state: string) => `scout-state-${state.toLowerCase().replaceAll(' ', '-')}`;
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
  if (!page) {
    const count = data ? attentionCount(data) : 0;
    return count > 0 ? <button className="scout-attention" onClick={onOpen}>{count} scouts need attention</button> : null;
  }
  const entry = data?.scouts.find((entry) => entry.file === selected);
  const detail = entry?.state === 'ok' ? entry.status : null;
  return <section aria-label="Scouts" className="scouts">
    <h1>Scouts</h1>
    {!data && <p role="status">{!result ? 'Loading scouts…' : result.kind === 'error' ? result.message : result.kind === 'signed-out' ? 'Sign in to view scouts.' : 'Scouts unavailable offline.'}</p>}
    {data?.scouts.length === 0 && <p>No status yet</p>}
    {data && <Insights data={data} hidden={!!detail} onSelect={setSelected} />}
    {detail ? <div className="scout-detail">
      <button onClick={() => setSelected(null)}>Back to scouts</button>
      <h2>{detail.displayName}</h2>
      <p className={stateClass(displayState(detail, data!.now))}>{displayState(detail, data!.now)}</p>
      <div className="scout-history" role="list" aria-label="Run history, oldest to newest">
        {[...detail.history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((run, i) =>
          <span key={i} role="listitem" className={`scout-run ${stateClass(run.status === 'success' ? 'Healthy' : run.status)}`}
            aria-label={`${exactTime(run.at)}: ${run.status}, findings ${run.findings ?? 'unknown'}`} title={`${exactTime(run.at)}: ${run.status}`} />)}
      </div>
      <dl><dt>Last success</dt><dd><ScoutTime at={detail.lastSuccessAt} now={data!.now} /></dd><dt>Last attempt</dt><dd><ScoutTime at={detail.lastAttemptAt} now={data!.now} /></dd>
        <dt>Last error</dt><dd>{detail.lastError?.replace(/\s+/g, ' ').slice(0, 200) || '—'}</dd></dl>
      <h3>Findings note</h3>
      {detail.latestOutput ? <FindingsNote key={detail.scoutId} id={detail.scoutId} /> : <p>No findings note yet.</p>}
    </div> : <div className="scout-grid">{data?.scouts.map((entry) => {
      const status = entry.state === 'ok' ? entry.status : null;
      const state = displayState(status, data.now);
      return <button key={entry.file} className="scout-panel" disabled={!status} onClick={() => setSelected(entry.file)}>
        <span className="scout-name">{status?.displayName ?? entry.file}</span>
        <span className={stateClass(state)}>{state}</span>
        <span>Last attempt <ScoutTime at={status?.lastAttemptAt ?? null} now={data.now} /></span><span>Last success <ScoutTime at={status?.lastSuccessAt ?? null} now={data.now} /></span>
        <span className="scout-metric"><strong>{status?.findings ?? '—'}</strong> findings</span>
        {status && <Sparkline history={status.history} />}
        <span className="scout-chips"><span>Sources {status?.sources ? `${status.sources.successful}/${status.sources.configured}` : '—'}</span><span>AI {status?.aiHealth ?? '—'}</span></span>
      </button>;
    })}</div>}
  </section>;
}
