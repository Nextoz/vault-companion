import type { GameAchievement, GameRules } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import {
  emptyCharacterLine, howXpWorks, levelCostAt, levelExamples, levelLabel, professionUnavailable, recentlyEarned,
  professionLine, restedSegment, shortDate, skillLabel, skillPercent, sourceLabel, trackedAchievements, unavailableLines, xpBar,
} from './character.ts';

/** Distinctive synthetic values so a hard-coded page (the real config) would fail every assertion below. */
const rules = (over: Partial<GameRules> = {}): GameRules => ({
  rulesVersion: 7,
  professions: [
    { id: 'athletics', name: 'Sports' }, { id: 'scholar', name: 'Study' },
    { id: 'lorekeeper', name: 'Archive' }, { id: 'quartermaster', name: 'Errands' },
  ],
  sources: [
    { id: 'training', profession: 'athletics', enabled: true, baseXp: 77, dailyCap: 9, minutes: { after: 11, step: 3, xp: 2, maxBonus: 44 }, overdue: null },
    { id: 'learning', profession: 'scholar', enabled: true, baseXp: 12, dailyCap: 4, minutes: { after: 0, step: 6, xp: 1, maxBonus: 8 }, overdue: null },
    { id: 'task', profession: 'quartermaster', enabled: true, baseXp: 5, dailyCap: 6, minutes: null, overdue: { days: 13, xp: 4, dailyCap: 2 } },
    { id: 'reflection', profession: 'lorekeeper', enabled: false, baseXp: 1, dailyCap: 1, minutes: null, overdue: null },
  ],
  skill: { max: 111, baseCost: 22, step: 7 },
  ranks: [{ skill: 0, name: 'Novice', title: 'Novice {profession}' }, { skill: 55, name: 'Adept', title: 'Adept {profession}' }],
  level: { min: 1, max: 11, baseCost: 111, costStep: 13 },
  rested: { perDay: 9, max: 90, multiplier: 0.25 },
  titles: [{ level: 1, title: 'Rookie' }],
  ...over,
});

const achievement = (over: Partial<GameAchievement>): GameAchievement => ({
  id: 'a', name: 'An achievement', category: 'General', type: 'one-off', points: 10,
  earned: true, earnedDate: '2026-01-01', visible: true, locked: false, lockedReason: null,
  chain: null, tier: null, progress: null, ...over,
});

describe('xpBar', () => {
  it('is a 0..100 percentage of the level cost', () => {
    expect(xpBar(50, 200).percent).toBe(25);
    expect(xpBar(0, 200).percent).toBe(0);
    expect(xpBar(999, 200).percent).toBe(100);
  });

  it('never divides by zero at maximum level; the bar reads full and maxed', () => {
    const bar = xpBar(0, 0);
    expect(bar.maxed).toBe(true);
    expect(bar.percent).toBe(100);
    expect(Number.isNaN(bar.percent)).toBe(false);
  });
});

describe('restedSegment', () => {
  it('starts at the fill and spans up to the level cost, never past the end', () => {
    expect(restedSegment(50, 200, 40)).toEqual({ start: 25, width: 20 });
    expect(restedSegment(50, 200, 10_000)).toEqual({ start: 25, width: 75 });
  });

  it('is empty at maximum level', () => {
    expect(restedSegment(0, 0, 130)).toEqual({ start: 100, width: 0 });
  });
});

describe('skillPercent and skillLabel', () => {
  it('uses the live cap and clamps', () => {
    expect(skillPercent(55, 111)).toBeCloseTo(49.55, 2);
    expect(skillPercent(999, 111)).toBe(100);
    expect(skillPercent(5, 0)).toBe(0);
    expect(skillLabel(55, rules())).toBe('55/111');
  });

  it('builds the rank line from the live cap and the profession', () => {
    const profession = { id: 'athletics', name: 'Sports', xp: 900, skill: 55, rank: 'Adept', title: 'Adept Sports' };
    expect(professionLine(profession, rules())).toBe('Adept · 55/111 · 900 XP');
  });
});

describe('levelLabel', () => {
  it('shows xp / cost, and "Max level" when there is no next level', () => {
    expect(levelLabel(50, 200)).toBe('50 / 200 XP');
    expect(levelLabel(0, 0)).toBe('Max level');
  });
});

describe('emptyCharacterLine', () => {
  it('names the fresh-character empty state and stays silent once anything is earned', () => {
    expect(emptyCharacterLine({ level: 1, xp: 0 })).toBe('No XP yet - log a session to begin');
    expect(emptyCharacterLine({ level: 1, xp: 5 })).toBeNull();
    expect(emptyCharacterLine({ level: 2, xp: 0 })).toBeNull();
  });
});

describe('unavailable sources', () => {
  it('names the failed source on the right profession, never a zero', () => {
    expect(professionUnavailable('athletics', ['training'])).toBe('Training unavailable');
    expect(professionUnavailable('scholar', ['learning'])).toBe('Learning unavailable');
    expect(professionUnavailable('lorekeeper', ['library'])).toBe('Library unavailable');
    expect(professionUnavailable('quartermaster', ['tasks'])).toBe('Tasks unavailable');
    expect(professionUnavailable('quartermaster', ['training'])).toBeNull();
    expect(professionUnavailable('unknown', ['training'])).toBeNull();
  });

  it('labels every named source and the source list', () => {
    expect(unavailableLines(['training', 'learning', 'library', 'tasks', 'health']))
      .toEqual(['Training unavailable', 'Learning unavailable', 'Library unavailable', 'Tasks unavailable', 'Health unavailable']);
    expect(sourceLabel('tasks')).toBe('Tasks');
  });
});

describe('recentlyEarned', () => {
  it('keeps only earned, dated achievements, newest first, capped at three', () => {
    const list = [
      achievement({ id: 'old', name: 'Old', earnedDate: '2026-01-01' }),
      achievement({ id: 'new', name: 'New', earnedDate: '2026-03-01' }),
      achievement({ id: 'mid', name: 'Mid', earnedDate: '2026-02-01' }),
      achievement({ id: 'later', name: 'Later', earnedDate: '2026-04-01' }),
      achievement({ id: 'unearned', name: 'Unearned', earned: false, earnedDate: null }),
      achievement({ id: 'undated', name: 'Undated', earnedDate: null }),
    ];
    expect(recentlyEarned(list).map((a) => a.id)).toEqual(['later', 'new', 'mid']);
    expect(recentlyEarned(list)).toHaveLength(3);
  });
});

describe('level curve', () => {
  it('derives the cost from base cost, step and the minimum level', () => {
    expect(levelCostAt(1, rules())).toBe(111);
    expect(levelCostAt(5, rules())).toBe(111 + 13 * 4);
    const examples = levelExamples(rules());
    expect(examples[0]).toEqual({ level: 1, cost: 111 });
    expect(examples.at(-1)!.level).toBe(10);
    expect(examples.at(-1)!.cost).toBe(111 + 13 * 9);
  });
});

describe('howXpWorks', () => {
  it('prints every rule value from the data, not the real config', () => {
    const text = howXpWorks(rules()).flatMap((section) => [section.heading, ...section.lines]).join('\n');
    for (const value of ['77', '9', '12', '111', '13', '22', '7', '25', '44', 'Novice', 'Adept', 'not active']) {
      expect(text).toContain(value);
    }
    // The real config's values/rank names never appear: the page renders from the payload it is given.
    for (const literal of ['Apprentice', 'New Adventurer', '300', '60']) {
      expect(text).not.toContain(literal);
    }
  });

  it('changes when a rule value changes, so the page cannot be hard-coded', () => {
    const before = JSON.stringify(howXpWorks(rules()));
    const after = JSON.stringify(howXpWorks(rules({ level: { min: 1, max: 11, baseCost: 222, costStep: 13 } })));
    expect(after).not.toBe(before);
    expect(after).toContain('222');
  });
});

/** An achievement still in progress (the fixture default is earned). */
const pending = (over: Partial<GameAchievement>): GameAchievement => achievement({ earned: false, earnedDate: null, ...over });

describe('trackedAchievements', () => {
  it('keeps visible, unlocked, unearned achievements with progress, closest to done first', () => {
    const list = [
      pending({ id: 'far', name: 'Far', progress: { current: 1, target: 10 } }),
      pending({ id: 'near', name: 'Near', progress: { current: 9, target: 10 } }),
      achievement({ id: 'done', name: 'Done', earned: true, earnedDate: '2026-09-01', progress: { current: 10, target: 10 } }),
      pending({ id: 'hidden', name: 'Hidden', visible: false, progress: { current: 5, target: 10 } }),
      pending({ id: 'locked', name: 'Locked', locked: true, progress: { current: 5, target: 10 } }),
      pending({ id: 'plain', name: 'Plain', progress: null }),
      pending({ id: 'zero', name: 'Zero', progress: { current: 3, target: 0 } }),
    ];
    expect(trackedAchievements(list).map((t) => t.id)).toEqual(['near', 'far']);
    expect(trackedAchievements(list)[0]).toMatchObject({ current: 9, target: 10, percent: 90 });
  });

  it('clamps overshoot, breaks ties by name and caps the list', () => {
    const list = ['C', 'A', 'B', 'D'].map((name) => pending({ id: name, name, progress: { current: 3, target: 6 } }));
    list.push(pending({ id: 'over', name: 'Over', progress: { current: 12, target: 6 } }));
    expect(trackedAchievements(list).map((t) => t.id)).toEqual(['over', 'A', 'B']);
    expect(trackedAchievements(list)[0]!.percent).toBe(100);
  });
});

describe('shortDate', () => {
  it('drops the year in the current year and keeps it otherwise', () => {
    expect(shortDate('2026-09-02', '2026-10-11')).toBe('2 Sep');
    expect(shortDate('2025-12-31', '2026-10-11')).toBe('31 Dec 2025');
  });

  it('returns anything that is not a calendar date unchanged', () => {
    expect(shortDate('', '2026-10-11')).toBe('');
    expect(shortDate('soon', '2026-10-11')).toBe('soon');
  });
});
