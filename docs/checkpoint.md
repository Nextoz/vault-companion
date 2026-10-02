# Checkpoint — 2026-10-02 (HC1 health API merged)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Live: `d9d3dff2`** (Mood M2+M3). Rollback target `35c44728`. HC1 is API-only: deploy together with HC2.
- **HC1 merged** — `GET /api/health` (ADR-0039): Worker reads only `Health/Data/Apple Health Daily.csv`; shown day =
  newest row ≤ yesterday (Copenhagen), `staleDays`; steps, headphone min, first/last move vs median of the 90 days
  before (≥ 14 values, "usual" ±10 % / ±30 min), 30-day series; missing/unreadable statuses. No values in logs.
- HC1: DeepSeek Flash one run (80k tokens); CodeRabbit 2 + GLM 4 findings → 1 real (time zone not wired); Lead also
  fixed `FileTooLarge` reported as "GitHub unreachable" (now `unreadable`, tested).
- FB Report button is ahead of HC on the backlog priority line but was not in Next actions; do it after HC2 unless
  the owner says otherwise. It is a new vault write target (high-risk).
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

## Next actions (in order)

1. **HC2 — Health panel on the Dashboard** (cyan board): stat tiles for steps, headphone min, first/last movement vs
   baseline with above/below/usual label, 30-day sparklines, "Data from <date>" line honest when stale; missing /
   unreadable messages; e2e with a synthetic CSV. Then deploy HC1+HC2.
2. Then FB Report button → AB AI budget card → NY Needs You + Morning Review → SP phone measurement (re-read the
   backlog note).

## Owner items

- Phone: Today → Mood check-in → pick values → Check in → see "Checked in HH:MM" and the Journal note on desktop;
  try Undo from Actions.
- On the phone: SP1 read-speed list (Today → "Vault updated").
- Review ADR-0036 (Mood), ADR-0037 (UI tokens), ADR-0038 (last copy); decide on `git stash@{0}`.

## Budget

DeepSeek $9.39. GLM ~100k/900k. RAM 4.5 GB free.
