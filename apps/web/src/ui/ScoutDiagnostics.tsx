// UX8 (layout C): Boards' scout diagnostics entry - the "scouts need attention" line that used to lead Today, moved
// to Boards (nothing deleted). Reuses the existing /api/scouts read the Overview already holds and links to the full
// Scouts screen; no new endpoint and no write.
import type { ScoutsResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getScouts, type Fetched } from '../api.ts';
import { attentionCount, scoutsNeedAttention } from '../scouts.ts';

export function ScoutDiagnostics({ refreshKey, accountKey, onOpenScouts }: {
  refreshKey: number | null; accountKey: string | null; onOpenScouts: () => void;
}) {
  const [scouts, setScouts] = useState<Fetched<ScoutsResponse> | null>(null);
  useEffect(() => {
    if (!accountKey) return;
    let live = true;
    void getScouts().then((value) => { if (live) setScouts(value); });
    return () => { live = false; };
  }, [refreshKey, accountKey]);
  const data = scouts?.kind === 'ok' ? scouts.data : null;
  const problems = data ? attentionCount(data) : 0;
  return (
    <section className="group scout-diagnostics" aria-label="Scout diagnostics">
      <h2>Scout diagnostics</h2>
      <button type="button" className="morning-line scout-diagnostics-open" onClick={onOpenScouts}>
        {problems > 0 ? scoutsNeedAttention(problems) : 'Scouts healthy'}
      </button>
    </section>
  );
}
