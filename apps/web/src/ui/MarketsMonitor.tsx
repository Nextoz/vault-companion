// W3 (markets monitor): the Markets card — the legacy market card, the watchlist and the private valuations folded
// into one MonitorCard of compact rows (mockup option B). Every label, price, change and amount comes from the w1 row
// model (markets.ts): this file never computes one, it only lays the rows out, keeps the open row and the chart
// selection, and copies the detail bodies the old Dashboard views had. Read-only, like the cards it replaces.
import type { DashboardRange, MarketCard, MarketSeries, PrivateValuationCard, WatchCard } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { MonitorCard } from './MonitorCard.tsx';
import { Chart, formatInstant, seriesSegments } from './MarketChart.tsx';
import { type MarketRow, marketRows, marketsSummary } from './markets.ts';
import { formatChange, formatPrivateValuation, formatWatchValue, watchDelayLabel, watchTitle, type WatchChange } from './watchlist.ts';
import './Markets.css';

// DASHBOARD_RANGES lives in Dashboard.tsx and importing it back would be circular; the four windows are fixed in the
// contract, so this card keeps its own copy of the same list.
const RANGES: readonly DashboardRange[] = ['1W', '1M', '3M', '1Y'];

// Markets.css styles up and down; muted is the global class — a muted value must never come out in the default text
// colour and look live.
const toneClass = (tone: 'up' | 'down' | 'muted'): string => (tone === 'muted' ? 'muted' : `markets-${tone}`);

export function MarketsMonitor({ market, watches, privates, range, onRange, isStale, onDrillthrough, loading = false }: {
  market: MarketCard | null;
  watches: readonly WatchCard[];
  privates: readonly PrivateValuationCard[];
  range: DashboardRange;
  onRange: (r: DashboardRange) => void;
  isStale: (card: MarketCard | WatchCard) => boolean;
  onDrillthrough?: ((view: string) => void) | undefined;
  /** The dashboard for this range is still loading: the card stays mounted (so it stays open) and says so. */
  loading?: boolean;
}) {
  // The open row lives here, not in the list: a range change that briefly empties the card keeps the row open.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rows = marketRows({ market, watches, privates, isStale });
  const { items, more } = marketsSummary(rows);
  return (
    <MonitorCard
      title="Markets"
      className="markets"
      headerExtra={loading || market !== null || watches.length > 0 ? (
        <div className="segmented markets-range" role="group" aria-label="Chart range">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => onRange(r)}>{r}</button>
          ))}
        </div>
      ) : undefined}
      status={rows.length === 0 ? <p className="dash-note" role="status">{loading ? "Loading markets…" : "No markets are configured."}</p> : undefined}
      summary={
        <p className="markets-summary">
          {items.map((item, index) => (
            <span key={index}>
              {index > 0 && <span className="muted"> · </span>}
              {item.label} <span className={toneClass(item.tone)}>{item.text}</span>
            </span>
          ))}
          {more > 0 && <span className="muted"> · +{more} more</span>}
        </p>
      }
    >
      <MarketsList rows={rows} openKey={openKey} onOpenKey={setOpenKey} onDrillthrough={onDrillthrough} />
    </MonitorCard>
  );
}

/** The 64x16 row chart: one polyline per unbroken run of closes, gaps staying gaps. Two points are the least it can
 * draw; anything less keeps the empty middle slot so the row's three columns stay aligned. */
function Sparkline({ series, change }: { series: MarketSeries | null; change: WatchChange | null }) {
  const points = series?.points ?? [];
  if (series === null || points.length < 2) return <span className="markets-mid"></span>;
  const closes = points.map((point) => point.close);
  const min = Math.min(...closes);
  const span = Math.max(...closes) - min || 1;
  const x = (index: number) => (index * 64) / (points.length - 1);
  const y = (close: number) => 1 + (1 - (close - min) / span) * 14;
  return (
    <svg className={`markets-spark ${toneClass(change === null ? 'muted' : change.direction)}`} viewBox="0 0 64 16" width="64" height="16" aria-hidden="true">
      {seriesSegments(series)
        .filter((segment) => segment.length > 1)
        .map((segment, index) => (
          <polyline key={index} points={segment.map((i) => `${x(i)},${y(points[i]!.close)}`).join(' ')} />
        ))}
    </svg>
  );
}

/** The open body: the rows and, under the one open row, its detail. */
function MarketsList({ rows, openKey, onOpenKey, onDrillthrough }: {
  rows: readonly MarketRow[]; openKey: string | null; onOpenKey: (key: string | null) => void; onDrillthrough?: ((view: string) => void) | undefined;
}) {
  return (
    <ul className="markets-list">
      {rows.map((row) => {
        const open = openKey === row.key;
        const detailId = `markets-detail-${row.key}`;
        return (
          <li key={row.key} className="markets-item">
            <button type="button" className="markets-row" aria-expanded={open} aria-controls={detailId}
              onClick={() => onOpenKey(open ? null : row.key)}>
              <span className="markets-label">{row.label}</span>
              {row.kind === 'priced' ? (
                <Sparkline series={row.series} change={row.change} />
              ) : row.kind === 'private' ? (
                <span className="markets-mid muted">last round</span>
              ) : (
                <span className="markets-mid muted">unavailable</span>
              )}
              <span className="markets-value">
                {row.kind === 'priced' ? (
                  <>
                    <span className={row.stale ? 'markets-price muted' : 'markets-price'}>{row.priceText}</span>
                    {row.change !== null && (
                      <span className={`markets-change ${row.stale ? 'muted' : `markets-${row.change.direction}`}`}>
                        {formatChange(row.change)}
                      </span>
                    )}
                  </>
                ) : row.kind === 'private' ? (
                  row.amountText
                ) : (
                  <span className="muted">—</span>
                )}
              </span>
              {row.kind === 'priced' && row.stale && <span className="visually-hidden">, stale</span>}
            </button>
            {open && (
              <div id={detailId} className="markets-detail">
                <RowDetail row={row} onDrillthrough={onDrillthrough} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The open row's body: the old MarketView / WatchView / PrivateValuationView bodies minus the article, the header and
 * the big price (the row already carries those). The chart selection resets when the series range or length changes,
 * exactly like the old views did. */
function RowDetail({ row, onDrillthrough }: { row: MarketRow; onDrillthrough?: ((view: string) => void) | undefined }) {
  const [selection, setSelection] = useState<number | null>(null);
  const series = row.kind === 'priced' ? row.series : null;
  const seriesKey = series !== null ? series.range + ':' + series.points.length : 'none';
  useEffect(() => setSelection(null), [seriesKey]);

  if (row.kind === 'unavailable') {
    const card = row.card;
    return (
      <>
        <p className="dash-note" role="status">
          {card.note ?? (card.id === 'private-valuation' ? 'Private valuation is unavailable.' : 'Market data is unavailable.')}
        </p>
        <p className="muted small">{card.provenance}</p>
      </>
    );
  }

  if (row.kind === 'private') {
    // A private row is only built from an ok card (markets.ts); the guard keeps the narrowing honest anyway.
    const card = row.card;
    if (card.status !== 'ok') return null;
    return (
      <>
        <p className="dash-private-value">{formatPrivateValuation(card)}</p>
        <a className="dash-private-source" href={card.item.source.url} target="_blank" rel="noopener noreferrer">Source: {card.item.source.label}</a>
        <p className="muted small">{card.provenance}</p>
      </>
    );
  }

  // A priced row is only built from an ok card (markets.ts); the guard keeps the narrowing honest anyway.
  const card = row.card;
  if (card.status !== 'ok') return null;
  const status = row.stale ? 'Stale' : 'Live';
  const delay = card.id === 'watchlist' ? watchDelayLabel(card) : null;
  return (
    <>
      <div className="dash-card-head">
        {delay !== null && <span className="dash-chip dash-chip-delayed">{delay}</span>}
        <span className={`dash-chip dash-chip-${status.toLowerCase()}`}>{status}</span>
      </div>
      <p className="dash-times muted small">
        Market time <time dateTime={card.ticker.providerTime}>{formatInstant(card.ticker.providerTime)}</time>
        {card.fetchedAt && <> · fetched <time dateTime={card.fetchedAt}>{formatInstant(card.fetchedAt)}</time></>}
      </p>
      {row.stale && <p className="dash-stale" role="status">This value is not fresh — showing the last one we have.</p>}
      {series !== null ? (
        <>
          <Chart
            series={series}
            title={card.id === 'watchlist' ? watchTitle(card) : card.title}
            formatValue={card.id === 'watchlist' ? (value: number) => formatWatchValue(card, value) : undefined}
            active={selection}
            onInspect={setSelection}
          />
          {series.missingIntervals > 0 && (
            <p className="muted small">{series.missingIntervals} intervals missing — shown as gaps, not filled in.</p>
          )}
        </>
      ) : (
        <p className="dash-note" role="status">{card.note ?? (card.id === 'market' ? 'History is unavailable.' : 'Current value only.')}</p>
      )}
      <p className="muted small">{card.provenance}</p>
      {card.drillthrough && (
        <button type="button" className="link" onClick={() => onDrillthrough?.(card.drillthrough!.view)}>{card.drillthrough.label}</button>
      )}
    </>
  );
}
