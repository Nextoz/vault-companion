// Health history (HC3b): the whole fixed Apple Health export, read-only, sliced client-side across range chips.
// Values are shown verbatim; nulls stay gaps; no scores, no diagnosis, no colour judgement.
import type { HealthHistoryDay, HealthHistoryResponse, HealthMetricKey } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getHealthHistory, type Fetched } from '../api.ts';
import { formatHealthValue, healthSegments } from './HealthPanel.tsx';

export type HistoryRange = '30d' | '90d' | '1y' | 'all';

const RANGES: readonly { readonly id: HistoryRange; readonly label: string; readonly days: number | null }[] = [
  { id: '30d', label: '30 d', days: 30 },
  { id: '90d', label: '90 d', days: 90 },
  { id: '1y', label: '1 y', days: 365 },
  { id: 'all', label: 'All', days: null },
];

const METRIC_KEYS: readonly HealthMetricKey[] = ['steps', 'headphone_min', 'first_move', 'last_move'];
const LABELS: Record<HealthMetricKey, string> = {
  steps: 'Steps',
  headphone_min: 'Headphones (min)',
  first_move: 'First move',
  last_move: 'Last move',
};

const copenhagen = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' });

function shiftDay(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** The window is anchored to yesterday (Copenhagen) and inclusive; future days are never shown. "All" keeps everything. */
export function sliceHistory(days: readonly HealthHistoryDay[], range: HistoryRange, now: number): HealthHistoryDay[] {
  const yesterday = shiftDay(copenhagen.format(now), -1);
  const span = RANGES.find((option) => option.id === range)!.days;
  const start = span === null ? null : shiftDay(yesterday, -(span - 1));
  return days.filter((day) => day.date <= yesterday && (start === null || day.date >= start));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function HistoryLine({ values }: { values: readonly (number | null)[] }) {
  if (!values.some((value) => value !== null)) return null;
  const W = 200;
  const H = 40;
  const PAD = 3;
  const present = values.filter((value): value is number => value !== null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;
  const x = (index: number) => (values.length < 2 ? W / 2 : PAD + (index * (W - 2 * PAD)) / (values.length - 1));
  const y = (value: number) => H - PAD - ((value - min) / span) * (H - 2 * PAD);
  return (
    <svg className="health-history-line" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {healthSegments(values).filter((segment) => segment.length >= 2).map((segment) => (
        <polyline key={segment[0]} points={segment.map((index) => `${x(index)},${y(values[index]!)}`).join(' ')} />
      ))}
    </svg>
  );
}

function HistoryMetric({ metricKey, values }: { metricKey: HealthMetricKey; values: readonly (number | null)[] }) {
  const present = values.filter((value): value is number => value !== null);
  return (
    <div className="health-tile">
      <h3 className="health-tile-label">{LABELS[metricKey]}</h3>
      <p className="health-value">{present.length === 0 ? 'No data' : formatHealthValue(metricKey, median(present))}</p>
      <p className="health-baseline">Range median</p>
      <HistoryLine values={values} />
    </div>
  );
}

function HistoryBoard({ history, range, onRange }: {
  history: HealthHistoryResponse; range: HistoryRange; onRange: (range: HistoryRange) => void;
}) {
  const days = sliceHistory(history.days, range, Date.parse(history.now));
  const columns = METRIC_KEYS.map((key) => days.map((day) => day[key]));
  const empty = days.length === 0 || columns.every((values) => values.every((value) => value === null));
  return (
    <>
      <div className="segmented health-history-ranges" role="group" aria-label="History range">
        {RANGES.map((option) => (
          <button key={option.id} type="button" aria-pressed={range === option.id} onClick={() => onRange(option.id)}>{option.label}</button>
        ))}
      </div>
      {empty ? <p className="dash-note" role="status">No data in this range.</p> : (
        <div className="dash-tiles health-tiles">
          {METRIC_KEYS.map((key, index) => <HistoryMetric key={key} metricKey={key} values={columns[index]!} />)}
        </div>
      )}
    </>
  );
}

/** Fetches once per mount: it is mounted only while the card's History toggle is open, so nothing loads on card load. */
export function HealthHistory() {
  const [read, setRead] = useState<Fetched<HealthHistoryResponse> | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [range, setRange] = useState<HistoryRange>('30d');

  useEffect(() => {
    let live = true;
    setRead(null);
    void getHealthHistory().then((result) => { if (live) setRead(result); });
    return () => { live = false; };
  }, [retryKey]);

  const failed = read !== null && read.kind !== 'ok';
  const history = read?.kind === 'ok' ? read.data : null;
  return (
    <section className="health-history" aria-label="Health history">
      {read === null && <p className="muted" role="status">Loading…</p>}
      {failed && (
        <>
          <p className="dash-note" role="status">History could not be loaded.</p>
          <button type="button" className="link" onClick={() => setRetryKey((previous) => previous + 1)}>Retry history</button>
        </>
      )}
      {history?.status === 'missing' && <p className="dash-note" role="status">No Apple Health export in the vault yet.</p>}
      {history?.status === 'unreadable' && <p className="dash-note" role="status">The Apple Health export could not be read.</p>}
      {history?.status === 'ok' && <HistoryBoard history={history} range={range} onRange={setRange} />}
    </section>
  );
}
