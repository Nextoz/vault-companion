import type { GameAchievement, GameResponse } from '@vault-companion/contracts';

type GameStepMilestones = NonNullable<GameResponse['stepMilestones']>;
import { describe, expect, it } from 'vitest';
import {
  addPin,
  chainLabel,
  chainLength,
  detailProgress,
  displayName,
  displayPoints,
  featPoints,
  formatStepMilestones,
  groupByCategory,
  isHiddenUnearned,
  isPinned,
  pinLimitNote,
  planToasts,
  removePin,
  resolveTracked,
  seenKey,
  pinnedKey,
  stepNumber,
  summaryText,
  tileProgress,
  totalPoints,
} from './achievements.ts';

const achievement = (over: Partial<GameAchievement> = {}): GameAchievement => ({
  id: 'a',
  name: 'Test Achievement',
  category: 'General',
  type: 'one-off',
  points: 10,
  earned: false,
  earnedDate: null,
  visible: true,
  locked: false,
  lockedReason: null,
  chain: null,
  tier: null,
  progress: null,
  ...over,
});

const milestones = (over: Partial<GameStepMilestones> = {}): GameStepMilestones => ({
  earned: [],
  next: { id: 'n1', name: 'Next Goal', current: 12_000_000, target: 12_500_000 },
  retroactiveSummary: null,
  ...over,
});

describe('device keys', () => {
  it('scopes the seen and pinned keys by account, and has a fallback for a null account', () => {
    expect(seenKey('abc')).toBe('vc.achievements.seen.abc');
    expect(pinnedKey('abc')).toBe('vc.achievements.pinned.abc');
    expect(seenKey(null)).toBe('vc.achievements.seen.none');
  });
});

describe('groupByCategory', () => {
  it('counts earned / total per category, A-Z, and leaves feats out', () => {
    const groups = groupByCategory([
      achievement({ id: 'a1', category: 'General', earned: true }),
      achievement({ id: 'a2', category: 'General', earned: false }),
      achievement({ id: 'a3', category: 'Training', earned: true }),
      achievement({ id: 'f1', category: 'Feats', type: 'feat' }),
    ]);
    expect(groups.map((g) => [g.category, g.earned, g.total])).toEqual([['General', 1, 2], ['Training', 1, 1]]);
  });
});

describe('hidden mask', () => {
  it('is hidden only while unearned', () => {
    expect(isHiddenUnearned(achievement({ visible: false, earned: false }))).toBe(true);
    expect(isHiddenUnearned(achievement({ visible: false, earned: true }))).toBe(false);
    expect(isHiddenUnearned(achievement({ visible: true, earned: false }))).toBe(false);
  });

  it('shows ??? for a hidden unearned name, and the real name once earned', () => {
    expect(displayName(achievement({ visible: false, earned: false, name: 'Secret' }))).toBe('???');
    expect(displayName(achievement({ visible: false, earned: true, name: 'Revealed' }))).toBe('Revealed');
  });

  it('hides the points of a hidden unearned achievement', () => {
    expect(displayPoints(achievement({ visible: false, earned: false, points: 50 }))).toBe(0);
    expect(displayPoints(achievement({ points: 25 }))).toBe(25);
  });
});

describe('feat points', () => {
  it('is always zero, whatever the payload holds', () => {
    expect(featPoints()).toBe(0);
    expect(displayPoints(achievement({ type: 'feat', points: 100 }))).toBe(0);
  });
});

describe('totalPoints', () => {
  it('adds only earned, non-feat points', () => {
    expect(totalPoints([
      achievement({ id: 'a1', points: 10, earned: true }),
      achievement({ id: 'a2', points: 20, earned: false }),
      achievement({ id: 'f1', points: 100, earned: true, type: 'feat' }),
    ])).toBe(10);
  });
});

describe('chains', () => {
  const chain = [
    achievement({ id: 'c1', type: 'chain', chain: 'run', tier: 1, earned: true }),
    achievement({ id: 'c2', type: 'chain', chain: 'run', tier: 2, progress: { current: 4, target: 7 } }),
    achievement({ id: 'c3', type: 'chain', chain: 'run', tier: 3, visible: false }),
    achievement({ id: 'c4', type: 'chain', chain: 'run', tier: 4, visible: false }),
  ];

  it('measures a chain by the achievements sharing its id', () => {
    expect(chainLength(chain, 'run')).toBe(4);
  });

  it('labels the chain tier for the detail sheet', () => {
    expect(chainLabel(chain[1]!, chain)).toBe('chain 2 of 4');
    expect(chainLabel(chain[0]!, chain)).toBe('chain 1 of 4');
    expect(chainLabel(achievement(), chain)).toBeNull();
  });

  it('shows the tier as 2/4 on the tile, and nothing for masked or earned ones', () => {
    expect(tileProgress(chain[1]!, chain)).toBe('2/4');
    expect(tileProgress(chain[2]!, chain)).toBeNull();
    expect(tileProgress(chain[0]!, chain)).toBeNull();
  });
});

describe('tile progress', () => {
  it('shows a counter as a percent', () => {
    expect(tileProgress(achievement({ type: 'counter', progress: { current: 20, target: 25 } }), [])).toBe('80%');
  });

  it('never divides by a zero target', () => {
    expect(tileProgress(achievement({ progress: { current: 3, target: 0 } }), [])).toBe('3/0');
  });

  it('is null without progress', () => {
    expect(tileProgress(achievement(), [])).toBeNull();
  });
});

describe('detailProgress', () => {
  it('gives the bar fill and a current / target label', () => {
    expect(detailProgress(achievement({ progress: { current: 18, target: 25 } }))).toMatchObject({ percent: 72, label: '18 / 25' });
  });

  it('is null when earned or masked', () => {
    expect(detailProgress(achievement({ earned: true, progress: { current: 25, target: 25 } }))).toBeNull();
    expect(detailProgress(achievement({ visible: false, progress: { current: 1, target: 25 } }))).toBeNull();
  });
});

describe('pins', () => {
  it('adds in order and is idempotent for an existing pin', () => {
    expect(addPin([], 'a').pinnedIds).toEqual(['a']);
    expect(addPin(['a'], 'a').pinnedIds).toEqual(['a']);
    expect(isPinned(['a'], 'a')).toBe(true);
  });

  it('refuses a pin past the limit with a short note, keeping the existing pins', () => {
    const result = addPin(['a', 'b', 'c'], 'd', 3);
    if (result.ok) throw new Error('a fourth pin should be refused');
    expect(result.reason).toBe(pinLimitNote(3));
    expect(result.pinnedIds).toEqual(['a', 'b', 'c']);
  });

  it('removes exactly one pin', () => {
    expect(removePin(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('resolves pins in pin order, dropping missing or earned ones and capping the list', () => {
    const list = [
      achievement({ id: 'a', name: 'A' }),
      achievement({ id: 'b', name: 'B', earned: true, earnedDate: '2026-01-01' }),
      achievement({ id: 'c', name: 'C' }),
      achievement({ id: 'd', name: 'D' }),
      achievement({ id: 'e', name: 'E' }),
    ];
    expect(resolveTracked(['a', 'missing', 'b', 'c', 'd', 'e'], list, 3).map((a) => a.id)).toEqual(['a', 'c', 'd']);
    expect(resolveTracked([], list)).toEqual([]);
  });
});

describe('planToasts', () => {
  const earned = [
    achievement({ id: 'a1', earned: true, earnedDate: '2024-05-15' }),
    achievement({ id: 'a2', earned: true, earnedDate: '2025-06-20' }),
    achievement({ id: 'a3', earned: true, earnedDate: '2026-01-10' }),
  ];

  it('is silent when nothing is unseen', () => {
    expect(planToasts(earned, null, ['a1', 'a2', 'a3'])).toEqual({ kind: 'none' });
    expect(planToasts([achievement()], null, null)).toEqual({ kind: 'none' });
  });

  it('summarises a whole history on the first sighting and marks every earned id seen', () => {
    const plan = planToasts(earned, null, null);
    if (plan.kind !== 'summary') throw new Error('expected a summary plan');
    expect(plan.summary).toMatchObject({ count: 3, firstYear: 2024 });
    expect(plan.seenIds).toEqual(['a1', 'a2', 'a3']);
  });

  it('prefers retroactiveSummary for the first-run count and year', () => {
    const plan = planToasts(earned, milestones({ retroactiveSummary: { count: 7, firstYear: 2024 } }), null);
    if (plan.kind !== 'summary') throw new Error('expected a summary plan');
    expect(plan.summary).toMatchObject({ count: 7, firstYear: 2024 });
    expect(summaryText(plan.summary)).toBe('7 step milestones earned since 2024');
  });

  it('shows at most three individual toasts, newest first, and marks just those seen', () => {
    const many = [...earned, achievement({ id: 'a4', earned: true, earnedDate: '2026-06-20' }), achievement({ id: 'a5', earned: true, earnedDate: '2026-07-01' })];
    const plan = planToasts(many, null, ['a1']);
    if (plan.kind !== 'individual') throw new Error('expected individual toasts');
    expect(plan.items.map((item) => item.id)).toEqual(['a5', 'a4', 'a3']);
    expect(plan.seenIds).toEqual(['a5', 'a4', 'a3']);
  });
});

describe('toast text', () => {
  it('names the achievement and its points, and drops the points when masked', () => {
  });

  it('reads the summary with and without a year, singular and plural', () => {
    expect(summaryText({ count: 1, firstYear: 2024 })).toBe('1 step milestone earned since 2024');
    expect(summaryText({ count: 4, firstYear: null })).toBe('4 step milestones earned');
  });
});

describe('step milestones', () => {
  it('formats a step count with k / M suffixes', () => {
    expect(stepNumber(900)).toBe('900');
    expect(stepNumber(12_000)).toBe('12.0k');
    expect(stepNumber(12_500_000)).toBe('12.5M');
  });

  it('reads null milestones as unavailable', () => {
    expect(formatStepMilestones(null)).toMatchObject({ available: false, earned: [], next: null });
  });

  it('gives NEXT a clamped percent and a current / target label', () => {
    const view = formatStepMilestones(milestones());
    expect(view.next).toMatchObject({ percent: 96, label: '12.0M / 12.5M' });
  });

  it('sorts EARNED newest first and passes the retroactive summary through', () => {
    const view = formatStepMilestones(milestones({
      earned: [
        { id: 'e1', name: 'Old', category: 'Walking', points: 5, ladder: 'lifetime', target: 1000, earnedDate: '2024-01-01', year: null },
        { id: 'e2', name: 'New', category: 'Walking', points: 10, ladder: 'lifetime', target: 2000, earnedDate: '2025-06-15', year: null },
      ],
      retroactiveSummary: { count: 2, firstYear: 2024 },
    }));
    expect(view.earned.map((milestone) => milestone.id)).toEqual(['e2', 'e1']);
    expect(view.retroactiveSummary).toEqual({ count: 2, firstYear: 2024 });
  });
});
