// ADR-0064: what to celebrate after an action, from two /api/game reads (before, after). Pure: no React, no storage,
// no audio. The order is the celebration order: small first, the biggest moment last, so a combo builds up.
import type { GameAchievement, GameResponse } from '@vault-companion/contracts';
import { displayName, displayPoints, isHiddenUnearned } from './achievements.ts';

export interface AchievementReward {
  readonly kind: 'achievement';
  readonly id: string;
  readonly name: string;
  readonly points: number;
  /** "Complete 10 tasks." — null when the Worker sent no feedback (older Worker). */
  readonly description: string | null;
  /** "Completing a task" — null when unknown. */
  readonly earnedBy: string | null;
  /** 25+ points or a meta: the bigger, glowing banner. */
  readonly major: boolean;
}

export type RewardEvent =
  | { readonly kind: 'xp'; readonly amount: number; readonly criticals: number }
  | { readonly kind: 'skill'; readonly profession: string; readonly skill: number }
  | AchievementReward
  | { readonly kind: 'title'; readonly title: string }
  | { readonly kind: 'level'; readonly level: number; /** XP still needed for the next level (0 at the cap). */ readonly nextCost: number; readonly title: string | null };

/** At most this many achievement banners per action; the rest are still marked seen and wait on the Character page. */
export const ACHIEVEMENT_CAP = 3;

/** A banner for an earned achievement, with the ADR-0064 lines when the payload carries them. */
export function achievementReward(achievement: GameAchievement, feedback: GameResponse['feedback']): AchievementReward {
  const extra = feedback?.achievements[achievement.id];
  return {
    kind: 'achievement',
    id: achievement.id,
    name: displayName(achievement),
    points: displayPoints(achievement),
    description: isHiddenUnearned(achievement) ? null : extra?.description ?? null,
    earnedBy: extra?.earnedBy ?? null,
    major: achievement.type === 'meta' || displayPoints(achievement) >= 25,
  };
}

/**
 * The celebrations between two reads of the same account. Returns nothing when the rules changed between them (a
 * deploy that retunes XP is not something you did), when the revision is unchanged, or when XP went down (an Undo).
 */
export function diffRewards(before: GameResponse, after: GameResponse, alreadySeen: ReadonlySet<string> = new Set()): RewardEvent[] {
  const a = before.character;
  const b = after.character;
  if (a.rulesVersion !== b.rulesVersion || before.revision === after.revision || b.xp < a.xp) return [];
  const events: RewardEvent[] = [];

  const gained = b.xp - a.xp;
  if (gained > 0) {
    const criticals = Math.max(0, (after.feedback?.criticals ?? 0) - (before.feedback?.criticals ?? 0));
    events.push({ kind: 'xp', amount: Math.round(gained), criticals: before.feedback && after.feedback ? criticals : 0 });
  }

  for (const profession of b.professions) {
    const previous = a.professions.find((p) => p.id === profession.id);
    if (previous && profession.skill > previous.skill) events.push({ kind: 'skill', profession: profession.name, skill: profession.skill });
  }

  const wasEarned = new Set([...a.achievements, ...a.feats].filter((x) => x.earned).map((x) => x.id));
  const fresh = [...b.achievements, ...b.feats]
    // Already-announced ids are dropped before the cap, so a seen one never pushes a new one out of the three.
    .filter((x) => x.earned && !wasEarned.has(x.id) && !alreadySeen.has(x.id))
    .map((x) => achievementReward(x, after.feedback))
    // Minor before major, so the glowing one lands last; ties by points then name for a stable order.
    .sort((x, y) => Number(x.major) - Number(y.major) || x.points - y.points || x.name.localeCompare(y.name));
  events.push(...fresh.slice(-ACHIEVEMENT_CAP));

  const titles: string[] = [];
  for (const profession of b.professions) {
    const previous = a.professions.find((p) => p.id === profession.id);
    if (previous && previous.rank !== profession.rank) titles.push(profession.title);
  }
  const levelTitle = b.title !== a.title && b.title !== '' ? b.title : null;
  for (const title of titles) events.push({ kind: 'title', title });

  if (b.level > a.level) events.push({ kind: 'level', level: b.level, nextCost: Math.max(0, Math.round(b.levelCost - b.levelXp)), title: levelTitle });
  else if (levelTitle !== null) events.push({ kind: 'title', title: levelTitle });
  return events;
}

/** Every achievement id earned between the reads (also those past the banner cap), for the device's seen record. */
export function newlyEarnedIds(before: GameResponse, after: GameResponse): string[] {
  const wasEarned = new Set([...before.character.achievements, ...before.character.feats].filter((x) => x.earned).map((x) => x.id));
  return [...after.character.achievements, ...after.character.feats].filter((x) => x.earned && !wasEarned.has(x.id)).map((x) => x.id);
}

/** "+3 XP", or "Critical! +6 XP" when at least one award in the gain was critical. */
export function xpText(event: Extract<RewardEvent, { kind: 'xp' }>): string {
  return event.criticals > 0 ? `Critical! +${event.amount} XP` : `+${event.amount} XP`;
}

/** WoW's own wording: "Your skill in Quartermaster has increased to 76." */
export function skillText(event: Extract<RewardEvent, { kind: 'skill' }>): string {
  return `Your skill in ${event.profession} has increased to ${event.skill}.`;
}

/** "Earned by completing a task" — the "awarded for" line under a banner and in the badge detail. */
export function earnedByText(earnedBy: string | null): string | null {
  return earnedBy === null ? null : `Earned by ${earnedBy.charAt(0).toLowerCase()}${earnedBy.slice(1)}`;
}

// ---- guards around the diff (review round 1) ------------------------------------------------------------------

/** Step milestones never award XP; every other unavailable source would make XP look lower than it is. */
const NON_XP_SOURCES: ReadonlySet<string> = new Set(['health']);

/** A read whose XP is trustworthy: no XP source failed. A partial read must never become the diff baseline. */
export function isComplete(game: GameResponse): boolean {
  return game.unavailable.every((source) => NON_XP_SOURCES.has(source));
}

/**
 * Which read to keep as the baseline, and whether to diff. A partial read is never diffed and never replaces a
 * complete baseline (else the next complete read would announce old achievements again); a complete read replaces a
 * missing or partial baseline without a diff.
 */
export function nextBaseline(current: GameResponse | null, next: GameResponse): { readonly baseline: GameResponse; readonly diff: boolean } {
  if (!isComplete(next)) return { baseline: current ?? next, diff: false };
  if (current === null || !isComplete(current)) return { baseline: next, diff: false };
  return { baseline: next, diff: true };
}

/** The seen-record key for a title, so Undo and redo of a rank-up never announce it twice. */
export const titleSeenId = (title: string): string => `title:${title}`;

/**
 * Drops what this device already celebrated: an achievement or title in the seen record, and a level up to a level
 * not above the highest one celebrated. Undo then redo replays the XP float, never the banner or the level screen.
 */
export function withoutCelebrated(events: readonly RewardEvent[], seen: readonly string[], maxLevel: number | null): RewardEvent[] {
  const known = new Set(seen);
  return events.filter((event) => {
    if (event.kind === 'achievement') return !known.has(event.id);
    if (event.kind === 'title') return !known.has(titleSeenId(event.title));
    if (event.kind === 'level') return maxLevel === null || event.level > maxLevel;
    return true;
  });
}

/** Seen ids to record for a set of events (achievements and titles). */
export function celebratedIds(events: readonly RewardEvent[]): string[] {
  return events.flatMap((event) => event.kind === 'achievement' ? [event.id] : event.kind === 'title' ? [titleSeenId(event.title)] : []);
}
