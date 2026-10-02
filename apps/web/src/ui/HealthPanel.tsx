// Health daily card (HC2): read-only projection of the one fixed Apple Health export. No scores, no diagnosis, no
// colour judgement; values and sparklines are shown verbatim, with gaps left as gaps.
import type { HealthMetric, HealthMetricKey, HealthResponse } from '@vault-companion/contracts';
import { useId, useState } from 'react';
import { getHealth } from '../api.ts';
import './Dashboard.css';
import { HealthHistory } from './HealthHistory.tsx';
import { CopyNote, useLastCopy } from './useLastCopy.tsx';

const stepNumber = new Intl.NumberFormat('en-US');
const healthDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

const TILE_LABELS: Record<HealthMetricKey, string> = {
  steps: 'Steps',
  headphone_min: 'Headphones (min)',
  first_move: 'First move',
  last_move: 'Last move',
};

const COMPARE_LABELS: Record<HealthMetric['compare'], string> = {
  above: 'Above usual',
  below: 'Below usual',
  usual: 'Usual',
  unknown: 'Not enough history',
};

/** First/last move are minutes after 03:00; shown as a wall-clock time on the 24h behavioural day. */
export function formatMove(value: number): string {
  const minutes = Math.floor((((180 + value) % 1440) + 1440) % 1440);
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
  const rest = String(minutes % 60).padStart(2, '0');
  return `${hours}:${rest}`;
}

export function formatHealthValue(key: HealthMetricKey, value: number): string {
  if (key === 'steps') return stepNumber.format(value);
  if (key === 'headphone_min') return String(Math.round(value));
  return formatMove(value);
}

/** Indices of consecutive non-null series entries. A `null` ends the current segment, so it is never bridged. */
export function healthSegments(series: readonly (number | null)[]): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  series.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) groups.push(current);
      current = [];
      return;
    }
    current.push(index);
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

function Sparkline({ series }: { series: readonly (number | null)[] }) {
  const hasValue = series.some((value) => value !== null);
  if (!hasValue) return null;
  const W = 120;
  const H = 36;
  const PAD = 3;
  const values = series.filter((value): value is number => value !== null);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number) => (series.length < 2 ? W / 2 : PAD + (index * (W - 2 * PAD)) / (series.length - 1));
  const y = (value: number) => H - PAD - ((value - min) / span) * (H - 2 * PAD);
  return (
    <svg className="health-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {healthSegments(series).filter((segment) => segment.length >= 2).map((segment) => (
        <polyline key={segment[0]} points={segment.map((index) => `${x(index)},${y(series[index]!)}`).join(' ')} />
      ))}
    </svg>
  );
}

function MetricTile({ metric }: { metric: HealthMetric }) {
  const value = metric.value === null ? 'No data' : formatHealthValue(metric.key, metric.value);
  const baseline = metric.baseline === null ? 'No data' : formatHealthValue(metric.key, metric.baseline);
  return (
    <div className="health-tile">
      <h3 className="health-tile-label">{TILE_LABELS[metric.key]}</h3>
      <p className="health-value">{value}</p>
      <p className="health-baseline">Usual {baseline}</p>
      <p className="health-compare">{COMPARE_LABELS[metric.compare]}</p>
      <Sparkline series={metric.series} />
    </div>
  );
}

function HealthFreshness({ health }: { health: HealthResponse }) {
  const day = health.day ? healthDay.format(Date.parse(`${health.day}T00:00:00Z`)) : 'unknown day';
  const staleDays = health.staleDays ?? 0;
  const age = staleDays > 0 ? ` — ${staleDays} day${staleDays === 1 ? '' : 's'} old` : '';
  const stale = staleDays >= 3;
  return (
    <p className={stale ? 'dash-stale' : 'muted small'} role="status">
      Data from {day}{age}
    </p>
  );
}

export function HealthPanel({ refreshKey, accountKey = null }: {
  refreshKey: number | null; accountKey?: string | null;
}) {
  const headingId = useId();
  const [retryKey, setRetryKey] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const view = useLastCopy<HealthResponse>(accountKey, 'health', () => getHealth(), `${refreshKey}:${retryKey}`);
  const res = view.res;
  const failed = res !== null && res.kind !== 'ok';
  const health = res?.kind === 'ok' ? res.data : null;
  return (
    <article className="dash-card dash-health" aria-labelledby={headingId}>
      <header className="dash-card-head">
        <h2 id={headingId}>Health</h2>
        <button type="button" className="link" aria-expanded={showHistory} onClick={() => setShowHistory((open) => !open)}>
          History
        </button>
      </header>
      <CopyNote view={view} />
      {!health && !failed && <p className="muted" role="status">Loading…</p>}
      {!health && failed && (
        <>
          <p className="dash-note" role="status">Health could not be loaded.</p>
          <button type="button" className="link" onClick={() => setRetryKey((previous) => previous + 1)}>Retry health</button>
        </>
      )}
      {health?.status === 'missing' && <p className="dash-note" role="status">No Apple Health export in the vault yet.</p>}
      {health?.status === 'unreadable' && <p className="dash-note" role="status">The Apple Health export could not be read.</p>}
      {health?.status === 'ok' && (
        <>
          <HealthFreshness health={health} />
          <div className="dash-tiles health-tiles">
            {health.metrics.map((metric) => <MetricTile key={metric.key} metric={metric} />)}
          </div>
          {view.failed && <button type="button" className="link" onClick={() => setRetryKey((previous) => previous + 1)}>Retry health</button>}
        </>
      )}
      {showHistory && <HealthHistory />}
    </article>
  );
}
