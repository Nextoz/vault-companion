// GAM1-C: pure presentation helpers for the Achievements page, the badge detail and the toast. No React and
// no storage access: every value is derived from the /api/game payload (contracts only), so a screen cannot drift.
import type { GameAchievement, GameResponse } from '@vault-companion/contracts';

/** The step-milestone shapes live in the game payload; derive them here so the module adds no runtime import. */
type GameStepMilestones = NonNullable<GameResponse['stepMilestones']>;
type GameStepMilestone = GameStepMilestones['earned'][number];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Device keys, scoped by account so two accounts on one device never share pins or seen ids. */
export const seenKey = (account: string | null): string => `vc.achievements.seen.${account ?? 'none'}`;
export const pinnedKey = (account: string | null): string => `vc.achievements.pinned.${account ?? 'none'}`;

export const PIN_LIMIT = 3;
export const pinLimitNote = (limit: number): string => `You can pin up to ${limit} achievements.`;

// ---- grouping and counters ----------------------------------------------------------------------------------
export interface AchievementGroup {
  readonly category: string;
  readonly earned: number;
  readonly total: number;
  readonly achievements: readonly GameAchievement[];
}

/** Group the achievements by category (feats have their own section) with earned/total counters, A-Z. */
export function groupByCategory(achievements: readonly GameAchievement[]): AchievementGroup[] {
  const groups = new Map<string, GameAchievement[]>();
  for (const a of achievements) {
    if (a.type === 'feat') continue;
    const list = groups.get(a.category);
    if (list) list.push(a);
    else groups.set(a.category, [a]);
  }
  return [...groups.entries()]
    .map(([category, list]) => ({ category, earned: list.filter((a) => a.earned).length, total: list.length, achievements: [...list] }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

// ---- hidden mask, feats and points --------------------------------------------------------------------------
/** A hidden, unearned achievement: its name, points and progress are all masked. */
export function isHiddenUnearned(achievement: GameAchievement): boolean {
  return !achievement.visible && !achievement.earned;
}

export function displayName(achievement: GameAchievement): string {
  return isHiddenUnearned(achievement) ? '???' : achievement.name;
}

/** Feats of Strength are worth 0 points, whatever the payload holds, and count toward no total. */
export function featPoints(): number {
  return 0;
}

export function displayPoints(achievement: GameAchievement): number {
  if (achievement.type === 'feat' || isHiddenUnearned(achievement)) return 0;
  return achievement.points;
}

/** The header total: earned (non-feat) points only, exactly like `character.points.total`. */
export function totalPoints(achievements: readonly GameAchievement[]): number {
  return achievements.reduce((sum, a) => (a.earned && a.type !== 'feat' ? sum + a.points : sum), 0);
}

// ---- chains and tile progress -------------------------------------------------------------------------------
/** How many tiers a chain has: the number of achievements sharing its `chain` id. */
export function chainLength(achievements: readonly GameAchievement[], chain: string): number {
  return achievements.filter((a) => a.chain === chain).length;
}

/** "chain 2 of 4" for the detail sheet; null when the achievement is not part of a chain. */
export function chainLabel(achievement: GameAchievement, achievements: readonly GameAchievement[]): string | null {
  if (achievement.type !== 'chain' || achievement.chain === null || achievement.tier === null) return null;
  return `chain ${achievement.tier} of ${chainLength(achievements, achievement.chain)}`;
}

/** The tile's one-line progress: a chain shows its tier (`2/4`), a counter its percent, nothing when masked/earned. */
export function tileProgress(achievement: GameAchievement, achievements: readonly GameAchievement[]): string | null {
  if (achievement.earned || isHiddenUnearned(achievement)) return null;
  if (achievement.type === 'chain' && achievement.chain !== null && achievement.tier !== null) {
    return `${achievement.tier}/${chainLength(achievements, achievement.chain)}`;
  }
  if (achievement.progress) {
    const { current, target } = achievement.progress;
    return target > 0 ? `${Math.round((current / target) * 100)}%` : `${current}/${target}`;
  }
  return null;
}

export interface DetailProgress {
  readonly current: number;
  readonly target: number;
  readonly percent: number;
  readonly label: string;
}

/** The detail sheet's progress bar: current/target as a 0..100% fill, null when earned/masked/without progress. */
export function detailProgress(achievement: GameAchievement): DetailProgress | null {
  if (achievement.earned || isHiddenUnearned(achievement) || !achievement.progress) return null;
  const { current, target } = achievement.progress;
  return { current, target, percent: target > 0 ? clamp((current / target) * 100, 0, 100) : 0, label: `${current} / ${target}` };
}

// ---- pinned achievements ------------------------------------------------------------------------------------
export function isPinned(pinnedIds: readonly string[], id: string): boolean {
  return pinnedIds.includes(id);
}

export type AddPinResult =
  | { readonly ok: true; readonly pinnedIds: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly pinnedIds: readonly string[] };

/** Pin one more: idempotent for an already-pinned id, refused (with a short note) once the limit is reached. */
export function addPin(pinnedIds: readonly string[], id: string, limit = PIN_LIMIT): AddPinResult {
  if (pinnedIds.includes(id)) return { ok: true, pinnedIds };
  if (pinnedIds.length >= limit) return { ok: false, reason: pinLimitNote(limit), pinnedIds };
  return { ok: true, pinnedIds: [...pinnedIds, id] };
}

export function removePin(pinnedIds: readonly string[], id: string): readonly string[] {
  return pinnedIds.filter((pinned) => pinned !== id);
}

/** The Tracked list for pins: pin order, capped, with a missing or already-earned pin dropped. */
export function resolveTracked(pinnedIds: readonly string[], achievements: readonly GameAchievement[], limit = PIN_LIMIT): readonly GameAchievement[] {
  const byId = new Map(achievements.map((a) => [a.id, a]));
  const rows: GameAchievement[] = [];
  for (const id of pinnedIds) {
    const achievement = byId.get(id);
    if (achievement && !achievement.earned) rows.push(achievement);
  }
  return rows.slice(0, limit);
}

// ---- toast selection ----------------------------------------------------------------------------------------
export interface ToastItem {
  readonly id: string;
  readonly name: string;
  readonly points: number;
  readonly hidden: boolean;
}

export interface SummaryToast {
  readonly count: number;
  readonly firstYear: number | null;
}

export type ToastPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'summary'; readonly summary: SummaryToast; readonly seenIds: readonly string[] }
  | { readonly kind: 'individual'; readonly items: readonly ToastItem[]; readonly seenIds: readonly string[] };

const toastItem = (achievement: GameAchievement): ToastItem => ({
  id: achievement.id,
  name: displayName(achievement),
  points: displayPoints(achievement),
  hidden: isHiddenUnearned(achievement),
});

const newestFirst = (achievements: readonly GameAchievement[]): GameAchievement[] =>
  [...achievements].sort((a, b) => (b.earnedDate ?? '').localeCompare(a.earnedDate ?? '') || a.name.localeCompare(b.name));

/**
 * What to announce after a /api/game load. `seen` is null when the device holds no seen record at all: then the
 * whole history is one summary (retroactiveSummary's count, or the earned-achievement count as a fallback) and every
 * earned id is marked seen. With a seen record, only the newest up to three unseen earned achievements are returned.
 */
export function planToasts(
  achievements: readonly GameAchievement[],
  milestones: GameStepMilestones | null,
  seen: readonly string[] | null,
): ToastPlan {
  const earned = achievements.filter((a) => a.earned);
  if (seen === null) {
    const retroactive = milestones?.retroactiveSummary ?? null;
    const count = retroactive ? retroactive.count : earned.length;
    if (count === 0) return { kind: 'none' };
    const years = earned.map((a) => Number((a.earnedDate ?? '').slice(0, 4))).filter((year) => Number.isFinite(year) && year > 0);
    const firstYear = retroactive ? retroactive.firstYear : years.length > 0 ? Math.min(...years) : null;
    return { kind: 'summary', summary: { count, firstYear }, seenIds: earned.map((a) => a.id) };
  }
  const unseen = newestFirst(earned.filter((a) => !seen.includes(a.id)));
  if (unseen.length === 0) return { kind: 'none' };
  const items = unseen.slice(0, 3).map(toastItem);
  return { kind: 'individual', items, seenIds: items.map((item) => item.id) };
}

/** "7 step milestones earned since 2024"; the year is dropped when there is none. */
export function summaryText(summary: SummaryToast): string {
  const many = `${summary.count} step milestone${summary.count === 1 ? '' : 's'}`;
  return summary.firstYear === null ? `${many} earned` : `${many} earned since ${summary.firstYear}`;
}

// ---- step milestones ----------------------------------------------------------------------------------------
export function stepNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export interface StepMilestoneView {
  readonly available: boolean;
  readonly earned: readonly GameStepMilestone[];
  readonly next: { readonly id: string; readonly name: string; readonly current: number; readonly target: number; readonly percent: number; readonly label: string } | null;
  readonly retroactiveSummary: GameStepMilestones['retroactiveSummary'];
}

/** The Walking section: NEXT as a progress bar and EARNED newest first. Null milestones read as unavailable. */
export function formatStepMilestones(milestones: GameStepMilestones | null): StepMilestoneView {
  if (milestones === null) return { available: false, earned: [], next: null, retroactiveSummary: null };
  const next = milestones.next;
  return {
    available: true,
    earned: [...milestones.earned].sort((a, b) => b.earnedDate.localeCompare(a.earnedDate) || a.name.localeCompare(b.name)),
    next: next
      ? { ...next, percent: next.target > 0 ? clamp((next.current / next.target) * 100, 0, 100) : 0, label: `${stepNumber(next.current)} / ${stepNumber(next.target)}` }
      : null,
    retroactiveSummary: milestones.retroactiveSummary,
  };
}
