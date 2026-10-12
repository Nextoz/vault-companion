// Redesign R2 (review #2): a sheet leaves the way it came. The header (it carries the grabber) can be dragged down:
// the sheet follows the finger, then either dismisses (slides off, then the caller's onClose) or springs back. The
// header's Close button slides the sheet out the same way. When onClose leaves the sheet mounted (a draft or save
// guard refused), the sheet springs back. The decisions are pure (sheet-drag.ts); this file only moves elements.
import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { dismissDuration, dragOffset, releaseDecision, releaseVelocity, type Sample } from '../sheet-drag.ts';
import { duration, easing, play, prefersReducedMotion } from './motion.ts';

interface Parts {
  sheet: HTMLElement;
  backdrop: HTMLElement | null;
}

interface Drag {
  pointer: number;
  startY: number;
  height: number;
  offset: number;
  samples: Sample[];
  scrim: string;
  parts: Parts;
}

function partsOf(header: HTMLElement | null): Parts | null {
  const sheet = header?.closest<HTMLElement>('.sheet');
  if (!sheet) return null;
  const parent = sheet.parentElement;
  return { sheet, backdrop: parent?.classList.contains('sheet-backdrop') ? parent : null };
}

/** The backdrop's colour with its alpha scaled by `k` (0 = clear), from a computed `rgb()/rgba()` value. */
/** The backdrop's current scrim colour ('' where there is no layout engine, as motion.ts does for tokens). */
const scrimOf = (el: Element): string => (typeof getComputedStyle === 'function' ? getComputedStyle(el).backgroundColor : '');

export function scaleAlpha(color: string, k: number): string {
  const inner = /rgba?\(([^)]*)\)/.exec(color)?.[1];
  if (inner === undefined) return color;
  const [r = 0, g = 0, b = 0, a = 1] = inner.split(/[\s,/]+/).filter(Boolean).map(Number);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a * k))})`;
}

const at = (y: number | string) => `translate3d(0, ${typeof y === 'number' ? `${y}px` : y}, 0)`;

/** Ends the mount slide/fade at once, so a gesture or a dismissal starts from the sheet's resting place. */
function settle(parts: Parts) {
  for (const el of [parts.sheet, parts.backdrop]) el?.getAnimations?.().forEach((a) => a.finish());
}

export function useSheetDismiss(header: RefObject<HTMLElement | null>, onClose: () => void, enabled: boolean) {
  const drag = useRef<Drag | null>(null);
  const busy = useRef(false);
  // Fill-forwards animations that hold a dismissed sheet off-screen until onClose unmounts it (or springs it back).
  const held = useRef<Animation[]>([]);
  // The exit takes a moment: by its end the caller may have a newer onClose, or be saving (disabled). Read them then.
  const latest = useRef({ onClose, enabled });
  latest.current = { onClose, enabled };
  // Focus inside the sheet when it went inert for its exit, given back if it springs back.
  const focused = useRef<HTMLElement | null>(null);

  /**
   * Back to rest. `faded` says the reduced-motion exit faded the whole sheet out, so it fades back in; a tap on the
   * header or a short drag only clears what the finger moved.
   */
  const restore = (parts: Parts, from: number | string, scrimFrom: string | null, faded = false) => {
    const { sheet, backdrop } = parts;
    held.current.forEach((a) => a.cancel());
    held.current = [];
    sheet.style.transform = '';
    if (backdrop) backdrop.style.backgroundColor = '';
    if (sheet.inert) {
      sheet.inert = false;
      if (focused.current?.isConnected) focused.current.focus();
    }
    focused.current = null;
    if (prefersReducedMotion()) {
      if (backdrop && faded) play(backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: duration('--dur-fade'), easing: 'linear' });
      return;
    }
    const options = { duration: duration('--dur-sheet'), easing: easing('--ease-sheet') };
    if (from !== 0) play(sheet, [{ transform: at(from) }, { transform: at(0) }], options);
    if (backdrop && scrimFrom !== null) {
      play(backdrop, [{ backgroundColor: scrimFrom }, { backgroundColor: scrimOf(backdrop) }], options);
    }
  };

  const dismiss = async (parts: Parts, offset: number, velocity: number, scrimNow: string) => {
    const { sheet, backdrop } = parts;
    busy.current = true;
    // A leaving sheet takes no more taps or keys (Save during the exit would race the close).
    focused.current = document.activeElement instanceof HTMLElement && sheet.contains(document.activeElement) ? document.activeElement : null;
    sheet.inert = true;
    const reduced = prefersReducedMotion();
    const height = sheet.getBoundingClientRect().height;
    const steps: Promise<void>[] = [];
    if (reduced) {
      if (backdrop) {
        const fade = play(backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: duration('--dur-fade'), easing: 'linear', fill: 'forwards' });
        if (fade.animation) held.current.push(fade.animation);
        steps.push(fade.done);
      }
    } else {
      const options: KeyframeAnimationOptions & { duration: number } = {
        duration: dismissDuration({ offset, height, velocity, max: duration('--dur-sheet') }),
        easing: easing('--ease-sheet'),
        fill: 'forwards',
      };
      const slide = play(sheet, [{ transform: at(offset) }, { transform: at('100%') }], options);
      if (slide.animation) held.current.push(slide.animation);
      steps.push(slide.done);
      if (backdrop) {
        const clear = play(backdrop, [{ backgroundColor: scrimNow }, { backgroundColor: scaleAlpha(scrimNow, 0) }], options);
        if (clear.animation) held.current.push(clear.animation);
      }
    }
    sheet.style.transform = '';
    if (backdrop) backdrop.style.backgroundColor = '';
    await Promise.all(steps);
    if (!sheet.isConnected) { busy.current = false; return; } // closed meanwhile: never close twice
    try {
      // The caller's current state decides, not the state at the tap (e.g. a save that started meanwhile).
      if (latest.current.enabled) flushSync(() => latest.current.onClose());
    } finally {
      busy.current = false;
      // Still mounted: a guard refused (unsaved text, a save in flight). Bring the sheet back.
      if (sheet.isConnected) restore(parts, reduced ? 0 : '100%', backdrop ? scaleAlpha(scrimNow, 0) : null, reduced);
    }
  };

  /** The header's Close button: slide out, then onClose. */
  const close = () => {
    if (busy.current) return;
    const parts = partsOf(header.current);
    if (!enabled || !parts) {
      onClose();
      return;
    }
    settle(parts);
    void dismiss(parts, 0, 0, parts.backdrop ? scrimOf(parts.backdrop) : '');
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || busy.current || drag.current || !e.isPrimary || e.button !== 0) return;
    // A tap on the header's own buttons (Back, Close) is a tap, never the start of a drag.
    if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea')) return;
    const parts = partsOf(e.currentTarget);
    if (!parts) return;
    settle(parts);
    drag.current = {
      pointer: e.pointerId,
      startY: e.clientY,
      height: parts.sheet.getBoundingClientRect().height,
      offset: 0,
      samples: [{ t: e.timeStamp, y: e.clientY }],
      scrim: parts.backdrop ? scrimOf(parts.backdrop) : '',
      parts,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    d.offset = dragOffset(e.clientY - d.startY, d.height);
    d.samples.push({ t: e.timeStamp, y: e.clientY });
    if (d.samples.length > 12) d.samples.shift();
    d.parts.sheet.style.transform = at(d.offset);
    if (d.parts.backdrop) d.parts.backdrop.style.backgroundColor = scaleAlpha(d.scrim, 1 - Math.max(0, d.offset) / d.height);
  };

  const end = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    if (!cancelled) d.samples.push({ t: e.timeStamp, y: e.clientY });
    const velocity = releaseVelocity(d.samples);
    const scrimNow = scaleAlpha(d.scrim, 1 - Math.max(0, d.offset) / d.height);
    if (!cancelled && releaseDecision({ offset: d.offset, height: d.height, velocity }) === 'dismiss') {
      void dismiss(d.parts, d.offset, velocity, scrimNow);
    } else {
      restore(d.parts, d.offset, d.parts.backdrop && d.offset !== 0 ? scrimNow : null);
    }
  };

  return {
    close,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => end(e, false),
      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => end(e, true),
    },
  };
}
