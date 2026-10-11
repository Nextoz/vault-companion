# ADR-0061: Stock quotes from the Yahoo Finance chart endpoint

Status: accepted (2026-10-11)

Context: the watchlist needs delayed USD prices and 1W-1Y daily history for NVDA and SPCX, personal use, from a Worker
within the subrequest budget. Stooq now serves a JavaScript challenge (unusable from a Worker). Keyed providers
(Twelve Data, Finnhub, Alpha Vantage) would need an owner secret.

Decision: `query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?range=1y&interval=1d`, keyless. One fetch per symbol feeds
the ticker and every range. The parser is defensive (USD only, symbol must match, no zero-fill) and isolated in
`stock-quote.ts`, so the source is swappable. Cards are labelled "Delayed". Any failure makes that row unavailable.

Consequences: the endpoint is unofficial and may throttle or change; the only effect is an unavailable row. Fallback if
that happens: a keyed provider behind the same adapter, with the owner creating the secret.
