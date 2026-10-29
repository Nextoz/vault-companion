# Brief HC5 — Ring analysis on the 15-minute slots (candidates; NOT released)

Written by a daytime session, 2026-10-28. **Not released to the Lead:** the owner picks which analyses go in; the
picked set gets its own ADR. Builds on HC4 / ADR-0068 (slot files `Health/Data/Ring/Ring Slots YYYY-MM.csv` and the
derived daily row). Owner: "Then build even more advanced analysis tools on top of the data."

**Rules that carry over:** missing stays missing (a day without enough data shows "not enough data yet", never an
estimate); values never go to AI models (including Jev), logs or fixtures; tests use synthetic data; nothing here is
a diagnosis. Today's rule is neutral colours with no good/bad judgement (ADR-0033/0039): candidates 3 and 4 below
need the owner to decide whether that rule changes.

**Data clock:** counts are nights or days with data, from the first stored slot (the ring was reset on 26 Oct, so
expect history from about then). Nights without wear do not count.

## Candidates (minimum data before it is shown)

| # | Analysis | What it shows | Minimum |
|---|---|---|---|
| 1 | **Personal baselines + rolling deviation** | For resting HR, overnight HRV (median of night slots), overnight temperature and SpO₂: a personal baseline (median of the last 30 nights) and today's distance from it in the person's own spread (e.g. robust z from the median absolute deviation), plus a 7-night rolling line. SpO₂ dips = count of night slots below the personal 10th percentile. | 14 nights to show, 30 for a stable baseline; temperature only once the ring's temperature mode is verified |
| 2 | **Sleep timing and regularity** | Bedtime, wake time, midpoint and duration per night; their spread over 7/14 nights; a Sleep Regularity Index (same sleep/wake state 24 h apart, slot by slot); weekday vs weekend midpoint shift ("social jetlag"). | 7 consecutive nights for a weekly value; 14 nights (≥ 4 weekend nights) for the jetlag figure |
| 3 | **Daily recovery / readiness score** | One 0–100 number from the deviations in 1 (resting HR up, HRV down, temperature up) plus last night's duration and regularity, with each part's contribution shown. Weights are a design decision for its ADR. | 30 nights (it inherits the baselines of 1); owner must accept a judgement-style number |
| 4 | **Correlation with mood check-ins and activity** | Paired days of ring metrics with the daily mood check-in (ADR-0036 frontmatter) and iPhone steps from the daily CSV, including a one-day lag (last night → today's mood). Scatter plus a rank correlation with `n` and its uncertainty; wording "goes together with", never "causes". | 30 paired days for a first look, 60 before any statement; depends on how often mood is logged |
| 5 | **Nocturnal HR dip** | Sleeping HR (resting HR) against the same day's daytime average HR, as a percentage. | 1 night to show; 14 for a baseline |
| 6 | **Daytime profile** | Average 24-hour curves (HR, steps, stress, fatigue) for weekdays vs weekends, with the slot's sample count. Stress and fatigue stay marked "unverified label". | 14 days |
| 7 | **Wear time and coverage** | Hours of data per day and per metric, nights missed, the longest gap. Explains why other analyses are blank. | 1 day; worth building first |
| 8 | **Weekly summary into the vault** | A few derived numbers per week (no raw slots) for the weekly review note. A new vault write target, so high-risk. | 7 days |

## Questions for the owner

1. Which of 1–8 go in, in what order? Suggested order: 7, 1, 2, 5, then 6, 4, 3, 8.
2. For 3 (and any "dip" or deviation marker): keep the neutral, no-judgement rule, or allow a calm good/bad hint?
3. Compute at read time from the slot files (no new write target, recommended) or store derived weekly files (8)?

## For the Lead, once released

One ADR for the picked set (definitions, minimum-data thresholds, where it is computed), then slices of ≤ 400 lines
in the HC4 pattern: pure domain functions with synthetic tests first, then the API, then screens with mockups the
owner picks from.
