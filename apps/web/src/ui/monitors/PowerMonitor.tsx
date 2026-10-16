// M4c2: the Power (DK2) monitor — DK2 spot prices and CO₂ intensity from Energi Data Service, one card on the
// Dashboard. The card fetches itself (read-only `/api/power`, retried on demand) and every number it shows comes from
// the M4c1 helpers in power.ts; failure words are the provider's own, never invented here.
import { useEffect, useState } from 'react';
import type { PowerResponse } from '@vault-companion/contracts';
import { getPower, type Fetched } from '../../api.ts';
import { MonitorCard } from '../MonitorCard.tsx';
import { co2Line, formatKr, powerBars, powerFreshTime, powerStale, powerSummary } from './power.ts';
import './Power.css';

const POWER_FAILED = 'Power prices could not be loaded. No values are shown.';
const NOT_PUBLISHED =
  "Tomorrow's prices are not published yet. Energi Data Service usually publishes them after 13:00.";

// Chart geometry from the m4 mockup: a 248x130 viewBox, one slot per hour from x 4 to 244, the floor at y 113 and
// 100 px for the day's most expensive hour. Axis labels sit under every 6th slot plus the last, at the bars' centres.
const X0 = 4;
const X1 = 244;
const FLOOR = 113;
const MAX_BAR = 100;
const BAR_SHARE = 0.65;

export function PowerMonitor() {
  const [retry, setRetry] = useState(0);
  const [res, setRes] = useState<Fetched<PowerResponse> | null>(null);
  const [tab, setTab] = useState<'today' | 'tomorrow'>('today');
  // One read per mount; the Retry button bumps `retry` to fetch again. A late answer never lands on an unmounted card.
  useEffect(() => {
    let live = true;
    void getPower().then((result) => { if (live) setRes(result); });
    return () => { live = false; };
  }, [retry]);
  const data = res !== null && res.kind === 'ok' ? res.data : null;
  const okData = data !== null && data.status === 'ok' ? data : null;
  const nowHour = tab === 'today' && okData !== null ? okData.nowHour : null;
  const day = okData !== null ? okData[tab] : null;
  const dayOk = day !== null && day.status === 'ok' ? day : null;
  const bars = dayOk !== null ? powerBars(dayOk, nowHour !== null ? nowHour.start : null, dayOk.cheapestWindow) : [];
  const slot = bars.length > 0 ? (X1 - X0) / bars.length : X1 - X0;
  const barWidth = slot * BAR_SHARE;
  // The dashed day-average line sits at the average's share of the tallest bar (never below the floor, never inverted).
  const avgRatio = dayOk !== null && dayOk.maxKrPerKwh > 0
    ? Math.min(Math.max(dayOk.averageKrPerKwh / dayOk.maxKrPerKwh, 0), 1)
    : 0;
  const avgY = FLOOR - avgRatio * MAX_BAR;
  const stale = data !== null && powerStale(data, Date.now());
  const co2 = okData !== null ? okData.co2 : null;
  const chartLabel = dayOk === null ? '' : `Hourly spot price bar chart for ${tab}` +
    (dayOk.cheapestWindow !== null ? `, cheapest window ${dayOk.cheapestWindow.label}` : '') +
    (nowHour !== null ? `, now marked at ${nowHour.label}:00` : '');
  return (
    <MonitorCard
      title="Power (DK2)"
      className="power-monitor"
      headerExtra={okData !== null ? (
        <div className="segmented" role="group" aria-label="Power day">
          <button type="button" aria-pressed={tab === 'today'} onClick={() => setTab('today')}>Today</button>
          <button type="button" aria-pressed={tab === 'tomorrow'} onClick={() => setTab('tomorrow')}>Tomorrow</button>
        </div>
      ) : undefined}
      status={res === null ? (
        <p className="dash-note" role="status">Loading…</p>
      ) : res.kind !== 'ok' ? (
        <div className="power-failure">
          <p className="dash-note" role="status">{POWER_FAILED}</p>
          <button type="button" className="link" onClick={() => setRetry((previous) => previous + 1)}>Retry</button>
        </div>
      ) : res.data.status === 'unavailable' ? (
        <p className="dash-note" role="status">{res.data.note}</p>
      ) : undefined}
      summary={<p className="power-summary">{data !== null ? powerSummary(data) : ''}</p>}
      footer={okData !== null && (
        <p className={stale ? 'dash-stale power-updated' : 'muted small power-updated'} role="status">
          Energi Data Service · Updated {powerFreshTime(okData.fetchedAt)}{stale ? ' · stale' : ''}
        </p>
      )}
    >
      {dayOk === null ? (
        <p className="dash-note" role="status">{NOT_PUBLISHED}</p>
      ) : (
        <>
          <svg className="power-chart" viewBox="0 0 248 130" width={248} height={130} role="img" aria-label={chartLabel}>
            {bars.map((bar, index) => {
              const height = Math.max(bar.ratio * MAX_BAR, 1);
              return <rect key={index} className={`power-bar power-bar-${bar.kind}`} x={X0 + index * slot}
                y={FLOOR - height} width={barWidth} height={height} rx={1.5} />;
            })}
            <line className="power-avg" x1={2} y1={avgY} x2={246} y2={avgY} />
            {bars.map((bar, index) => index % 6 === 0 || index === bars.length - 1 ? (
              <text key={`axis-${index}`} x={X0 + index * slot + barWidth / 2} y={124} textAnchor="middle">{bar.label}</text>
            ) : null)}
          </svg>
          <div className="power-row">
            {dayOk.cheapestWindow !== null && (
              <span className="power-cheapest">
                Cheapest 3 h · {dayOk.cheapestWindow.label} · {formatKr(dayOk.cheapestWindow.averageKrPerKwh)} kr
              </span>
            )}
            <span className="muted small">avg {formatKr(dayOk.averageKrPerKwh)}</span>
          </div>
          {tab === 'today' && <p className="muted small">CO₂ intensity: {co2Line(co2)}</p>}
        </>
      )}
    </MonitorCard>
  );
}
