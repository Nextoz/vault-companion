// ADR-0021: completion history from To-Do `## Done` and Active Work `## Dropped or done`. Synthetic vault only.
import { ACTIVE_WORK_PATH, HistoryResponse, MAX_HISTORY_ITEMS } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { createHistoryService } from './history.ts';
import { StoreUnavailable } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const TODO = 'Tasks/To-Do List.md';
const TODO_TEXT = [
  '## Open',
  '- [ ] Buy compost #todo',
  '## Done',
  '- [x] Water the plants #todo ✅ 2026-09-25',
  '- [x] Call the [[Garden Shop]] #todo ✅ 2026-09-26',
  '- [x] Undated done line #todo',
  '- [-] Cancelled chore #todo ❌ 2026-09-26',
  '- [x] Dropped chore #todo ❌ 2026-09-26',
  '- [x] Late evening task #todo ✅ 2026-09-26',
  '',
].join('\n');
const AW_TEXT = [
  '## Now',
  '- [ ] **Bike repair:** commuting. Next: call the shop',
  '## Dropped or done',
  '- 2026-09-18: an older prose entry. [[Archive/Old]]',
  '- [ ] **Old idea:** stopped ❌ 2026-09-26 not needed',
  '- [x] **Garden plan:** beds ready [[Garden Plan|plan]] ✅ 2026-09-26',
  '- [x] **Shed:** ✅ 2026-09-24',
  '',
].join('\n');

async function history(files: Record<string, string>, tweak?: (s: InMemoryStore) => void) {
  const store = await InMemoryStore.create(files);
  tweak?.(store);
  const r = await createHistoryService({ store, timeZone: 'Europe/Copenhagen', now: () => new Date('2026-09-26T22:30:00Z') }).readHistory();
  return { r, store };
}
const items = (r: unknown) => HistoryResponse.parse(r).items;

describe('completion history', () => {
  it('reads both sources at one head, newest day first, file order within a day, without cancelled/undated/prose', async () => {
    const { r, store } = await history({ [TODO]: TODO_TEXT, [ACTIVE_WORK_PATH]: AW_TEXT });
    expect(r).toMatchObject({ revision: store.headCommit, today: '2026-09-27' });
    expect(items(r).map((i) => [i.doneDate, i.source, i.description])).toEqual([
      ['2026-09-26', 'todo', 'Call the [[Garden Shop]]'],
      ['2026-09-26', 'todo', 'Late evening task'],
      ['2026-09-26', 'active-work', 'Garden plan: beds ready [[Garden Plan|plan]]'],
      ['2026-09-25', 'todo', 'Water the plants'],
      ['2026-09-24', 'active-work', 'Shed'],
    ]);
    expect(store.calls.filter((c) => c === 'head')).toHaveLength(1);
    expect(store.calls.filter((c) => c === 'readFile')).toHaveLength(2);
  });

  it('carries locators and link targets the linked-note path accepts', async () => {
    const [shop, , garden] = items((await history({ [TODO]: TODO_TEXT, [ACTIVE_WORK_PATH]: AW_TEXT })).r);
    expect(shop).toMatchObject({ links: ['Garden Shop'], locator: { path: TODO, lineIndex: 4, lineText: TODO_TEXT.split('\n')[4], occurrencesAtRead: 1 } });
    expect(garden).toMatchObject({ links: ['Garden Plan'], locator: { path: ACTIVE_WORK_PATH, lineIndex: 5, lineText: AW_TEXT.split('\n')[5] } });
  });

  it('dates are the Markdown dates as written (no time-zone shift at the day boundary)', async () => {
    const { r } = await history({ [TODO]: '## Open\n## Done\n- [x] Midnight task #todo ✅ 2026-09-26\n' });
    expect(items(r)).toEqual([expect.objectContaining({ doneDate: '2026-09-26' })]);
  });

  it('an absent Active Work file contributes no items', async () => {
    expect(items((await history({ [TODO]: TODO_TEXT })).r).every((i) => i.source === 'todo')).toBe(true);
  });

  it(`keeps the newest ${MAX_HISTORY_ITEMS} items`, async () => {
    const lines = Array.from({ length: MAX_HISTORY_ITEMS + 5 }, (_, i) => `- [x] Task ${i} #todo ✅ 2026-${String(1 + (i % 9)).padStart(2, '0')}-10`);
    const got = items((await history({ [TODO]: `## Open\n## Done\n${lines.join('\n')}\n` })).r);
    expect(got).toHaveLength(MAX_HISTORY_ITEMS);
    expect(got.at(-1)!.doneDate).toBe('2026-01-10');
    // Months 2–9 hold 893 of the 1,005 lines; the cut falls inside January.
    expect(got.filter((i) => i.doneDate === '2026-01-10')).toHaveLength(MAX_HISTORY_ITEMS - 893);
  });

  it('store outage ⇒ retryable upstream-unavailable', async () => {
    const { r } = await history({ [TODO]: TODO_TEXT }, (s) => {
      s.readFile = async () => {
        throw new StoreUnavailable('down');
      };
    });
    expect(r).toEqual({ code: 'upstream-unavailable', message: expect.any(String), retryable: true });
  });
});
