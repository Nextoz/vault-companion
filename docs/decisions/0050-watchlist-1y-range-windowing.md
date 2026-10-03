# ADR-0050 — 1Y watchlist range and Coinbase candle windowing

Status: draft (WL3, 2026-10-03). Consequential because it widens `DashboardRange`, raises the contract series cap, and
changes how a provider request longer than its per-request candle cap is fetched.

## Context
The Dashboard ranges were 1W/1M/3M. Adding 1Y means ~365 daily buckets. Coinbase refuses a candles request for more
than 300 buckets, and its coarsest granularity is one day, so a single request cannot cover a year.

## Decision
- **Contract:** `DASHBOARD_RANGES` gains `1Y`; `DASHBOARD_RANGE_PLAN['1Y']` is `{ granularitySeconds: 86_400,
  spanSeconds: 365 * 86_400 }`. `MAX_MARKET_POINTS` rises 300 -> 400 (a merged year fits with headroom).
- **Windowing:** `apps/worker/src/market.ts` exposes `COINBASE_MAX_CANDLES = 300`, `candleWindows(...)` and
  `readCandleRows(...)`. A span is split into consecutive whole-bucket windows that ask for at most 299 buckets each
  (one of the provider's 300 kept as headroom for the candle Coinbase may prepend before `start`), and the raw rows are
  concatenated; all ranges but 1Y stay a single window (no new subrequest). Any failed window fails the read, so no
  partial year is passed off as complete.
- **FX:** Frankfurter and Bank of Russia windows use the same 1Y span (~365 days); `FX_SERIES_TTL_MS['1Y']` is 12 h
  (reference rates move once a day).
- **UI:** `RANGE_LABELS['1Y'] = '1 year'` and the chip list gains `1Y`; the change % and freshness rules are unchanged.

## Alternatives
- One 365-day request: rejected — Coinbase rejects over-cap requests, and a guessed truncation is not honest.
- Coarser synthetic granularity: rejected — Coinbase has no granularity between one day and one week.
- Keep `MAX_MARKET_POINTS = 300`: rejected — a merged year exceeds it; the zod cap would reject a valid series.

## Consequences
`1Y` costs two provider subrequests (crypto) instead of one; shorter ranges are unchanged. A later range longer than a
year would window further, bounded by `MAX_MARKET_POINTS`.
