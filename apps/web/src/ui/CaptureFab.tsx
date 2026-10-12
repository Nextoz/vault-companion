import { useEffect, useState } from 'react';
import { fabScroll, fabVerb, type FabScroll } from '../nav.ts';
import type { Tab } from './TabBar.tsx';

/**
 * C3: the floating + is an extended pill that says what it adds ("+ Capture", "+ Training", "+ Session",
 * "+ Reading"). It shrinks to a 56 px circle while the page scrolls down and extends again on a scroll up or at the
 * top. The accessible name stays the full verb in both shapes.
 */
export function CaptureFab({ tab, inert, onClick }: { tab: Tab; inert: boolean; onClick: () => void }) {
  const { verb, label } = fabVerb(tab);
  const [state, setState] = useState<FabScroll>(() => ({ compact: false, anchor: typeof window === 'undefined' ? 0 : window.scrollY }));
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setState((s) => fabScroll(s, window.scrollY));
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  // A new screen starts extended.
  useEffect(() => setState({ compact: false, anchor: window.scrollY }), [tab]);

  return (
    <button type="button" className="fab" data-compact={state.compact ? '' : undefined} inert={inert} aria-label={label} onClick={onClick}>
      <svg className="fab-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" focusable="false">
        <path d="M12 5v14M5 12h14" />
      </svg>
      <span className="fab-verb" aria-hidden="true">{verb}</span>
    </button>
  );
}
