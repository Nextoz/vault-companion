# Checkpoint — 2026-10-04 (CAL-b)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **CS (app side, lanes)**: Events triage shows a Work/Culture lane tag per card (`laneOf` in `apps/web/src/triage.ts`, category set per backlog), an All · Work · Culture filter (filtering never remounts the stack, so Undo/skip state survives) and a "6 work · 4 culture" line. Scouts tab needs no code: the registry is the status directory. Open: owner phone check of the mix; confirm `culture-events` shows on Scouts after its first run; tolerant missing record untested live.
- **HC3b**: Health card → **History** toggle (lazy `GET /api/health/history`, all rows ≤ yesterday; chips 30 d / 90 d / 1 y / All slice client-side; range medians + SVG lines). Shares `readSource` with the card.
- **HC3a** (ADR-0043): `POST /api/health/ingest`, own service-token verifier (ingest AUD only, no email claim),
  rewrites only sent days of the health CSV via `executeWrite`. **Live and working with the real Shortcut.**
  Root causes: Access session lifetime > 24 h (401), a trailing space in the Shortcut's `steps` key (422). Ingest
  now trims key names (null-prototype map, 400 on collision); 400/422 answers append the body shape (no values).
- **MB2**: `GET /api/morning-brief` (domain `createMorningBriefReadService`, fixed path, re-validated) + MorningCard rows above the existing lines (`briefLines`: Fallback marker, day, state, gaps with suggestion, to-dos open Tasks, encouragement); stale date or failed read = card unchanged. e2e MockApi serves a stale brief by default.
- **AB Part 2** (ADR-0049): `GET /api/ai-budget` reads fixed `Automation/Scout Status/ai-budget.json` (per-provider degradation) -> "AI budget" section in the Status sheet (`budgetRows`, thresholds, stale > 2 h). **No real data until the vault-side Part 1 writer exists** (must emit schema 1); card shows "No budget data yet". Parallel NY was blocked by RAM (3.0 GB free).
- **UX4**: copy/polish only: morning-card weather glance (`weatherGlance`), scout/event pluralisation, wrapped labels, FAB clearance, hidden "Not configured" dashboard tiles, Failed/Stale scouts shown once (board row, not Insights cards). Mood/Energy/Sleep labels were already done.
- **UX3**: status dot → Status sheet (`StatusSheet.tsx`, pure `status-sheet.ts`): Vault freshness, Scouts (keyed to account), Data sources (in-memory last copies), Speed, Actions. Presentation only.
- **UX5**: Log = Training · Progress · Health (HealthPanel moved off Today; `LogMood` shows the last 14 check-ins on Progress). Mood list is device-held only (queue snapshot, receipts capped at 20), no server mood-history read yet; Report labels the Health tab.
- **UX2**: Today = `MorningCard` (weather glance / scouts / papers / new events / tasks lines, each opens its detail) + check-in line, then Dashboard; Triage now mounts under the Scouts tab. Check-in shows collapsed "Checked in HH:MM" (kept so Undo stays reachable; backlog says hide, owner to say). Pure `morning-card.ts`.
- **UX1b** (bar, status dot → Status) · **B12** (ADR-0042) edit training; **B9** BTC history; **B11** Group training (ADR-0041); **B8**; **B7** — all live.
- FB1/FB2 (Report button, ADR-0040) live. Launcher gotcha: prepend Git's `bin` to PATH before
  `tools/launch-worker.ps1`, else `agent-pane.sh: No such file`.
- `pnpm -r exec tsc --noEmit` reads stale `dist` d.ts via project references; use `pnpm typecheck` (`tsc -b`).
- Workers cannot run Playwright; e2e failures surface only in the Lead's run — budget a Lead fix pass for UI slices.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

- **NY1** (Needs You v1): Today card line "Needs you" (hidden at 0) opens `NeedsYouSheet`; pure `ui/needs-you.ts` rows: failed/degraded scouts, Active Work review due, triage pending, queue actions needing attention. Waiting items and registration deadlines not covered (no client data). NY2 Morning Review next.
- **WL1** (Watchlist backend): dashboard now returns one `watchlist` card per item in `apps/worker/src/watchlist.ts` (BTC, ETH Coinbase; SEK/DKK Frankfurter; RUB/DKK Bank of Russia XML, id R01215, because ECB dropped RUB) plus the legacy `market` card; ranges 1W/1M/3M (1Y open). Web UI is WL2.

- **WL2**: Dashboard renders one card per `watchlist` item (pure `ui/watchlist.ts`: price format, range change %), legacy BTC `market` card hidden when a watchlist exists.

- **NY2** (Morning Review v1): "Review my morning" on the Today card opens a step sheet: calendar lines from today's brief, Needs you rows, pick up to 3 tasks (existing `editTask`, scheduled = today, Undo as usual). Owner uses it a week before anything is added.

- **WL3**: watchlist ranges now 1W/1M/3M/**1Y** (ADR-0050): 1Y crypto = two daily Coinbase windows (299 buckets each, merged; a failed window fails the read), fx 1Y via Frankfurter/CBR, TTL 12 h, `MAX_MARKET_POINTS` 400. Open: phone check of the 1Y chip; confirm live Coinbase accepts the windows.

- **AB-registry**: `ai-budget.json` is excluded from the Scouts list (`NON_SCOUT_FILES` in `packages/domain/src/scouts.ts`), no more grey "unreadable" tile. Deploy pending.

- **NY3**: Needs You only lists what can be resolved: Degraded scouts moved to the Status sheet (yellow, with their `lastError`), Failed scouts show the full error and a device-held "Got it" (`vc.needsYouDismissed`, keyed by row + error text, pruned on recovery or text change). Deployed together with AB-registry. Open: phone check.

- **AB3a** (ADR-0051): `GET /api/ai-usage` reads fixed `AI/Usage/AI Usage Summary.json` (schema 1, read-only; bad provider/day dropped and counted in `skipped`, unknown providers kept). Backend only; AB3b panel UI next. e2e not run (no UI).

- **SC1** (tooling): `glm-review.ps1`/`handoff-check.ps1` can use a larger Scaleway reviewer model (e.g. `qwen3.5-397b-a17b`); `reasoning_effort` is sent only to GLM models. Tooling only, no deploy.

- **UX6**: Today's check-in prompt/card disappears once checked in today (Undo via the Status sheet Actions; returns next morning); Log → Progress lists the last 14 check-ins with Edit only on today's effective entry. Open: phone check.

- **AB3b**: Today → Dashboard shows an "AI usage" panel (pure `ui/ai-usage.ts`, `AiUsagePanel.tsx`): one tile per provider from `GET /api/ai-usage` (Claude/Codex output + cache-write, cache-read excluded; Jev calls; DeepSeek/Scaleway cost), 7 d/30 d sparkline without zero-fill, budget-left line from `/api/ai-budget`, stale > 2 h, honest failed state. App feeds it and clears it on sign-out. No real data until the vault-side usage writer exists. Open: phone check.

- **CAL-a** (ADR-0052, backend only, no UI): `calendar-writer.ts` (own `calendar.events` token, exact-scope guard, list-dedupe on `vcOperationId`, delete only marked events, colour map, `suggestType`), `calendar-service.ts` + links file `Automation/Calendar Links.json` (CAS, one writer), routes `GET /api/calendar/links`, `POST /api/calendar/events`, `POST /api/calendar/events/remove`. Removing an unmarked event drops the link and keeps the event (`eventKept`). 503 `calendar-write-unavailable` until the owner secrets exist in the Worker (they do per 2026-10-03). Review: CodeRabbit + Lead read (GLM crashed: `glm-review.ps1` null array). Deploy: not yet (no UI). **CAL-b** (UI, ordinary review): muted calendar glyph on task and Active Work rows -> `CalendarSheet` (pure `ui/calendar-sheet.ts`: window-first prefill, keyword type guess, free-block chips from the brief gaps, stable `operationId` per open, no queue, inline errors); linked rows show "In Calendar" + Remove. Item keys are locator-based, so editing an item may orphan its link (v1). e2e `calendar.spec.ts` added. Open: phone check; deploy pending.

## Next actions (in order)

0. **Order from the vault Ready Backlog (owner 2026-10-04):** LG1 -> SIWH -> SC2 spike -> SP/RR. Items 1-2 below are history.

1. **MB0 + MB1** (owner 2026-10-02, before UX2). MB0: ADR-0044 merged; waiting on owner Google setup
   (vault note "Morning Brief - Owner Setup Steps") + `tools/google-token-spike.ps1` day-0 PASS, then build the
   Worker Google reader (Pro, `-Reviewer both`); day-8 re-run ≥ 2026-10-10 gates MB "done". MB1a merged (pure day
   model `packages/domain/src/morning-brief.ts`: `freeBlocks` 07–22 local DST-safe, `rankTodos` bills/due ≤ 3 d →
   overdue → rest, max 3; `stateLine` above/below flags, low = mood or energy ≤ −2). **MB1b merged** (`apps/worker/src/morning-brief-gather.ts`: injected readers -> todos/metrics/mood/training/weather windows, never throws, `unavailable` list; `bill` always false: TaskView has no bill marker, `readMood` is device-held check-ins, so MB1c must decide the server-side mood source). **MB1b2 merged** (ADR-0045: pure `morning-brief-writer.ts` input/prompt/validate/fallback + Worker `scaleway-chat.ts`, model `deepseek-v4-flash-0731` on Scaleway; ADR-0044 now `gmail.metadata`). **MB1c merged** (ADR-0046: `morning-brief-job.ts` cron at `31 4`/`31 5` UTC, own invocation, runs only at Copenhagen hour 6; writes only `Daily/Morning Digest/Morning Brief - latest.json`, CAS + date dedupe, fallback brief without `SCALEWAY_API_KEY`; calendar/mail/mood readers `unavailable` until MB0/MB1d). **MB1d merged** (ADR-0047: free Email Routing `send_email` binding `BRIEF_EMAIL`, pure `morning-brief-email.ts` MIME+HTML render, best-effort send after a fresh commit; owner secrets `BRIEF_EMAIL_FROM`/`BRIEF_EMAIL_TO` + `SCALEWAY_API_KEY` still to set; check the live run's subrequest count in logs). **MB2 merged.** **MB0 built** (`google-reader.ts`: one shared token refresh, exact-scope guard, `invalid_grant` -> `google-reauth-needed`, calendar -> `freeBlocks`, `Jev/*` labelled inbox mail -> to-dos, metadata only). Day-0 read spike PASSED 2026-10-03; **day-8 re-run >= 2026-10-10 gates MB done**. Calendar write credential (ADR-0048, `calendar.events` only, `tools/google-token-spike-write.ps1`) day-0 PASSED; feature unbuilt (Ideas Backlog, not Ready).
   Tooling note: pass `handoff-check.ps1 -Clone` as an absolute path (a relative one writes the report to a nested dir).
2. (UX1–UX5, AB Part 2, CS done) NY Needs You + Morning Review → SP phone measurement (re-read the backlog). AB Part 1
   (vault writer) is not the Lead's; owner decides when it is built.

## Owner items

- Phone: Today → Health → History → tap 30 d / 90 d / 1 y / All; values and lines look right (HC3b).
- Phone: bottom bar Today · Tasks · Scouts · Notes · Log; Tasks → Today/All; Log → Training/Progress; status dot →
  Status → Back (UX1b). Tell me if the cockpit order on Today feels right.
- Phone: Log → Training → tap a session → change a value → Save changes; status dot → Actions → Undo (B12).
- Phone: Log training → Workout → Group training → class → Save; suggestion next time (B11). BTC 1W/1M/3M (B9).
- Phone: Today → mood check-in on a day with no journal note yet → saves (B7); rows labelled (B8).
- Review ADR-0036 (Mood), 0037 (UI tokens), 0038 (last copy), 0039 (health), 0040 (report button); decide on `git stash@{0}`.


## Budget

DeepSeek $7.76. GLM ~270k/900k.
