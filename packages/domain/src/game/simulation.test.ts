import { expect, it } from 'vitest';
import { characterConfig } from './config.ts';
import { computeCharacter } from './engine.ts';
import type { GameRecord } from './types.ts';

it('simulates twelve weeks of a synthetic default profile', () => {
  const records: GameRecord[] = [];
  const table: { week: number; XP: number; level: number; skills: string }[] = [];
  let journeymanWeek = 0;
  for (let week = 0; week < 12; week++) {
    for (let day = 0; day < 7; day++) {
      const date = new Date(Date.UTC(2026, 0, 5 + week * 7 + day)).toISOString().slice(0, 10);
      if ([0, 1, 3, 5].includes(day)) records.push({ source: 'training', date, time: '10:00', type: 'Run', distance: '3', duration: '30:00', weight: '', split: '', note: 'Synthetic session' });
      if ([0, 2, 4].includes(day)) records.push({ source: 'learning', date, kind: 'Reading', minutes: '20', score: '0', detail: 'Synthetic practice', topic: 'Example', note: '' });
      if (day < 5) for (let i = 0; i < 2; i++) records.push({ source: 'task', date, id: `task-${week}-${day}-${i}`, overdueDays: 0 });
      if ([2, 6].includes(day)) records.push({ source: 'library', date, id: `note-${week}-${day}` });
    }
    const today = new Date(Date.UTC(2026, 0, 11 + week * 7)).toISOString().slice(0, 10);
    const c = computeCharacter(records, characterConfig, today);
    if (!journeymanWeek && c.professions[0]!.skill >= 75) journeymanWeek = week + 1;
    table.push({ week: week + 1, XP: c.xp, level: c.level, skills: c.professions.map(p => p.skill).join('/') });
  }
  console.log(['week | XP | level | skills (Athletics/Scholar/Lorekeeper/Quartermaster)', ...table.map(r => `${r.week} | ${r.XP} | ${r.level} | ${r.skills}`)].join('\n'));
  expect(table.at(-1)!.level).toBeGreaterThanOrEqual(14);
  expect(table.at(-1)!.level).toBeLessThanOrEqual(16);
  expect(journeymanWeek).toBeGreaterThanOrEqual(4);
  expect(journeymanWeek).toBeLessThanOrEqual(6);
  expect(table.at(-1)!.XP).toBe(2916);
});
