// WL2 (watchlist UI): pure formatting and selection for the Dashboard watchlist cards, so the React component stays
// thin. Given a card, return the strings the card shows; nothing here fetches or holds state.
import type { DashboardCard, MarketCard, MarketSeries, WatchCard } from '@vault-companion/contracts';

/** Every watchlist card in the response, in arrival order. Pure. */
export function watchCards(cards: readonly DashboardCard[]): WatchCard[] {
  return cards.filter((card): card is WatchCard => card.id === 'watchlist');
}

/**
 * The legacy `market` (BTC/USD) card, or null when watchlist cards exist. WL1 keeps returning it beside the watchlist;
 * rendering both would show BTC twice, so it is shown only when the response carries no watchlist card at all.
 */
export function legacyMarketCard(cards: readonly DashboardCard[]): MarketCard | null {
  if (watchCards(cards).length > 0) return null;
  return cards.find((card): card is MarketCard => card.id === 'market') ?? null;
}

/** The title from item/ticker base/quote, e.g. "RUB / DKK". Without a ticker the symbol is split on its separator. */
export function watchTitle(card: WatchCard): string {
  if (card.status === 'ok') return `${card.ticker.base} / ${card.ticker.quote}`;
  return card.item.symbol.replace(/[-/]/g, ' / ').trim();
}

/** fx reference rates are quoted to four decimals; crypto to two, like the legacy BTC market card. */
export function watchDecimals(card: WatchCard): number {
  return card.item.type === 'fx' ? 4 : 2;
}

/** One value for a card, formatted per quote (fx four decimals, crypto two). `unavailable` has no value: stays empty. */
export function formatWatchValue(card: WatchCard, value: number): string {
  if (card.status !== 'ok') return '';
  const decimals = watchDecimals(card);
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: card.ticker.quote, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(value).replace(/\u00a0/g, ' ');
}

/** The card's current value, in the same format the chart readout uses. */
export function formatWatchPrice(card: WatchCard): string {
  return card.status === 'ok' ? formatWatchValue(card, card.ticker.price) : '';
}

export interface WatchChange {
  readonly direction: 'up' | 'down';
  readonly percent: number;
}

/**
 * Percent change across the range, first to last returned close. Null when there is no history (or the start is not a
 * usable base): a missing history never becomes a made-up change.
 */
export function seriesChange(series: MarketSeries | null): WatchChange | null {
  if (series === null || series.points.length < 2) return null;
  const first = series.points[0]!.close;
  const last = series.points[series.points.length - 1]!.close;
  if (!(first > 0)) return null;
  const percent = ((last - first) / first) * 100;
  return { direction: percent < 0 ? 'down' : 'up', percent };
}

/** "+1.23%" / "-1.23%": the sign is carried by the text, never dropped. */
export function formatChange(change: WatchChange): string {
  return `${change.percent < 0 ? '' : '+'}${change.percent.toFixed(2)}%`;
}

/** A fetched value may stand this long before its card calls itself stale; the same window as the market card. */
export function watchFresh(card: WatchCard, nowMs: number, staleMs: number): boolean {
  return card.status === 'ok' && card.fetchedAt !== null && nowMs - Date.parse(card.fetchedAt) <= staleMs;
}
