// ux3/AB2: the Status screen opened from the status dot - one grouped sheet. Vault, Scouts, Data sources, AI budget,
// Speed and Actions. No write path: the scout read is the Scouts tab's own read, the AI budget is a fixed read-only
// file, and the data sources come from in-memory copies the app already has (absent => "-").
import type { AiBudgetResponse, DashboardResponse, HealthResponse, ScoutsResponse, TasksResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getAiBudget, getScouts, type Fetched } from '../api.ts';
import { FRESH_FOR_MS, vaultFreshness } from '../freshness.ts';
import { lastCopies } from '../lastCopy.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { exactTime } from '../scouts.ts';
import { readTimings } from '../timings.ts';
import { ActionsPanel } from './ActionsPanel.tsx';
import { budgetFreshness, budgetRows, buildLine, dataSourceRows, scoutRows, shortRevision, stateLabel, type BudgetRow, type ScoutRow } from './status-sheet.ts';

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

/** A tiny 7-day line: at least two points by the time it is drawn, scaled to its own min/max. No axis, no labels. */
function BudgetSparkline({ row }: { row: BudgetRow }) {
  const history = row.history!;
  const min = Math.min(...history);
  const span = Math.max(...history) - min || 1;
  const points = history
    .map((value, i) => `${(1 + i * 38 / (history.length - 1)).toFixed(1)},${(15 - (value - min) / span * 13).toFixed(1)}`)
    .join(' ');
  return <svg className="status-sheet-budget-spark" viewBox="0 0 40 16" aria-hidden="true"><polyline points={points} /></svg>;
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
  const [scouts, setScouts] = useState<{ account: string; value: Fetched<ScoutsResponse> } | null>(null);
  const [budget, setBudget] = useState<{ account: string; value: Fetched<AiBudgetResponse> } | null>(null);

  useEffect(() => {
    setTimings(readTimings());
    setNow(Date.now());
    if (checkedAt === null) return;
    // Update only the display when it ages; this never initiates a read.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, checkedAt + FRESH_FOR_MS + 1 - Date.now()));
    return () => clearTimeout(timer);
  }, [checkedAt]);

  // The Scouts tab's own read: same function, same endpoint, no new fetch shape. The response is stamped with the
  // account it was requested for, so a previous account's scouts are never shown while a new read is pending.
  useEffect(() => {
    if (!accountKey) { setScouts(null); return; }
    let live = true;
    void getScouts().then((value) => { if (live) setScouts({ account: accountKey, value }); });
    return () => { live = false; };
  }, [accountKey, checkedAt]);

  // The AI budget read, stamped with its account so a previous account's rows never flash while a new read is pending.
  useEffect(() => {
    if (!accountKey) { setBudget(null); return; }
    let live = true;
    void getAiBudget().then((value) => { if (live) setBudget({ account: accountKey, value }); });
    return () => { live = false; };
  }, [accountKey, checkedAt]);

  const status = read ? vaultFreshness(read, checkedAt, failed, now) : null;
  const timeZone = read?.timeZone ?? 'Europe/Copenhagen';
  const build = typeof __APP_BUILD__ === 'undefined' ? { commit: 'dev', builtAt: null } : __APP_BUILD__;
  const health = lastCopies.get<HealthResponse>(accountKey, 'health')?.data ?? null;
  const sources = dataSourceRows({ dashboard: newestDashboard(accountKey), health }, now, timeZone);
  const scoutResult = scouts && scouts.account === accountKey ? scouts.value : null;
  const scoutData = scoutResult?.kind === 'ok' ? scoutResult.data : null;
  const rows = scoutData ? scoutRows(scoutData) : [];
  const budgetData = budget && budget.account === accountKey && budget.value.kind === 'ok' ? budget.value.data : null;
  const budgetRowList = budgetRows(budgetData, now, timeZone);
  const budgetLine = budgetFreshness(budgetData, now, timeZone);

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
        {!scoutResult && <p className="muted" role="status">Loading scouts…</p>}
        {scoutResult && scoutResult.kind !== 'ok' && <p className="muted" role="status">{scoutResult.kind === 'error' ? scoutResult.message : scoutResult.kind === 'signed-out' ? 'Sign in to view scouts.' : 'Scouts unavailable offline.'}</p>}
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

      <section className="group" aria-label="AI budget">
        <h2>AI budget</h2>
        {!budgetData && <p className="muted" role="status">No budget data yet</p>}
        {budgetData && (
          <>
            {budgetLine && <p className={budgetLine.stale ? 'chip chip-attention' : 'muted'}>{budgetLine.text}</p>}
            {budgetRowList.length === 0
              ? <p className="muted">No budget data yet</p>
              : (
                <ul className="status-sheet-budgets" aria-label="AI budget">
                  {budgetRowList.map((row, i) => (
                    <li key={`${row.id}-${i}`} className="status-sheet-budget">
                      <span className="status-sheet-budget-label">{row.label}</span>
                      <span className={`status-sheet-budget-value budget-${row.tone}`}>{row.value}</span>
                      {row.history && <BudgetSparkline row={row} />}
                      {row.reset && <span className="muted small status-sheet-budget-reset">{row.reset}</span>}
                    </li>
                  ))}
                </ul>
              )}
          </>
        )}
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
