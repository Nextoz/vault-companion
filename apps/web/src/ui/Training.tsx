import type { TrainingResponse } from '@vault-companion/contracts';
import { getTraining } from '../api.ts';
import { trainingRowKeys, trainingSummary } from '../training.ts';
import { copenhagenDay } from '../triage.ts';
import { weekBars } from '../week-chart.ts';
import { BarChart } from './BarChart.tsx';
import { CopyNote, useLastCopy } from './useLastCopy.tsx';

export function Training({ refreshKey, accountKey }: { refreshKey: number | null; accountKey: string | null }) {
  const view = useLastCopy<TrainingResponse>(accountKey, 'training', getTraining, refreshKey);
  const res = view.res;
  const read = res?.kind === 'ok' ? res.data : null;
  const keys = read?.status === 'ok' ? trainingRowKeys(read.rows) : [];
  return <section className="group training" aria-label="Training sessions">
    <h2>Training</h2>
    <CopyNote view={view} />
    {!res && <p className="muted">Loading training…</p>}
    {res && !read && <p className="muted">Training could not be loaded. Refresh when connected.</p>}
    {read?.status === 'absent' && <p className="muted">Training log not found. Create Health/Training Log.md in Obsidian.</p>}
    {read?.status === 'refused' && <p className="error">{read.message}</p>}
    {read?.status === 'ok' && <>
      {read.rows.length === 0 && <p className="muted">No sessions yet.</p>}
      {read.rows.length > 0 && <BarChart title="Sessions per week" testId="training-chart" bars={weekBars(read.rows.map((r) => r.date), copenhagenDay(new Date().toISOString()))} />}
      <ul className="training-list">{read.rows.map((row, i) => <li key={keys[i]} data-testid="training-row">
        <p className="muted small">{row.date}{row.time && ` · ${row.time}`}</p>
        <p><span aria-hidden="true">{row.type === 'Run' ? '🏃' : row.type === 'Gym' ? '🏋️' : '●'}</span> <strong>{row.type}</strong> {trainingSummary(row)}</p>
        {row.note && <details><summary aria-label="Show session note">📝</summary><p>{row.note}</p></details>}
      </li>)}</ul>
      {read.unknownLines.length > 0 && <div className="active-work-unknown"><p className="muted small">Edited in Obsidian</p><pre>{read.unknownLines.join('\n')}</pre></div>}
    </>}
  </section>;
}
