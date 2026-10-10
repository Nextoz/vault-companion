# ADR-0060: Character XP and achievements as a derived projection

Status: Accepted (GAM1-A1; task gam1a)

## Context
The Character summarizes already-read training, learning, kept Library notes and completed tasks.
Markdown + Git remain authoritative. A stored XP ledger would add a write target, synchronization,
deduplication and deletion policy before the owner has calibrated the rules.

## Decision
- Use the pure `computeCharacter(records, config, today)` projection; no ledger, I/O or new write target.
  Adapters flatten rows with `source` and a local `YYYY-MM-DD` date. Library records represent kept
  notes; task records represent completed tasks and supply a stable id and nonnegative integer overdueDays.
  Undated history cannot participate. Reflection records are defined but disabled.
- `characterConfig` is the single rules object, with `rulesVersion: 1`, source rules, professions,
  progression, titles and the imported 62-entry catalogue (every requested tier, including two feats).
  A new source/profession needs config data only. Callers supply valid config; catalogue tests guard its data.
- Sort by calendar date then a stable key of source, identity, parsed minutes and overdue days.
  Equal keys are award-equivalent. Dates use UTC arithmetic on date labels, never timezone conversion.
  Reject/count malformed or future records; invalid minutes mean no minutes bonus. Duration accepts
  plain minutes, minute suffixes, mm:ss and hh:mm:ss. Disabled sources are ignored, not malformed.
- Daily source caps limit XP, not historical achievement counts. Training: 2; learning: 3;
  kept notes: 5; reflections (when enabled): 2; tasks: 5, with at most 3 overdue bonuses.
  Distance, weight, speed, split, heart data, mood, sleep, steps, learning score and late activity
  never affect awards. There is no decay or public resetting streak counter.
- Rest starts at the first valid enabled record, with no invented prehistory. Every full zero-XP
  date before today adds 15 (maximum 150). Awards draw a 50% bonus, outside caps, including exact
  half-XP values. Remaining reserve includes idle dates after the last record. Empty history earns
  nothing, including feats: this prioritizes the explicit empty-history quality bar over the
  conflicting Founding Hero today fallback. Founding Hero uses the earliest participating record.
- Skill uses `5 + floor(s/10)` through 300; level uses `100 + 15*(n-1)` through 60.
  The formula yields skill 225 at **3,545 XP**, not the brief's 3,680 (which yields skill 230).
  Other supplied milestones agree. Prefer the explicit formula; retain it as tunable data.
  Maximum level has levelXp/levelCost zero; overall XP continues accumulating.
- Achievement dates are the completing record date; idle time alone earns nothing. Chains expose
  earned tiers plus the next tier; later entries retain `visible: false`. Hidden names are `???`
  until earned. Metas follow dependency achievements, independent of catalogue order. Locked
  reflections cannot earn. Feats carry zero points and are separate from category totals.
  Weekly rhythm retains its historical maximum internally and exposes no counter. Day One uses
  the earliest date and six following dates. Renaissance/Jack thresholds are 75/150, following
  the Lead decision rather than contradictory prose rank names.

## Step milestones (GAM1-A2, owner decision 10 Oct 2026)
Steps are achievements with points and **never XP**: no daily goal, no streak, and no XP or level from steps or any
other health value. The source is the cumulative `steps` column of `Health/Data/Apple Health Daily.csv`, read through
the existing health read (the same file the Health history uses); sleep, heart, mood, weight, distance and late
activity are never read here. The pure `computeStepMilestones(days, config)` takes daily `{date, steps}` rows and
returns the earned milestones with the real date the running total first crossed each threshold, the next lifetime
`{current, target}` for a progress bar, and a `{count, firstYear}` summary for one toast. A blank or missing day adds
nothing and is never guessed. Thresholds live only in `characterConfig.steps`: lifetime 100k, 250k, 500k, 1M, 2.5M,
5M, 7.5M, 10M then every 2.5M, and per calendar year (counted separately, never reset) 1M, 2M, 3M, 4M. Catalogue
entries (category `Journey`, tier points, `xp` untouched) pair the thresholds with names and points. `GET /api/game`
returns the Character plus `stepMilestones` (null when the health read failed); any source that fails to read is named
in `unavailable` and never counted as zero, and the engine still runs on the remaining sources.

## Consequences
Identical records/config/today produce identical output, with sorting O(n log n) and linear replay
for the fixed catalogue. An achievement based on a later-deleted record can disappear; rule edits
can also change prior results. Persistence would require a separate ADR. Synthetic tests cover caps,
exclusions, dates, 2,000 rows and progression; the 12-week default profile reaches level 15 and
Athletics Journeyman in week 5. API integration and UI belong to later slices.
