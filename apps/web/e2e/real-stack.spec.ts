// Review O3: the real PWA queue against the real server stack — no mocked API. The built app and the Worker app share
// one origin (real-stack.ts); commands commit through LocalGitStore to a disposable bare repo, and every flow ends on
// the bytes and commits in that repo. Synthetic text only.
import { expect, test as base, type Page } from '@playwright/test';
import { startRealStack, todayIn, type RealStack } from './real-stack.ts';
import { goTo } from './nav.ts';

const TODO = 'Tasks/To-Do List.md';
const OLD_DONE = '- [x] Synthetic old chore #todo ✅ 2026-09-01';

const open = (name: string, today: string) => `- [ ] ${name} #todo 📅 ${today}`;
const done = (name: string, today: string) => `- [x] ${name} #todo 📅 ${today} ✅ ${today}`;
const captured = (text: string, today: string) => `- [ ] ${text} #todo ➕ ${today}`;

function todo(openLines: readonly string[], doneLines: readonly string[] = [OLD_DONE]): string {
  return ['---', 'title: To-Do List', '---', '', '## Open', '', ...openLines, '', '## Done', '', ...doneLines, ''].join('\n');
}

const test = base.extend<{ stack: RealStack; seedOpen: readonly string[] }>({
  seedOpen: [['Synthetic chore 01', 'Synthetic chore 02'], { option: true }],
  stack: async ({ seedOpen }, use) => {
    const today = todayIn();
    const stack = await startRealStack({ [TODO]: todo(seedOpen.map((n) => open(n, today))) });
    try {
      await use(stack);
      // A18: no task or note text reaches the server's log sink.
      expect(JSON.stringify(stack.server.logs)).not.toContain('Synthetic');
    } finally {
      await stack.close();
    }
  },
});

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const actions = (page: Page) => region(page, 'Actions on this device').getByTestId('action');
const appCommits = (stack: RealStack) => stack.commits().filter((c) => c.operationId !== '');

async function load(page: Page, stack: RealStack, first: string): Promise<void> {
  // B2: the Actions list is collapsed by default; these checks read its rows (own origin, so not the config's storage).
  await page.addInitScript(() => localStorage.setItem('vc.actionsOpen', '1'));
  await page.goto(stack.origin);
  await expect(region(page, 'Today').getByText(first)).toBeVisible();
}

async function capture(page: Page, kind: 'Task' | 'Note', text: string): Promise<void> {
  await page.getByRole('button', { name: 'Capture' }).click();
  await page.getByRole('button', { name: kind, exact: true }).click();
  await page.getByLabel(`${kind} text`).fill(text);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel(`${kind} text`)).toHaveCount(0);
}

const CHORES = Array.from({ length: 10 }, (_, i) => `Synthetic chore ${String(i + 1).padStart(2, '0')}`);

test.describe('offline burst', () => {
  test.use({ seedOpen: CHORES });

  test('26 offline actions all land exactly once, are acknowledged, and the saved list drains', async ({ page, context, stack }) => {
    test.setTimeout(180_000);
    const today = todayIn();
    await load(page, stack, CHORES[0]!);

    await context.setOffline(true);
    const tasks = Array.from({ length: 8 }, (_, i) => `Synthetic capture ${String(i + 1).padStart(2, '0')}`);
    const notes = Array.from({ length: 8 }, (_, i) => `Synthetic thought ${String(i + 1).padStart(2, '0')}`);
    for (let i = 0; i < CHORES.length; i++) {
      await page.getByRole('button', { name: `Complete: ${CHORES[i]}` }).click();
      const task = tasks[i];
      if (task) await capture(page, 'Task', task);
      const note = notes[i];
      if (note) await capture(page, 'Note', note);
    }
    await expect(actions(page)).toHaveCount(26);
    await expect(actions(page).filter({ hasText: 'On this device' })).toHaveCount(26);
    expect(appCommits(stack)).toHaveLength(0);

    await context.setOffline(false);
    // Every action committed exactly once: one commit per operation, 26 operations.
    await expect.poll(() => appCommits(stack).length, { timeout: 120_000 }).toBe(26);
    expect(new Set(appCommits(stack).map((c) => c.operationId)).size).toBe(26);

    // Receipts → known → acknowledged → watermark → eviction: all 26 acknowledged, the oldest 6 evicted (20 kept).
    await expect(actions(page)).toHaveCount(20, { timeout: 60_000 });
    await expect(actions(page).filter({ hasText: 'Saved to GitHub' })).toHaveCount(20);
    // Only acknowledged receipts can be cleared: an empty list proves every remaining one was acknowledged.
    await region(page, 'Actions on this device').getByRole('button', { name: 'Clear saved' }).click();
    await expect(region(page, 'Actions on this device')).toHaveCount(0);

    // The vault has each change exactly once, byte for byte. The queue orders only actions on the same task, so
    // independent captures and completions may land in any order: the order is read back, the lines are not.
    const file = stack.read(TODO);
    const lines = file.split('\n');
    const capturedLines = lines.filter((l) => l.startsWith('- [ ] Synthetic capture'));
    const doneLines = lines.filter((l) => l.startsWith('- [x] Synthetic chore'));
    expect(capturedLines.toSorted()).toEqual(tasks.map((t) => captured(t, today)));
    expect(doneLines.toSorted()).toEqual(CHORES.map((c) => done(c, today)));
    expect(file).toBe(todo(capturedLines, [...doneLines, OLD_DONE]));
    for (const note of notes) {
      expect(stack.read(`Inbox/${note} - ${today}.md`).split(note)).toHaveLength(2);
    }
    // The screen shows the vault: every capture listed once, no chore left open.
    await goTo(page, 'All');
    for (const t of tasks) await expect(region(page, 'All tasks').getByText(t, { exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Complete: Synthetic chore/ })).toHaveCount(0);
  });
});

test('Undo tapped before the completion receipt arrives: one completion commit, one undo commit, task open again', async ({ page, stack }) => {
  const today = todayIn();
  const seed = stack.read(TODO);
  await load(page, stack, 'Synthetic chore 01');

  const release = stack.holdCommandResponses();
  await page.getByRole('button', { name: 'Complete: Synthetic chore 01' }).click();
  // The server has committed the completion; its receipt is held on the wire.
  await expect.poll(() => stack.held()).toBe(1);
  expect(appCommits(stack)).toHaveLength(1);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(actions(page)).toHaveCount(2);
  await expect(actions(page).filter({ hasText: 'Saved to GitHub' })).toHaveCount(0);
  release();

  await expect(actions(page).filter({ hasText: 'Saved to GitHub' })).toHaveCount(2);
  const commits = appCommits(stack);
  expect(commits).toHaveLength(2);
  expect(new Set(commits.map((c) => c.operationId)).size).toBe(2);
  expect(stack.read(TODO)).toBe(seed);
  expect(seed).toContain(open('Synthetic chore 01', today));
  await expect(region(page, 'Today').getByRole('button', { name: 'Complete: Synthetic chore 01' })).toBeVisible();
  await expect(region(page, 'Done today').getByText('Synthetic chore 01')).toHaveCount(0);
});

test('desktop conflict markers block task writes with a banner; resolved on the desktop, writes resume', async ({ page, stack }) => {
  const today = todayIn();
  const { desktop } = stack;
  await load(page, stack, 'Synthetic chore 01');

  // The desktop edits a line the phone completes concurrently; its sync commits the merge with markers (W4).
  const edited = open('Synthetic chore 01 on the desktop', today);
  desktop.edit(TODO, (t) => t.replace(open('Synthetic chore 01', today), edited));
  await page.getByRole('button', { name: 'Complete: Synthetic chore 01' }).click();
  await expect(actions(page).filter({ hasText: 'Saved to GitHub' })).toHaveCount(1);
  expect(desktop.sync()).toMatchObject({ integrated: 'conflict', conflicts: [TODO], pushed: true });
  expect(stack.read(TODO)).toContain('<<<<<<< ');

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert').first()).toContainText('Your task list has a sync conflict');
  await expect(page.getByRole('button', { name: /^Complete:/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByRole('button', { name: 'Task', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close' }).click();

  // The owner resolves it on the desktop (keeps the desktop edit) and syncs.
  desktop.edit(TODO, (t) => t.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> [^\n]*\n/, '$1'));
  expect(desktop.sync()).toMatchObject({ integrated: 'up-to-date', pushed: true });

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Your task list has a sync conflict')).toHaveCount(0);
  await page.getByRole('button', { name: 'Complete: Synthetic chore 02' }).click();
  await expect(actions(page).filter({ hasText: 'Saved to GitHub' })).toHaveCount(2);
  expect(appCommits(stack)).toHaveLength(2);
  expect(stack.read(TODO)).toBe(todo([edited], [done('Synthetic chore 02', today), done('Synthetic chore 01', today), OLD_DONE]));
});
