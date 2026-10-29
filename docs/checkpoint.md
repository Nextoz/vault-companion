# HC6 phone health v2 — brief + ADR-0070 (proposed) merged, HC6-a1 next (2026-10-29)

- Opus subagent wrote `docs/briefs/HC6-phone-health-v2.md` and ADR-0070: v2 body on the same `/api/health/ingest`
  (`schemaVersion: 2`, `samples` lines), `phone-metrics.ts` registry, Phone Slots month files, v1 daily CSV rebuilt
  byte-identical, combined steps = per-slot max(phone, ring) in `Health/Data/Activity Daily.csv`, backfill via a
  repo script into the local vault checkout (owner runs). Slices a1, a2, b (high risk), c, d, e.
- Unverified (probe Shortcut first): Find Health Samples with a variable type + source filter; type names/units.
- Open owner question: switch Steps headline/baseline/XP to combined later? (HC6 keeps phone steps.)
- HC5 slice c: owner asked (ACTION NEEDED 2026-10-29) whether to build the Ring-card UI at all.
- Next: HC6-a1 (registry + v2 line parser), backend, overnight-safe.

# HC5 ring analysis — slices a + b merged, slice c next (2026-10-29)

- Owner released HC5 candidates #7 (coverage) and #2 (sleep timing + regularity) only; brief `docs/briefs/HC5-ring-analysis.md`, ADR-0069. Other HC5 candidates and LAS stay unreleased.
- Slice a merged: daily row gains `slots_n`, `longest_gap_min`, `sleep_mask` (`ring-daily.ts` `coverage`, 92/96/100 grid; a date with no slots gets empty cells). `RING_DAILY_HEADER_V1` kept: `mergeDailyFile` upgrades a V1 file only on a write that changes one of the 18 original values or adds a date (untouched rows padded empty, identical resend = no write; a coverage-only difference never upgrades); `parseRingDaily` accepts both headers and ignores the new columns (`RingDailyRow` unchanged). Lead review skipped GLM #1-3/#5 as false or by design (Copenhagen DST is never at midnight; inserted rows are excluded from padding), fixed #4 (padding width from the headers).
- Slice b merged: pure `ring-analysis.ts` (`analyseRing`) + `GET /api/health/ring/analysis` (`RingAnalysisResponse`), reading only the daily file via `parseRingDailyFull(text, tz)`; without `tz` (vitals, day view) the new columns are skipped, so a bad mask never blanks the Ring card. Lead choices (not in ADR-0069): 30-date window ending today, clipped at the first row; spread7/14 and SRI over the N dates ending at the latest night, any gap => null; population SD; SRI share 0..1 with `n`, slots paired by clock label + occurrence. 400 rows: ~2.6 ms warm in Node, ~21 ms cold (Intl init); real Workers CPU unmeasured.
- Next: slice c = UI under the Ring card (screen slice: daytime session, Opus brief + shot review; owner's "no new ring UI unless asked" rule vs the HC5 release: confirm with the owner first). RAM was ~2 GB free (one worker at a time).
- Ring CPU (Workers Free 10 ms) fixed in three PRs, all live: #236 zone offset cache, #237 day read parses one day (~40 -> ~3 ms), #238 line-level merge + windowed daily (7-day ingest ~190 -> ~35 ms, 2-day ~19 ms; laptop bench incl. in-memory store). The Shortcut now sends 2 days routinely. Not yet proven under 10 ms: read real CPU from the Workers logs after the owner's first syncs (owner sets up the Shortcut 2026-10-29); if over, owner decides Paid vs smaller files.
- Flaky: `e2e/morning.spec.ts` "long brief keeps Close tappable" [iphone-15-webkit, light] failed once on CI, passed on re-run. DeepSeek Pro worker hung after its first message ("model metadata for deepseek-v4-pro not found"); ADR drafts went to codex instead.

# HC4 ring slots — live (2026-10-28)

- Released full scope (owner). Plan: `docs/briefs/HC4-plan.md`; brief `docs/briefs/HC4-ring-slots.md`; ADR-0068. Gate 3 (Access) done. Owner approved the deploy 2026-10-28. Note: CI (`ci.yml` job `deploy production`) deploys every green `main` commit with a smoke test and automatic rollback, so HC4-a1..c went live on merge; HC4-d's main run failed on two flaky tests and goes live with the follow-up PR (flake fixes, WebKit focus-on-click, "temp (day avg)" label).
- HC4-d merged (#233, d1+d2): lazy "Ring day" sheet (`RingDaySheet.tsx`, `ring-day.ts`; design A, DST-aware axis, join rule, newest slot selected) and a Ring section on the Health card from `vitals`. The web reads the registry only via `@vault-companion/domain/ring-metrics` (ADR-0068 amendment; lint exception next to ADR-0067 `/game`).
- HC4-c merged (#232): `GET /api/health/ring?date=` + `vitals` on `/api/health` (`packages/domain/src/ring-read.ts`); prev/next read at most one adjacent month file per direction. HC4-b merged (#231): `POST /api/health/ring/ingest` (`apps/worker/src/ring-ingest.ts`, same service token as v1 ingest).
- Owner saw "No ring data yet" on the Health tab (2026-10-28); day view check after the first sync.
- Fixed: WebKit does not focus a tapped button, so sheets lost their opener; `apps/web/src/ui/focus-on-click.ts` (installed in `main.tsx`) focuses it for every sheet (leaderboard e2e green on webkit). The real-stack Undo-race spec is flaky. Workers and handoff-check never run lint: the Lead's acceptance run found lint/CSS-token failures on hc4-c and hc4-d.
- HC4-a2 merged: `ring-slot-file.ts` (slot-file parse/merge, header upgrade only on a changing write, empty file refused) and `ring-daily.ts` (sessions, night, aggregates from the registry, `affectedDates` incl. the night before and re-dated sessions, `mergeDailyFile`); Opus review fixed a per-slot Intl formatter CPU blowup (formatters cached per zone).
- HC4-a1 merged: metric registry `ring-metrics.ts`, strict parser/canonical slot_start/month split `ring-slots.ts`, v1 helpers moved to `health-format.ts`.
- Next: owner deploy approval, then the steps above; the queue after HC4 is unranked (LAS spec awaits the owner). Jev triage returned unparsable on hc4-a2 (all findings auto-skipped): check `Tools/jev.ps1` before trusting automatic triage.
- Open decisions noted in the plan: `generatedAt` freshness bound (replay of old bodies is harmless, no erase), negative `tempC` refused.
# AI leaderboard — release verification

- Branch `feat/glm-workflow-leaderboard` in isolated clone `glm-workflow-20261015`; original drafts preserved. Integrated main through `2de19209`.
- Implemented all-page Artificial Analysis ingestion, bounded refresh, durable current/previous KV snapshots, authenticated storage-only API, daily cron and mobile Dashboard/model details. Existing cron budget includes provider and storage operations. Missing fields remain unavailable.
- Standalone controller/runner: 58 offline tests passed; independent live GLM infrastructure review passed. Actual detached leaderboard launch stopped safely when OpenCode produced no final answer. State and usage retained outside repository; no worker remains active and no paid repair loop was restarted. Owner requested local repairs and CodeRabbit as release reviewer.
- Owner approved 2026-10-16: created leaderboard KV namespace, set production GitHub secret `LEADERBOARD_KV_NAMESPACE_ID`, and added Worker secret `AA_API_KEY` from existing local environment. Identifiers/values are not committed. Previous live application tag `2de19209`; setting the secret did not publish feature code.
- Verification: focused source/API/UI tests, 58 controller tests, lint, typecheck, web/Worker bundle dry run and dependency audit passed. Initial full application run: 3,040 passed, one CSS-token failure fixed and its check passed. Final full run, complete browser suite and screenshot tour are in progress.
- Next: finish verification, address CodeRabbit/CI findings, then merge and deploy under the owner's existing authorization. Do not restart the GLM implementation job or expose secrets. Durable run receipts remain in the local workspace.
