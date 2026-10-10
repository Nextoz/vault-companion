// GAM1-B: pure presentation helpers for the Character card and screen. No React and no worker/domain import:
// every number is derived from the /api/game payload (contracts only), so the page cannot drift from the config.
import type { GameAchievement, GameProfession, GameRules } from '@vault-companion/contracts';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export interface XpBar {
  /** Fill as 0..100%. */
  readonly percent: number;
  /** True at the level cap, where the server reports `levelCost` zero. */
  readonly maxed: boolean;
}

/** The level bar fill. At maximum level `levelCost` is zero: never divide by it, the bar is full and "maxed". */
export function xpBar(levelXp: number, levelCost: number): XpBar {
  if (levelCost <= 0) return { percent: 100, maxed: true };
  return { percent: clamp((levelXp / levelCost) * 100, 0, 100), maxed: false };
}

export interface RestedSegment {
  readonly start: number;
  readonly width: number;
}

/** Where the rested reserve sits on the level bar: from the current fill, never past the end; empty at max level. */
export function restedSegment(levelXp: number, levelCost: number, restedXp: number): RestedSegment {
  const start = xpBar(levelXp, levelCost).percent;
  if (levelCost <= 0) return { start, width: 0 };
  return { start, width: clamp((restedXp / levelCost) * 100, 0, 100 - start) };
}

/** A profession ring fill as 0..100% of the skill cap; a non-positive cap is empty, never a division. */
export function skillPercent(skill: number, max: number): number {
  return max > 0 ? clamp((skill / max) * 100, 0, 100) : 0;
}

/** "skill/300" uses the live cap from the config, never a literal. */
export function skillLabel(skill: number, rules: GameRules): string {
  return `${skill}/${rules.skill.max}`;
}

/** A profession's rank line: rank, skill over the live cap, and lifetime XP. */
export function professionLine(profession: GameProfession, rules: GameRules): string {
  return `${profession.rank} · ${skillLabel(profession.skill, rules)} · ${profession.xp} XP`;
}

/** The bar's text: `levelXp / levelCost XP`, or "Max level" when there is no next level. */
export function levelLabel(levelXp: number, levelCost: number): string {
  return levelCost <= 0 ? 'Max level' : `${levelXp} / ${levelCost} XP`;
}

/** True when the profession's source is named in `unavailable`; drives the "<Source> unavailable" note. */
export function professionUnavailable(professionId: string, unavailable: readonly string[]): string | null {
  const source = PROFESSION_SOURCES[professionId];
  return source !== undefined && unavailable.includes(source) ? `${sourceLabel(source)} unavailable` : null;
}

/** The named sources that failed, as "<Source> unavailable" lines, stable order. */
export function unavailableLines(unavailable: readonly string[]): string[] {
  return unavailable.map((source) => `${sourceLabel(source)} unavailable`);
}

/** The profession a source feeds, so a failed read can be named on the right row. */
export const PROFESSION_SOURCES: Readonly<Record<string, string>> = {
  athletics: 'training', scholar: 'learning', lorekeeper: 'library', quartermaster: 'tasks',
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  training: 'Training', learning: 'Learning', library: 'Library', tasks: 'Tasks', health: 'Health',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** Where a profession's XP is earned: existing Log / Radar screens only (GAM1-B). */
export const PROFESSION_DESTINATION: Readonly<Record<string, string>> = {
  athletics: 'training', scholar: 'learning', lorekeeper: 'radar', quartermaster: 'history',
};

const earnedDate = (a: GameAchievement): string => a.earnedDate ?? '';

/** Up to `limit` earned achievements, newest first, ties by name; unearned and undated never appear. */
export function recentlyEarned(achievements: readonly GameAchievement[], limit = 3): GameAchievement[] {
  return achievements
    .filter((a) => a.earned && a.earnedDate !== null)
    .sort((a, b) => earnedDate(b).localeCompare(earnedDate(a)) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** XP needed to advance from `level`, straight from the config's base cost, step and minimum level. */
export function levelCostAt(level: number, rules: GameRules): number {
  const { baseCost, costStep, min } = rules.level;
  return baseCost + costStep * (Math.max(min, level) - min);
}

/** A few labelled points on the curve (first levels, ~level 10, the last level before the cap), all derived. */
export function levelExamples(rules: GameRules): Array<{ level: number; cost: number }> {
  const { min, max } = rules.level;
  const candidates = [min, min + 9, max - 1];
  const levels = [...new Set(candidates)].filter((l) => l >= min && l < max).sort((a, b) => a - b);
  return levels.map((level) => ({ level, cost: levelCostAt(level, rules) }));
}

export interface RuleSection {
  readonly id: string;
  readonly heading: string;
  readonly lines: readonly string[];
}

const professionName = (rules: GameRules, id: string): string =>
  rules.professions.find((p) => p.id === id)?.name ?? id;

function sourceLine(rules: GameRules, source: GameRules['sources'][number]): string {
  const parts = [`${source.baseXp} XP per entry, up to ${source.dailyCap} a day`];
  if (source.minutes) {
    const { after, step, xp, maxBonus } = source.minutes;
    parts.push(after > 0
      ? `+${xp} XP per ${step} minutes beyond the first ${after}, up to +${maxBonus}`
      : `+${xp} XP per ${step} minutes, up to +${maxBonus}`);
  }
  if (source.overdue) {
    parts.push(`+${source.overdue.xp} XP when overdue by ${source.overdue.days}+ days, up to ${source.overdue.dailyCap} a day`);
  }
  return `${professionName(rules, source.profession)}: ${parts.join('; ')}.`;
}

/**
 * The "How XP works" page as data. Every value is read from `rules` (the live config projection), never a literal,
 * so a config edit changes the page and a unit test that swaps a value must see the page change too.
 */
export function howXpWorks(rules: GameRules): RuleSection[] {
  const enabled = rules.sources.filter((s) => s.enabled);
  const disabled = rules.sources.filter((s) => !s.enabled);
  const level = rules.level;
  const restedBonus = Math.round(rules.rested.multiplier * 100);
  return [
    {
      id: 'sources',
      heading: 'Where XP comes from',
      lines: [
        ...enabled.map((source) => sourceLine(rules, source)),
        ...disabled.map((source) => `${professionName(rules, source.profession)}: not active.`),
      ],
    },
    {
      id: 'caps',
      heading: 'Daily caps',
      lines: enabled.map((source) => `${professionName(rules, source.profession)}: ${source.dailyCap} entries a day.`),
    },
    {
      id: 'levels',
      heading: 'Level curve',
      lines: [
        `${level.baseCost} XP to go from level ${level.min} to level ${level.min + 1}, then +${level.costStep} XP each level, up to level ${level.max}.`,
        ...levelExamples(rules).map((row) => `Level ${row.level}: ${row.cost} XP to advance.`),
      ],
    },
    {
      id: 'skill',
      heading: 'Skill and ranks',
      lines: [
        `Skill grows by ${rules.skill.baseCost} + floor(skill / ${rules.skill.step}), capped at ${rules.skill.max}.`,
        ...rules.ranks.map((rank) => `${rank.name} at skill ${rank.skill}.`),
      ],
    },
    {
      id: 'rested',
      heading: 'Rested XP',
      lines: [
        `Rested builds ${rules.rested.perDay} for every full day off, up to ${rules.rested.max}, and grants a +${restedBonus}% bonus until used.`,
      ],
    },
  ];
}
