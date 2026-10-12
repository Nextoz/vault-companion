// Redesign R4 (review option B2): the pure decisions behind the Character skin. Item quality per achievement tier,
// the locked tile's progress arc and the category glyph. No React, no CSS: the components read these and the skin
// tokens (`--skin-quality-*`) paint them, only inside the Character screens.
import type { GameAchievement } from '@vault-companion/contracts';
import { isHiddenUnearned } from './achievements.ts';

export type Quality = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/** Points thresholds, highest first: 50 epic, 25 rare, 10 uncommon, anything less common. */
const QUALITY_BY_POINTS: ReadonlyArray<readonly [number, Quality]> = [[50, 'epic'], [25, 'rare'], [10, 'uncommon']];

/** The quality a points value earns. Values between tiers take the tier below (15 pts is uncommon, 30 is rare). */
export function qualityForPoints(points: number): Quality {
  for (const [min, quality] of QUALITY_BY_POINTS) if (points >= min) return quality;
  return 'common';
}

/** An achievement's quality: Feats of Strength are legendary (they are worth 0 points), the rest go by points. */
export function achievementQuality(achievement: Pick<GameAchievement, 'type' | 'points'>): Quality {
  if (achievement.type === 'feat') return 'legendary';
  return qualityForPoints(achievement.points);
}

/**
 * The reward banner only knows the points it shows. An earned achievement shows 0 points only when it is a Feat
 * (`displayPoints`), so 0 means legendary there.
 */
export function bannerQuality(points: number): Quality {
  return points <= 0 ? 'legendary' : qualityForPoints(points);
}

/** The quality word for the detail sheet ("Rare"). */
export function qualityLabel(quality: Quality): string {
  return quality.charAt(0).toUpperCase() + quality.slice(1);
}

/**
 * How much of the locked tile's arc is drawn, 0..1. Null (no arc) when the achievement is earned, still hidden, or
 * has no measurable progress; a chain without its own counter has no arc either.
 */
export function lockedArc(achievement: Pick<GameAchievement, 'earned' | 'visible' | 'type' | 'progress'>): number | null {
  if (isHiddenUnearned(achievement) || achievement.earned || achievement.progress === null) return null;
  const { current, target } = achievement.progress;
  if (target <= 0) return null;
  return Math.min(1, Math.max(0, current / target));
}

/** What is left on an unearned achievement with progress ("3 to go"); null when there is nothing to count. */
export function remainingText(achievement: Pick<GameAchievement, 'earned' | 'visible' | 'type' | 'progress'>): string | null {
  if (isHiddenUnearned(achievement) || achievement.earned || achievement.progress === null) return null;
  const left = achievement.progress.target - achievement.progress.current;
  return left > 0 ? `${left} to go` : null;
}

export type GlyphId = 'general' | 'athletics' | 'scholar' | 'lorekeeper' | 'quartermaster' | 'feats' | 'journey';

/**
 * Category -> glyph. The domain uses profession ids (athletics, scholar, …) and the app's own words (Training,
 * Learning, …) appear in older payloads and fixtures; both map to the same glyph. Unknown categories get the
 * general medal, never a blank frame.
 */
const GLYPHS: Readonly<Record<string, GlyphId>> = {
  general: 'general',
  athletics: 'athletics',
  training: 'athletics',
  scholar: 'scholar',
  learning: 'scholar',
  lorekeeper: 'lorekeeper',
  research: 'lorekeeper',
  library: 'lorekeeper',
  reading: 'lorekeeper',
  quartermaster: 'quartermaster',
  tasks: 'quartermaster',
  feats: 'feats',
  'feats of strength': 'feats',
  journey: 'journey',
  walking: 'journey',
  steps: 'journey',
};

export function categoryGlyph(category: string): GlyphId {
  return GLYPHS[category.trim().toLowerCase()] ?? 'general';
}
