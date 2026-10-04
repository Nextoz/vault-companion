import type { LearningResponse } from '@vault-companion/contracts';
import { getLearning } from '../api.ts';
import { copenhagenDay } from '../triage.ts';
import { BarChart } from './BarChart.tsx';
import { kindName, learningRowKeys, learningWeekBars, scoreTrends, type ScoreTrend } from '../learning.ts';
import { CopyNote, useLastCopy } from './useLastCopy.tsx';

/** A tiny SVG polyline for one kind's scores; the series always has at least two points. */
function TrendSpark({ values }: { values: readonly number[] }) {
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values
    .map((value, i) => `${(1 + i * 38 / (values.length - 1)).toFixed(1)},${(15 - (value - min) / span * 13).toFixed(1)}`)
    .join(' ');
  return <svg className="learning-spark" viewBox="0 0 40 16" aria-hidden="true"><polyline points={points} /></svg>;
}

export function Learning({ refreshKey, accountKey }: { refreshKey: number | null; accountKey: string | null }) {
  const view = useLastCopy<LearningResponse>(accountKey, 'learning', getLearning, refreshKey);
  const res = view.res;
  const read = res?.kind === 'ok' ? res.data : null;
  const rows = read?.status === 'ok' ? read.rows : [];
  const kinds = read?.status === 'ok' ? read.kinds : [];
  const trends: ScoreTrend[] = read?.status === 'ok' ? scoreTrends(read.rows) : [];
  const keys = learningRowKeys(rows);
  const today = copenhagenDay(new Date().toISOString());
  return <section className="group learning" aria-label="Learning sessions">
    <h2>Learning</h2>
    <CopyNote view={view} />
    {!res && <p className="muted">Loading learning…</p>}
    {res && !read && <p className="muted">Learning could not be loaded. Refresh when connected.</p>}
    {read?.status === 'absent' && <p className="muted">Learning Gym Log not found. Create Personal/Learning Gym Log.md in Obsidian.</p>}
    {read?.status === 'refused' && <p className="error">{read.message}</p>}
    {read?.status === 'ok' && <>
      {rows.length === 0 && <p className="muted">No sessions yet.</p>}
      {rows.length > 0 && <BarChart title="Sessions per week" testId="learning-chart" bars={learningWeekBars(rows.map((r) => r.date), today)} />}
      {trends.length > 0 && <ul className="learning-trends" aria-label="Score trend">
        {trends.map((trend) => <li key={trend.kind} data-testid="learning-trend">
          <span>{kindName(kinds, trend.kind)}</span> <TrendSpark values={trend.values} />
        </li>)}
      </ul>}
      <ul className="learning-list">{rows.map((row, i) => {
        const name = kindName(kinds, row.kind);
        const effort = row.minutes !== '' ? `${row.minutes} min` : 'no minutes';
        const quality = row.score !== '' ? `score ${row.score}` : 'no score';
        return <li key={keys[i]} data-testid="learning-row">
          <p className="muted small">{row.date}</p>
          <details>
            <summary aria-label={`Show ${name} session on ${row.date}`}>
              <span className="learning-session-line"><strong>{name}</strong> <span className="learning-effort">{effort}</span> <span className="learning-quality">{quality}</span></span>
            </summary>
            <dl className="learning-detail">
              {row.detail && <><dt>Detail</dt><dd>{row.detail}</dd></>}
              {row.topic && <><dt>Topic</dt><dd>{row.topic}</dd></>}
              {row.note && <><dt>Note</dt><dd>{row.note}</dd></>}
            </dl>
          </details>
        </li>;
      })}</ul>
      {read.unknownLines.length > 0 && <div className="active-work-unknown"><p className="muted small">Edited in Obsidian</p><pre>{read.unknownLines.join('\n')}</pre></div>}
    </>}
  </section>;
}
