import type { TrainingResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getTraining, type Fetched } from '../api.ts';
import { trainingRowKeys, trainingSummary } from '../training.ts';

export function Training({ refreshKey }: { refreshKey: number | null }) {
  const [res, setRes] = useState<Fetched<TrainingResponse> | null>(null);
  useEffect(() => {
    let live = true;
    void getTraining().then((r) => { if (live) setRes(r); });
    return () => { live = false; };
  }, [refreshKey]);
  const read = res?.kind === 'ok' ? res.data : null;
  const keys = read?.status === 'ok' ? trainingRowKeys(read.rows) : [];
  return <section className="group training" aria-label="Training sessions">
    <h2>Training</h2>
    {!res && <p className="muted">Loading training…</p>}
    {res && !read && <p className="muted">Training could not be loaded. Refresh when connected.</p>}
    {read?.status === 'absent' && <p className="muted">Training log not found. Create Health/Training Log.md in Obsidian.</p>}
    {read?.status === 'refused' && <p className="error">{read.message}</p>}
    {read?.status === 'ok' && <>
      {read.rows.length === 0 && <p className="muted">No sessions yet.</p>}
      <ul className="training-list">{read.rows.map((row, i) => <li key={keys[i]} data-testid="training-row">
        <p className="muted small">{row.date}{row.time && ` · ${row.time}`}</p>
        <p><span aria-hidden="true">{row.type === 'Run' ? '🏃' : row.type === 'Gym' ? '🏋️' : '●'}</span> <strong>{row.type}</strong> {trainingSummary(row)}</p>
        {row.note && <details><summary aria-label="Show session note">📝</summary><p>{row.note}</p></details>}
      </li>)}</ul>
      {read.unknownLines.length > 0 && <div className="active-work-unknown"><p className="muted small">Edited in Obsidian</p><pre>{read.unknownLines.join('\n')}</pre></div>}
    </>}
  </section>;
}
