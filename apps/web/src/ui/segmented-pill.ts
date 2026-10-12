// Redesign R2 (review #2): every segmented control (`.segmented` with `aria-pressed` buttons) gets one selection pill
// that slides between segments instead of the highlight jumping. One shared mechanism for all twelve controls, with no
// change to their markup: this watches the document, measures the pressed segment of each `.segmented`, and hands the
// geometry to CSS as custom properties; `.segmented[data-pill]::before` (motion.css) is the pill and moves with a
// transform. A control first seen gets its pill in place, without a slide.

const GROUP = '.segmented';

/** Puts `group`'s pill under its pressed segment, or hides it when none is pressed or the group is not laid out. */
export function placePill(group: HTMLElement): void {
  const pressed = group.querySelector<HTMLElement>('button[aria-pressed="true"]');
  if (!pressed || pressed.offsetWidth === 0) {
    group.removeAttribute('data-pill');
    return;
  }
  // Layout offsets, not client rects: a segment shrinking under the finger (:active scale) must not skew the pill.
  let x = pressed.offsetLeft;
  let y = pressed.offsetTop;
  if (pressed.offsetParent !== group) {
    const g = group.getBoundingClientRect();
    const p = pressed.getBoundingClientRect();
    x = p.left - g.left - group.clientLeft;
    y = p.top - g.top - group.clientTop;
  }
  const style = group.style;
  style.setProperty('--seg-x', `${x}px`);
  style.setProperty('--seg-y', `${y}px`);
  style.setProperty('--seg-w', `${pressed.offsetWidth}px`);
  style.setProperty('--seg-h', `${pressed.offsetHeight}px`);
  group.setAttribute('data-pill', '');
}

const inGroup = (node: Node | null): boolean => node instanceof Element && node.closest(GROUP) !== null;
const hasGroup = (node: Node): boolean => node instanceof Element && (node.matches(GROUP) || node.querySelector(GROUP) !== null);

/** Starts watching `root` (the document body) for segmented controls; returns a stop function. */
export function installSegmentedPills(root: HTMLElement): () => void {
  if (typeof MutationObserver === 'undefined') return () => undefined;
  const sized = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver((entries) => entries.forEach((entry) => placePill(entry.target as HTMLElement)));
  const watched = new WeakSet<Element>();

  const sweep = () => {
    root.querySelectorAll<HTMLElement>(GROUP).forEach((group) => {
      if (!watched.has(group)) {
        watched.add(group);
        sized?.observe(group);
      }
      placePill(group);
    });
  };

  const forget = (node: Node) => {
    if (!(node instanceof Element) || !sized) return;
    const groups = node.matches(GROUP) ? [node] : [...node.querySelectorAll(GROUP)];
    groups.forEach((group) => { sized.unobserve(group); watched.delete(group); });
  };

  const mutations = new MutationObserver((records) => {
    records.forEach((r) => r.removedNodes.forEach(forget));
    // Only a mutation in or around a segmented control can move a pill: skip the rest of the app's renders.
    const relevant = records.some((r) =>
      r.type === 'characterData' ? inGroup(r.target.parentElement) : inGroup(r.target) || [...r.addedNodes].some(hasGroup));
    if (relevant) sweep();
  });
  mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-pressed'] });
  sweep();
  return () => {
    mutations.disconnect();
    sized?.disconnect();
  };
}
