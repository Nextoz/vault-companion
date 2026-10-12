// Redesign R2 (review #2): the pure decisions behind dragging a sheet down by its header. No DOM here; the pointer
// handler in ui/sheet-motion.ts feeds it finger positions and applies what it returns.

/** A release past this fraction of the sheet's height dismisses it. */
export const DISMISS_FRACTION = 0.25;
/** px/ms: a release at least this fast is a flick (down dismisses, up restores). */
export const FLICK_VELOCITY = 0.5;
/** px: a "flick" shorter than this is a jittery tap, not an intent to dismiss. */
export const MIN_FLICK_DISTANCE = 12;
/** ms: velocity is measured over the last stretch of the gesture only. */
export const VELOCITY_WINDOW = 100;
/** iOS rubber-band stiffness. */
const RUBBER = 0.55;

export interface Sample {
  /** Event time, ms. */
  t: number;
  /** Finger y, px. */
  y: number;
}

/** Where the sheet sits for a finger moved `dy` px from where it went down: 1:1 downward, rubber-banded upward. */
export function dragOffset(dy: number, height: number): number {
  if (dy >= 0) return dy;
  const extent = Math.max(height, 1);
  return -(1 - 1 / ((-dy * RUBBER) / extent + 1)) * extent;
}

/** px/ms over the samples inside the last `VELOCITY_WINDOW` ms (positive = downward); 0 without two samples. */
export function releaseVelocity(samples: readonly Sample[]): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  const recent = samples.filter((s) => last.t - s.t <= VELOCITY_WINDOW);
  const first = recent[0];
  if (!first || last.t === first.t) return 0;
  return (last.y - first.y) / (last.t - first.t);
}

export type Release = 'dismiss' | 'restore';

/** What a released drag does: dismiss past 25% of the height or on a downward flick, otherwise spring back. */
export function releaseDecision({ offset, height, velocity }: { offset: number; height: number; velocity: number }): Release {
  if (velocity <= -FLICK_VELOCITY) return 'restore';
  if (velocity >= FLICK_VELOCITY && offset >= MIN_FLICK_DISTANCE) return 'dismiss';
  return offset > height * DISMISS_FRACTION ? 'dismiss' : 'restore';
}

/** How long the sheet takes to leave from `offset`: a flick carries its own speed, never slower than `max` ms. */
export function dismissDuration({ offset, height, velocity, max }: { offset: number; height: number; velocity: number; max: number }): number {
  const remaining = Math.max(height - offset, 0);
  if (velocity <= 0) return max;
  return Math.min(max, Math.max(max / 2, remaining / velocity));
}
