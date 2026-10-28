# Brief HC4 — Ring data in 15-minute slots, a JRing-style day view

Read `AGENTS.md`, ADR-0039, ADR-0043 and **ADR-0068** (`docs/decisions/0068-ring-slots.md`, accepted 2026-10-28).
Synthetic data only. Written by a daytime session, revised 2026-10-28; the Lead owns slicing, worker briefs and
merges. This brief and the ADR are untracked in the main checkout: commit both in the HC4-a PR.

**Released 2026-10-28, full scope** (owner: "We do not want to do the simple or minimal version. We want to get all
the data, as much as possible."). Build HC4-a to HC4-d completely; "full scope" means every metric and every slot,
still delivered as small slices. HC5 (analysis, `docs/briefs/HC5-ring-analysis.md`) is **not** released.

**Outcome:** after each Ring Sync run, the ring's last 7 days land as 15-minute rows in
`Health/Data/Ring/Ring Slots YYYY-MM.csv`, a daily summary row is derived into
`Health/Data/Apple Health Vitals Daily.csv`, and the Health card shows any day like the JRing app: HR and SpO₂ lines,
steps bars, a sleep-stage band, and BP, stress, fatigue and HRV as small series.

**Why:** the owner wants as much as the JRing app shows, every 15 minutes. Apple Health cannot carry stress, fatigue
or ring BP, so the owner's PulseLoop fork exposes an App Intent, "Get ring data", that returns the slots as JSON
(contract in ADR-0068); the Shortcut posts it. The app itself makes no network calls.

**Not in scope:** `POST /api/health/ingest` (v1), the existing daily CSV and `Tools/apple_health_daily.py` stay
unchanged. Ring steps never enter the daily CSV, iPhone step totals or baselines. No baselines, thresholds or
good/bad colours. No changes to the fork (built separately).

## Gates

1. **Done 2026-10-27:** resting HR = option A (median of the night session's non-null slot `hr`, ≥ 3 slots, else
   empty); recorded in `.agent/owner-instructions.md` and ADR-0068.
2. **Waived by the owner 2026-10-28:** no separate shape check. The owner builds the real Ring Sync directly;
   vault-0.2 has synced with the ring since 28 Oct and the fork's `RingSlotsExportTests` cover the format. The
   Worker's strict parser and its `error` text (slot index and key only) catch any mismatch on the first real send.
   If the shape ever differs from the contract, the contract in ADR-0068 wins and the fork is fixed, not the parser.
3. **Done 2026-10-28** (owner: "Access done"): `app.karpov.dk/api/health/ring/ingest` is in the existing
   health-ingest Access application (same AUD; an unauthenticated POST gets 403). The deploy itself still needs
   `ACTION NEEDED:` with the exact command.

Build plan, module boundaries, registry shape and test list: `docs/briefs/HC4-plan.md`.

## Shortcut for the owner: a separate "Ring Sync" (Sync Health stays unchanged)

Lesson from v1: hand-built Shortcuts break easily, so each one stays small and the logic lives in the Worker.

1. **Get ring data** (PulseLoop app action). Leave **Days** at its default **7** (range 1–28): the Worker accepts
   only slots from the last 8 days and refuses the whole send otherwise.
2. **Get Contents of URL** `https://app.karpov.dk/api/health/ring/ingest`, Method **POST**, three headers
   `CF-Access-Client-Id`, `CF-Access-Client-Secret` (the same service token) and `Content-Type: application/json`;
   Request Body **File** = the output of *Get ring data*. Send the JSON text as it is; do not rebuild it as a
   Shortcuts dictionary (that retypes nulls and numbers).
3. **Get Dictionary Value** `error` → **If** it *has any value* → **Show Notification** with it.

Automation: **App → PulseLoop → Is Closed → Run Ring Sync** (Run Immediately). The earlier "Find Health Samples"
blocks for ring types are **not** needed.

**Response contract for this check (Worker, HC4-b):** every failure the Worker answers is JSON with an `error`
string (and `ok: false`); every success has `ok: true` and **never** an `error` key. Wiring tests assert both for
each status the route can return (400, 401, 404, 409, 413, 422, 503, 200). Limitation the Lead should tell the
owner: a refusal at Cloudflare Access (expired or revoked token) or a network failure never reaches the Worker and
carries no `error` key, so this Shortcut stays silent then. Judge delivery by the slot file's commit time, not by
the absence of a notification.

## Slices (one PR each, ≤ 400 changed lines; one implementation worker at a time)

- **HC4-a, pure domain, two PRs** (no I/O; data-integrity work: run Jev's tier choice, floor `sol-medium`):
  **a1** metric registry `ring-metrics.ts`, shared `health-format.ts` (helpers moved from v1, no logic change),
  `ring-slots.ts`: strict payload parse, canonical `slot_start` keyed on the instant, month split.
  **a2** `ring-slot-file.ts`: slot-file merge (non-null replaces, null never erases); `ring-daily.ts`: daily row
  derivation from merged rows (night sessions, resting HR = median of the session's non-null `hr`, ≥ 3 slots,
  counts) and the daily-file row merge. Each module has its own `*.test.ts`.
- **HC4-b, write path — high-risk** (route `POST /api/health/ring/ingest` in `app.ts`, `/api/*` guard exemption,
  `contracts` constants, wiring tests, `docs/health-shortcut.md` ring section, `docs/vault-contract.md` rows):
  sequential `executeWrite` per month file then the daily file, create-if-absent, wrong header refused.
  `-Reviewer both` plus the Lead's focused review of the risky diff.
- **HC4-c, read API** (`GET /api/health/ring?date=`, `vitals` block on `GET /api/health`, read guards).
- **HC4-d, full day view like JRing** (a day sheet opened from the Health card; e2e at phone width; split into
  d1/d2 if it exceeds 400 lines). Every metric of every 15-minute slot is visible: HR as a line with the
  `hr_min`–`hr_max` band, SpO₂ line, steps bars, a sleep-stage band (light/deep/awake), BP systolic/diastolic,
  stress, fatigue, HRV and temperature as small aligned series on one shared 00:00–24:00 time axis. Tapping or
  scrubbing a slot shows all 14 values of that slot (`—` for null). Previous/next day navigation over the stored
  files; the derived night summary and coverage counts at the top. Gaps for missing slots, never 0 or interpolated;
  neutral colours, no good/bad judgement; an "unverified label" note on fatigue, stress and HRV. Screen slice
  procedure: the Lead's Opus subagent writes the worker brief from a mockup and reviews the tour screenshots.
  Design picked 2026-10-28: option A "stacked strips" (`docs/mockups/2026-10-28/ring-day-view-A.html` + `.png`,
  behaviour notes at the bottom of the HTML; commit both with HC4-d), inside Log → Health via a "Ring" section and
  a "Ring day ›" link. Strips come from the registry; readings ≤ 2 slots apart are joined, a longer gap breaks the
  line. The axis follows instants, so DST days show 23 or 25 hours.

## Invariants the acceptance tests must break if violated

- `null` never erases a stored value; a re-send of the same body makes no commit; untouched rows are byte-identical.
- The repeated hour on the last Sunday of October keeps two rows; the same instant is never stored twice.
- A send spanning two months writes both files; a failed later write errors, and the next send repairs it.
- Non-boundary, duplicate or out-of-window slot starts, unknown or missing keys, and all-null slots refuse the whole
  request with slot index and key only.
- Missing stays missing in the files, the API (`null`) and the chart (a gap, never 0 or an interpolated line).
- v1 ingest output is unchanged (golden synthetic test).
- No health value in logs, errors, diagnostics, commit messages, Jev prompts or fixtures; tests build slots in code.

## Done means

1. Gate 3 confirmed by the owner before the deploy.
2. HC4-a to d merged with green CI; the deploy goes through `ACTION NEEDED:`.
3. The owner's first Shortcut run answers `{"ok":true,…}` and creates this month's slot file.
4. After 48 hours the slot file's last commit time moved without the owner pressing anything, and the card's day
   view shows last night on the phone.
