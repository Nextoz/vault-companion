// M1b: the Credit burn-down monitor. It only draws what the finished `creditBurn()` projection hands it: a typed
// reason when the Scaleway voucher cannot be measured, otherwise the remaining credit ring, the pace against the
// expiry day, the reconstructed spend-vs-ideal chart and the sibling budget rows. MonitorCard owns the disclosure,
// so the collapsed card stays one summary line (nowrap, ellipsis) and the body swaps in on expand.
import type { AiBudgetResponse, AiUsageResponse } from '@vault-companion/contracts';
import type { Fetched } from '../../api.ts';
import { aiUsageDayLabel } from '../ai-usage.ts';
import { creditBurn, type CreditBurnChart, type CreditBurnOk, type CreditBurnOther } from './credit-burn.ts';
import { MonitorCard } from '../MonitorCard.tsx';
import './Monitors.css';

/** The mockup's 246x66 plot box: a baseline at y=52 and values scaled up to y=6, where the ideal line starts. */
const PLOT = { width: 246, height: 66, left: 2, right: 244, baseline: 52, top: 6 };
const RING_R = 47;
const RING_STROKE = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

/** "63" for whole units, "63.2" otherwise, so a balance never grows a meaningless trailing zero. */
const amount = (value: number): string => (Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2))));
/** "EUR 63"; an unknown unit keeps the bare number rather than inventing a currency. */
const money = (unit: string, value: number): string => (unit ? `${unit} ${amount(value)}` : amount(value));

/** The 110 px ring: the track always, the filled arc only when a limit is known, the balance at its centre. */
function Ring({ left, limit, unit, fraction }: { left: number; limit: number | null; unit: string; fraction: number | null }) {
  const arc = fraction === null ? null : `${(fraction * RING_CIRCUMFERENCE).toFixed(1)} ${RING_CIRCUMFERENCE.toFixed(1)}`;
  return (
    <div className="m1-ring">
      <svg width="110" height="110" viewBox="0 0 110 110" role="img"
        aria-label={`${money(unit, left)}${limit === null ? '' : ` of ${amount(limit)}`} left`}>
        <circle className="m1-ring-track" cx="55" cy="55" r={RING_R} strokeWidth={RING_STROKE} />
        {arc !== null && <circle className="m1-ring-arc" cx="55" cy="55" r={RING_R} strokeWidth={RING_STROKE}
          strokeLinecap="round" strokeDasharray={arc} transform="rotate(-90 55 55)" />}
        <text className="m1-ring-value" x="55" y={limit === null ? 59 : 51} textAnchor="middle">{money(unit, left)}</text>
        {limit !== null && <text className="m1-ring-sub" x="55" y="66" textAnchor="middle">of {amount(limit)} left</text>}
      </svg>
    </div>
  );
}

/** The spend curve, oldest first, against a dashed ideal line from the first recorded day to the expiry day. The y
 *  scale tops out at the reconstruction's own highest balance, so the curve and the ideal line share one axis. */
function Chart({ chart, expiresLabel }: { chart: CreditBurnChart; expiresLabel: string }) {
  const points = chart.points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const top = Math.max(...points.map((point) => point.left), 1);
  const x = (index: number) =>
    points.length === 1 ? PLOT.right : PLOT.left + (index * (PLOT.right - PLOT.left)) / (points.length - 1);
  const y = (value: number) => PLOT.baseline - (value / top) * (PLOT.baseline - PLOT.top);
  const idealTo = chart.idealTo;
  return (
    <svg className="m1-chart" width={PLOT.width} height={PLOT.height} viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
      role="img" aria-label={`Spend vs ideal from ${aiUsageDayLabel(first.date)} to ${expiresLabel}`}>
      <line className="m1-chart-base" x1={PLOT.left} y1={PLOT.baseline} x2={PLOT.right} y2={PLOT.baseline} />
      {idealTo && <line className="m1-chart-ideal" x1={PLOT.left} y1={y((chart.idealFrom ?? first).left)}
        x2={PLOT.right} y2={y(idealTo.left)} />}
      <polyline className="m1-chart-line"
        points={points.map((point, index) => `${x(index).toFixed(1)},${y(point.left).toFixed(1)}`).join(' ')} />
      <circle className="m1-chart-dot" cx={x(points.length - 1)} cy={y(last.left)} r="3" />
      <text className="m1-chart-label" x={PLOT.left} y="62">{aiUsageDayLabel(first.date)}</text>
      <text className="m1-chart-label m1-chart-label-end" x={PLOT.right} y="62" textAnchor="end">{expiresLabel}</text>
    </svg>
  );
}

/** One sibling budget row: label over its reset note, the row's own value text at the right, and a hairline bar for
 *  the rows that carry a percentage. */
function OtherRow({ row }: { row: CreditBurnOther }) {
  return (
    <div className="m1-other">
      <div className="m1-other-row">
        <span className="m1-other-label">
          {row.label}
          {row.reset && <span className="m1-other-reset">{row.reset}</span>}
        </span>
        <span className="m1-other-value">{row.value}</span>
      </div>
      {row.percent !== null && <div className="m1-bar"><i className={`m1-bar-fill m1-bar-${row.tone}`}
        style={{ width: `${Math.min(Math.max(row.percent, 0), 100)}%` }} /></div>}
    </div>
  );
}

function Burned({ view }: { view: CreditBurnOk }) {
  return (
    <div className="m1-body">
      <p className="m1-sec">Scaleway voucher</p>
      <Ring left={view.left} limit={view.limit} unit={view.unit} fraction={view.ring.fraction} />
      <p className="m1-expiry">{view.daysLeft} days left · expires {view.expiresLabel}</p>
      <p className="m1-sec">Spend vs ideal</p>
      {view.chart.points.length === 0
        ? <p className="m1-empty muted small">No spend recorded yet.</p>
        : <Chart chart={view.chart} expiresLabel={view.expiresLabel} />}
      {view.chart.points.length > 0 && <p className="m1-legend muted small">— actual · – – – ideal</p>}
      <p className={`m1-pace ${view.burn === null ? 'm1-pace-unknown' : view.burn.onPace ? 'm1-pace-ok' : 'm1-pace-warn'}`}>
        {view.burn === null ? 'Pace unknown: no recorded spend in the last 7 days' : view.burn.paceText}
      </p>
      {view.others.length > 0 && <p className="m1-sec">Other balances</p>}
      {view.others.map((row) => <OtherRow key={row.id} row={row} />)}
    </div>
  );
}

export function CreditBurnMonitor({ usage, budget, now, timeZone = 'Europe/Copenhagen' }: {
  usage: Fetched<AiUsageResponse> | null;
  budget: Fetched<AiBudgetResponse> | null;
  now: number;
  timeZone?: string;
}) {
  if (usage === null && budget === null) return null;
  const view = creditBurn(budget?.kind === 'ok' ? budget.data : null, usage?.kind === 'ok' ? usage.data : null, now, timeZone);
  const footer = view.freshness && (
    <p className={view.freshness.stale ? 'dash-stale' : 'muted small'} role="status">{view.freshness.text}</p>
  );
  if (view.kind === 'unavailable') {
    return (
      <MonitorCard title="Credit burn-down" className="credit-burn" footer={footer} summary={null}
        status={<p className="dash-note" role="status">{view.reason}</p>}>{null}</MonitorCard>
    );
  }
  const tone = view.burn === null ? 'm1-summary-unknown' : view.burn.onPace ? 'm1-summary-ok' : 'm1-summary-short';
  return (
    <MonitorCard title="Credit burn-down" className="credit-burn" footer={footer}
      summary={<p className={`m1-summary ${tone}`}>{view.summary}</p>}>
      <Burned view={view} />
    </MonitorCard>
  );
}
