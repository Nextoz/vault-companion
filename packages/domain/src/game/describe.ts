// ADR-0064: one short sentence per achievement ("what it asks") and per earning source ("what earned it"), derived from
// the criterion so the copy can never drift from the rule. Pure; the Worker sends these, the phone only renders them.
import type { AchievementDefinition, CharacterConfig, Criterion } from './types.ts';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Per source: "Complete 10 tasks", "Log 3 different kinds of training", ...; `verb` is the bare activity ("Train"). */
const SOURCE_COPY: Readonly<Record<string, { count: (n: number) => string; variety: (n: number) => string; weeks: (n: number) => string; verb: string; earned: string }>> = {
  task: { count: n => `Complete ${plural(n, 'task')}.`, variety: n => `Complete ${plural(n, 'kind')} of task.`, weeks: n => `Complete a task every week for ${plural(n, 'week')} in a row.`, verb: 'Complete a task', earned: 'Completing a task' },
  quest: { count: n => `Finish ${plural(n, 'Active Work item')}.`, variety: n => `Finish ${n} different Active Work items.`, weeks: n => `Finish an Active Work item every week for ${plural(n, 'week')} in a row.`, verb: 'Finish an Active Work item', earned: 'Finishing an Active Work item' },
  training: { count: n => `Log ${plural(n, 'training session')}.`, variety: n => `Log ${n} different kinds of training.`, weeks: n => `Train at least once a week for ${plural(n, 'week')} in a row.`, verb: 'Train', earned: 'Logging a training session' },
  learning: { count: n => `Log ${plural(n, 'learning session')}.`, variety: n => `Study ${n} different kinds of learning.`, weeks: n => `Study at least once a week for ${plural(n, 'week')} in a row.`, verb: 'Study', earned: 'Logging a learning session' },
  library: { count: n => `Keep ${plural(n, 'note')} in the Library.`, variety: n => `Keep ${n} different notes in the Library.`, weeks: n => `Keep a note every week for ${plural(n, 'week')} in a row.`, verb: 'Keep a Library note', earned: 'Keeping a note in the Library' },
  reflection: { count: n => `Save ${plural(n, 'book reflection')}.`, variety: n => `Save reflections on ${plural(n, 'book')}.`, weeks: n => `Save a reflection every week for ${plural(n, 'week')} in a row.`, verb: 'Save a reflection', earned: 'Saving a book reflection' },
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const list = (items: readonly string[], joiner = 'and'): string => items.length > 1 ? `${items.slice(0, -1).join(', ')} ${joiner} ${items.at(-1)}` : items.join('');
const verbOf = (source: string): string => SOURCE_COPY[source]?.verb ?? `Log ${source}`;
const lowerFirst = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

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
    case 'weeks': return (criterion.perWeek ?? 1) > 1
      ? `${verbOf(criterion.source)} at least ${criterion.perWeek} times a week for ${plural(criterion.target, 'week')} in a row.`
      : copy?.weeks(criterion.target) ?? `Keep it up for ${plural(criterion.target, 'week')}.`;
    case 'run': return `${verbOf(criterion.source)} ${criterion.target} days in a row${criterion.rest ? ' (one rest day a week is fine)' : ''}.`;
    case 'peak': {
      const window = criterion.window === 'month' ? 'calendar month' : criterion.window;
      return `${(copy?.count(criterion.target) ?? `Reach ${criterion.target}.`).slice(0, -1)} in one ${window}.`;
    }
    case 'weekends': return `${verbOf(criterion.source)} on both Saturday and Sunday of ${criterion.target === 1 ? 'a weekend' : `${criterion.target} weekends`}.`;
    case 'distinct': return `${verbOf(criterion.source)} ${criterion.target} different ${criterion.field === 'topic' ? 'texts or topics' : `${criterion.field}s`}.`;
    case 'months': {
      const names = criterion.months.map(m => MONTHS[m - 1] ?? String(m));
      if (criterion.months.length === 12 && criterion.target === 12) return `${verbOf(criterion.source)} in every month of the year.`;
      return criterion.target >= criterion.months.length
        ? `${verbOf(criterion.source)} in ${list(names)}.`
        : `${verbOf(criterion.source)} in ${criterion.target} of ${list(names, 'or')}.`;
    }
    case 'together': {
      const verbs = criterion.sources.map((s, i) => i === 0 ? verbOf(s) : lowerFirst(verbOf(s)));
      return `${list(verbs)} on the same day${criterion.target === 1 ? '' : `, ${criterion.target} times`}.`;
    }
    case 'dayProfessions': return `Earn XP in ${criterion.target} professions in one day.`;
    case 'fullWeeks': return criterion.target === 1 ? 'Earn XP on all 7 days of a week.' : `Earn XP on all 7 days of a week, ${criterion.target} times.`;
    case 'points': return `Collect ${criterion.target} achievement points.`;
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
