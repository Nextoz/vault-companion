// Dashboard composition (DASH1): the read-only card list the phone renders. Market data comes from the public
// Coinbase source; Weather uses the same projection as the Today morning view; AI usage and Health have no approved
// source yet and say so honestly.
import type { DashboardCard, DashboardRange, DashboardResponse, MarketCard, MarketTickerResponse, MarketUnavailableReason, WeatherCard, WeatherFailureReason, WeatherResponse } from '@vault-companion/contracts';
import type { MarketSource } from './market.ts';

const PROVIDER_LABEL = 'Coinbase Exchange (public)';
const iso = (ms: number): string => new Date(ms).toISOString();

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
      const [market, weather] = await Promise.all([marketCard(range), weatherCard()]);
      return { now: deps.now().toISOString(), cards: [market, weather, ...overviewCards()] };
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
