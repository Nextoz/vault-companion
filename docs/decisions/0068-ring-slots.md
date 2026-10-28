# ADR-0068 — Ring data: 15-minute slots from the ring app, monthly slot files and a derived daily row (HC4)

Status: **accepted** (owner, 2026-10-28; drafted by a daytime session after the owner's decision: "as much
information as in the JRing app … once every 15 minutes"). Resting HR option A chosen 2026-10-27. The separate shape
check was waived 2026-10-28: the fork's `RingSlotsExportTests` cover the format and the strict parser's `error`
catches a mismatch on the first real send. Amends ADR-0043 (one more ingest route and its write targets) and ADR-0039 (more read files).

## Context

The owner's ring (56ff/JRing, FW V138) syncs through their fork of PulseLoop iOS (`Nextoz/PulseLoopiOS`). Apple Health
cannot carry stress, fatigue or the ring's blood pressure, and it reduces the ring's history to whatever samples the
fork writes. The fork therefore gets an App Intent, **"Get ring data"**, that returns the last 7 days as 15-minute
slots in JSON. A separate "Ring Sync" Shortcut posts that JSON to Vault Companion; the app itself makes no network calls.

Ingest v1 (`POST /api/health/ingest`, ADR-0043) stays exactly as it is for the iPhone's steps and the daily CSV.
Steps, Distance and Active Energy stay iPhone-only in Apple Health (v1 sums every source).

## Decision

**Route.** `POST /api/health/ring/ingest`, behind the same service token and the same guards as `/api/health/ingest`:
the owner adds this path to the existing ingest Access application (same AUD, same `HEALTH_INGEST_AUD` check, no
`email` claim), and the general `/api/*` guard skips exactly this method and path. *Not* `POST /api/health/ring`:
Cloudflare Access matches paths, not methods, so a service-token application on `/api/health/ring` would also catch
the owner's `GET /api/health/ring?date=` and refuse it.

**Payload (fixed contract, the fork builds exactly this).**

```json
{"schema":"ring-slots/1","device":"SMART_RING V138","generatedAt":"2026-10-27T07:40:12+01:00",
 "slots":[{"start":"2026-10-27T03:15:00+01:00","steps":null,"hr":54,"hrMin":52,"hrMax":57,"spo2":96,
           "bpSys":null,"bpDia":null,"fatigue":null,"stress":null,"hrvMs":null,"tempC":null,
           "sleepLightMin":11,"sleepDeepMin":4,"sleepAwakeMin":0}]}
```
(Values above are synthetic.) Parsed strictly; anything unexpected refuses the whole request, naming the slot index
and key only, never a value:
- `schema` is exactly `ring-slots/1`; `device` a non-empty string ≤ 64 chars (validated, not stored);
  `generatedAt` ISO 8601 with offset, not more than 5 min in the future. The intent's Days parameter (default 7,
  range 1–28) must stay at 7: a slot older than the 8-day window refuses the whole request.
- Each slot has exactly the 14 keys above. `start` is ISO 8601 with offset, on a 15-minute boundary of Copenhagen
  wall-clock time (seconds `00`, no fraction; any offset is accepted, the instant counts), within the 8 days before
  `generatedAt` and not after it, unique **by instant** within the body. Every other key is `null` or a
  non-negative JSON integer (`tempC`: a non-negative number with at most two decimals). Sleep minutes are 0–15 each and sum to ≤ 15.
- A slot with every value `null` is refused (the contract omits it). `null` means "not measured"; `0` is a real 0.
- An empty `slots` array is valid: `{"ok":true,"slots":0}`, no commit.
- Status: not JSON, wrong `schema`/`device`/`generatedAt`, a missing or unknown key or a wrong value type ⇒ 400;
  a non-boundary, out-of-window or duplicate `start`, an all-null slot or a sleep sum > 15 ⇒ 422.
- Success body: `{"ok":true,"slots":<n>,"months":["YYYY-MM",…],"days":["YYYY-MM-DD",…]}` (counts and dates only).

**Metric registry (owner, 2026-10-28).** One registry in `packages/domain` (`ring-metrics.ts`) is the single source
for every ring metric: payload key, CSV column, unit, value rule (integer / decimals, bounds, nullability), schema
version that introduced it, daily aggregation(s), chart kind, colour token and the "label unverified" flag. The
parser, CSV writer, daily row, read API and day view all read it. A new metric = one registry entry + a schema bump:
`ring-slots/N` is a superset of earlier versions and every earlier version stays accepted (with exactly its own key
set). New CSV columns append at the end. Header rule: a file whose header equals the header of any known version is
valid; the byte-identity of untouched rows holds within one version, and the first write after a bump upgrades the
file once (new header, empty trailing cells). Daily derivations are pure functions over merged slots, so HC5
analyses plug in without touching I/O.

**Response.** The owner's separate "Ring Sync" Shortcut notifies only when the response has an `error` key, so every
failure the Worker answers on this route is JSON `{"ok":false,"error":"<text without values>"}` (including 401 and
404), and every success is `{"ok":true,…}` with **no** `error` key. Refusals at Cloudflare Access and network
failures never reach the Worker and carry no `error`; delivery is judged by the slot file's commit time.

**Storage.** One file per Copenhagen month, `Health/Data/Ring/Ring Slots YYYY-MM.csv`:

```
slot_start,steps,hr,hr_min,hr_max,spo2,bp_sys,bp_dia,fatigue,stress,hrv_ms,temp_c,sleep_light_min,sleep_deep_min,sleep_awake_min
```

- `slot_start` is written canonically by the Worker (Copenhagen local time with its offset, e.g.
  `2026-10-25T02:15:00+02:00`) and rows are keyed on the **instant**, so the repeated hour at the end of summer time
  keeps two distinct rows and the same instant can never appear twice with different offsets. Rows sorted by instant.
- **Merge, idempotent per slot:** a non-null value in the send replaces the stored cell; `null` never erases a stored
  value; untouched rows stay byte-identical; identical bytes make no commit. Consequence: a wrong stored value can
  only be removed by a manual vault edit, and re-sends correct only the 7 days the ring still holds.
- Cells: integers as plain digits, `temp_c` as the shortest decimal form (no trailing zeros), `null` as an empty cell.
  A touched row is rewritten only when one of its values changes. A stored row whose `slot_start` or cells do not
  parse ⇒ refused (409), never repaired. Existing row order is kept; new rows are inserted at their instant.
- Absent file ⇒ created with the header (`expect: 'absent'`); an existing file with any other header ⇒ refused (409).
  At ~3,000 rows a month the file stays well under the 1 MB guard.

**P2 amendment � rows a request uses are validated.** Merge indexes stored start cells and rejects invalid
starts or duplicate instants; the header and every touched row are validated, including unchanged resends.
Changed/new rows are individually validated before output (value rules, sleep sum and canonical start).
Untouched cells are trusted from their original write and retained byte-for-byte, including tolerated offsets;
a corrupt untouched cell does not block unrelated writes. Daily derivation validates only rows in the canonical
local date window (sent/affected dates plus neighbours), widening and reloading if affected dates escape it.
Write-plan results are memoised only within a write and by exact revision, so CAS retries compute afresh.

**Derived daily row.** `Health/Data/Apple Health Vitals Daily.csv` (header as in the first draft:
`date,weekday,sleep_start,sleep_end,light_min,deep_min,awake_min,resting_hr,avg_hr,min_spo2,avg_spo2,hrv_sdnn_ms,body_temp_c,hr_n,spo2_n,hrv_n,temp_n,sleep_n`)
is computed from the **merged** slot files, never from the send alone, for every date the send touched (the Copenhagen
calendar date of each sent slot, plus the night date of each sent sleep slot); the derivation also reads the previous
month's file when a night crosses a month boundary:
- Night = the date you wake up (03:00 cut, as v1: the night date is the calendar date of `sleep_end` − 3 h in
  Copenhagen wall-clock time). A sleep slot is a slot with light + deep + awake minutes > 0. Sleep slots form one
  session while consecutive sleep-slot starts are ≤ 75 min apart (at most 4 empty slots, 60 min, between them); the
  night is the session with the longest `sleep_end − sleep_start` among those whose night date is that date (tie:
  the later one). `sleep_start` = its first slot's start,
  `sleep_end` = its last slot's start + 15 min (both cells in the canonical `slot_start` form `YYYY-MM-DDTHH:MM:00+HH:MM`, empty without a session); stage minutes are the sums over that session's slots. No session ⇒
  the sleep cells stay empty; a session with no deep minutes ⇒ `deep_min` 0. The night's slots (for `resting_hr`)
  are all slots with a start in [`sleep_start`, `sleep_end`); `sleep_n` = the session's sleep slots.
- Day values use the Copenhagen calendar date (00:00–24:00, 92 or 100 slots on DST days), not the 03:00 cut:
  `avg_hr` = mean of the date's non-null slot `hr`; `min_spo2`/`avg_spo2`, `hrv_sdnn_ms`, `body_temp_c` likewise from
  non-null slots; `*_n` = number of non-null slots for that value. A median over an even count is the mean of the two
  middle values, then rounded.
- Integers for HR and HRV, one decimal for SpO₂ and temperature, v1's half-even rounding. Missing stays missing: no
  slot with a value ⇒ empty cell and count 0; nothing is interpolated or carried forward. A date with no slots is not
  written, so an older row survives.
- BP, stress, fatigue and ring steps stay in the slot files only. Ring steps are never added to the daily CSV, the
  iPhone step totals or any baseline.

**Resting HR (accepted, owner 2026-10-27):** `resting_hr` = median of the night session's non-null slot `hr`, at
least 3 such slots, else empty. Rejected: the lowest slot `hr` (one low reading sets it) and the median of `hrMin`
(lower by construction, harder to compare with other devices).

**Write path.** Sequential `executeWrite` calls in one request, oldest month first, then the daily row file; each
has its own operation ID (`ring-slots:<YYYY-MM>:<body hash>`, `ring-daily:<body hash>`; body hash = first 32 hex of
the body's SHA-256, as v1), CAS on the head, trailers
and dedupe, and skips when bytes are identical. A send spans at most two months, so at most three writes. If a later
write fails, the response is an error naming the file kind; the next send (which carries the same 7 days) repairs it
and the completed writes are then no-ops. Each plan's `compute` reads and merges at its own CAS commit (a retry
re-merges); the daily plan derives from the slot files as they are at that commit, never from request memory.
`executeWrite` is not changed.

**Read.** The Worker reads the slot file for a requested month by a name built from a validated `YYYY-MM-DD` only
(no client path, no folder listing), plus the daily row file as one more constant; ADR-0039 guards (1 MB, UTF-8,
blob SHA). `GET /api/health/ring?date=YYYY-MM-DD` (user Access, email allowlist) returns that day's slots in order
with `null` kept as `null`, plus the derived night. `GET /api/health` adds a `vitals` block from the daily row.

**Card.** The Health card opens a day view like JRing that shows every stored metric of every slot: an HR line
(with the slot min–max band) and SpO₂ line, steps bars, a sleep-stage band, and BP, stress, fatigue, HRV and
temperature as small series on one shared time axis; a selected slot shows all its values. Missing slots are gaps, never
interpolated or drawn as 0. Neutral colours only; no good/bad judgement, no thresholds. Fatigue, stress and HRV carry
an "unverified label" note until the owner confirms the fork's mapping. The web day view reads the registry through
the import-free subpath `@vault-companion/domain/ring-metrics` (the second web exception after ADR-0067's `/game`),
imported only by the lazy day sheet; the rest of `domain` stays out of the web bundle.

**Privacy.** Health values never reach logs, error text, response diagnostics (slot counts and key names only),
commit messages, AI models including Jev, or fixtures. Tests build synthetic slots in code (ADR-0039); real App
Intent output and ring captures never enter this repository.

## Alternatives

- **Apple Health samples via Find Health Samples (first draft):** no stress, fatigue or ring BP, and depends on what
  the fork writes to Health. Superseded by the App Intent.
- **One row per day only:** loses the JRing-style day view the owner asked for. Rejected.
- **Extend v1 `/api/health/ingest` with a schema 2:** mixes two sources and contracts on one route. Rejected.
- **Multi-file commits in `executeWrite`:** atomic, but changes the dedupe/receipt core. Rejected; sequential
  idempotent writes self-repair on the next send.
- **Derive the daily row at read time only:** fewer writes, but agents and notes in the vault could not read it.
  Rejected.

## Consequences

- High-risk under `docs/orchestration.md`: new route, new write targets, a privacy boundary. Negative tests for:
  null never erasing, non-boundary and duplicate slot starts, the repeated DST hour, an unknown or missing key, a
  wrong header, a month-spanning send, a failed second or third write, empty `slots`, and v1 ingest unchanged.
- Owner actions: add the path to the ingest Access application (Access change, explicit approval; the deploy waits
  for it); build the separate "Ring Sync" Shortcut (`docs/health-shortcut.md`, ring section); approve the deploy.
- If the fork changes its fatigue/stress/HRV mapping, older rows keep the old meaning; the slot files do not record
  the mapping version.
- `docs/vault-contract.md` gains rows for `Health/Data/Ring/` and the daily row file.
- Changing the session gap, rounding or the resting-HR definition later is a constant change, not a new ADR.
