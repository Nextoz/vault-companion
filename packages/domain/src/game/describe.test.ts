import { expect, it } from 'vitest';
import { characterConfig } from './config.ts';
import { describeAchievement } from './describe.ts';

const text = (id: string): string => describeAchievement(characterConfig.achievements.find(a => a.id === id)!, characterConfig);

it('writes one short sentence per achievement from its rule', () => {
  expect(text('first-steps')).toBe('Earn your first XP.');
  expect(text('quartermaster-tasks-10')).toBe('Complete 10 tasks.');
  expect(text('athletics-first')).toBe('Log 1 training session.');
  expect(text('rising-hero-20')).toBe('Reach level 20.');
  expect(text('athletics-rank-150')).toBe('Reach skill 150 in Athletics.');
  expect(text('athletics-rhythm-4')).toBe('Train at least once a week for 4 weeks in a row.');
  expect(text('renaissance')).toBe('Reach skill 75 in all 4 professions.');
  expect(text('deep-work')).toBe('Spend 45 minutes in one session.');
});

it('covers every catalogue entry with a sentence that ends in a full stop and stays short', () => {
  for (const a of characterConfig.achievements) {
    const line = describeAchievement(a, characterConfig);
    expect(line, a.id).toMatch(/^[A-Z].*\.$/);
    expect(line.length, a.id).toBeLessThanOrEqual(90);
  }
});
