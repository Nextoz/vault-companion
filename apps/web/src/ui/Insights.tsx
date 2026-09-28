import type { ScoutsResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getScoutOutput } from '../api.ts';
import { findingsTrend, overview, topPicks, type InsightPick } from '../insights.ts';
import { displayState } from '../scouts.ts';
import { ScoutTime } from './ScoutTime.tsx';
import './Insights.css';

type ScoutEntry = Extract<ScoutsResponse['scouts'][number], { state: 'ok' }>;
type Output = { state: 'loading' } | { state: 'ready'; picks: InsightPick[] } | { state: 'unavailable' };
const outputBatches = new Map<string, Promise<Record<string, Output>>>();

function loadOutputs(key: string, entries: readonly ScoutEntry[]): Promise<Record<string, Output>> {
  const existing = outputBatches.get(key);
  if (existing) return existing;
  const batch = Promise.all(entries.map(async ({ status }) => {
    const result = await getScoutOutput(status.scoutId);
    const output: Output = result.kind === 'ok' && result.data.status === 'ok'
      ? { state: 'ready', picks: topPicks(result.data.markdown) }
      : { state: 'unavailable' };
    return [status.scoutId, output] as const;
  })).then((results) => Object.fromEntries(results));
  outputBatches.set(key, batch);
  return batch;
}

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
    void loadOutputs(data.revision, candidates).then((loaded) => { if (live) setOutputs(loaded); });
    return () => { live = false; };
  }, [data]);

  const max = Math.max(1, ...trend.map((day) => day.findings ?? 0));
  const trendLabel = `7-day findings: ${trend.map((day) => `${day.date}: ${day.findings ?? 'no data'}`).join(', ')}`;
  return <section className="insights" aria-labelledby="insights-heading" hidden={hidden}>
    <h2 id="insights-heading">What your scouts found</h2>
    <div className="insights-overview">
      <p><strong>{summary.totalFindings} findings</strong><span>Latest <ScoutTime at={summary.latestSuccessAt} now={data.now} /></span>
        {!!summary.noSuccess.length && <span> · {summary.noSuccess.length} without a successful run</span>}</p>
      <div className="insights-trend" role="img" aria-label={trendLabel}>
        {trend.map((day) => <span key={day.date} className={day.findings === null ? 'insights-bar-gap' : 'insights-bar'}
          style={day.findings === null ? undefined : { height: `${Math.max(8, day.findings / max * 100)}%` }} />)}
      </div>
    </div>
    <div className="insights-cards">
      {entries.map(({ file, status }) => {
        const state = displayState(status, data.now);
        const successful = summary.byScout.get(status.scoutId);
        const output = outputs[status.scoutId];
        const suppressPicks = state === 'Failed' || state === 'Stale';
        const headingId = `insight-${status.scoutId}`;
        return <article className="insight-card" key={file} aria-labelledby={headingId}>
          <header><h3 id={headingId}>{status.displayName}</h3><strong>{successful ? `${successful.findings} findings` : 'No successful run'}</strong></header>
          {suppressPicks ? <p className={`insight-state scout-state-${state.toLowerCase()}`}>{state}</p> : <>
            {successful && <small>Picks from <ScoutTime at={successful.at} now={data.now} /></small>}
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
