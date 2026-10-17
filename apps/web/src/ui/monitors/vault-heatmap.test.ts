import { VaultActivityResponse } from '@vault-companion/contracts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectVaultHeatmap } from './vault-heatmap.ts';

// Synthetic values, real producer schema (apps/web/src/ui/monitors/fixtures, schema captured 2026-10-16).
const fixture = VaultActivityResponse.parse({
  revision: 'a'.repeat(40),
  ...JSON.parse(readFileSync(new URL('./fixtures/vault-activity.json', import.meta.url), 'utf8')),
});
const GENERATED = Date.parse(fixture.generatedAt);
const view = projectVaultHeatmap(fixture, GENERATED + 60_000);

describe('projectVaultHeatmap', () => {
  it('summarises the streak and the month on one line', () => {
    expect(view.summary).toBe(`23-day streak · ${fixture.notesThisMonth} notes this month`);
  });

  it('puts every day in a cell: Monday-first rows, one column per week, today last', () => {
    expect(view.cells).toHaveLength(182);
    expect(view.cells[0]).toMatchObject({ date: '2026-04-18', row: 5, col: 0 }); // a Saturday
    expect(view.cells[2]).toMatchObject({ date: '2026-04-20', row: 0, col: 1 }); // the next Monday
    expect(view.cells.at(-1)).toMatchObject({ date: '2026-10-16', row: 4, today: true }); // a Friday
    expect(view.cells.filter((c) => c.today)).toHaveLength(1);
    expect(view.cols).toBe(view.cells.at(-1)!.col + 1);
  });

  it('levels by quartiles of the non-zero days: zero is 0, the bulk day is 4, every level is used', () => {
    const levels = new Set(view.cells.map((c) => c.level));
    expect([...levels].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(view.cells.filter((c) => c.notes === 0).every((c) => c.level === 0)).toBe(true);
    expect(view.cells.find((c) => c.notes === 310)!.level).toBe(4);
    // One huge day must not flatten the rest: fewer than half of the active days sit at level 1.
    expect(view.cells.filter((c) => c.level === 1).length).toBeLessThan(view.cells.filter((c) => c.level > 0).length * 0.5);
  });

  it('labels the month columns for each 1st inside the window', () => {
    expect(view.monthLabels.map((m) => m.label)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    const may = view.cells.find((c) => c.date === '2026-05-01')!;
    expect(view.monthLabels[0]).toEqual({ label: 'May', col: may.col });
  });

  it('shows the top five areas and folds the rest into Other, shares summing to 1', () => {
    expect(view.areas.map((a) => a.area)).toEqual(['Projects', 'Health', '(root)', 'Learning', 'Events', 'Other']);
    expect(view.areas.at(-1)).toMatchObject({ area: 'Other', notes: 17 });
    expect(view.areas.reduce((s, a) => s + a.share, 0)).toBeCloseTo(1, 6);
  });

  it('has no Other bucket with five or fewer areas, and survives an empty window', () => {
    const few = projectVaultHeatmap({ ...fixture, areas30d: fixture.areas30d.slice(0, 3), days: [] }, GENERATED);
    expect(few.areas.map((a) => a.area)).toEqual(['Projects', 'Health', '(root)']);
    expect(few).toMatchObject({ cells: [], cols: 0, monthLabels: [] });
  });

  it('is current inside 26 hours and stale after, with the footer in Copenhagen time', () => {
    // generatedAt is 05:40 local (+02:00).
    expect(projectVaultHeatmap(fixture, GENERATED + 25 * 3_600_000)).toMatchObject({ stale: false, footer: 'Vault git history · Updated 05:40' });
    const stale = projectVaultHeatmap(fixture, GENERATED + 27 * 3_600_000);
    expect(stale.stale).toBe(true);
    expect(stale.footer).toBe('Vault git history · Stale · Updated 16 Oct 05:40');
  });

  it('reads the footer time in the standard-time offset after the 25 Oct clock change', () => {
    const winter = { ...fixture, generatedAt: '2026-10-26T05:40:00+01:00' };
    expect(projectVaultHeatmap(winter, Date.parse(winter.generatedAt)).footer).toBe('Vault git history · Updated 05:40');
  });
});
