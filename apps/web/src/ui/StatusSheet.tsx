// ux3: the Status screen opened from the status dot - one grouped sheet over reads the app already holds. Vault,
// Scouts, Data sources, Speed and Actions. No write path, no new endpoint: the scout read is the Scouts tab's own
// read, and the data sources come from in-memory copies the app already has (absent => "-").
import type { DashboardResponse, HealthResponse, ScoutsResponse, TasksResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getScouts, type Fetched } from '../api.ts';
import { FRESH_FOR_MS, vaultFreshness } from '../freshness.ts';
import { lastCopies } from '../lastCopy.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { exactTime } from '../scouts.ts';
import { readTimings } from '../timings.ts';
import { ActionsPanel } from './ActionsPanel.tsx';
import { buildLine, dataSourceRows, scoutRows, shortRevision, stateLabel, type ScoutRow } from './status-sheet.ts';

const DASHBOARD_KEYS = ['dashboard:1W', 'dashboard:1M', 'dashboard:3M'] as const;
const stateClass = (state: string) => `scout-state-${state.toLowerCase().replaceAll(' ', '-')}`;

/** The Dashboard answer the app already holds, newest of the three ranges; null until that tab has been opened. */
function newestDashboard(accountKey: string | null): DashboardResponse | null {
  let newest: DashboardResponse | null = null;
  let at = -1;
  for (const key of DASHBOARD_KEYS) {
    const copy = lastCopies.get<DashboardResponse>(accountKey, key);
    if (copy && copy.at > at) {
      newest = copy.data;
      at = copy.at;
    }
  }
  return newest;
}

function ScoutLine({ row }: { row: ScoutRow }) {
  return (
    <li className="status-sheet-scout">
      <span className={`status-sheet-scout-name ${stateClass(row.state)}`}>{row.name}</span>
      <span className={`chip ${stateClass(row.state)}`}>{stateLabel(row.state)}</span>
      <span className="muted small status-sheet-scout-run">{row.run ? `Last run ${exactTime(row.run)}` : 'No run yet'}</span>
    </li>
  );
}

export function StatusSheet({
  read, checkedAt, failed, busy, onRefresh, accountKey, queue, items, onDiscard,
}: {
  read: TasksResponse | null;
  checkedAt: number | null;
  failed: boolean;
  busy: boolean;
  onRefresh: () => Promise<void>;
  accountKey: string | null;
  queue: PendingQueue;
  items: readonly QueueItem[];
  onDiscard: (item: QueueItem) => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now);
  const [timings, setTimings] = useState(readTimings);
  const [scouts, setScouts] = useState<Fetched<ScoutsResponse> | null>(null);

  useEffect(() => {
    setTimings(readTimings());
    setNow(Date.now());
    if (checkedAt === null) return;
    // Update only the display when it ages; this never initiates a read.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, checkedAt + FRESH_FOR_MS + 1 - Date.now()));
    return () => clearTimeout(timer);
  }, [checkedAt]);

  // The Scouts tab's own read: same function, same endpoint, no new fetch shape.
  useEffect(() => {
    if (!accountKey) return;
    let live = true;
    void getScouts().then((value) => { if (live) setScouts(value); });
    return () => { live = false; };
  }, [accountKey, checkedAt]);

  const status = read ? vaultFreshness(read, checkedAt, failed, now) : null;
  const timeZone = read?.timeZone ?? 'Europe/Copenhagen';
  const build = typeof __APP_BUILD__ === 'undefined' ? { commit: 'dev', builtAt: null } : __APP_BUILD__;
  const health = lastCopies.get<HealthResponse>(accountKey, 'health')?.data ?? null;
  const sources = dataSourceRows({ dashboard: newestDashboard(accountKey), health }, now, timeZone);
  const scoutData = scouts?.kind === 'ok' ? scouts.data : null;
  const rows = scoutData ? scoutRows(scoutData) : [];

  return (
    <section className="status-sheet" aria-label="Vault status">
      <h1 className="status-sheet-title">Status</h1>

      <section className="group" aria-label="Vault">
        <h2>Vault</h2>
        <p className="status-sheet-line">{status?.updated ?? 'Vault not loaded'}</p>
        <p className={status?.warning || failed ? 'chip chip-attention' : 'muted'}>{status?.checked ?? 'Not refreshed yet'}</p>
        {read && <p className="muted status-sheet-line">Vault {shortRevision(read.revision)}</p>}
        <p className="muted status-sheet-line">{buildLine(build.commit, build.builtAt, timeZone)}</p>
        <button type="button" aria-label="Refresh vault" aria-busy={busy} disabled={busy} onClick={() => void onRefresh()}>Refresh</button>
      </section>

      <section className="group" aria-label="Scouts">
        <h2>Scouts</h2>
        {!scouts && <p className="muted" role="status">Loading scouts…</p>}
        {scouts && !scoutData && <p className="muted" role="status">{scouts.kind === 'error' ? scouts.message : scouts.kind === 'signed-out' ? 'Sign in to view scouts.' : 'Scouts unavailable offline.'}</p>}
        {scoutData && rows.length === 0 && <p className="muted">No status yet</p>}
        {rows.length > 0 && (
          <ul className="status-sheet-scouts" aria-label="Scout states">
            {rows.map((row) => <ScoutLine key={row.file} row={row} />)}
          </ul>
        )}
      </section>

      <section className="group" aria-label="Data sources">
        <h2>Data sources</h2>
        <ul className="status-sheet-sources" aria-label="Data sources">
          {sources.map((source) => (
            <li key={source.label} className="status-sheet-source">
              <span>{source.label}</span>
              <span className="muted">{source.time ?? '-'}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="group" aria-label="Speed">
        <h2>Speed</h2>
        {timings.length === 0
          ? <p className="muted">No reads measured yet.</p>
          : (
            <ul className="read-speed" aria-label="Read speed">
              {timings.map((t) => (
                <li key={t.route}>{t.route.replace(/^\/api\//, '')} {t.totalMs} ms{t.serverMs !== null && ` · server ${t.serverMs} ms`}</li>
              ))}
            </ul>
          )}
      </section>

      <section className="group" aria-label="Actions">
        <h2>Actions</h2>
        {items.length === 0 && <p className="muted">No pending actions.</p>}
        <ActionsPanel queue={queue} items={items} read={read} onRefresh={onRefresh} onDiscard={onDiscard} />
      </section>
    </section>
  );
}