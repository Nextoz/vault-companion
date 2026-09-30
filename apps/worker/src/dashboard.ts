// Dashboard composition (DASH1): the read-only card list the phone renders. Market data comes from the public
// Coinbase source; the AI usage and Health overviews have no approved source yet and say so honestly.
import type { DashboardCard, DashboardRange, DashboardResponse, MarketCard, MarketTickerResponse, MarketUnavailableReason } from '@vault-companion/contracts';
import type { MarketSource } from './market.ts';

const PROVIDER_LABEL = 'Coinbase Exchange (public)';
const iso = (ms: number): string => new Date(ms).toISOString();

const REASON_NOTE: Record<MarketUnavailableReason, string> = {
  timeout: 'The market provider did not answer in time.',
  malformed: 'The market provider sent data we could not read.',
  'provider-error': 'The market provider is unavailable right now.',
};

/** No approved AI-usage or Health source exists: these cards carry no numbers, only an honest status and a seam. */
const overviewCards = (): DashboardCard[] => [
  {
    id: 'ai-usage', status: 'not-configured', title: 'AI usage', provenance: 'Not configured',
    observedAt: null, fetchedAt: null, note: 'No approved usage source is connected yet.', drillthrough: null,
  },
  {
    id: 'health', status: 'not-configured', title: 'Health', provenance: 'Not configured',
    observedAt: null, fetchedAt: null, note: 'No approved health source is connected yet.', drillthrough: null,
  },
];

export interface DashboardDeps {
  readonly market: MarketSource;
  readonly now: () => Date;
}

export function createDashboardService(deps: DashboardDeps) {
  const marketCard = async (range: DashboardRange): Promise<MarketCard> => {
    const [ticker, series] = await Promise.all([deps.market.ticker(), deps.market.series(range)]);
    if (ticker.status !== 'ok') {
      return {
        id: 'market', status: 'unavailable', title: 'BTC / USD', provenance: PROVIDER_LABEL,
        observedAt: null, fetchedAt: null, note: REASON_NOTE[ticker.reason], drillthrough: null, reason: ticker.reason,
      };
    }
    // The current value stands even when the candles read failed: that is shown as an absent history, never invented.
    const historyMissing = series.status !== 'ok';
    return {
      id: 'market', status: 'ok', title: 'BTC / USD', provenance: PROVIDER_LABEL,
      observedAt: ticker.ticker.providerTime, fetchedAt: iso(ticker.fetchedAt),
      note: historyMissing ? `Current value only. ${REASON_NOTE[series.reason]} History is not shown.` : null,
      drillthrough: null,
      ticker: ticker.ticker,
      series: series.status === 'ok' ? series.series : null,
    };
  };

  return {
    async readDashboard(range: DashboardRange): Promise<DashboardResponse> {
      const market = await marketCard(range);
      return { now: deps.now().toISOString(), cards: [market, ...overviewCards()] };
    },
    async readMarketTicker(): Promise<MarketTickerResponse> {
      const now = deps.now().toISOString();
      const ticker = await deps.market.ticker();
      return ticker.status === 'ok'
        ? { status: 'ok', now, ticker: ticker.ticker, fetchedAt: iso(ticker.fetchedAt) }
        : { status: 'unavailable', now, reason: ticker.reason };
    },
  };
}
