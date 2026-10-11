import type { AchievementDefinition, Criterion, StepMilestoneRules } from './types.ts';

const single = (id: string, name: string, category: string, points: number, criterion: Criterion, type: AchievementDefinition['type'] = 'one-off'): AchievementDefinition => ({ id, name, category, points, criterion, type });
const chain = (id: string, name: string, category: string, thresholds: readonly number[], points: readonly number[], criterion: (target: number) => Criterion): AchievementDefinition[] => thresholds.map((target, index) => ({
  ...single(`${id}-${target}`, `${name} ${target}`, category, points[index]!, criterion(target), 'chain'), chain: id, tier: index + 1,
}));
const ranks = (profession: string): AchievementDefinition[] => [
  ['Journeyman', 75, 10], ['Expert', 150, 10], ['Artisan', 225, 25], ['Master', 300, 50],
].map(([name, target, points]) => single(`${profession}-rank-${target}`, `${name} ${profession}`, profession, Number(points), { kind: 'skill', profession, target: Number(target) }));

/** Catalogue data is part of characterConfig; the evaluator has no named achievements. */
export const achievementCatalogue: readonly AchievementDefinition[] = [
  single('first-steps', 'First Steps', 'general', 5, { kind: 'xp', target: 1 }),
  ...chain('rising-hero', 'Rising Hero', 'general', [5, 10, 20, 30, 40, 50, 60], [5, 10, 10, 25, 25, 50, 50], target => ({ kind: 'level', target })),
  single('well-rested', 'Well Rested', 'general', 5, { kind: 'rested', target: 1 }),
  single('long-way-back', 'The Long Way Back', 'general', 10, { kind: 'gap', target: 14 }, 'hidden'),
  single('balanced-week', 'Balanced Week', 'general', 25, { kind: 'balanced', target: 4 }, 'hidden'),
  single('renaissance', 'Renaissance', 'general', 25, { kind: 'meta', requires: ['athletics', 'scholar', 'lorekeeper', 'quartermaster'].map(id => `${id}-rank-75`) }, 'meta'),
  single('jack-of-all-trades', 'Jack of All Trades', 'general', 50, { kind: 'meta', requires: ['athletics', 'scholar', 'lorekeeper', 'quartermaster'].map(id => `${id}-rank-150`) }, 'meta'),
  single('athletics-first', 'First Session', 'athletics', 5, { kind: 'count', source: 'training', target: 1 }),
  ...chain('athletics-sessions', 'Sessions', 'athletics', [10, 25, 50, 100, 250], [5, 10, 10, 25, 50], target => ({ kind: 'count', source: 'training', target })),
  ...chain('athletics-variety', 'Variety', 'athletics', [3, 5], [10, 25], target => ({ kind: 'variety', source: 'training', target })),
  ...chain('athletics-rhythm', 'Weekly Rhythm', 'athletics', [4, 8, 12], [10, 25, 50], target => ({ kind: 'weeks', source: 'training', target })),
  ...ranks('athletics'),
  single('scholar-first', 'First Session', 'scholar', 5, { kind: 'count', source: 'learning', target: 1 }),
  ...chain('scholar-sessions', 'Sessions', 'scholar', [10, 25, 50, 100], [5, 10, 10, 25], target => ({ kind: 'count', source: 'learning', target })),
  single('many-subjects', 'Many Subjects', 'scholar', 10, { kind: 'variety', source: 'learning', target: 3 }, 'counter'),
  single('deep-work', 'Deep Work', 'scholar', 10, { kind: 'minutes', source: 'learning', target: 45 }),
  ...ranks('scholar'),
  single('first-note', 'First Note Kept', 'lorekeeper', 5, { kind: 'count', source: 'library', target: 1 }),
  ...chain('lorekeeper-notes', 'Notes Kept', 'lorekeeper', [10, 25, 50, 100], [5, 10, 10, 25], target => ({ kind: 'count', source: 'library', target })),
  single('first-reflection', 'First Reflection', 'lorekeeper', 10, { kind: 'count', source: 'reflection', target: 1 }),
  ...chain('lorekeeper-reflections', 'Reflections', 'lorekeeper', [10], [25], target => ({ kind: 'count', source: 'reflection', target })),
  ...ranks('lorekeeper'),
  ...chain('quartermaster-tasks', 'Tasks Completed', 'quartermaster', [10, 50, 100, 250, 500], [5, 10, 10, 25, 50], target => ({ kind: 'count', source: 'task', target })),
  single('clean-slate', 'Clean Slate', 'quartermaster', 10, { kind: 'overdue', source: 'task', target: 30 }),
  ...ranks('quartermaster'),
  single('founding-hero', 'Founding Hero', 'feats', 0, { kind: 'founding', target: 1 }, 'feat'),
  single('day-one', 'Day One', 'feats', 0, { kind: 'dayOne', target: 2 }, 'feat'),
];

/** A Journey step milestone: points only, never XP (owner decision 10 Oct 2026). Thresholds live in `steps` config. */
export interface StepMilestoneDefinition {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly points: number;
  readonly ladder: 'lifetime' | 'yearly';
  readonly target: number;
}

export const STEP_MILESTONE_CATEGORY = 'Journey';

const stepLabel = (target: number): string => target >= 1_000_000 ? `${target / 1_000_000}M` : `${target / 1_000}K`;
const stepDefinition = (ladder: StepMilestoneDefinition['ladder'], target: number, name: string, points: number): StepMilestoneDefinition =>
  ({ id: `steps-${ladder}-${target}`, name, category: STEP_MILESTONE_CATEGORY, points, ladder, target });

/** Pairs the configured thresholds with Journey names and points. Recurring lifetime milestones use `recurringStepMilestone`. */
export function stepMilestoneCatalogue(steps: StepMilestoneRules): readonly StepMilestoneDefinition[] {
  return [
    ...steps.lifetime.map((target, index) => stepDefinition('lifetime', target, `${stepLabel(target)} Steps`, steps.points.lifetime[index]!)),
    ...steps.yearly.map((target, index) => stepDefinition('yearly', target, `${stepLabel(target)} Steps in a Year`, steps.points.yearly[index]!)),
  ];
}

/** The definition for a lifetime threshold past the last explicit one (every `lifetimeEvery` steps). */
export function recurringStepMilestone(target: number, steps: StepMilestoneRules): StepMilestoneDefinition {
  return stepDefinition('lifetime', target, `${stepLabel(target)} Steps`, steps.points.recurring);
}

/** Returns configuration mistakes, including impossible bounded criteria and cyclic metas. */
export function catalogueErrors(config: import('./types.ts').CharacterConfig): string[] {
  const errors: string[] = [];
  const ids = new Map<string, AchievementDefinition>();
  for (const a of config.achievements) {
    if (ids.has(a.id)) errors.push(`Duplicate achievement: ${a.id}`);
    ids.set(a.id, a);
    const c = a.criterion;
    if (c.kind === 'meta') continue;
    if (!Number.isFinite(c.target) || c.target <= 0) errors.push(`Invalid target: ${a.id}`);
    if (c.kind === 'skill' && (c.target > config.skill.max || !config.professions.some(p => p.id === c.profession))) errors.push(`Unreachable skill: ${a.id}`);
    if (c.kind === 'level' && c.target > config.level.max) errors.push(`Unreachable level: ${a.id}`);
    const earningProfessions = new Set(Object.values(config.sources).filter(s => s.enabled && s.dailyCap > 0 && (s.baseXp > 0 || (s.minutes?.maxBonus ?? 0) > 0 || (s.overdue?.xp ?? 0) > 0)).map(s => s.profession));
    if ((c.kind === 'balanced' || c.kind === 'dayOne') && c.target > config.professions.filter(p => earningProfessions.has(p.id)).length) errors.push(`Unreachable professions: ${a.id}`);
    if (c.kind === 'founding' && c.target > 1) errors.push(`Unreachable founding: ${a.id}`);
    if (c.kind === 'rested' && (config.rested.perDay <= 0 || config.rested.max <= 0 || config.rested.multiplier <= 0)) errors.push(`Unreachable rested: ${a.id}`);
    if ('source' in c && (!config.sources[c.source] || (!config.sources[c.source]!.enabled && !a.locked))) errors.push(`Unavailable source: ${a.id}`);
    if (c.kind === 'minutes' && !config.sources[c.source]?.minutes) errors.push(`Unavailable minutes: ${a.id}`);
    if (c.kind === 'overdue' && !config.sources[c.source]?.overdue) errors.push(`Unavailable overdue: ${a.id}`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { errors.push(`Cyclic meta: ${id}`); return; }
    if (visited.has(id)) return;
    const a = ids.get(id);
    if (!a) { errors.push(`Missing dependency: ${id}`); return; }
    visiting.add(id);
    if (a.criterion.kind === 'meta') {
      if (!a.criterion.requires.length) errors.push(`Empty meta: ${id}`);
      for (const dependency of a.criterion.requires) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids.keys()) visit(id);
  return errors;
}
