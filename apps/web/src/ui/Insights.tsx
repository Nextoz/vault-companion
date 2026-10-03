import type { ScoutsResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getScoutOutput } from '../api.ts';
import { degradedReason, findingsTrend, overview } from '../insights.ts';
import { createOutputLoader, type Output } from '../insight-outputs.ts';
import { displayState, pluralise } from '../scouts.ts';
import { ScoutTime } from './ScoutTime.tsx';
import './Insights.css';

type ScoutEntry = Extract<ScoutsResponse['scouts'][number], { state: 'ok' }>;
const loadOutput = createOutputLoader(async (scoutId) => {
  const result = await getScoutOutput(scoutId);
  return result.kind === 'ok' && result.data.status === 'ok' ? result.data.markdown : null;
});

export function Insights({ data, hidden, onSelect }: { data: ScoutsResponse; hidden: boolean; onSelect: (file: string) => void }) {
  const entries = data.scouts.filter((entry): entry is ScoutEntry => entry.state === 'ok');
  const summary = overview(entries.map((entry) => entry.status));
  const trend = findingsTrend(entries.map((entry) => entry.status), data.now);
  const [outputs, setOutputs] = useState<Record<string, Output>>({});
  useEffect(() => {
    let live = true;
    const candidates = data.scouts.filter((entry): entry is ScoutEntry => entry.state === 'ok')
      .filter(({ status }) => status.latestOutput && !['Failed', 'Stale'].includes(displayState(status, data.now))).slice(0, 6);
    setOutputs(Object.fromEntries(candidates.map(({ status }) => [status.scoutId, { state: 'loading' }])));
    // Each card updates when its own read settles: one slow scout never holds the others at "Loading".
    for (const { status } of candidates) {
      void loadOutput(data.revision, status.scoutId).then((output) => { if (live) setOutputs((prev) => ({ ...prev, [status.scoutId]: output })); });
    }
    return () => { live = false; };
  }, [data]);

  const max = Math.max(1, ...trend.map((day) => day.findings ?? 0));
  const trendLabel = `7-day findings: ${trend.map((day) => `${day.date}: ${day.findings ?? 'no data'}`).join(', ')}`;
  return <section className="insights" aria-labelledby="insights-heading" hidden={hidden}>
    <h2 id="insights-heading">What your scouts found</h2>
    <div className="insights-overview">
      <p><strong>{pluralise(summary.totalFindings, 'finding')}</strong><span>Latest <ScoutTime at={summary.latestSuccessAt} now={data.now} /></span>
        {!!summary.noSuccess.length && <span> · {summary.noSuccess.length} without usable findings</span>}</p>
      <div className="insights-trend" role="img" aria-label={trendLabel}>
        {trend.map((day) => <span key={day.date} className={day.findings === null ? 'insights-bar-gap' : 'insights-bar'}
          style={day.findings === null ? undefined : { height: `${Math.max(8, day.findings / max * 100)}%` }} />)}
      </div>
    </div>
    <div className="insights-cards">
      {entries.map(({ file, status }) => {
        const state = displayState(status, data.now);
        const latest = summary.byScout.get(status.scoutId);
        const output = outputs[status.scoutId];
        const suppressPicks = state === 'Failed' || state === 'Stale';
        const reason = state === 'Degraded' ? degradedReason(status) : null;
        const headingId = `insight-${status.scoutId}`;
        return <article className="insight-card" key={file} aria-labelledby={headingId}>
          <header><h3 id={headingId}>{status.displayName}</h3><strong>{latest ? pluralise(latest.findings, 'finding') : 'No usable findings'}</strong></header>
          {suppressPicks ? <p className={`insight-state scout-state-${state.toLowerCase()}`}>{state}</p> : <>
            {state === 'Degraded' && <p className="insight-state scout-state-degraded">Ran with problems{reason ? ` — ${reason}` : ''}</p>}
            {latest && <small>Picks from <ScoutTime at={latest.at} now={data.now} /></small>}
            {output?.state === 'loading' && <p role="status">Loading findings…</p>}
            {output?.state === 'unavailable' && <p>Findings unavailable</p>}
            {output?.state === 'ready' && (output.picks.length ? <ol>{output.picks.map((pick, index) => <li key={index}>
              {pick.link ? <a href={pick.link} target="_blank" rel="noopener noreferrer">{pick.text}</a> : <span>{pick.text}</span>}
              {pick.details.length > 0 && <small>{pick.details.join(' · ')}</small>}
            </li>)}</ol> : <p>No picks to preview</p>)}
            {!output && status.latestOutput && <p>Open scout to see findings</p>}
            {!status.latestOutput && <p>No findings note yet</p>}
          </>}
          <button type="button" onClick={() => onSelect(file)}>See all</button>
        </article>;
      })}
    </div>
  </section>;
}
