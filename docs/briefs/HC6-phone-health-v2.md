# Brief HC6 — Phone health v2: 15-minute phone slots, every iPhone type, dual-source steps

Read `AGENTS.md`, ADR-0043, ADR-0068 and **ADR-0070** (`docs/decisions/0070-phone-health-slots-and-dual-source-steps.md`,
proposed 2026-10-29). Synthetic data only. Written by a Lead subagent from the owner's decisions of 2026-10-28; the
Lead owns slicing, worker briefs and merges. Commit this brief and ADR-0070 in the HC6-a1 PR.

## Outcome

- Each "Sync Health" run stores the iPhone's samples of every phone-recorded type as 15-minute rows in
  `Health/Data/Phone/Phone Slots YYYY-MM.csv`, keeps writing the v1 daily row byte-compatibly, and refreshes
  `Health/Data/Activity Daily.csv` with phone, ring and combined (`max` per slot) steps.
- Phone history since 2024-02 is imported once from `export.xml` by an owner-run local tool.
- Log → Health shows phone · ring · combined steps where steps already appear. No other UI, no new ring UI.

## Acceptance

- A v2 send with all registry types creates/updates the month file(s); a re-send of the same body makes no commit.
- Equivalent v1 and v2 bodies produce byte-identical `Apple Health Daily.csv` (golden synthetic test); v1 bodies
  still work unchanged.
- Combined steps per slot = max(phone, ring), never the sum; daily combined = sum of slot combined.
- A PulseLoop source line, an unknown type or unit, or a missing Steps set refuses the whole request, naming line and
  type only.
- A new type needs only one registry entry + schema bump (proved by a test that adds a fake `since: 2` entry).
- The backfill dry run prints counts only; `--write` produces files equal to what the Worker would write for the
  same samples (shared code path, cross-check test).

## Quality bar

- Domain modules pure (no Hono/Cloudflare/GitHub/React); registry is the only list of types, columns and units.
- Superset schema versions; new CSV columns append at the end; files of every known version stay valid.
- Daily derivations are pure functions over merged slot rows (HC5-style analyses plug in without I/O changes).
- Each test fails when its guard is removed (sentinel values like 987/9876; slots and lines built in code).
- No health value or source name in logs, errors, commit messages, CLI output or fixtures.

## Phone registry (`packages/domain/src/phone-metrics.ts`, `phone-slots/1`)

| key | Shortcuts type name (verify) | HK identifier | column | units accepted -> stored | slot agg | daily |
|---|---|---|---|---|---|---|
| steps | Steps | StepCount | steps | count | sum-prorata int | sum |
| distance | Walking + Running Distance | DistanceWalkingRunning | distance_km | km, m, mi -> km | sum-prorata 3 dp | sum |
| flights | Flights Climbed | FlightsClimbed | flights | count | sum-prorata int | sum |
| activeEnergy | Active Energy | ActiveEnergyBurned | active_kcal | kcal | sum-prorata 1 dp | sum |
| walkingSpeed | Walking Speed | WalkingSpeed | walking_speed_kmh | km/hr, m/s -> km/h | mean 2 dp | mean |
| stepLength | Walking Step Length | WalkingStepLength | step_length_cm | cm, m -> cm | mean | mean |
| asymmetry | Walking Asymmetry | WalkingAsymmetryPercentage | asymmetry_pct | % (0–100) | mean 1 dp | mean |
| doubleSupport | Double Support Time | WalkingDoubleSupportPercentage | double_support_pct | % | mean | mean |
| steadiness | Walking Steadiness | AppleWalkingSteadiness | steadiness_pct | % | last | last |
| sixMinWalk | Six-Minute Walk | SixMinuteWalkTestDistance | six_min_walk_m | m | last | last |
| stairUp | Stair Speed: Up | StairAscentSpeed | stair_up_mps | m/s | mean 2 dp | mean |
| stairDown | Stair Speed: Down | StairDescentSpeed | stair_down_mps | m/s | mean | mean |
| headphone | Headphone Audio Levels | HeadphoneAudioExposure | headphone_db + headphone_min | dBASPL | energy mean / union min | as v1 script |
| inBed | Sleep (value "In Bed") | SleepAnalysis (InBed) | in_bed_min | (none) | union overlap min | sum |

Not phone-recorded without a watch (excluded until asked; each is one entry later): basal energy, heart rate and its
derivatives, environmental sound, time in daylight, running/cycling metrics. Six-Minute Walk may stay empty without
a watch (kept: an empty column costs nothing). Daily derivation names (column order) are ADR-0070's Activity Daily
header. Export.xml percent values are fractions (×100 in the backfill mapping); the Shortcut's scale is verified on
the first send.

## Slices (one PR each, ≤ 400 changed lines incl. tests, docs excluded; one worker at a time)

**HC6-a1 — registry + v2 line parser** (pure). Owns `domain/src/phone-metrics.ts`, `domain/src/phone-samples.ts`
(`parsePhoneV2(body, now, tz)` -> `{ok, from, sentAt, samples: PhoneSample[]}` or `{ok:false, status: 400|422, error}`;
`PhoneSample = {key, start, end, value, inBed?}`), `index.ts` exports. Invariants: registry-driven validation (no
hand list); unit conversion from the registry; source backstop; errors name line + type only.
Tests `phone-metrics.test.ts` (header == ADR literal; keys/columns/type names/HK ids unique; Activity Daily header ==
ADR literal; fake `since: 2` entry appends to header and leaves v1 header unchanged), `phone-samples.test.ts`
(refusal table: 5 fields, unknown type, wrong unit, `1,234`, negative, % 101, end < start, bad ISO, PulseLoop
source in any case, no Steps -> 422, span > 8 days, future `sentAt`; m->cm and mi->km conversions exact; blank lines
skipped; sentinel 987 never in `error`).

**HC6-a2 — slot aggregation + slot file** (pure). Owns `domain/src/phone-slots.ts` (`aggregatePhoneSlots(samples,
from, sentAt, tz)` -> `PhoneSlot[]` per ADR rules, `from + 1 h` guard), `domain/src/phone-slot-file.ts`
(`mergePhoneSlotFile(text|null, slots, version, tz, mode: 'replace'|'fill')`), reusing `ringFileLines`,
`joinRingLines`, `firstEol`, `canonicalSlotStart`, `splitByMonth`-style helper (generalise only by type parameter;
no ring behaviour change). Tests `phone-slots.test.ts` (987 steps over 09:10–09:20 -> 494 in 09:00, 493 in
09:15: tie to the earlier slot, total preserved; zero-length sample; mean vs last; headphone overlap union and
energy mean; in-bed overlapping samples not double counted; DST: `2026-10-25T02:15+02:00` and `+01:00` separate rows;
slot before `from + 1 h` dropped; month split Oct 31/Nov 1), `phone-slot-file.test.ts` (null never erases; same
slots twice -> `changed:false`; neighbour rows exact bytes with CRLF + BOM; `fill` keeps stored cell, fills empty;
older header upgraded once; unknown header -> `refused:structure`; malformed touched row refused).

**HC6-b — ingest v2 write path (high risk, `-Reviewer both`)**. Owns schema dispatch in `domain/src/health-ingest.ts`
(v1 path untouched; v2 builds the v1 `Samples` from v2 lines and calls the existing aggregation),
`apps/worker/src/phone-ingest.ts` (or an extension of the health ingest service: sequential `executeWrite`s per
ADR), contracts `PHONE_SLOTS_DIR`, `phoneSlotsPath(month)`, `app.ts` response for v2, `docs/health-shortcut.md` v2
section, `docs/vault-contract.md` Phone slots row. Invariants: v1 bytes; per-file op IDs; plans read at CAS commit;
JSON `{ok:false,error}` for every failure. Tests: golden v1 vs v2 daily-CSV equality; same body twice -> no new
write; failing write 2 -> error names file kind, re-send commits only the missing write; log spy has no sentinel or
source name; v1 body still 200; a maximal synthetic 3-day body (all 14 types, realistic sample counts) stays within
the Workers Free CPU budget measured like ring CPU P1/P2.

**HC6-c — Activity Daily (combined steps)**. Owns `domain/src/activity-daily.ts` (`deriveActivityDaily(phoneSlots,
ringSlots, dates, tz)` -> rows; `mergeActivityDaily`), contracts `ACTIVITY_DAILY_CSV`, the extra write in both the v2
phone ingest and `apps/worker/src/ring-ingest.ts` (affected dates only, reads both slot files at its CAS commit),
vault-contract row. Invariants: max per slot never sum; empty+empty -> no contribution; daily combined = sum of
slot combined; date without slots in either source not written; ring ingest's existing writes unchanged.
Tests: phone 987 + ring 400 in one slot -> 987 (fails if sum); phone null + ring 400 -> 400; slot counts; DST day
(92/100 slots) sums; ring re-send changes only the steps cells of affected dates; existing ring ingest tests green.

**HC6-d — backfill tool (owner-run)**. Owns `tools/health-backfill/export_samples.py` (stdlib `iterparse`, copied
parse/unit logic from the vault tool, source filter, HK-id map file generated from the registry, refuses an output
path inside the repo), `tools/health-backfill/build.ts` (reads the lines file, chunks by month, calls a1/a2/c domain
functions, `fill` mode against the vault checkout given by `--vault`, dry run default, `--write`), runner = the
repo's existing TS runner if any (`pnpm exec tsx --version`), else add `tsx` as a root devDependency (say so in the
PR). Tests: a synthetic `export.xml` snippet (in code) -> lines; lines -> files equal to the Worker path's output for
the same samples; PulseLoop record skipped; dry run writes nothing and prints no value; output path in repo refused.

**HC6-e — minimal read + UI (justified: the owner asked for phone/ring/combined where steps appear)**. Owns
`domain/src/health.ts` (read today's Activity Daily row into `GET /api/health` as optional `steps2: {phone, ring,
combined}`, nulls kept), contracts optional field (cached v1 copies still parse), `apps/web/src/ui/HealthPanel.tsx`
one secondary line "phone · ring · combined" under the existing Steps value. Headline, baselines, history and XP
keep v1 `steps`. Tests: read returns nulls when the file/row is absent; the line is hidden when all three are null.

## Invariants (every slice keeps them)

- `null` never erases; re-send makes no commit; untouched rows byte-identical; one row per instant (DST).
- Phone and ring raw steps stay in their own files; combined is derived only.
- v1 route behaviour and v1 daily bytes unchanged.
- Refusals are whole-request with line/type only; no values anywhere outside the vault.

## Owner Shortcut steps

Verified: the v1 "Find Health Samples → Repeat → Text → Combine Text" chain (HC3, in production), `Add to Variable`,
nested `Repeat with Each`. **Assumed, checked by step 0:** that Find Health Samples accepts a variable as *Type*,
offers a *Source* filter, and that one action handles both quantity types and Sleep. If step 0 fails, use the
fallback; the Worker accepts both shapes identically.

0. **Probe (2 min).** New Shortcut "Probe": **List** with two lines `Steps` and `Walking Step Length` → **Repeat
   with Each** item in List → inside: **Find Health Samples**, tap *Type* and pick the variable **Repeat Item**; add
   filter *Source* **is** your iPhone; *Start Date* is in the last 7 days; *Limit* 1 → **Quick Look**. Run. Pass =
   two samples of two types. Then add `Sleep` to the list and run again. Report pass/fail per line to the Lead.
1. Open "Sync Health" (v1). Keep steps 1–2 (`SentAt` = Current Date; `From` = SentAt minus 3 days). Delete the seven
   type blocks and the old JSON body fields after step 6 below works (keep a duplicate of v1 as backup first).
2. **List** with these lines, exactly: `Steps`, `Walking + Running Distance`, `Flights Climbed`, `Active Energy`,
   `Walking Speed`, `Walking Step Length`, `Walking Asymmetry`, `Double Support Time`, `Walking Steadiness`,
   `Six-Minute Walk`, `Stair Speed: Up`, `Stair Speed: Down`, `Headphone Audio Levels`, `Sleep`. (Use the names the
   Find Health Samples type picker shows; if one differs, type the picker's name and tell the Lead.)
3. **Repeat with Each** item in List. Inside, in order:
   a. **Set Variable** `TypeName` to *Repeat Item*.
   b. **Find Health Samples**: *Type* = `TypeName`; *Start Date* is after `From`; *Source* is your iPhone; sort by
      *Start Date*, oldest first; no limit.
   c. **Repeat with Each** item in *Health Samples*: **Text** `TypeName|Start Date|End Date|Value|Unit|Source`
      (the sample's details; both dates *ISO 8601* with *Include ISO 8601 Time* on; `|` typed literally, no spaces).
      Then **Add to Variable** `Lines`. End inner repeat.
   End outer repeat.
4. **Combine Text** `Lines` with *New Lines*.
5. **Get Contents of URL** `https://app.karpov.dk/api/health/ingest`, POST, the same two `CF-Access-Client-*`
   headers, Request Body **JSON** with exactly four fields: `schemaVersion` (Number) `2`, `from` (Text, `From` ISO
   8601 with time), `sentAt` (Text, `SentAt` likewise), `samples` (Text, *Combined Text*).
6. **Get Dictionary Value** `error` → **If** it *has any value* → **Show Notification** with it. Run by hand with
   the phone unlocked; expect no notification. If an error names a type, line or unit, send the Lead only that text.

**Fallback if step 0 fails:** instead of steps 2–3, one block per list name: **Find Health Samples** (*Type* chosen
in the picker, same filters) → **Repeat with Each** → **Text** `Steps|Start Date|End Date|Value|Unit|Source`
(the literal type name first) → **Add to Variable** `Lines`. Build and test one block, then duplicate it and change
only the type and the literal name. Automations stay as in v1 (22:30 daily, charging connected).

**Backfill (once, after HC6-d):** Health app → profile → Export All Health Data → copy `export.zip` to the PC
outside both repos; unzip; run the two commands from `docs/health-shortcut.md` (HC6-d adds them): dry run, check
the counts, then `--write`; pull the vault before, commit and push right after; delete the export files.

## Open questions for the owner

1. Should the Steps headline, its baseline/history and XP switch from phone steps to combined steps later? HC6 keeps
   them on phone steps (continuity with 2024–2026 history, where no ring exists) and adds combined as a secondary
   line; switching is a one-line read change plus a decision on how to compare pre-ring history.

Decided here (not asked): same route with `schemaVersion: 2` (no Access change); Shortcut source filter "is this
iPhone" plus a Worker PulseLoop backstop (strict: other apps' steps would also double count); pro-rata slot split
(aligns with ring bins for `max`); backfill writes through the shared domain code into the local vault checkout and
the normal Git path (no service token on the PC, no v1 row rewrite); v1 schema stays accepted indefinitely.

## Risks

- Shortcut type names, units and percent scale are unverified until the first send; the strict parser names the
  type/line, and registry aliases are one-line fixes.
- CPU: up to four commits and ~thousands of lines per send on Workers Free; measure in HC6-b before merge; if over,
  shorten the Shortcut window to 2 days (1 full day + today) rather than relaxing validation.
- Combined steps under-count when both devices miss a slot and over-state nothing; DST days have 92/100 slots.
- Backfill races a live sync on the current month: `fill` mode plus pull-before/push-after; a conflict is resolved by
  re-running after pull (deterministic output).
- Activity Daily rows are derived: hand edits on a re-derived date are overwritten (accepted, as ADR-0068).
