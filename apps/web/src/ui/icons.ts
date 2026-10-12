// Redesign R5 (review #10): the one icon registry. Every glyph is a set of 24x24 stroke paths (stroke 1.8, round caps,
// currentColor); Icon.tsx draws them. Pure data so a test can guard it. No emoji or text glyph stands in for an icon.

const CLOUD = 'M7.5 18.5a4.5 4.5 0 0 1-.4-8.98 5.5 5.5 0 0 1 10.6 1.5 3.75 3.75 0 0 1-.7 7.48Z';
const CLOUD_HIGH = 'M7.5 14.5a4.25 4.25 0 0 1-.4-8.48 5.25 5.25 0 0 1 10.1 1.4 3.5 3.5 0 0 1-.6 7.08Z';
const SUN = 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4';
const DUMBBELL = 'M4 9v6M20 9v6M7 7v10M17 7v10M7 12h10';

export const ICON_PATHS = {
  // Tab bar and generic glyphs.
  today: SUN,
  tasks: 'm4 6 1.6 1.6L8.5 4.7M4 12.5l1.6 1.6L8.5 11.2M4 19l1.6 1.6L8.5 17.7M12 6.5h8M12 13h8M12 19.5h8',
  scouts: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM7.5 12a4.5 4.5 0 0 0 4.5 4.5M12 12l5.8-5.8M16 14.5h.01',
  notes: 'M7 3h7l4 4v14H7ZM14 3v4h4M10 12h5M10 16h5',
  log: DUMBBELL,
  chevron: 'm9 6 6 6-6 6',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6 6 18',
  calendar: 'M5.5 5h13A2.5 2.5 0 0 1 21 7.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5v-11A2.5 2.5 0 0 1 5.5 5ZM3 10h18M8 3v4M16 3v4',
  // Training rows.
  run: 'M16.5 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM14 8.5l-3.5 2.5-3-1M10.5 11l1.5 3.5-3.5 2.5-1.5 3.5M12 14.5l3.5 1.5 1 3.5M14 8.5l2 3.5 3 .5',
  dumbbell: DUMBBELL,
  note: 'M6 4h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM8.5 9h7M8.5 13h7M8.5 17h4',
  dot: 'M12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z',
  // Weather (WMO groups; see weatherGlyph).
  sun: SUN,
  'part-cloud': 'M8 3v1.2M3.2 5.2l.9.9M2.5 10.5h1.2M12.8 5.2l-.9.9M5.7 10a3 3 0 0 1 5.3-2.2M9.5 20a3.5 3.5 0 0 1-.3-6.98 4.5 4.5 0 0 1 8.6 1.2 3.2 3.2 0 0 1-.6 5.78Z',
  cloud: CLOUD,
  fog: 'M4 8h16M3 12h18M6 16h12M9 20h6',
  drizzle: `${CLOUD_HIGH}M8 18v.01M12 20v.01M16 18v.01`,
  rain: `${CLOUD_HIGH}M8 17.5l-1 3M12 17.5l-1 3M16 17.5l-1 3`,
  snow: `${CLOUD_HIGH}M8 17.5v.01M12 17.5v.01M16 17.5v.01M10 20.5v.01M14 20.5v.01`,
  storm: `${CLOUD_HIGH}M12.8 14.5 10.5 18h3.2l-2 3.5`,
} as const;

export type IconName = keyof typeof ICON_PATHS;

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

/** The path data for an icon name (never empty; the registry test guards that). */
export function iconPath(name: IconName): string {
  return ICON_PATHS[name];
}
