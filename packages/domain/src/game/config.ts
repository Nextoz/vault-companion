import { achievementCatalogue } from './catalogue.ts';
import type { CharacterConfig } from './types.ts';

export const characterConfig: CharacterConfig = {
  // v3 (owner, 23 Oct 2026): dictation (learning) pays like a gym session, tasks pay more with a higher cap, and a
  // finished Active Work item is its own "quest" source.
  rulesVersion: 3,
  professions: [{ id: 'athletics', name: 'Athletics' }, { id: 'scholar', name: 'Scholar' }, { id: 'lorekeeper', name: 'Lorekeeper' }, { id: 'quartermaster', name: 'Quartermaster' }],
  sources: {
    training: { profession: 'athletics', enabled: true, identityField: 'type', baseXp: 30, dailyCap: 2, minutes: { field: 'duration', format: 'duration', after: 20, step: 5, xp: 1, maxBonus: 20 } },
    learning: { profession: 'scholar', enabled: true, identityField: 'kind', baseXp: 40, dailyCap: 3, minutes: { field: 'minutes', format: 'minutes', after: 0, step: 2, xp: 1, maxBonus: 20 } },
    library: { profession: 'lorekeeper', enabled: true, identityField: 'id', baseXp: 5, dailyCap: 5 },
    reflection: { profession: 'lorekeeper', enabled: true, identityField: 'id', baseXp: 25, dailyCap: 2 },
    task: { profession: 'quartermaster', enabled: true, identityField: 'id', baseXp: 5, dailyCap: 10, overdue: { field: 'overdueDays', days: 7, xp: 2, dailyCap: 3 } },
    quest: { profession: 'quartermaster', enabled: true, identityField: 'id', baseXp: 20, dailyCap: 3 },
  },
  // Journey step milestones (owner decision 10 Oct 2026): achievements with points, never XP. Thresholds only here.
  steps: {
    lifetime: [100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 7_500_000, 10_000_000],
    lifetimeEvery: 2_500_000,
    yearly: [1_000_000, 2_000_000, 3_000_000, 4_000_000],
    points: { lifetime: [5, 10, 10, 25, 25, 50, 50, 50], recurring: 50, yearly: [10, 25, 50, 50] },
  },
  skill: { max: 300, baseCost: 5, step: 10 },
  ranks: [
    { skill: 0, name: 'Apprentice', title: 'Apprentice {profession}' },
    { skill: 75, name: 'Journeyman', title: 'Journeyman of {profession}' },
    { skill: 150, name: 'Expert', title: 'Expert {profession}' },
    { skill: 225, name: 'Artisan', title: 'Artisan {profession}' },
    { skill: 300, name: 'Master', title: 'Master {profession}' },
  ],
  level: { min: 1, max: 60, baseCost: 100, costStep: 15 },
  rested: { perDay: 15, max: 150, multiplier: 0.5 },
  // ADR-0064: about one capped award in eight is a "Critical!" with double base XP (rested applies on top).
  critical: { every: 8, multiplier: 2 },
  titles: [{ level: 1, title: 'New Adventurer' }, { level: 10, title: 'Adventurer' }, { level: 30, title: 'Veteran' }, { level: 60, title: 'Seasoned Hero' }],
  dayOneDays: 7,
  achievements: achievementCatalogue,
};
