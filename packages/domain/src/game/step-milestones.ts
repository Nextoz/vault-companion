// Journey step milestones (owner decision 10 Oct 2026): achievements with points, never XP. Pure: the caller passes
// the already-read daily step rows. A missing/blank day adds nothing and is never guessed.
import { recurringStepMilestone, stepMilestoneCatalogue, type StepMilestoneDefinition } from './catalogue.ts';
import type { CharacterConfig } from './types.ts';

export interface StepDay {
  readonly date: string;
  readonly steps: number | null;
}

export interface EarnedStepMilestone {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly points: number;
  readonly ladder: 'lifetime' | 'yearly';
  readonly target: number;
  /** The real calendar date the running total first reached the target. */
  readonly earnedDate: string;
  /** Calendar year for a yearly milestone; null for a lifetime one. */
  readonly year: number | null;
}

export interface StepMilestones {
  /** Deterministic order: earned date ascending, lifetime before yearly, then threshold ascending. */
  readonly earned: readonly EarnedStepMilestone[];
  /** The next lifetime milestone for a progress bar. The lifetime ladder is unbounded, so this is never null. */
  readonly next: { readonly id: string; readonly name: string; readonly current: number; readonly target: number };
  /** One toast later: how many milestones were already crossed, and the year of the first. Null when none. */
  readonly retroactiveSummary: { readonly count: number; readonly firstYear: number } | null;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function lifetimeTargets(total: number, config: CharacterConfig): number[] {
  const { lifetime, lifetimeEvery } = config.steps;
  const last = lifetime.at(-1) ?? 0;
  const targets = lifetime.filter((target) => target <= total);
  if (lifetimeEvery > 0 && last > 0) {
    for (let target = last + lifetimeEvery; target <= total; target += lifetimeEvery) targets.push(target);
  }
  return targets;
}

export function computeStepMilestones(days: readonly StepDay[], config: CharacterConfig): StepMilestones {
  const { steps } = config;
  const catalogue = stepMilestoneCatalogue(steps);
  const lifetimeNamed = new Map(catalogue.filter((entry) => entry.ladder === 'lifetime').map((entry) => [entry.target, entry]));
  const yearlyNamed = catalogue.filter((entry) => entry.ladder === 'yearly');

  // One value per date; a duplicate date keeps the last supplied one. Blank, negative or malformed rows add nothing.
  const byDate = new Map<string, number>();
  for (const day of days) {
    if (!day || typeof day.date !== 'string' || !CALENDAR_DATE.test(day.date)) continue;
    const value = day.steps;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    byDate.set(day.date, value);
  }

  const earnedIds = new Set<string>();
  const earned: EarnedStepMilestone[] = [];
  const yearTotals = new Map<number, number>();
  let lifetime = 0;
  const earn = (definition: StepMilestoneDefinition, date: string, year: number | null): void => {
    const id = year === null ? definition.id : `${definition.id}-${year}`;
    if (earnedIds.has(id)) return;
    earnedIds.add(id);
    earned.push({ id, name: definition.name, category: definition.category, points: definition.points, ladder: definition.ladder, target: definition.target, earnedDate: date, year });
  };

  for (const date of [...byDate.keys()].sort()) {
    const value = byDate.get(date)!;
    lifetime += value;
    const year = Number(date.slice(0, 4));
    const yearTotal = (yearTotals.get(year) ?? 0) + value;
    yearTotals.set(year, yearTotal);
    for (const target of lifetimeTargets(lifetime, config)) earn(lifetimeNamed.get(target) ?? recurringStepMilestone(target, steps), date, null);
    for (const definition of yearlyNamed) if (yearTotal >= definition.target) earn(definition, date, year);
  }

  const lastNamed = steps.lifetime.at(-1) ?? 0;
  const nextTarget = steps.lifetime.find((target) => target > lifetime)
    ?? lastNamed + (Math.floor((lifetime - lastNamed) / steps.lifetimeEvery) + 1) * steps.lifetimeEvery;
  const nextDefinition = lifetimeNamed.get(nextTarget) ?? recurringStepMilestone(nextTarget, steps);

  return {
    earned,
    next: { id: nextDefinition.id, name: nextDefinition.name, current: lifetime, target: nextTarget },
    retroactiveSummary: earned.length === 0 ? null : { count: earned.length, firstYear: Number(earned[0]!.earnedDate.slice(0, 4)) },
  };
}
