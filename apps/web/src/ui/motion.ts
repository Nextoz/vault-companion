// Redesign R2: the few motions JavaScript drives (sheet drag/dismiss, a done row leaving or arriving). Durations and
// curves are read from tokens.css, never written here. The Web Animations API is used rather than CSS transitions:
// it runs on the document timeline (unaffected by a test's fake clock), reports completion as a promise, and is not
// switched off by the global reduced-motion rule; callers pick a fade instead under reduced motion.

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function tokenValue(name: string): string {
  if (typeof getComputedStyle !== 'function') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A `--dur-*` token in ms; 0 when the token is missing (no stylesheet, e.g. jsdom), so the motion is skipped. */
export function duration(name: `--dur-${string}`): number {
  const value = tokenValue(name);
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return value.endsWith('ms') ? n : value.endsWith('s') ? n * 1000 : n;
}

/** An `--ease-*` token; `linear` when it is missing. */
export function easing(name: `--ease-${string}`): string {
  return tokenValue(name) || 'linear';
}

/**
 * Plays keyframes and resolves when they end (or are cancelled). Without the Web Animations API, or with a zero
 * duration and delay, it resolves at once and leaves no animation behind.
 */
export function play(el: Element, frames: Keyframe[], options: KeyframeAnimationOptions & { duration: number }): { animation: Animation | null; done: Promise<void> } {
  const delay = typeof options.delay === 'number' ? options.delay : 0;
  if (typeof el.animate !== 'function' || options.duration + delay <= 0) return { animation: null, done: Promise.resolve() };
  const animation = el.animate(frames, options);
  return { animation, done: animation.finished.then(() => undefined, () => undefined) };
}
