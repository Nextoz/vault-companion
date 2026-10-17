// W1a (markets rows): the pure row model for the Markets card. Everything one row shows — label, price, change,
// amount — is computed here from dashboard cards, so the React component stays thin and all rules are testable.
import type { MarketCard, MarketSeries, PrivateValuationCard, WatchCard } from '@vault-companion/contracts';
import { type WatchChange, formatChange, formatWatchPrice, seriesChange } from './watchlist.ts';

export type MarketRow =
  | { kind: 'priced'; key: string; label: string; priceText: string; change: WatchChange | null; series: MarketSeries | null; stale: boolean; card: MarketCard | WatchCard }
  | { kind: 'private'; key: string; label: string; amountText: string; card: PrivateValuationCard }
  | { kind: 'unavailable'; key: string; label: string; card: MarketCard | WatchCard | PrivateValuationCard };

export interface MarketsInput {
  market: MarketCard | null;
  watches: readonly WatchCard[];
  privates: readonly PrivateValuationCard[];
  isStale: (card: MarketCard | WatchCard) => boolean;
}

/**
 * The rows the Markets card lists: the legacy market card first (when present), then the watch cards in arrival
 * order, then the private-valuation cards. An unavailable card is a row without any number — never an old one.
 * Pure.
 */
export function marketRows(input: MarketsInput): MarketRow[] {
  const rows: MarketRow[] = [];
  if (input.market !== null) rows.push(marketOrWatchRow(input.market, input.isStale, rows.length));
  for (const card of input.watches) rows.push(marketOrWatchRow(card, input.isStale, rows.length));
  for (const card of input.privates) rows.push(privateRow(card, rows.length));
  return rows;
}

const usdBillions = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const usdPrice = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$2.1 B" / "$500 B": a hand-maintained last-round figure (billions), at most one decimal, never a market price. */
export function formatPrivateAmount(billions: number): string {
  return `$${usdBillions.format(billions)} B`;
}

export interface SummaryItem {
  label: string;
  text: string;
  tone: 'up' | 'down' | 'muted';
}

/**
 * The one-line summary over the rows: the first two rows as label + text + tone, plus how many rows did not fit.
 * A stale priced row says so and reads muted: a stale number must never look like a fresh one. Pure.
 */
export function marketsSummary(rows: readonly MarketRow[]): { items: SummaryItem[]; more: number } {
  return { items: rows.slice(0, 2).map(summaryItem), more: Math.max(0, rows.length - 2) };
}

function marketOrWatchRow(card: MarketCard | WatchCard, isStale: (card: MarketCard | WatchCard) => boolean, index: number): MarketRow {
  if (card.status === 'unavailable') return { kind: 'unavailable', key: `unavailable:${index}`, label: marketOrWatchLabel(card), card };
  return {
    kind: 'priced',
    key: card.id === 'market' ? 'market' : `watch:${card.item.symbol}`,
    label: marketOrWatchLabel(card),
    priceText: card.id === 'market' ? `$${usdPrice.format(card.ticker.price)}` : formatWatchPrice(card),
    change: seriesChange(card.series),
    series: card.series,
    stale: isStale(card),
    card,
  };
}

function privateRow(card: PrivateValuationCard, index: number): MarketRow {
  if (card.status === 'unavailable') return { kind: 'unavailable', key: `unavailable:${index}`, label: card.title, card };
  return { kind: 'private', key: `private:${card.item.id}`, label: card.title, amountText: formatPrivateAmount(card.item.valueUsdBillions), card };
}

/**
 * The short name a row shows: a stock by its symbol, crypto by its base, fx as base/quote, the legacy market card by
 * its base. With no ticker to read (unavailable), the item's symbol — the title for the legacy card — still names the
 * market without inventing a pair.
 */
function marketOrWatchLabel(card: MarketCard | WatchCard): string {
  if (card.id === 'market') return card.status === 'ok' ? card.ticker.base : card.title;
  if (card.item.type === 'stock' || card.status !== 'ok') return card.item.symbol;
  return card.item.type === 'fx' ? `${card.ticker.base}/${card.ticker.quote}` : card.ticker.base;
}

function summaryItem(row: MarketRow): SummaryItem {
  if (row.kind === 'unavailable') return { label: row.label, text: 'unavailable', tone: 'muted' };
  if (row.kind === 'private') return { label: row.label, text: 'last round', tone: 'muted' };
  const text = row.change !== null ? formatChange(row.change) : row.priceText;
  if (row.stale) return { label: row.label, text: `${text} (stale)`, tone: 'muted' };
  return { label: row.label, text, tone: row.change !== null ? row.change.direction : 'muted' };
}
