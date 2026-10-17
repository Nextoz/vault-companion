// MarketChart (DASH1): the dashboard's price chart and the pure helpers it needs, moved unchanged from Dashboard.tsx.
// Gaps stay gaps: the series is split where a bucket is missing and never joined across one. Presentation only.
import type { DashboardRange, MarketSeries } from '@vault-companion/contracts';
import { useId, useMemo, type PointerEvent } from 'react';

export const RANGE_LABELS: Record<DashboardRange, string> = { '1W': '1 week', '1M': '1 month', '3M': '3 months', '1Y': '1 year' };

export const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const instant = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const formatInstant = (iso: string): string => `${instant.format(Date.parse(iso))} UTC`;
const at = (iso: string): number => Date.parse(iso);

/**
 * Indices of points, split where the provider left a bucket out. The chart draws one segment per group and never joins
 * across a gap: a missing interval stays missing instead of becoming an invented straight line.
 */
export function seriesSegments(series: MarketSeries): number[][] {
  const stepMs = series.granularitySeconds * 1000;
  const groups: number[][] = [];
  let current: number[] = [];
  series.points.forEach((point, index) => {
    if (current.length > 0) {
      const previous = series.points[current[current.length - 1]!]!;
      if (at(point.time) - at(previous.time) > stepMs) {
        groups.push(current);
        current = [];
      }
    }
    current.push(index);
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

export function Chart({ series, title, formatValue = (value: number) => money.format(value), active, onInspect }: {
  series: MarketSeries; title: string; formatValue?: ((value: number) => string) | undefined; active: number | null; onInspect: (index: number) => void;
}) {
  const points = series.points;
  const segments = useMemo(() => seriesSegments(series), [series]);
  const { min, max } = useMemo(() => {
    const closes = points.map((p) => p.close);
    return { min: Math.min(...closes), max: Math.max(...closes) };
  }, [points]);
  const W = 320;
  const H = 120;
  const PAD = 6;
  const span = max - min || 1;
  const x = (index: number) => (points.length < 2 ? W / 2 : PAD + (index * (W - 2 * PAD)) / (points.length - 1));
  const y = (value: number) => H - PAD - ((value - min) / span) * (H - 2 * PAD);
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    // Default SVG xMidYMid meet scaling can also leave horizontal letterboxing.
    const scale = Math.min(rect.width / W, rect.height / H);
    if (scale <= 0) return;
    const plotX = (event.clientX - rect.left - (rect.width - W * scale) / 2) / scale;
    const ratio = (plotX - PAD) / (W - 2 * PAD);
    onInspect(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
  };
  const label = `${title} ${RANGE_LABELS[series.range]}: ${points.length} points, ${series.missingIntervals} intervals missing`;
  const fillId = `dash-fill-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <figure className="dash-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="dash-svg" role="img" aria-label={label} onPointerDown={pick} onPointerMove={(e) => { if (e.buttons) pick(e); }}>
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="dash-fill-top" />
            <stop offset="100%" className="dash-fill-bottom" />
          </linearGradient>
        </defs>
        {/* Soft fill under each segment only: a gap stays empty, like the line. */}
        {segments.filter((segment) => segment.length > 1).map((segment, index) => (
          <path key={`fill-${index}`} className="dash-area" fill={`url(#${fillId})`}
            d={`M${x(segment[0]!)},${H - PAD} ${segment.map((i) => `L${x(i)},${y(points[i]!.close)}`).join(' ')} L${x(segment[segment.length - 1]!)},${H - PAD} Z`} />
        ))}
        {segments.map((segment, index) =>
          segment.length > 1 ? (
            <polyline key={index} className="dash-line" points={segment.map((i) => `${x(i)},${y(points[i]!.close)}`).join(' ')} />
          ) : (
            <circle key={index} className="dash-dot" cx={x(segment[0]!)} cy={y(points[segment[0]!]!.close)} r={2} />
          ))}
        {points.length > 0 && <circle className="dash-cursor" cx={x(active ?? points.length - 1)} cy={y(points[active ?? points.length - 1]!.close)} r={4} />}
      </svg>
      <input
        type="range"
        className="dash-slider"
        min={0}
        max={Math.max(0, points.length - 1)}
        step={1}
        value={active ?? Math.max(0, points.length - 1)}
        onInput={(e) => onInspect(Number(e.currentTarget.value))}
        aria-label={`Inspect ${RANGE_LABELS[series.range]}`}
      />
      <figcaption className="dash-readout" aria-live="polite">
        {points.length > 0
          ? <><time dateTime={points[active ?? points.length - 1]!.time}>{formatInstant(points[active ?? points.length - 1]!.time)}</time> · {formatValue(points[active ?? points.length - 1]!.close)}</>
          : 'No points to inspect'}
      </figcaption>
    </figure>
  );
}
