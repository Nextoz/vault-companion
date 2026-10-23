# ADR-0067: Instant local XP, rules v3 and more achievement kinds

Status: accepted (owner, 2026-10-23 evening session). Supersedes ADR-0064 decision 1 ("re-read and diff after the
save"); amends ADR-0060 (Character projection) and the web boundary in `eslint.config.js`.

## Problem

XP did not arrive when you acted. The reward layer waited until the action's commit reached GitHub, then 600 ms, then a
full `/api/game` read (head plus six vault reads), then possibly 2.5 s more. When GitHub still had not shown the commit
after that one retry, the diff saw an unchanged revision and the action's "+XP" was never shown; it turned up merged
into the next action. The owner also found that training was nearly the only XP source in practice (78 % of real XP):
dictation paid 15 XP with no minutes logged, tasks paid 3 XP with only 5 a day counting.

## Decision

1. **Predict on the phone, confirm from the server.** `GET /api/game` now also returns `records` (the slim records the
   engine read: date, identity, minutes, topic, overdue days; no notes, scores or measurements) and `timeZone`. The
   Worker computes the Character from exactly these slim records. The moment an action is queued, `RewardLayer` turns
   its command into the record it will add (`apps/web/src/predict.ts`), runs the same engine on records + new record,
   and celebrates the difference at once. After the save, the existing re-read replaces the baseline; it is diffed
   against what was already shown, so a correct prediction confirms silently and anything else (a desktop edit, a
   refused action, an older Worker without `records`) is celebrated or corrected then. Undo drops its target's
   prediction; a refused action drops its own; a drop is never celebrated.
   ADR-0064 rejected client prediction for "two copies of the rules". That no longer holds: the phone imports the one
   engine and config (`@vault-companion/domain/game`), so the rules exist once. A prediction is skipped (old path) for
   a partial read, a read without records, or a `rulesVersion` the bundle does not know.
2. **Web boundary.** `apps/web` may import `@vault-companion/domain/game` only (a pure entry point with no store,
   command or GitHub code); every other domain import stays forbidden by lint.
3. **Rules v3** (`rulesVersion` 3; owner: "more for dictation, a bit more per task"): learning 40 XP base, +1 per 2 min
   up to +20 (was 15 / +15); tasks 5 XP, 10 a day (was 3, 5 a day); a finished Active Work item is a new **quest**
   source, Quartermaster, 20 XP, 3 a day (it used to count as a to-do task). Training, Library and reflections are
   unchanged. The 12-week synthetic simulation moves from level 15 to level 20.
4. **More achievement kinds**, all derived from the same records and all counting participation, never intensity:
   `run` (consecutive days, optional one rest day per 7), `weeks` with a per-week minimum, `peak` (most in one day,
   week or month), `weekends`, `distinct` (e.g. learning topics), `months`, `together` (two sources the same day),
   `dayProfessions`, `fullWeeks` and `points`. The catalogue gains 46 entries, including the Scholar daily and
   weekly streaks the owner asked for on 9 October and never got. Week rhythms still show no resetting counter; every
   other progress bar shows a best-ever value.

## Consequences

- The payload grows by the slim records (at most about 1,100 rows in practice). Private text stays on the Worker.
- A changed rule set (`rulesVersion`) announces nothing on the first read after a deploy, as before; retroactive
  achievements arrive as the usual on-open summary.
- A prediction can be wrong only when the server's view differs from the phone's (a desktop edit landing at the same
  moment, a refused write). The confirming read then corrects the shown state silently.
