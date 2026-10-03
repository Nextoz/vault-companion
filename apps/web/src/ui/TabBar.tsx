import type { ReactNode } from 'react';

/** Every internal screen. The bottom bar groups them into five buttons. */
export type Tab =
  | 'today'
  | 'tasks'
  | 'all'
  | 'notes'
  | 'training'
  | 'scouts'
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
    case 'history':
    case 'health':
      return 'log';
    case 'today':
      return 'today';
    case 'tasks':
      return 'tasks';
    case 'scouts':
      return 'scouts';
    case 'notes':
      return 'notes';
    case 'status':
      return null;
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
  tasks: (
    <>
      <path d="m4 6 1.6 1.6L8.5 4.7M4 12.5l1.6 1.6L8.5 11.2M4 19l1.6 1.6L8.5 17.7" />
      <path d="M12 6.5h8M12 13h8M12 19.5h8" />
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
};

const ITEMS: ReadonlyArray<{ key: BarKey; label: string; to: Tab }> = [
  { key: 'today', label: 'Today', to: 'today' },
  { key: 'tasks', label: 'Tasks', to: 'tasks' },
  { key: 'scouts', label: 'Scouts', to: 'scouts' },
  { key: 'notes', label: 'Notes', to: 'notes' },
  { key: 'log', label: 'Log', to: 'training' },
];

/** Fixed bottom tab bar: five icon+label buttons, one pressed per screen (All shares Tasks, both Log views share Log). */
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
