// M3: the collapsible Scout heartbeat monitor on Boards. It reads the same /api/scouts the Overview holds - one read,
// no write - and draws one row per scheduled scout. MonitorCard owns the disclosure; this file owns the summary line
// (coloured dots, one line at 390 px), the legend and the 14-day rows.
import type { ScoutsResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getScouts, type Fetched } from '../../api.ts';
import { MonitorCard } from '../MonitorCard.tsx';
import { scoutHeartbeat, type HeartbeatState, type ScoutHeartbeat } from './scout-heartbeat.ts';
import './ScoutHeartbeat.css';

export const SCOUT_HEARTBEAT_FAILED = 'Scout status could not be read.';

const LEGEND: readonly { readonly tone: HeartbeatState; readonly label: string }[] = [
  { tone: 'ok', label: 'ok' },
  { tone: 'degraded', label: 'degraded' },
  { tone: 'failed', label: 'failed' },
  { tone: 'none', label: 'no run' },
];

/** A count-line part's colour, read off its own words so the dots always match the projection's summary string. */
const partTone = (text: string): HeartbeatState =>
  text.includes('degraded') ? 'degraded' : text.includes('failed') ? 'failed' : text.includes('stale') ? 'stale' : 'ok';

/** The collapsed line: "8 ok · 2 degraded · 1 failed", each part coloured, one line at 390 px (ellipsis, no wrap). */
const Summary = ({ summary }: { summary: string }) => (
  <p className="m3-summary">
    {summary.split(' \u00b7 ').map((part, index) => (
      <span key={part}>
        {index > 0 && <span className="m3-sep" aria-hidden="true">{' \u00b7 '}</span>}
        <span className={`m3-dot m3-dot-${partTone(part)}`} aria-hidden="true" />
        {part}
      </span>
    ))}
  </p>
);

const Rows = ({ view }: { view: ScoutHeartbeat }) => (
  <>
    <div className="m3-legend">
      {LEGEND.map((item) => (
        <span key={item.tone}><span className={`m3-dot m3-dot-${item.tone}`} aria-hidden="true" />{item.label}</span>
      ))}
    </div>
    <ul className="m3-rows">
      {view.rows.map((row) => (
        <li key={row.id} className={`m3-row m3-state-${row.state}`}
          aria-label={`${row.name}: ${row.state}, last run ${row.last}`}>
          <div className="m3-top">
            <span className="m3-name">{row.name}</span>
            <span className="m3-when">{row.state === 'failed' ? `FAILED ${row.last}` : row.last}</span>
          </div>
          <div className="m3-dots" aria-hidden="true">
            {row.cells.map((cell, index) => <span key={index} className={`m3-square m3-square-${cell}`} />)}
          </div>
        </li>
      ))}
    </ul>
  </>
);

/** Web only. Fetches the existing scouts read on mount and on refresh/account change; nothing is written or retried. */
export function ScoutHeartbeatMonitor({ refreshKey, accountKey, timeZone = 'Europe/Copenhagen' }: {
  refreshKey: number | null; accountKey: string | null; timeZone?: string;
}) {
  const [scouts, setScouts] = useState<Fetched<ScoutsResponse> | null>(null);
  useEffect(() => {
    if (!accountKey) return;
    let live = true;
    // A read that throws is a failed read, never a blanked dashboard: the card shows its own status line instead.
    void Promise.resolve()
      .then(() => getScouts())
      .then((value) => { if (live) setScouts(value); })
      .catch(() => { if (live) setScouts({ kind: 'error', message: SCOUT_HEARTBEAT_FAILED }); });
    return () => { live = false; };
  }, [refreshKey, accountKey]);
  if (scouts === null) return null;
  const view = scouts.kind === 'ok' ? scoutHeartbeat(scouts.data, timeZone) : null;
  return (
    <MonitorCard
      title="Scout heartbeat"
      className="scout-heartbeat"
      status={view === null ? <p className="dash-note" role="status">{SCOUT_HEARTBEAT_FAILED}</p> : undefined}
      summary={view === null ? null : <Summary summary={view.summary} />}
      footer={view === null ? null : <p className="muted small m3-updated" role="status">{view.freshness}</p>}
    >
      {view === null ? null : <Rows view={view} />}
    </MonitorCard>
  );
}
