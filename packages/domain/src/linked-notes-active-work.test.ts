// ADR-0019: a link on an Active Work item opens through the same allowlisted linked-note path. Synthetic vault only.
import { ACTIVE_WORK_PATH, type ActiveWorkLocator } from '@vault-companion/contracts';
import { beforeEach, expect, it } from 'vitest';
import { createLinkedNoteService } from './linked-notes.ts';
import type { VaultPath } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const LINES = [
  '## Now',
  '',
  '- [ ] **Garden plan:** beds ready. Next: order seeds ⏳ 2026-10-03 [[Projects/Garden/Plan]]',
  '- [ ] **Budget:** review. Next: sort receipts ⏳ 2026-10-03 [[Finance/Budget]]',
  '- [ ] **No link:** just text. Next: think',
  '- [x] **Old plan:** done. [[Projects/Garden/Plan]] ✅ 2026-09-26',
  '',
];
let store: InMemoryStore;
let notes: ReturnType<typeof createLinkedNoteService>;
let blobSha: string;

beforeEach(async () => {
  store = await InMemoryStore.create({
    [ACTIVE_WORK_PATH]: LINES.join('\n'),
    'Projects/Garden/Plan.md': '# Plan\n',
    'Finance/Budget.md': '# Budget\n',
  });
  notes = createLinkedNoteService({ store });
  const head = (await store.head()).commitSha;
  blobSha = (await store.readFile(ACTIVE_WORK_PATH as VaultPath, head))!.blobSha;
});

const at = (lineIndex: number, over: Partial<ActiveWorkLocator> = {}): ActiveWorkLocator => ({
  path: ACTIVE_WORK_PATH, blobSha, lineIndex, lineText: LINES[lineIndex]!, occurrencesAtRead: 1, ...over,
});

it('opens the allowlisted note an Active Work item links to', async () => {
  const r = await notes.readLinkedNote({ taskLocator: at(2), linkIndex: 0 });
  expect(r).toMatchObject({ status: 'ok', path: 'Projects/Garden/Plan.md' });
});

it('refuses a note outside the allowlist, exactly as for task links', async () => {
  const r = await notes.readLinkedNote({ taskLocator: at(3), linkIndex: 0 });
  expect(r).toMatchObject({ status: 'refused', code: 'outside-allowlist' });
});

it('refuses when the file or the line changed since the read (no fuzzy re-location)', async () => {
  expect(await notes.readLinkedNote({ taskLocator: at(2, { blobSha: 'f'.repeat(40) }), linkIndex: 0 })).toMatchObject({ status: 'refused', code: 'task-changed' });
  expect(await notes.readLinkedNote({ taskLocator: at(2, { lineIndex: 3 }), linkIndex: 0 })).toMatchObject({ status: 'refused', code: 'task-changed' });
});

it('an item without a link, or any link index but 0, is not-found', async () => {
  expect(await notes.readLinkedNote({ taskLocator: at(4), linkIndex: 0 })).toMatchObject({ status: 'refused', code: 'not-found' });
  expect(await notes.readLinkedNote({ taskLocator: at(2), linkIndex: 1 })).toMatchObject({ status: 'refused', code: 'not-found' });
});

it('ADR-0021: a done item (history) opens its link before the appended done date', async () => {
  expect(await notes.readLinkedNote({ taskLocator: at(5), linkIndex: 0 })).toMatchObject({ status: 'ok', path: 'Projects/Garden/Plan.md' });
});
