# ADR-0039 — Worker reads the Apple Health daily CSV (Health card Phase 1)

Status: accepted (Lead, 2026-10-02, under the owner's HC brief in the vault Ready Backlog).

## Context

The HC Health card shows yesterday's activity against a personal baseline and 30-day trends. The data already exists
as `Health/Data/Apple Health Daily.csv` (owner-refreshed from an Apple Health export). ADR-0018/0033 keep the Worker's
reads on allowlisted paths; ADR-0033 fixes the Health boundaries (no health data to AI, missing is not zero).

## Decision

- The Worker may read exactly one extra file, the constant `HEALTH_DAILY_CSV`. No client-supplied path, no folder
  listing beyond resolving that file, no write. Size guard 1 MB, UTF-8 only, blob SHA checked as for scout status.
- `GET /api/health` returns derived values only: the shown day, staleness in days and, for steps, headphone minutes,
  first and last movement, the day's value, the baseline, a compare label and a 30-day series.
- Baseline = median of the 90 calendar days before the shown day, ignoring no-data days (steps 0 and no first
  movement); fewer than 14 values ⇒ unknown. "Usual" = within ±10 % (times ±30 min). Times are minutes after 03:00
  (the CSV's behavioural day), so medians do not wrap at midnight. No colour warnings: ADR-0033's usual-range method
  is still unresolved, so the card stays neutral cyan.
- Health values never reach logs, error messages, AI models (including Jev) or fixtures; tests use synthetic CSVs.

## Consequences

Phase 2 (Shortcut intake, a write target) needs its own ADR and high-risk review. Changing the label band or the
baseline window is a constant change in `packages/domain/src/health.ts`, not a new ADR.
