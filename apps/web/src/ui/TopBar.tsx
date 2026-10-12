import { useEffect, useRef, useState, type RefObject } from 'react';
import { FRESH_FOR_MS } from '../freshness.ts';
import { pullArmed, pullDistance, PULL_THRESHOLD, vaultChip } from '../nav.ts';

/** Touches that start here belong to something else (a sheet, a banner layer, the tab bar), never to the page pull. */
const NOT_THE_PAGE = '.sheet-backdrop, [role="dialog"], .reward-layer, .tabbar, .fab, .triage-card';

/**
 * Review #8: the one top bar. Status dot left (it pulses while a read runs), a yellow/red chip when the vault read is
 * stale or failed (both open the Status screen, which shows freshness and can refresh), the collapsed large title in
 * the centre, and one action right (Report). Pulling the page down from the top refreshes the vault.
 */
export function TopBar({ barRef, back, dot, busy, checkedAt, failed, signedOut, title, collapsed, inert, reportDisabled, onStatus, onReport, onRefresh }: {
  barRef: RefObject<HTMLElement | null>;
  /** A pushed screen (Status, Radar): Back takes the dot's place, as on iOS. */
  back: (() => void) | null;
  dot: 'red' | 'yellow' | 'green';
  busy: boolean;
  checkedAt: number | null;
  failed: boolean;
  signedOut: boolean;
  title: string | null;
  collapsed: boolean;
  inert: boolean;
  reportDisabled: boolean;
  onStatus: () => void;
  onReport: () => void;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (checkedAt === null) return;
    // Re-render once when the read ages past the freshness window; this never starts a read.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, checkedAt + FRESH_FOR_MS + 1 - Date.now()));
    return () => clearTimeout(timer);
  }, [checkedAt]);
  const chip = signedOut ? null : vaultChip(checkedAt, failed, now);
  const pull = usePull(onRefresh, signedOut || inert);

  return (
    <header ref={barRef} className="top" inert={inert} data-collapsed={collapsed ? '' : undefined}>
      <div className="top-bar">
        <div className="top-lead">
          {back ? <button type="button" className="link top-back" onClick={back}>‹ Back</button> : <>
          <button type="button" className="status-dot" data-state={dot} data-busy={busy ? '' : undefined} aria-label="Status" onClick={onStatus} />
          {chip && (
            <button type="button" className="vault-chip" data-tone={chip.tone} aria-label={`Vault ${chip.text.toLowerCase()}: open Status`} onClick={onStatus}>
              {chip.text}
            </button>
          )}
          </>}
        </div>
        <p className="top-title" aria-hidden="true">{title}</p>
        <div className="top-trail">
          <button type="button" className="link" aria-label="Report a bug or wish" disabled={reportDisabled} onClick={onReport}>Report</button>
        </div>
      </div>
      {pull > 0 && (
        <div className="ptr" aria-hidden="true" data-armed={pullArmed(pull) ? '' : undefined}
          style={{ ['--pull' as string]: Math.min(1, pull / PULL_THRESHOLD) }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v13M6.5 12.5 12 18l5.5-5.5" />
          </svg>
        </div>
      )}
    </header>
  );
}

/** The current pull distance; releasing past the threshold calls `onRefresh` once. Passive listeners only. */
function usePull(onRefresh: () => void, disabled: boolean): number {
  const [distance, setDistance] = useState(0);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    if (disabled) return;
    let start: { x: number; y: number; top: number } | null = null;
    let pulled = 0;
    const reset = () => { start = null; pulled = 0; setDistance(0); };
    const down = (e: TouchEvent) => {
      const touch = e.touches[0];
      const target = e.target instanceof Element ? e.target : null;
      if (e.touches.length !== 1 || !touch || target?.closest(NOT_THE_PAGE)) { reset(); return; }
      start = { x: touch.clientX, y: touch.clientY, top: window.scrollY };
    };
    const move = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!start || !touch) return;
      // A sideways swipe (a card, a chip row) is not a pull.
      const dx = Math.abs(touch.clientX - start.x);
      if (pulled === 0 && dx > 10 && dx > Math.abs(touch.clientY - start.y)) { reset(); return; }
      pulled = window.scrollY > 0 ? 0 : pullDistance(start.y, touch.clientY, start.top);
      setDistance(pulled);
    };
    const up = () => {
      if (start && pullArmed(pulled)) refresh.current();
      reset();
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    document.addEventListener('touchcancel', reset, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', reset);
    };
  }, [disabled]);
  return distance;
}
