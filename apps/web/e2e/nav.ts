import type { Page } from '@playwright/test';

/** Screens the specs reach through the bottom bar (and, for the More screens, its list). */
export type Screen =
  | 'Today'
  | 'All'
  | 'Scouts'
  | 'Notes'
  | 'Log'
  | 'Progress'
  | 'Dashboard'
  | 'Status'
  | 'Actions';

/** Which bottom-bar button opens each screen. */
const BAR: Record<Screen, 'Today' | 'Scouts' | 'Notes' | 'Log' | 'More'> = {
  Today: 'Today',
  All: 'Today',
  Scouts: 'Scouts',
  Notes: 'Notes',
  Log: 'Log',
  Progress: 'More',
  Dashboard: 'More',
  Status: 'More',
  Actions: 'More',
};

/** Reach a screen the way a person would: the bottom bar, then the segmented switch or the More list. */
export async function goTo(page: Page, name: Screen): Promise<void> {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: BAR[name], exact: true }).click();
  if (name === 'All') {
    await page.getByRole('group', { name: 'Task view' }).getByRole('button', { name: 'All', exact: true }).click();
    return;
  }
  if (name === 'Progress' || name === 'Dashboard' || name === 'Status' || name === 'Actions') {
    await page.getByRole('navigation', { name: 'More' }).getByRole('button', { name, exact: true }).click();
  }
}
