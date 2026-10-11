// GAM1-C: pure presentation helpers for Achievements. No React and no storage access.
// Every number is derived from the /api/game payload (contracts only).
import type { GameAchievement, GameStepMilestones } from '@vault-companion/contracts';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Grouped achievements with earned/total counts per category. */
export interface AchievementGroup {
  readonly category: string;
  readonly earned: number;
  readonly total: number;
  readonly achievements: readonly GameAchievement[];
}

/**
 * Group achievements by category, sorted alphabetically. Each group tracks earned/total counts.
 * Feats are excluded (they have their own section).
 */
export function groupByCategory(achievements: readonly GameAchievement[]): AchievementGroup[] {
  const groups = new Map<string, GameAchievement[]>();
  for (const a of achievements) {
    if (a.type === 'feat') continue;
    const list = groups.get(a.category) ?? [];
    list.push(a);
    groups.set(a.category, list);
  }
  const result: AchievementGroup[] = [];
  for (const [category, list] of groups) {
    const earned = list.filter((a) => a.earned).length;
    result.push({ category, earned, total: list.length, achievements: [...list] });
  }
  return result.sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Format progress text for an unearned achievement.
 * - counter/chain: "current/target" or "current/target (percent%)"
 * - chain with tier: "tier/M" where M is the chain length (inferred from tier max)
 */
export function progressText(achievement: GameAchievement): string | null {
  if (achievement.earned || !achievement.progress) return null;
  const { current, target } = achievement.progress;
  if (achievement.type === 'chain' && achievement.tier !== null) {
    // Chain tier display: find max tier from the chain (use tier + 1 as fallback)
    const maxTier = achievement.tier + 1;
    return `${achievement.tier}/${maxTier}`;
  }
  if (target > 0) {
    const percent = Math.round((current / target) * 100);
    return `${current}/${target} (${percent}%)`;
  }
  return `${current}/${target}`;
}

/** True if the achievement is hidden (visible:false) and unearned. */
export function isHiddenUnearned(achievement: GameAchievement): boolean {
  return !achievement.visible && !achievement.earned;
}

/**
 * Feats of Strength: always show 0 points regardless of the points field.
 * They never count toward any total.
 */
export function featPoints(feat: GameAchievement): number {
  return 0;
}

/** Total points from achievements (excludes feats). */
export function totalPoints(achievements: readonly GameAchievement[]): number {
  return achievements.filter((a) => a.type !== 'feat').reduce((sum, a) => sum + a.points, 0);
}

/** Category points (excludes feats). */
export function categoryPoints(achievements: readonly GameAchievement[], category: string): number {
  return achievements
    .filter((a) => a.type !== 'feat' && a.category === category)
    .reduce((sum, a) => sum + a.points, 0);
}

/** Pinned achievement management. */
export interface PinState {
  readonly pinnedIds: readonly string[];
  readonly addPin: (id: string, limit: number) => { ok: true } | { ok: false; reason: string };
  readonly removePin: (id: string) => readonly string[];
  readonly getTracked: (achievements: readonly GameAchievement[], limit: number) => readonly GameAchievement[];
}

/**
 * Create pin state management. Returns functions for add/remove/get.
 * Storage access is handled by the caller; this is pure logic.
 */
export function createPinState(pinnedIds: readonly string[]): PinState {
  const addPin = (id: string, limit: number): { ok: true } | { ok: false; reason: string } => {
    if (pinnedIds.includes(id)) {
      return { ok: true };
    }
    if (pinnedIds.length >= limit) {
      return { ok: false, reason: `You can pin up to ${limit} achievements.` };
    }
    return { ok: true };
  };

  const removePin = (id: string): readonly string[] => {
    return pinnedIds.filter((pid) => pid !== id);
  };

  const getTracked = (achievements: readonly GameAchievement[], limit: number): readonly GameAchievement[] => {
    // Filter to valid pins (exist and not earned), maintain order
    const achievementMap = new Map(achievements.map((a) => [a.id, a]));
    const valid = pinnedIds
      .map((id) => achievementMap.get(id))
      .filter((a): a is GameAchievement => a !== undefined && !a.earned && a.visible && !a.locked);
    return valid.slice(0, limit);
  };

  return { pinnedIds, addPin, removePin, getTracked };
}

/** Toast notification logic. */
export interface ToastState {
  readonly unseenIds: readonly string[];
  readonly getToasts: (achievements: readonly GameAchievement[], hasPriorSeen: boolean) => {
    kind: 'summary' | 'individual';
    count?: number;
    firstYear?: number;
    achievements: readonly GameAchievement[];
  } | null;
  readonly markSeen: (ids: readonly string[]) => readonly string[];
}

/**
 * Create toast state. unseenIds are achievement ids not yet shown to the user.
 * hasPriorSeen: true if the user has any seen record (not first run).
 */
export function createToastState(unseenIds: readonly string[]): ToastState {
  const getToasts = (
    achievements: readonly GameAchievement[],
    hasPriorSeen: boolean,
  ): { kind: 'summary' | 'individual'; count?: number; firstYear?: number; achievements: readonly GameAchievement[] } | null => {
    const earned = achievements.filter((a) => a.earned);
    const newlyEarned = earned.filter((a) => unseenIds.includes(a.id));

    if (newlyEarned.length === 0) {
      return null;
    }

    // First run: show summary toast with retroactive count
    if (!hasPriorSeen) {
      // Use retroactiveSummary from stepMilestones if available, otherwise count earned achievements
      const count = newlyEarned.length;
      const firstYear = earned.length > 0 ? earned[earned.length - 1]!.earnedDate?.slice(0, 4) : undefined;
      return { kind: 'summary', count, firstYear, achievements: newlyEarned };
    }

    // Subsequent runs: show individual toasts, capped at 3
    const capped = newlyEarned.slice(0, 3);
    return { kind: 'individual', achievements: capped };
  };

  const markSeen = (ids: readonly string[]): readonly string[] => {
    // Remove seen ids from unseen list
    const seenSet = new Set(ids);
    return unseenIds.filter((id) => !seenSet.has(id));
  };

  return { unseenIds, getToasts, markSeen };
}

/** Step milestone formatting. */
export interface StepMilestoneView {
  readonly earned: readonly GameStepMilestone[];
  readonly next: {
    readonly id: string;
    readonly name: string;
    readonly current: number;
    readonly target: number;
    readonly percent: number;
    readonly label: string;
  } | null;
  readonly retroactiveSummary: { readonly count: number; readonly firstYear: number } | null;
  readonly available: boolean;
}

/**
 * Format step milestones for display.
 * - next: progress bar with current/target (e.g., "12.0 / 12.5M")
 * - earned: newest first, with dates and points
 * - available: false when stepMilestones is null
 */
export function formatStepMilestones(milestones: GameStepMilestones | null): StepMilestoneView {
  if (!milestones) {
    return { earned: [], next: null, retroactiveSummary: null, available: false };
  }

  const { earned, next, retroactiveSummary } = milestones;

  // Sort earned newest first
  const sortedEarned = [...earned].sort((a, b) => b.earnedDate.localeCompare(a.earnedDate));

  // Format next milestone
  let nextView: StepMilestoneView['next'] = null;
  if (next) {
    const { current, target } = next;
    const percent = target > 0 ? clamp((current / target) * 100, 0, 100) : 0;
    // Format target with M suffix if >= 1000
    const formatNumber = (n: number): string => {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
      return n.toString();
    };
    const label = `${formatNumber(current)} / ${formatNumber(target)}`;
    nextView = { ...next, percent, label };
  }

  return {
    earned: sortedEarned,
    next: nextView,
    retroactiveSummary: retroactiveSummary,
    available: true,
  };
}

/**
 * Determine if an achievement tile is "earned" looking.
 * Earned tiles look different from unearned ones.
 */
export function isEarnedTile(achievement: GameAchievement): boolean {
  return achievement.earned;
}

/**
 * Get the display name for an achievement.
 * Hidden unearned achievements show as '???'.
 */
export function displayName(achievement: GameAchievement): string {
  return isHiddenUnearned(achievement) ? '???' : achievement.name;
}

/**
 * Get the display points for an achievement.
 * Hidden unearned and feats show as '0 pts' or no points.
 */
export function displayPoints(achievement: GameAchievement): number {
  if (isHiddenUnearned(achievement)) return 0;
  if (achievement.type === 'feat') return 0;
  return achievement.points;
}