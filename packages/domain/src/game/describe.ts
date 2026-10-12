// ADR-0064: one short sentence per achievement ("what it asks") and per earning source ("what earned it"), derived from
// the criterion so the copy can never drift from the rule. Pure; the Worker sends these, the phone only renders them.
import type { AchievementDefinition, CharacterConfig, Criterion } from './types.ts';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Per source: "Complete 10 tasks", "Log 3 different kinds of training", ... */
const SOURCE_COPY: Readonly<Record<string, { count: (n: number) => string; variety: (n: number) => string; weeks: (n: number) => string; earned: string }>> = {
  task: { count: n => `Complete ${plural(n, 'task')}.`, variety: n => `Complete ${plural(n, 'kind')} of task.`, weeks: n => `Complete a task every week for ${plural(n, 'week')} in a row.`, earned: 'Completing a task' },
  training: { count: n => `Log ${plural(n, 'training session')}.`, variety: n => `Log ${n} different kinds of training.`, weeks: n => `Train at least once a week for ${plural(n, 'week')} in a row.`, earned: 'Logging a training session' },
  learning: { count: n => `Log ${plural(n, 'learning session')}.`, variety: n => `Study ${n} different kinds of learning.`, weeks: n => `Study at least once a week for ${plural(n, 'week')} in a row.`, earned: 'Logging a learning session' },
  library: { count: n => `Keep ${plural(n, 'note')} in the Library.`, variety: n => `Keep ${n} different notes in the Library.`, weeks: n => `Keep a note every week for ${plural(n, 'week')} in a row.`, earned: 'Keeping a note in the Library' },
  reflection: { count: n => `Save ${plural(n, 'book reflection')}.`, variety: n => `Save reflections on ${plural(n, 'book')}.`, weeks: n => `Save a reflection every week for ${plural(n, 'week')} in a row.`, earned: 'Saving a book reflection' },
};

const professionName = (config: CharacterConfig, id: string): string => config.professions.find(p => p.id === id)?.name ?? id;

function describeCriterion(criterion: Criterion, config: CharacterConfig): string {
  const copy = 'source' in criterion ? SOURCE_COPY[criterion.source] : undefined;
  switch (criterion.kind) {
    case 'xp': return criterion.target === 1 ? 'Earn your first XP.' : `Earn ${criterion.target} XP.`;
    case 'level': return `Reach level ${criterion.target}.`;
    case 'rested': return 'Earn bonus XP while rested.';
    case 'gap': return `Come back after ${criterion.target} or more days away.`;
    case 'balanced': return `Earn XP in ${criterion.target} professions in one week.`;
    case 'founding': return 'Start your character.';
    case 'dayOne': return `Earn XP in ${criterion.target} professions in your first ${config.dayOneDays} days.`;
    case 'skill': return `Reach skill ${criterion.target} in ${professionName(config, criterion.profession)}.`;
    case 'minutes': return `Spend ${criterion.target} minutes in one session.`;
    case 'overdue': return `Complete a task that was ${criterion.target} or more days overdue.`;
    case 'count': return copy?.count(criterion.target) ?? `Reach ${criterion.target}.`;
    case 'variety': return copy?.variety(criterion.target) ?? `Reach ${criterion.target} kinds.`;
    case 'weeks': return copy?.weeks(criterion.target) ?? `Keep it up for ${plural(criterion.target, 'week')}.`;
    case 'meta': {
      const required = criterion.requires.map(id => config.achievements.find(a => a.id === id));
      const skills = required.map(a => a?.criterion.kind === 'skill' ? a.criterion : null);
      const target = skills[0]?.target;
      // "Reach skill 75 in all four professions" reads better than four rank names.
      if (skills.every(c => c !== null && c.target === target) && new Set(skills.map(c => c!.profession)).size === config.professions.length) {
        return `Reach skill ${target} in all ${config.professions.length} professions.`;
      }
      const names = required.map((a, i) => a?.name ?? criterion.requires[i]!);
      return `Earn ${names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(' and ')}.`;
    }
  }
}

/** The "what it asks" line shown on the badge detail. */
export function describeAchievement(achievement: AchievementDefinition, config: CharacterConfig): string {
  return describeCriterion(achievement.criterion, config);
}

/** The "what earned it" phrase for a record source, e.g. "Completing a task"; null for an unknown source. */
export function earnedByPhrase(source: string | null): string | null {
  return source === null ? null : SOURCE_COPY[source]?.earned ?? null;
}
