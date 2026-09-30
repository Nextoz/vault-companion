// Dashboard (DASH1): read-only overview. One BTC/USD card with a 1W/1M/3M series, plus honest overview cards for the
// AI usage and Health sources that are not connected yet. No writes, no provider calls from the browser.
import type { DashboardCard, DashboardRange, DashboardResponse, MarketCard, MarketSeries, MarketTickerResponse } from '@vault-companion/contracts';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { getDashboard, getMarketTicker, type Fetched } from '../api.ts';
import './Dashboard.css';

export const TICKER_POLL_MS = 60_000;
/** Older than this and the card says so, in words; the number is never silently repainted as fresh. */
export const MARKET_STALE_MS = 120_000;
export const RANGE_LABELS: Record<DashboardRange, string> = { '1W': '1 week', '1M': '1 month', '3M': '3 months' };
export const DASHBOARD_RANGES: readonly DashboardRange[] = ['1W', '1M', '3M'];

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
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

/** Fold a ticker-only poll into the loaded dashboard; only the market card's current value is replaced. */
export function mergeTicker(data: DashboardResponse, poll: MarketTickerResponse): DashboardResponse {
  if (poll.status !== 'ok') return data;
  return {
    now: poll.now,
    cards: data.cards.map((card): DashboardCard =>
      card.id === 'market' && card.status === 'ok'
        ? { ...card, ticker: poll.ticker, observedAt: poll.ticker.providerTime, fetchedAt: poll.fetchedAt }
        : card),
  };
}

export function marketFresh(card: MarketCard, nowMs: number): boolean {
  return card.status === 'ok' && card.fetchedAt !== null && nowMs - at(card.fetchedAt) <= MARKET_STALE_MS;
}

function Chart({ series, active, onInspect }: { series: MarketSeries; active: number | null; onInspect: (index: number) => void }) {
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
  const label = `BTC / USD ${RANGE_LABELS[series.range]}: ${points.length} points, ${series.missingIntervals} intervals missing`;
  return (
    <figure className="dash-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="dash-svg" role="img" aria-label={label} onPointerDown={pick} onPointerMove={(e) => { if (e.buttons) pick(e); }}>
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
          ? <><time dateTime={points[active ?? points.length - 1]!.time}>{formatInstant(points[active ?? points.length - 1]!.time)}</time> · {money.format(points[active ?? points.length - 1]!.close)}</>
          : 'No points to inspect'}
      </figcaption>
    </figure>
  );
}

function MarketView({ card, stale, onDrillthrough }: {
  card: MarketCard; stale: boolean; onDrillthrough?: ((view: string) => void) | undefined;
}) {
  const headingId = useId();
  const [selection, setSelection] = useState<number | null>(null);
  const seriesKey = card.status === 'ok' && card.series ? card.series.range + ':' + card.series.points.length : 'none';
  useEffect(() => setSelection(null), [seriesKey]);
  const status = card.status === 'unavailable' ? 'Unavailable' : stale ? 'Stale' : 'Live';
  return (
    <article className="dash-card dash-market" aria-labelledby={headingId} aria-busy={stale}>
      <header className="dash-card-head">
        <h2 id={headingId}>{card.title}</h2>
        <span className={`dash-chip dash-chip-${status.toLowerCase()}`}>{status}</span>
      </header>

      {card.status === 'unavailable' ? (
        <p className="dash-note" role="status">{card.note ?? 'Market data is unavailable.'}</p>
      ) : (
        <>
          <p className="dash-price">{money.format(card.ticker.price)}</p>
          <p className="dash-times muted small">
            Market time <time dateTime={card.ticker.providerTime}>{formatInstant(card.ticker.providerTime)}</time>
            {card.fetchedAt && <> · fetched <time dateTime={card.fetchedAt}>{formatInstant(card.fetchedAt)}</time></>}
          </p>
          {stale && <p className="dash-stale" role="status">This value is not fresh — showing the last one we have.</p>}
          {card.series
            ? <>
                <Chart series={card.series} active={selection} onInspect={setSelection} />
                {card.series.missingIntervals > 0 && <p className="muted small">{card.series.missingIntervals} intervals missing — shown as gaps, not filled in.</p>}
              </>
            : <p className="dash-note" role="status">{card.note ?? 'History is unavailable.'}</p>}
        </>
      )}
      <p className="muted small">{card.provenance}</p>
      {card.drillthrough && <button type="button" className="link" onClick={() => onDrillthrough?.(card.drillthrough!.view)}>{card.drillthrough.label}</button>}
    </article>
  );
}

function OverviewCard({ card, onDrillthrough }: { card: DashboardCard; onDrillthrough?: ((view: string) => void) | undefined }) {
  const headingId = useId();
  const status = card.status === 'ok' ? 'Live' : card.status === 'unavailable' ? 'Unavailable' : 'Not configured';
  return (
    <article className="dash-card" aria-labelledby={headingId}>
      <header className="dash-card-head">
        <h2 id={headingId}>{card.title}</h2>
        <span className={`dash-chip dash-chip-${card.status === 'not-configured' ? 'not-configured' : card.status}`}>{status}</span>
      </header>
      <p className="muted small">{card.provenance}</p>
      {card.note && <p className="dash-note" role="status">{card.note}</p>}
      {card.fetchedAt && <p className="muted small">Fetched <time dateTime={card.fetchedAt}>{formatInstant(card.fetchedAt)}</time></p>}
      {card.drillthrough && <button type="button" className="link" onClick={() => onDrillthrough?.(card.drillthrough!.view)}>{card.drillthrough.label}</button>}
    </article>
  );
}

export function Dashboard({ refreshKey, onDrillthrough }: { refreshKey: number | null; onDrillthrough?: ((view: string) => void) | undefined }) {
  const [range, setRange] = useState<DashboardRange>('1W');
  const [loaded, setLoaded] = useState<{ range: DashboardRange; data: DashboardResponse } | null>(null);
  const [failed, setFailed] = useState(false);
  const [tickerFailed, setTickerFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    let live = true;
    void getDashboard(range).then((res: Fetched<DashboardResponse>) => {
      if (!live || gen !== genRef.current) return;
      if (res.kind === 'ok') {
        setLoaded({ range, data: res.data });
        setFailed(false);
        setTickerFailed(false);
      } else {
        setFailed(true);
      }
    });
    return () => { live = false; };
  }, [range, refreshKey, retryKey]);

  useEffect(() => {
    const canPoll = () => (typeof document === 'undefined' || document.visibilityState !== 'hidden') && (typeof navigator === 'undefined' || navigator.onLine !== false);
    const tick = async () => {
      if (!canPoll()) return;
      const gen = genRef.current;
      const res = await getMarketTicker();
      if (gen !== genRef.current) return;
      if (res.kind === 'ok') {
        setLoaded((previous) => (previous ? { ...previous, data: mergeTicker(previous.data, res.data) } : previous));
        setTickerFailed(res.data.status !== 'ok');
      } else {
        setTickerFailed(true);
      }
    };
    const timer = setInterval(() => void tick(), TICKER_POLL_MS);
    const onWake = () => { if (canPoll()) void tick(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
    };
  }, []);

  const onRange = useCallback((next: DashboardRange) => setRange(next), []);
  const matching = loaded !== null && loaded.range === range ? loaded.data : null;
  // When the requested range has not arrived yet, an older range's data may still be shown — but only labelled as stale.
  const shown = matching ?? (failed ? loaded?.data ?? null : null);
  const market = shown?.cards.find((card): card is MarketCard => card.id === 'market') ?? null;
  const stale = failed || tickerFailed || (market !== null && market.status === 'ok' && shown !== null && !marketFresh(market, at(shown.now)));

  return (
    <section className="dash" aria-label="Dashboard">
      <h2 className="dash-heading">Dashboard</h2>
      <div className="dash-ranges" role="group" aria-label="Chart range">
        {DASHBOARD_RANGES.map((r) => (
          <button key={r} type="button" aria-pressed={range === r} onClick={() => onRange(r)}>{r}</button>
        ))}
      </div>
      {!shown && !failed && <p className="muted" role="status">Loading…</p>}
      {!shown && failed && <p className="dash-note" role="status">The dashboard could not be loaded.</p>}
      {(failed || market?.status === 'unavailable' || (market?.status === 'ok' && !market.series)) && <button type="button" className="link" onClick={() => setRetryKey((previous) => previous + 1)}>Retry dashboard</button>}
      {shown && stale && <p className="dash-stale" role="status">Not refreshed — the times below are from the last success.</p>}
      {shown && market && <MarketView card={market} stale={stale} onDrillthrough={onDrillthrough} />}
      {shown && shown.cards.filter((card) => card.id !== 'market').map((card) => <OverviewCard key={card.id} card={card} onDrillthrough={onDrillthrough} />)}
    </section>
  );
}
