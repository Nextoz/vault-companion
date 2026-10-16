import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { logTabSuffix } from '../nav.ts';
import { Icon } from './Icon.tsx';

/** Every internal screen. The bottom bar groups them into five buttons. */
export type Tab =
  | 'today'
  | 'tasks'
  | 'all'
  | 'notes'
  | 'training'
  | 'learning'
  | 'reading'
  | 'scouts'
  | 'radar'
  | 'history'
  | 'health'
  | 'status';

/** The five bottom-bar buttons. */
export type BarKey = 'today' | 'tasks' | 'scouts' | 'notes' | 'log';

/**
 * Which bottom-bar button is pressed for a screen; 'all' shares Tasks, both Log views share Log.
 * The header's Status screen belongs to no bar button: nothing is pressed.
 */
export function barKey(tab: Tab): BarKey | null {
  switch (tab) {
    case 'all':
      return 'tasks';
    case 'training':
    case 'learning':
    case 'reading':
    case 'history':
    case 'health':
      return 'log';
    case 'today':
      return 'today';
    case 'tasks':
      return 'tasks';
    case 'scouts':
      return 'scouts';
    case 'radar':
      return null;
    case 'notes':
      return 'notes';
    case 'status':
      return null;
  }
}

const ITEMS: ReadonlyArray<{ key: BarKey; label: string; to: Tab }> = [
  { key: 'today', label: 'Today', to: 'today' },
  { key: 'tasks', label: 'Tasks', to: 'tasks' },
  { key: 'scouts', label: 'Scouts', to: 'scouts' },
  { key: 'notes', label: 'Notes', to: 'notes' },
  { key: 'log', label: 'Log', to: 'training' },
];

/** Holding the Log tab this long opens the Character sheet (D2). */
export const LONG_PRESS_MS = 500;

/**
 * Fixed bottom tab bar: five icon+label buttons, one marked current per screen (All shares Tasks, both Log views share Log).
 * D2: `strip` (the XP strip) runs along its top edge; the Log tab names the level for assistive tech ("Log, level
 * 12") and a 500 ms hold on it opens the Character sheet.
 */
export function TabBar({ tab, onSelect, inert, strip, level = null, onHoldLog, logTo }: {
  tab: Tab;
  onSelect: (tab: Tab) => void;
  inert?: boolean;
  strip?: ReactNode;
  level?: number | null;
  onHoldLog?: (() => void) | undefined;
  /** R3b: the Log view the Log button opens (the one last shown on this device); Training when omitted. */
  logTo?: Tab;
}) {
  const active = barKey(tab);
  const hold = useHold(onHoldLog);
  return (
    <nav className="tabbar" aria-label="Views" inert={inert}>
      {strip}
      {ITEMS.map(({ key, label, to }) => (
        <button key={key} type="button" className="tab" aria-current={active === key ? 'page' : undefined}
          aria-label={key === 'log' && level !== null ? label + logTabSuffix(level) : undefined}
          {...(key === 'log' ? hold.handlers : {})}
          onClick={() => { if (key === 'log' && hold.consume()) return; onSelect(key === 'log' ? logTo ?? to : to); }}>
          <Icon name={key} filled={active === key} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

/** A press held for LONG_PRESS_MS fires `onHold`; the click that ends that press is then swallowed. */
function useHold(onHold: (() => void) | undefined) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  return {
    consume: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
    handlers: onHold ? {
      onPointerDown: (e: ReactPointerEvent) => {
        fired.current = false;
        origin.current = { x: e.clientX, y: e.clientY };
        cancel();
        timer.current = window.setTimeout(() => { timer.current = null; fired.current = true; onHold(); }, LONG_PRESS_MS);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        const o = origin.current;
        if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) cancel();
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
    } : {},
  };
}
