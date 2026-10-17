// Dashboard (DASH1): read-only overview. One card per watched item (WL2) with a 1W/1M/3M/1Y series, honest overview
// cards, and the AB3b AI usage panel (fed from App). No writes, no provider calls from the browser.
import type { AiBudgetResponse, AiUsageResponse, DashboardCard, DashboardRange, DashboardResponse, LeaderboardResponse, MarketCard, MarketTickerResponse, WeatherCard } from '@vault-companion/contracts';
import { useCallback, useEffect, useId, useState } from 'react';
import { getDashboard, getMarketTicker, type Fetched } from '../api.ts';
import './Dashboard.css';
import { AiUsagePanel } from './AiUsagePanel.tsx';
import { VaultHeatmapMonitor } from './monitors/VaultHeatmapMonitor.tsx';
import { LeaderboardPanel } from './LeaderboardPanel.tsx';
import { formatInstant } from './MarketChart.tsx';
import { MarketsMonitor } from './MarketsMonitor.tsx';
import { CreditBurnMonitor } from './monitors/CreditBurnMonitor.tsx';
import { ScoutHeartbeatMonitor } from './monitors/ScoutHeartbeatMonitor.tsx';
import { WeekRunwayMonitor } from './monitors/WeekRunwayMonitor.tsx';
import { PowerMonitor } from './monitors/PowerMonitor.tsx';
import { SkyMonitor } from './monitors/SkyMonitor.tsx';
import { BarometerMonitor } from './monitors/BarometerMonitor.tsx';
import { CopyNote, useLastCopy } from './useLastCopy.tsx';
import { legacyMarketCard, privateValuationCards, watchCards, watchFresh } from './watchlist.ts';
import { WeatherLab, weatherFresh } from './WeatherLab.tsx';

export { RANGE_LABELS, formatInstant, seriesSegments } from './MarketChart.tsx';

export const TICKER_POLL_MS = 60_000;
/** Older than this and the card says so, in words; the number is never silently repainted as fresh. */
export const MARKET_STALE_MS = 120_000;
export const DASHBOARD_RANGES: readonly DashboardRange[] = ['1W', '1M', '3M', '1Y'];

const at = (iso: string): number => Date.parse(iso);

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

function WeatherCardView({ card, stale, onDrillthrough }: {
  card: WeatherCard; stale: boolean; onDrillthrough?: ((view: string) => void) | undefined;
}) {
  const headingId = useId();
  const status = card.status === 'unavailable' ? 'Unavailable' : stale ? 'Stale' : 'Live';
  return (
    <article className="dash-card dash-weather" aria-labelledby={headingId} aria-busy={stale}>
      <header className="dash-card-head">
        <h2 id={headingId}>{card.title}</h2>
        <span className={`dash-chip dash-chip-${status.toLowerCase()}`}>{status}</span>
      </header>
      {card.status === 'unavailable'
        ? <p className="dash-note" role="status">{card.note ?? 'Weather is unavailable.'}</p>
        : <WeatherLab projection={card.projection} />}
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

/**
 * UX4: the small overview tiles, minus the ones that only exist to say "Not configured". A placeholder that carries no
 * fact is hidden here (the Status sheet still lists the source); a card that honestly failed stays, so "Unavailable" is
 * never lost. Market, watchlist, weather and the health card have their own spots. Pure.
 */
export function overviewTiles(cards: readonly DashboardCard[]): DashboardCard[] {
  return cards.filter((card) => card.id !== 'market' && card.id !== 'watchlist' && card.id !== 'weather' && card.id !== 'health' && card.id !== 'private-valuation' && card.status !== 'not-configured');
}

export function Dashboard({ refreshKey, accountKey = null, onDrillthrough, aiUsage = null, aiBudget = null, leaderboard = null }: {
  refreshKey: number | null; accountKey?: string | null; onDrillthrough?: ((view: string) => void) | undefined;
  aiUsage?: Fetched<AiUsageResponse> | null; aiBudget?: Fetched<AiBudgetResponse> | null; leaderboard?: Fetched<LeaderboardResponse> | null;
}) {
  const [range, setRange] = useState<DashboardRange>('1W');
  const [retryKey, setRetryKey] = useState(0);
  const [poll, setPoll] = useState<MarketTickerResponse | null>(null);
  const [tickerFailed, setTickerFailed] = useState(false);
  const [lastGood, setLastGood] = useState<DashboardResponse | null>(null);
  // SP3c (ADR-0038): each range opens from its own last copy. The ticker poll is merged into live answers only and
  // never written into a copy.
  const view = useLastCopy<DashboardResponse>(accountKey, `dashboard:${range}`, () => getDashboard(range), `${refreshKey}:${retryKey}`);
  const res = view.res;
  const isCopy = view.copyAt !== null;
  const live = res?.kind === 'ok' && !isCopy;
  const failed = res !== null && res.kind !== 'ok';

  useEffect(() => {
    if (res?.kind !== 'ok') return;
    setLastGood(res.data);
    if (live) setTickerFailed(false);
  }, [res]);

  useEffect(() => {
    const canPoll = () => (typeof document === 'undefined' || document.visibilityState !== 'hidden') && (typeof navigator === 'undefined' || navigator.onLine !== false);
    let mounted = true;
    const tick = async () => {
      if (!canPoll()) return;
      const res = await getMarketTicker();
      if (!mounted) return;
      if (res.kind === 'ok') {
        if (res.data.status === 'ok') setPoll(res.data);
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
      mounted = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
    };
  }, []);

  const onRange = useCallback((next: DashboardRange) => setRange(next), []);
  // A failed read with no copy of this range may still show an earlier answer — but only labelled as stale.
  const base = res?.kind === 'ok' ? res.data : failed ? lastGood : null;
  // A poll older than the answer it would patch is ignored, so a late ticker never repaints a newer value.
  const shown = base && live && poll && at(poll.now) >= at(base.now) ? mergeTicker(base, poll) : base;
  // WL2: the legacy market card is hidden while watchlist cards exist (no duplicate BTC); the ticker poll only feeds it.
  const market = legacyMarketCard(shown?.cards ?? []);
  const watches = shown ? watchCards(shown.cards) : [];
  const weather = shown?.cards.find((card): card is WeatherCard => card.id === 'weather') ?? null;
  const privateValuations = shown ? privateValuationCards(shown.cards) : [];
  const nowMs = shown ? at(shown.now) : 0;
  const notLive = failed || isCopy;
  const marketStale = market !== null && market.status === 'ok' && shown !== null && !marketFresh(market, nowMs);
  const watchesStale = shown !== null && watches.some((card) => card.status === 'ok' && !watchFresh(card, nowMs, MARKET_STALE_MS));
  const stale = notLive || (market !== null && tickerFailed) || marketStale || watchesStale;
  const weatherStale = notLive || (weather !== null && weather.status === 'ok' && shown !== null && !weatherFresh(weather.projection, nowMs));
  const tiles = shown ? overviewTiles(shown.cards) : [];
  const watchRetry = watches.some((card) => card.status === 'unavailable' || (card.status === 'ok' && !card.series));

  return (
    <section className="dash" aria-label="Dashboard">
      <h2 className="dash-heading">Dashboard</h2>
      <CopyNote view={view} />
      {!shown && !failed && <p className="muted" role="status">Loading…</p>}
      {!shown && failed && <p className="dash-note" role="status">The dashboard could not be loaded.</p>}
      {(failed || view.failed || market?.status === 'unavailable' || (market?.status === 'ok' && !market.series) || watchRetry) && <button type="button" className="link" onClick={() => setRetryKey((previous) => previous + 1)}>Retry dashboard</button>}
      {shown && stale && !isCopy && <p className="dash-stale" role="status">Not refreshed — the times below are from the last success.</p>}
      {(shown || !failed) && <MarketsMonitor loading={!shown} market={market} watches={watches} privates={privateValuations} range={range} onRange={onRange} isStale={(card) => card.id === 'market' ? stale : notLive || !watchFresh(card, nowMs, MARKET_STALE_MS)} onDrillthrough={onDrillthrough} />}
      {shown && weather && <WeatherCardView card={weather} stale={weatherStale} onDrillthrough={onDrillthrough} />}
      {tiles.length > 0 && (
        <div className="dash-tiles">
          {tiles.map((card) => <OverviewCard key={card.id} card={card} onDrillthrough={onDrillthrough} />)}
        </div>
      )}
      <AiUsagePanel usage={aiUsage} budget={aiBudget} now={nowMs || Date.now()} />
      <CreditBurnMonitor usage={aiUsage} budget={aiBudget} now={nowMs || Date.now()} />
      <ScoutHeartbeatMonitor refreshKey={refreshKey} accountKey={accountKey} />
      <WeekRunwayMonitor />
      <PowerMonitor />
      <SkyMonitor />
      <BarometerMonitor />
      <VaultHeatmapMonitor nowMs={nowMs || undefined} />
      <LeaderboardPanel view={leaderboard} now={nowMs || Date.now()} />
    </section>
  );
}
