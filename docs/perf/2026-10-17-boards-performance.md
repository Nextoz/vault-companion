# Boards performance — findings (2026-10-17)

Owner: "It started being a bit slow again, perhaps after the dashboard." Measured on `origin/main` `04e500d`
(after PRs #207–#218). Builds on SP1 (`docs/reviews/SP-read-latency.md`: every read = `head` + blobs), SP2 (per-isolate
commit-addressed blob cache) and SP3 (ADR-0038 last copy). No measurement method was redone.

## Method

- **Production:** Workers Logs (observability is on) via the Cloudflare API with the existing login, the Worker's own
  `route` + `durationMs` log line. Window A = 9–16 Oct 08:00 UTC (before the monitors), B = 16 Oct 08:00 – 17 Oct.
- **Client:** a Playwright probe on the mock app (`MockApi`, iPhone 15 WebKit) counting `/api/*` calls per phase.
- **Bundle:** `vite build` plus a source-map attribution of the one JS chunk.
- **Worker code:** read every Boards route and its provider for per-request outbound/GitHub work.

## Production route times (Worker wall time, p50 / p90 ms)

| route | before (n) | after (n) | note |
| --- | --- | --- | --- |
| `/api/game` | 5139 / 6759 (859) | 5309 / 6152 (167) | slowest; composes radar + 5 reads |
| `/api/radar` | 5177 / 6510 (258) | 5198 / 5809 (23) | ~20 notes read **one after another** |
| `/api/scouts/output` | 876 / 3628 (518) | **3646** / 4258 (101) | scans every status file sequentially |
| `/api/scouts` | 2810 / 3771 (559) | **3299** / 4400 (104) | 14 status files read sequentially |
| `/api/tasks` | 1252 / 1838 | 1243 / 2007 | |
| `/api/dashboard` | 1237 / 3254 | 1182 / 1757 | |
| `/api/ai-usage`, `/api/ai-budget` | ~1000 / 1500 | ~940 / 1400 | head + one blob |
| `/api/week-runway` | — | 1168 / 2302 (5) | weather + triage + cached busy read |
| `/api/monitors/vault-activity` | — | 745 / 1140 (4) | head + one blob |
| `/api/power`, `/api/sky`, `/api/barometer`, `/api/weather` | — | 66–168 / 372–935 | already TTL-cached |

## Client requests (mock app)

| phase | `/api/*` calls |
| --- | --- |
| cold open, Overview | **31** — every Overview read twice, `/api/game` 4×, plus `ai-usage`/`ai-budget`/`leaderboard` ×2 that only Boards shows |
| switch to Boards | **10** — every monitor, `/api/scouts` 2× (heartbeat + diagnostics), `/api/weather` again |
| back to Overview | 7 — the Overview card remounts and re-reads everything |
| app focus on Overview / Boards | 13 / 9 |

Polling: only the market ticker (60 s, Boards only, paused while hidden). No other interval.

## Bundle

One chunk, 878.7 kB min / 272.7 kB gzip, CSS 117.9 kB. Boards-only modules ≈ 88 kB min (10 %). The Markdown stack
(markdown-it, dompurify, entities, linkify-it, uc.micro ≈ 120 kB) is in the main chunk because `note/render.ts` is
also imported statically (Vite warns `INEFFECTIVE_DYNAMIC_IMPORT`).

## Ranked causes

| # | cause | evidence | expected gain | fix size |
| --- | --- | --- | --- | --- |
| 1 | **Sequential GitHub reads** in `/api/scouts`, `/api/scouts/output` and `/api/radar` (→ `/api/game`). The monitor writers (job radar, vault activity, agent activity) added 3 scout status files, so 11 → 14 serial blob reads. | scouts p50 2.8 → 3.3 s, scouts/output 0.9 → 3.6 s; radar/game 5.2 s; `for … await readFile` in `packages/domain/src/scouts.ts`, `research-radar.ts` | scouts ~3.3 → <1 s; radar/game ~5 → ~1.5–2 s. These are the long poles of every Today open. | S (scouts), M (radar) |
| 2 | **Boards re-reads on every view switch**, and reads `/api/scouts` twice | 10 calls per switch, 7 back; two 3.3 s scouts reads per Boards open | toggling costs 0 calls after the first visit; −1 scouts read per Boards open | S–M |
| 3 | **Duplicate reads on cold open**: components read with no account, again when the account arrives, again on the first task read | 31 calls; `/api/game` (5.3 s) 4× | ~31 → ~17 calls per open, half the GitHub load at the slowest moment | M |
| 4 | Main chunk carries Boards and the Markdown stack | 879 kB min; ~200 kB of it not needed for Overview | ~25 % less JS to parse on a cold open | S–M |

Rejected candidates: **Worker TTL caches for outbound providers** — power, sky, barometer, weather, market,
watchlist and the Google busy read already cache 10–15 min in-isolate (p50 66–170 ms). **One batched Boards
endpoint** — the vault-file monitors are ~0.9 s each but run in parallel; after #1–#3 the saving is one `head` per
route, not worth a new contract now. **Polling while hidden** — the ticker already pauses.

Not measured: phone render/JS time (no trace from the phone), Cloudflare Access time before the Worker.

## Fixes and results

Filled in per PR below (before → after).

### Fix 1 — parallel vault reads (scouts, scout output, radar)

`mapBounded` (`packages/domain/src/bounded.ts`, 6 at a time = the Workers open-connection limit per request) replaces
the one-by-one loops in `scouts.ts` (list + output) and `research-radar.ts` (note slices, decision months). The radar
budget is still taken in the same order (planned before the first await); the independent slices run together.
Bench: SP1 harness (`tools/sp-read-latency.mjs`), 14 status files + 20 Important notes, injected
head/tree 100 ms, blob 150 ms, cold isolate:

| route | before | after |
| --- | --- | --- |
| `/api/scouts` | 2509 ms | 741 ms |
| `/api/radar` | 3074 ms | 1029 ms |

Production p50 after deploy: see the PR. Guard tests: `bounded.test.ts`, the concurrency tests in `scouts.test.ts`
and `research-radar.test.ts` fail when reads are sequential again (checked with the limit set to 1).

Production after the #221 deploy (17 Oct 17:24 UTC), first owner visit, n=1 each: `/api/scouts` 1053 ms (was 3299 p50),
`/api/game` 3456 ms (was 5309 p50). Re-query the same way (Workers Logs, `route`/`durationMs`) once a day of traffic
has accrued.

### Fix 2 — the view switch stops re-reading (#222)

Overview stays mounted (hidden) while Boards shows and re-reads once when shown again if a refresh happened
meanwhile (`useHeldWhileHidden`); Boards' two scouts readers share one same-task read; the AI usage/budget/leaderboard
reads run while Boards shows. `/api/*` calls (mock app): back to Overview 7 → 0, cold open 31 → 25, Boards open
10 → 12 (the AI reads moved there).

### Fix 3 — one read per screen on a cold open (#223)

Screens get `readKey`, which the first clean task read leaves alone. Cold open 25 → 17 calls; `/api/game` 4 → 3.

### Fix 4 — Boards and the note renderer load on demand

`Dashboard` is a lazy chunk under one Suspense with the scout diagnostics (so they still share one scouts read);
Research Radar uses NoteView's lazy renderer. Main chunk 878.7 → 782.4 kB (gzip 272.7 → 242.9 kB); Boards 67.9 kB
and render 29.5 kB load when needed and are precached for offline. `markdown-it` stays in the main chunk because
`insights.ts` parses scout notes with it; splitting that is the next candidate.

### Totals (mock app, one session: open, Boards, back, focus, Boards, focus)

| | before | after |
| --- | --- | --- |
| `/api/*` calls | 80 | 59 |
| cold-open calls | 31 | 17 |
| main JS (gzip) | 272.7 kB | 242.9 kB |

Follow-ups not done: `/api/game` still calls `head` 7× per request (one per composed read; single-flight per
request would remove 6 GitHub round trips), and the `insights.ts` Markdown split.
