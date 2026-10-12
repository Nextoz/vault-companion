import type { GameAchievement } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { GameResponse } from '@vault-companion/contracts';
import {
  ACHIEVEMENT_CAP, celebratedIds, diffRewards, earnedByText, isComplete, newlyEarnedIds, nextBaseline, skillText, titleSeenId, withoutCelebrated, xpText,
} from './rewards.ts';

const achievement = (id: string, over: Partial<GameAchievement> = {}): GameAchievement => ({
  id, name: id, category: 'quartermaster', type: 'one-off', points: 10, earned: false, earnedDate: null, visible: true,
  locked: false, lockedReason: null, chain: null, tier: null, progress: null, ...over,
});

const profession = (id: string, skill: number, rank = 'Apprentice') => ({ id, name: id[0]!.toUpperCase() + id.slice(1), xp: skill * 6, skill, rank, title: `${rank} ${id}` });

function game(over: { revision?: string; xp?: number; level?: number; title?: string; criticals?: number; earned?: string[]; skill?: number; rank?: string; rulesVersion?: number; extra?: GameAchievement[] } = {}): GameResponse {
  const earned = new Set(over.earned ?? []);
  const list = [achievement('tasks-10'), achievement('tasks-50', { points: 25 }), achievement('meta-one', { type: 'meta', points: 10 }), achievement('secret', { type: 'hidden', visible: false, name: '???' }), ...(over.extra ?? [])]
    .map((a) => earned.has(a.id) ? { ...a, earned: true, earnedDate: '2026-10-11', name: a.id } : a);
  return {
    revision: (over.revision ?? 'a').repeat(40), now: '2026-10-11T10:00:00.000Z',
    character: {
      rulesVersion: over.rulesVersion ?? 2, xp: over.xp ?? 100, level: over.level ?? 2, levelXp: 0, levelCost: 115, restedXp: 0,
      title: over.title ?? 'New Adventurer', professions: [profession('quartermaster', over.skill ?? 10, over.rank)],
      achievements: list, feats: [], points: { total: 0, byCategory: {} }, skippedRecords: 0,
    },
    rules: { rulesVersion: 2, professions: [], sources: [], skill: { max: 300, baseCost: 5, step: 10 }, ranks: [], level: { min: 1, max: 60, baseCost: 100, costStep: 15 }, rested: { perDay: 15, max: 150, multiplier: 0.5 }, titles: [] },
    stepMilestones: null, unavailable: [],
    feedback: {
      criticals: over.criticals ?? 0, critical: { every: 8, multiplier: 2 },
      achievements: { 'tasks-10': { description: 'Complete 10 tasks.', earnedBy: earned.has('tasks-10') ? 'Completing a task' : null } },
    },
  };
}

describe('diffRewards', () => {
  it('announces XP, a skill up, the achievement, a new title and the level up in that order', () => {
    const before = game();
    const after = game({ revision: 'b', xp: 106, level: 3, title: 'Adventurer', criticals: 1, earned: ['tasks-10'], skill: 11 });
    expect(diffRewards(before, after).map((e) => e.kind)).toEqual(['xp', 'skill', 'achievement', 'level']);
    expect(diffRewards(before, after)[0]).toEqual({ kind: 'xp', amount: 6, criticals: 1 });
    expect(diffRewards(before, after)[2]).toMatchObject({ name: 'tasks-10', description: 'Complete 10 tasks.', earnedBy: 'Completing a task', major: false });
    expect(diffRewards(before, after).at(-1)).toEqual({ kind: 'level', level: 3, nextCost: 115, title: 'Adventurer' });
  });

  it('puts the major achievement last and announces a profession rank as a title', () => {
    const extra = [achievement('big', { points: 50 }), achievement('small', { points: 5 })];
    const events = diffRewards(game({ extra }), game({ revision: 'b', xp: 110, earned: ['big', 'small'], skill: 76, rank: 'Journeyman', extra }));
    expect(events.filter((e) => e.kind === 'achievement').map((e) => e.kind === 'achievement' && e.id)).toEqual(['small', 'big']);
    expect(events.at(-1)).toEqual({ kind: 'title', title: 'Journeyman quartermaster' });
  });

  it('caps banners, keeps the major one, and marks every newly earned id', () => {
    const extra = [achievement('major', { points: 50 }), ...Array.from({ length: 5 }, (_, i) => achievement(`x${i}`))];
    const after = game({ revision: 'b', xp: 103, earned: extra.map((a) => a.id), extra });
    const banners = diffRewards(game({ extra }), after).filter((e) => e.kind === 'achievement');
    expect(banners).toHaveLength(ACHIEVEMENT_CAP);
    expect(banners.at(-1)).toMatchObject({ id: 'major', major: true });
    expect(newlyEarnedIds(game({ extra }), after)).toHaveLength(6);
  });

  it('says nothing for an unchanged revision, an Undo or a rules change', () => {
    expect(diffRewards(game(), game({ xp: 106 }))).toEqual([]);
    expect(diffRewards(game({ xp: 106 }), game({ revision: 'b', xp: 100 }))).toEqual([]);
    expect(diffRewards(game({ rulesVersion: 1 }), game({ revision: 'b', xp: 200, level: 3 }))).toEqual([]);
  });

  it('never claims a critical when either read lacks feedback (older Worker)', () => {
    const after = { ...game({ revision: 'b', xp: 106, criticals: 3 }) };
    const before = { ...game(), feedback: undefined };
    expect(diffRewards(before, after)[0]).toEqual({ kind: 'xp', amount: 6, criticals: 0 });
  });

  it('keeps a hidden achievement hidden until earned, then names it', () => {
    const events = diffRewards(game(), game({ revision: 'b', xp: 103, earned: ['secret'] }));
    expect(events.find((e) => e.kind === 'achievement')).toMatchObject({ id: 'secret', name: 'secret' });
  });
});

it('formats the lines', () => {
  expect(xpText({ kind: 'xp', amount: 3, criticals: 0 })).toBe('+3 XP');
  expect(xpText({ kind: 'xp', amount: 6, criticals: 1 })).toBe('Critical! +6 XP');
  expect(skillText({ kind: 'skill', profession: 'Quartermaster', skill: 76 })).toBe('Your skill in Quartermaster has increased to 76.');
  expect(earnedByText('Completing a task')).toBe('Earned by completing a task');
  expect(earnedByText(null)).toBeNull();
});

describe('guards around the diff', () => {
  it('never diffs a partial read and never lets it replace a complete baseline', () => {
    const complete = game();
    const partial = { ...game({ revision: 'b', xp: 40 }), unavailable: ['tasks'] };
    expect(isComplete(complete)).toBe(true);
    expect(isComplete({ ...complete, unavailable: ['health'] })).toBe(true);
    expect(isComplete(partial)).toBe(false);
    expect(nextBaseline(complete, partial)).toEqual({ baseline: complete, diff: false });
    expect(nextBaseline(partial, complete)).toEqual({ baseline: complete, diff: false });
    expect(nextBaseline(null, complete)).toEqual({ baseline: complete, diff: false });
    const next = game({ revision: 'c', xp: 106 });
    expect(nextBaseline(complete, next)).toEqual({ baseline: next, diff: true });
  });

  it('drops achievements, titles and levels already celebrated (Undo then redo)', () => {
    const events = diffRewards(game(), game({ revision: 'b', xp: 106, level: 3, earned: ['tasks-10'], skill: 76, rank: 'Journeyman' }));
    const seen = celebratedIds(events);
    expect(seen).toEqual(['tasks-10', titleSeenId('Journeyman quartermaster')]);
    expect(withoutCelebrated(events, seen, 3).map((e) => e.kind)).toEqual(['xp', 'skill']);
    expect(withoutCelebrated(events, [], 2).map((e) => e.kind)).toEqual(events.map((e) => e.kind));
    expect(withoutCelebrated(events, [], null).some((e) => e.kind === 'level')).toBe(true);
  });

  it('an installed older client (no feedback in its schema) still parses a new payload', () => {
    const olderClient = GameResponse.omit({ feedback: true }).strip();
    const parsed = olderClient.parse(game());
    expect('feedback' in parsed).toBe(false);
  });
});
