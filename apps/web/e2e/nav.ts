import type { Page } from '@playwright/test';

/** Screens the specs reach through the bottom bar, the segmented switches, or the header's Status dot. */
export type Screen =
  | 'Today'
  | 'Tasks'
  | 'All'
  | 'Scouts'
  | 'Notes'
  | 'Log'
  | 'Progress'
  | 'Status';

/** Which bottom-bar button opens each screen ('All' shares Tasks, Progress shares Log). */
const BAR: Record<Exclude<Screen, 'Status'>, 'Today' | 'Tasks' | 'Scouts' | 'Notes' | 'Log'> = {
  Today: 'Today',
  Tasks: 'Tasks',
  All: 'Tasks',
  Scouts: 'Scouts',
  Notes: 'Notes',
  Log: 'Log',
  Progress: 'Log',
};

/** Reach a screen the way a person would: the bottom bar, then a segmented switch or the header's Status dot. */
export async function goTo(page: Page, name: Screen): Promise<void> {
  if (name === 'Status') {
    await page.getByRole('button', { name: 'Status', exact: true }).click();
    return;
  }
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: BAR[name], exact: true }).click();
  if (name === 'All') {
    await page.getByRole('group', { name: 'Task view' }).getByRole('button', { name: 'All', exact: true }).click();
    return;
  }
  if (name === 'Progress') {
    await page.getByRole('group', { name: 'Log view' }).getByRole('button', { name: 'Progress', exact: true }).click();
  }
}
