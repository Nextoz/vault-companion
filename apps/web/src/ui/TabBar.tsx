import type { ReactNode } from 'react';

/** Every internal screen. The bottom bar groups them into five buttons. */
export type Tab =
  | 'dashboard'
  | 'today'
  | 'all'
  | 'notes'
  | 'training'
  | 'scouts'
  | 'history'
  | 'more'
  | 'status'
  | 'actions';

/** The five bottom-bar buttons. */
export type BarKey = 'today' | 'scouts' | 'notes' | 'log' | 'more';

/** Which bottom-bar button is pressed for a screen; 'all' shares Today, the More screens share More. */
export function barKey(tab: Tab): BarKey {
  switch (tab) {
    case 'all':
      return 'today';
    case 'training':
      return 'log';
    case 'dashboard':
    case 'history':
    case 'status':
    case 'actions':
      return 'more';
    default:
      return tab;
  }
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const ICONS: Record<BarKey, ReactNode> = {
  today: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </>
  ),
  scouts: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  notes: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4M10 12h5M10 16h5" />
    </>
  ),
  log: <path d="M4 9v6M20 9v6M7 7v10M17 7v10M7 12h10" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
};

const ITEMS: ReadonlyArray<{ key: BarKey; label: string; to: Tab }> = [
  { key: 'today', label: 'Today', to: 'today' },
  { key: 'scouts', label: 'Scouts', to: 'scouts' },
  { key: 'notes', label: 'Notes', to: 'notes' },
  { key: 'log', label: 'Log', to: 'training' },
  { key: 'more', label: 'More', to: 'more' },
];

/** Fixed bottom tab bar: five icon+label buttons, one pressed per screen (Today also covers All). */
export function TabBar({ tab, onSelect, inert }: { tab: Tab; onSelect: (tab: Tab) => void; inert?: boolean }) {
  const active = barKey(tab);
  return (
    <nav className="tabbar" aria-label="Views" inert={inert}>
      {ITEMS.map(({ key, label, to }) => (
        <button key={key} type="button" className="tab" aria-pressed={active === key} onClick={() => onSelect(to)}>
          <Icon>{ICONS[key]}</Icon>
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
