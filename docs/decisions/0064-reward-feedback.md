# ADR-0064: Reward feedback — instant celebrations, Critical XP, achievement descriptions, sounds

Status: accepted (owner, 2026-10-11 daytime session). Amends ADR-0060 (Character projection) and the GAM1-C toast.

## Problem

Earning felt flat. The achievement toast read `/api/game` only when the app opened, so the moment you completed the
10th task nothing happened; you saw a plain text pill minutes later. Achievements had no description, so the badge
detail could not say what an achievement asks or what earned it. XP had no visible feedback at all.

## Decision

1. **Celebrate right after the action.** The web `RewardLayer` (replaces `AchievementToast`) keeps the last
   `/api/game` read. When any queued action newly reaches `saved`, it waits 600 ms, re-reads, and diffs the two reads
   (`apps/web/src/rewards.ts`, pure). If the read still shows the same revision it retries once after 2.5 s. The
   offline queue therefore never celebrates something that did not save. Owner choice: re-read and diff (option A),
   over a game delta in the write receipt (couples the write path to the game) or client-side prediction (two copies
   of the rules; a capped award would show "+3" and take it back).
2. **Order, small to big, one at a time:** `+XP` float with skill-up lines → achievement banners (minor before major,
   at most 3 per action; the rest are marked seen) → new profession or level titles → full-screen level up. A diff
   across a `rulesVersion` change, an unchanged revision or a drop in XP (Undo) announces nothing.
3. **Critical XP (variable reward, owner option B).** About one capped award in `critical.every` (8) has its base XP
   multiplied by `critical.multiplier` (2); rested applies on top; daily caps are unchanged. The engine stays
   derived-only, so a critical is not random: `isCritical(date, source, ordinal)` hashes the day, the source and the
   award's ordinal that day (FNV-1a). Keyed by ordinal, not record identity, because task ids carry a line index that
   shifts when the To-Do List changes: a recompute never moves a past critical. `rulesVersion` 1 → 2; the first read
   after the deploy recomputes all history with criticals (about +13 % XP in the simulation: 2916 → 3296 at week 12,
   level still 14-16). The rules-version guard keeps that jump from being announced as a reward.
4. **Descriptions and "earned by".** `describeAchievement` (domain, pure) writes one sentence per achievement from its
   criterion ("Complete 10 tasks.", "Reach skill 75 in all 4 professions."). The engine records the source of the
   record whose award earned each achievement; `earnedByPhrase` turns it into "Completing a task". Hidden achievements
   send neither until earned. Rank achievement names now use the profession's display name ("Journeyman Athletics").
5. **Wire shape: a new optional top-level `feedback` field** on `GameResponse` (`criticals`, `critical`, and
   per-achievement `description`/`earnedBy`). Not new fields on `GameCharacter`/`GameAchievement`: those are strict,
   so an installed older client would reject the whole read, while it strips unknown top-level keys. Optional so a
   new client still reads an older Worker during a rollout. The Worker maps the domain Character to the exact GAM1
   wire fields (`wireCharacter`).
6. **Sounds are synthesised with Web Audio** (`apps/web/src/sound.ts`): no audio files, nothing to license (WoW's own
   sounds are Blizzard's and this repo is public). On by default, a "Reward sounds" switch on the Character sheet
   (device-held `vc.sound`). iOS needs a gesture to start audio, so the first tap anywhere unlocks the context. iPhone
   web apps cannot vibrate, so there is no haptic.
7. **Reduced motion** replaces every movement with a fade.

## Not decided here

Choosing a displayed title, a global XP strip on the tab bar, floats that rise from the tapped checkbox, and a
heavier WoW skin inside the Character screens (see the vault design and feel review, 2026-10-11).

## Undo

Revert the PR. Setting `critical.every` to 0 turns criticals off without a code change elsewhere (bump
`rulesVersion` with it so the drop is not diffed as a loss).
