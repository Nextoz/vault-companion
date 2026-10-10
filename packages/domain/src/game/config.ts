import { achievementCatalogue } from './catalogue.ts';
import type { CharacterConfig } from './types.ts';

export const characterConfig: CharacterConfig = {
  rulesVersion: 1,
  professions: [{ id: 'athletics', name: 'Athletics' }, { id: 'scholar', name: 'Scholar' }, { id: 'lorekeeper', name: 'Lorekeeper' }, { id: 'quartermaster', name: 'Quartermaster' }],
  sources: {
    training: { profession: 'athletics', enabled: true, identityField: 'type', baseXp: 30, dailyCap: 2, minutes: { field: 'duration', format: 'duration', after: 20, step: 5, xp: 1, maxBonus: 20 } },
    learning: { profession: 'scholar', enabled: true, identityField: 'kind', baseXp: 15, dailyCap: 3, minutes: { field: 'minutes', format: 'minutes', after: 0, step: 2, xp: 1, maxBonus: 15 } },
    library: { profession: 'lorekeeper', enabled: true, identityField: 'id', baseXp: 5, dailyCap: 5 },
    reflection: { profession: 'lorekeeper', enabled: false, identityField: 'id', baseXp: 25, dailyCap: 2 },
    task: { profession: 'quartermaster', enabled: true, identityField: 'id', baseXp: 3, dailyCap: 5, overdue: { field: 'overdueDays', days: 7, xp: 2, dailyCap: 3 } },
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
  titles: [{ level: 1, title: 'New Adventurer' }, { level: 10, title: 'Adventurer' }, { level: 30, title: 'Veteran' }, { level: 60, title: 'Seasoned Hero' }],
  dayOneDays: 7,
  achievements: achievementCatalogue,
};
