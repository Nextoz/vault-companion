import type { GameAchievement, GameStepMilestones } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import {
  categoryPoints,
  createPinState,
  createToastState,
  displayName,
  displayPoints,
  formatStepMilestones,
  groupByCategory,
  isEarnedTile,
  isHiddenUnearned,
  progressText,
  totalPoints,
} from './achievements.ts';

const achievement = (over: Partial<GameAchievement>): GameAchievement => ({
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

describe('groupByCategory', () => {
  it('groups achievements by category with earned/total counts', () => {
    const list = [
      achievement({ id: 'a1', name: 'A1', category: 'General', earned: true }),
      achievement({ id: 'a2', name: 'A2', category: 'General', earned: false }),
      achievement({ id: 'a3', name: 'A3', category: 'Training', earned: true }),
    ];
    const groups = groupByCategory(list);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ category: 'General', earned: 1, total: 2 });
    expect(groups[1]).toMatchObject({ category: 'Training', earned: 1, total: 1 });
  });

  it('excludes feats from grouping', () => {
    const list = [
      achievement({ id: 'a1', category: 'General', type: 'one-off' }),
      achievement({ id: 'f1', category: 'Feats', type: 'feat' }),
    ];
    const groups = groupByCategory(list);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe('General');
  });

  it('sorts categories alphabetically', () => {
    const list = [
      achievement({ id: 'a1', category: 'Zebra' }),
      achievement({ id: 'a2', category: 'Alpha' }),
      achievement({ id: 'a3', category: 'Beta' }),
    ];
    const groups = groupByCategory(list);
    expect(groups.map((g) => g.category)).toEqual(['Alpha', 'Beta', 'Zebra']);
  });
});

describe('progressText', () => {
  it('returns null for earned achievements', () => {
    expect(progressText(achievement({ earned: true, progress: { current: 10, target: 10 } }))).toBeNull();
  });

  it('returns null for achievements without progress', () => {
    expect(progressText(achievement({ progress: null }))).toBeNull();
  });

  it('formats counter progress as current/target (percent%)', () => {
    const text = progressText(achievement({ type: 'counter', progress: { current: 18, target: 25 } }));
    expect(text).toBe('18/25 (72%)');
  });

  it('formats chain tier as tier/maxTier', () => {
    const text = progressText(achievement({ type: 'chain', tier: 2, progress: { current: 4, target: 7 } }));
    expect(text).toBe('2/3');
  });

  it('handles zero target without division', () => {
    const text = progressText(achievement({ progress: { current: 3, target: 0 } }));
    expect(text).toBe('3/0');
  });
});

describe('isHiddenUnearned', () => {
  it('is true when visible:false and not earned', () => {
    expect(isHiddenUnearned(achievement({ visible: false, earned: false }))).toBe(true);
  });

  it('is false when earned', () => {
    expect(isHiddenUnearned(achievement({ visible: false, earned: true }))).toBe(false);
  });

  it('is false when visible', () => {
    expect(isHiddenUnearned(achievement({ visible: true, earned: false }))).toBe(false);
  });
});

describe('featPoints', () => {
  it('always returns 0 for feats', () => {
    expect(displayPoints(achievement({ type: 'feat', points: 100 }))).toBe(0);
  });
});

describe('totalPoints', () => {
  it('sums points excluding feats', () => {
    const list = [
      achievement({ id: 'a1', points: 10, type: 'one-off' }),
      achievement({ id: 'a2', points: 20, type: 'counter' }),
      achievement({ id: 'f1', points: 100, type: 'feat' }),
    ];
    expect(totalPoints(list)).toBe(30);
  });

  it('returns 0 for empty list', () => {
    expect(totalPoints([])).toBe(0);
  });
});

describe('categoryPoints', () => {
  it('sums points for a specific category, excluding feats', () => {
    const list = [
      achievement({ id: 'a1', category: 'General', points: 10, type: 'one-off' }),
      achievement({ id: 'a2', category: 'General', points: 20, type: 'counter' }),
      achievement({ id: 'a3', category: 'Training', points: 15, type: 'one-off' }),
      achievement({ id: 'f1', category: 'General', points: 100, type: 'feat' }),
    ];
    expect(categoryPoints(list, 'General')).toBe(30);
    expect(categoryPoints(list, 'Training')).toBe(15);
  });
});

describe('createPinState', () => {
  it('adds pins up to the limit', () => {
    const state = createPinState([]);
    expect(state.addPin('a1', 3)).toEqual({ ok: true });
    expect(state.addPin('a2', 3)).toEqual({ ok: true });
    expect(state.addPin('a3', 3)).toEqual({ ok: true });
    expect(state.addPin('a4', 3)).toEqual({ ok: false, reason: 'You can pin up to 3 achievements.' });
  });

  it('allows re-adding existing pins', () => {
    const state = createPinState(['a1']);
    expect(state.addPin('a1', 3)).toEqual({ ok: true });
  });

  it('removes pins', () => {
    const state = createPinState(['a1', 'a2', 'a3']);
    expect(state.removePin('a2')).toEqual(['a1', 'a3']);
  });

  it('gets tracked achievements in pin order, filtering invalid ones', () => {
    const achievements = [
      achievement({ id: 'a1', name: 'A1', earned: false, visible: true, locked: false }),
      achievement({ id: 'a2', name: 'A2', earned: true, visible: true, locked: false }), // earned
      achievement({ id: 'a3', name: 'A3', earned: false, visible: false, locked: false }), // hidden
      achievement({ id: 'a4', name: 'A4', earned: false, visible: true, locked: false }),
    ];
    const state = createPinState(['a1', 'a2', 'a3', 'a4']);
    const tracked = state.getTracked(achievements, 3);
    expect(tracked.map((a) => a.id)).toEqual(['a1', 'a4']);
  });

  it('caps tracked at limit', () => {
    const achievements = [
      achievement({ id: 'a1', name: 'A1' }),
      achievement({ id: 'a2', name: 'A2' }),
      achievement({ id: 'a3', name: 'A3' }),
    ];
    const state = createPinState(['a1', 'a2', 'a3']);
    expect(state.getTracked(achievements, 2).map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('createToastState', () => {
  it('returns null when no new achievements', () => {
    const state = createToastState([]);
    const achievements = [achievement({ id: 'a1', earned: true, earnedDate: '2026-01-01' })];
    expect(state.getToasts(achievements, true)).toBeNull();
  });

  it('shows summary toast on first run', () => {
    const state = createToastState(['a1', 'a2', 'a3']);
    const achievements = [
      achievement({ id: 'a1', earned: true, earnedDate: '2024-05-15' }),
      achievement({ id: 'a2', earned: true, earnedDate: '2025-06-20' }),
      achievement({ id: 'a3', earned: true, earnedDate: '2026-01-10' }),
    ];
    const result = state.getToasts(achievements, false);
    expect(result).toMatchObject({ kind: 'summary', count: 3, firstYear: '2024' });
  });

  it('shows individual toasts (capped at 3) on subsequent runs', () => {
    const state = createToastState(['a1', 'a2', 'a3', 'a4', 'a5']);
    const achievements = Array.from({ length: 5 }, (_, i) =>
      achievement({ id: `a${i + 1}`, earned: true, earnedDate: '2026-01-01' }),
    );
    const result = state.getToasts(achievements, true);
    expect(result?.kind).toBe('individual');
    expect(result?.achievements).toHaveLength(3);
    expect(result?.achievements.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('marks achievements as seen', () => {
    const state = createToastState(['a1', 'a2', 'a3']);
    expect(state.markSeen(['a1', 'a3'])).toEqual(['a2']);
  });
});

describe('formatStepMilestones', () => {
  it('returns unavailable when milestones is null', () => {
    const view = formatStepMilestones(null);
    expect(view).toMatchObject({ available: false, earned: [], next: null });
  });

  it('formats next milestone with progress bar', () => {
    const milestones: GameStepMilestones = {
      earned: [],
      next: { id: 'n1', name: 'Next Goal', current: 12000, target: 12500 },
      retroactiveSummary: null,
    };
    const view = formatStepMilestones(milestones);
    expect(view.next).toMatchObject({
      id: 'n1',
      name: 'Next Goal',
      current: 12000,
      target: 12500,
      label: '12.0k / 12.5k',
      percent: 96,
    });
  });

  it('formats large targets with M suffix', () => {
    const milestones: GameStepMilestones = {
      earned: [],
      next: { id: 'n1', name: 'Marathon', current: 12000000, target: 12500000 },
      retroactiveSummary: null,
    };
    const view = formatStepMilestones(milestones);
    expect(view.next?.label).toBe('12.0M / 12.5M');
  });

  it('sorts earned milestones newest first', () => {
    const milestones: GameStepMilestones = {
      earned: [
        { id: 'e1', name: 'Old', category: 'Walking', points: 5, ladder: 'lifetime', target: 1000, earnedDate: '2024-01-01', year: 2024 },
        { id: 'e2', name: 'New', category: 'Walking', points: 10, ladder: 'lifetime', target: 2000, earnedDate: '2025-06-15', year: 2025 },
      ],
      next: null,
      retroactiveSummary: null,
    };
    const view = formatStepMilestones(milestones);
    expect(view.earned.map((e) => e.id)).toEqual(['e2', 'e1']);
  });

  it('includes retroactive summary', () => {
    const milestones: GameStepMilestones = {
      earned: [],
      next: null,
      retroactiveSummary: { count: 7, firstYear: 2024 },
    };
    const view = formatStepMilestones(milestones);
    expect(view.retroactiveSummary).toEqual({ count: 7, firstYear: 2024 });
  });
});

describe('displayName', () => {
  it('returns ??? for hidden unearned achievements', () => {
    expect(displayName(achievement({ visible: false, earned: false, name: 'Secret' }))).toBe('???');
  });

  it('returns the name for visible achievements', () => {
    expect(displayName(achievement({ name: 'Visible' }))).toBe('Visible');
  });

  it('returns the name for earned hidden achievements', () => {
    expect(displayName(achievement({ visible: false, earned: true, name: 'Revealed' }))).toBe('Revealed');
  });
});

describe('displayPoints', () => {
  it('returns 0 for hidden unearned achievements', () => {
    expect(displayPoints(achievement({ visible: false, earned: false, points: 50 }))).toBe(0);
  });

  it('returns 0 for feats', () => {
    expect(displayPoints(achievement({ type: 'feat', points: 100 }))).toBe(0);
  });

  it('returns actual points for normal achievements', () => {
    expect(displayPoints(achievement({ points: 25 }))).toBe(25);
  });
});

describe('isEarnedTile', () => {
  it('is true for earned achievements', () => {
    expect(isEarnedTile(achievement({ earned: true }))).toBe(true);
  });

  it('is false for unearned achievements', () => {
    expect(isEarnedTile(achievement({ earned: false }))).toBe(false);
  });
});