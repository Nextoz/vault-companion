// Dashboard composition (DASH1): the read-only card list the phone renders. Market data comes from the public
// Coinbase source; Weather uses the same projection as the Today morning view; AI usage and Health have no approved
// source yet and say so honestly.
import type { DashboardCard, DashboardRange, DashboardResponse, MarketCard, MarketTickerResponse, MarketUnavailableReason, WatchCard, WeatherCard, WeatherFailureReason, WeatherResponse } from '@vault-companion/contracts';
import type { MarketSource } from './market.ts';
import type { WatchItem, WatchlistSource } from './watchlist.ts';

const PROVIDER_LABEL = 'Coinbase Exchange (public)';
const iso = (ms: number): string => new Date(ms).toISOString();

/** Human source names per watch provider; the fallback keeps a not-yet-fetched card honest about its source. */
const WATCH_PROVIDER_LABEL = {
  coinbase: PROVIDER_LABEL,
  frankfurter: 'Frankfurter (ECB reference rates)',
  cbr: 'Bank of Russia',
} as const;
const watchProvenance = (item: WatchItem, provider?: string): string => {
  if (provider === 'coinbase' || provider === 'frankfurter' || provider === 'cbr') return WATCH_PROVIDER_LABEL[provider];
  if (item.type === 'crypto') return WATCH_PROVIDER_LABEL.coinbase;
  return (item.base ?? item.symbol.split('/')[0]) === 'RUB' ? WATCH_PROVIDER_LABEL.cbr : WATCH_PROVIDER_LABEL.frankfurter;
};

const REASON_NOTE: Record<MarketUnavailableReason, string> = {
  timeout: 'The market provider did not answer in time.',
  malformed: 'The market provider sent data we could not read.',
  'provider-error': 'The market provider is unavailable right now.',
};

const WEATHER_REASON_NOTE: Record<WeatherFailureReason, string> = {
  timeout: 'The weather provider did not answer in time.',
  malformed: 'The weather provider sent data we could not read.',
  'provider-error': 'The weather provider is unavailable right now.',
  'no-data': 'No weather model returned usable forecast points.',
};

export interface WeatherReadService {
  readWeather(): Promise<WeatherResponse>;
}

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
  readonly watchlist: WatchlistSource;
  readonly weather: WeatherReadService;
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

  const watchCard = async (item: WatchItem, range: DashboardRange): Promise<WatchCard> => {
    const [ticker, series] = await Promise.all([deps.watchlist.ticker(item), deps.watchlist.series(item, range)]);
    const ref = { symbol: item.symbol, type: item.type } as const;
    if (ticker.status !== 'ok') {
      return {
        id: 'watchlist', status: 'unavailable', title: item.name, provenance: watchProvenance(item),
        observedAt: null, fetchedAt: null, note: REASON_NOTE[ticker.reason], drillthrough: null, item: ref, reason: ticker.reason,
      };
    }
    // As with the market card: a failed history read is an absent history, never invented points.
    const historyMissing = series.status !== 'ok';
    return {
      id: 'watchlist', status: 'ok', title: item.name, provenance: watchProvenance(item, ticker.ticker.provider),
      observedAt: ticker.ticker.providerTime, fetchedAt: iso(ticker.fetchedAt),
      note: historyMissing ? `Current value only. ${REASON_NOTE[series.reason]} History is not shown.` : null,
      drillthrough: null, item: ref, ticker: ticker.ticker, series: series.status === 'ok' ? series.series : null,
    };
  };

  const weatherCard = async (): Promise<WeatherCard> => {
    const response = await deps.weather.readWeather();
    if (response.status !== 'ok') {
      return {
        id: 'weather', status: 'unavailable', title: 'Weather', provenance: 'Open-Meteo (DMI + ECMWF)',
        observedAt: null, fetchedAt: null, note: WEATHER_REASON_NOTE[response.reason], drillthrough: null, reason: response.reason,
      };
    }
    const projection = response.projection;
    const retrievedAt = projection.models.map((series) => series.retrievedAt).sort()[0] ?? null;
    return {
      id: 'weather', status: 'ok', title: 'Weather', provenance: 'DMI HARMONIE AROME Europe vs ECMWF IFS 9 km (Open-Meteo)',
      observedAt: null, fetchedAt: retrievedAt,
      note: projection.partialError === 'one-model-unavailable' ? 'One model is unavailable; agreement is single-model.' : null,
      drillthrough: null,
      projection,
    };
  };

  return {
    async readDashboard(range: DashboardRange): Promise<DashboardResponse> {
      const [market, watches, weather] = await Promise.all([
        marketCard(range),
        Promise.all(deps.watchlist.items.map((item) => watchCard(item, range))),
        weatherCard(),
      ]);
      return { now: deps.now().toISOString(), cards: [market, ...watches, weather, ...overviewCards()] };
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
