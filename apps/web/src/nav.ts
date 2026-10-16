// Redesign R3a (review #8, C3, D2): the pure decisions behind the large-title header, the capture button and the
// global XP strip. No DOM here; the components measure and call these.
import { FRESH_FOR_MS } from './freshness.ts';
import type { Tab } from './ui/TabBar.tsx';

// ---- C3: the capture button says what it adds -------------------------------------------------------------------

export interface FabVerb {
  /** The word after the "+" on the extended pill. */
  readonly verb: string;
  /** The button's accessible name; it contains the visible word (WCAG 2.5.3). */
  readonly label: string;
}

/** Log screens add their own thing; every other screen opens Capture. */
export function fabVerb(tab: Tab): FabVerb {
  switch (tab) {
    case 'training':
      return { verb: 'Training', label: 'Add training' };
    case 'learning':
      return { verb: 'Session', label: 'Add session' };
    case 'reading':
      return { verb: 'Reading', label: 'Log reading' };
    default:
      return { verb: 'Capture', label: 'Capture' };
  }
}

/** Scroll positions at or above this count as "at the top": the pill is always extended there. */
export const FAB_TOP_ZONE = 8;
/** Smaller movements are finger jitter and keep the current shape. */
export const FAB_JITTER = 6;

export interface FabScroll {
  readonly compact: boolean;
  /** The scroll position the last decision was taken at; movement is measured from here. */
  readonly anchor: number;
}

/** Shrink to the circle while scrolling down, extend again on a scroll up or back at the top. */
export function fabScroll(state: FabScroll, y: number): FabScroll {
  if (y <= FAB_TOP_ZONE) return state.compact || state.anchor !== y ? { compact: false, anchor: y } : state;
  const moved = y - state.anchor;
  if (moved > FAB_JITTER) return { compact: true, anchor: y };
  if (moved < -FAB_JITTER) return { compact: false, anchor: y };
  return state;
}

// ---- #8: pull to refresh --------------------------------------------------------------------------------------

/** Finger travel (px) that arms a refresh. */
export const PULL_THRESHOLD = 70;

/** How far the page is pulled: only a touch that began with the page scrolled to the very top counts. */
export function pullDistance(startY: number, y: number, scrollTopAtStart: number): number {
  if (scrollTopAtStart > 0) return 0;
  return Math.max(0, y - startY);
}

/** Releasing at or past the threshold refreshes; a shorter pull springs back without a read. */
export function pullArmed(distance: number): boolean {
  return distance >= PULL_THRESHOLD;
}

// ---- #8: a stale or failed vault read is a chip in the bar, not a paragraph ----------------------------------

export interface VaultChip {
  readonly tone: 'red' | 'yellow';
  readonly text: string;
}

/** Red when the last read failed, yellow when the last good read is older than the freshness window. */
export function vaultChip(checkedAt: number | null, failed: boolean, now: number): VaultChip | null {
  if (failed) return { tone: 'red', text: 'Not refreshed' };
  if (checkedAt !== null && now - checkedAt > FRESH_FOR_MS) return { tone: 'yellow', text: 'Stale' };
  return null;
}

// ---- D2: the global XP strip ----------------------------------------------------------------------------------

export interface StripValue {
  readonly level: number;
  readonly levelXp: number;
  readonly levelCost: number;
  readonly restedXp: number;
}

export interface StripFractions {
  /** XP into the level, 0..1 of the strip. */
  readonly fill: number;
  /** The rested run starts at the fill end and never passes the level end. */
  readonly restedStart: number;
  readonly restedWidth: number;
  /** The "zz" mark: a rested reserve exists (never at the level cap). */
  readonly rested: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function stripFractions(value: StripValue): StripFractions {
  // At the level cap there is no next level: a full bar and no reserve.
  if (value.levelCost <= 0) return { fill: 1, restedStart: 1, restedWidth: 0, rested: false };
  const fill = clamp(value.levelXp / value.levelCost, 0, 1);
  const restedWidth = clamp(value.restedXp / value.levelCost, 0, 1 - fill);
  return { fill, restedStart: fill, restedWidth, rested: value.restedXp > 0 };
}

/**
 * How the strip moves to a new value: an XP gain within the level is earned, so it uses the reward ease; a drop (an
 * Undo) uses the interface ease; a new level or the first value jumps, because the level-up screen covers it.
 */
export function stripMotion(prev: StripValue | null, next: StripValue): 'reward' | 'ui' | 'none' {
  if (prev === null || prev.level !== next.level) return 'none';
  if (next.levelXp > prev.levelXp) return 'reward';
  if (next.levelXp === prev.levelXp && next.restedXp === prev.restedXp) return 'none';
  return 'ui';
}

/** The Log tab's visually hidden suffix: "Log, level 12" to assistive tech; nothing until the level is known. */
export function logTabSuffix(level: number | null): string {
  return level === null ? '' : `, level ${level}`;
}
