import { describe, expect, it } from 'vitest';
import { editTask, exportText } from './commands.ts';
import type { TaskLocator } from '@vault-companion/contracts';

const task: TaskLocator = { path: 'Tasks/To-Do List.md', blobSha: '2'.repeat(40), lineIndex: 10,
  lineText: '- [ ] Water the plants', occurrencesAtRead: 1 };
const ctx = { baseRevision: '1'.repeat(40), now: new Date('2026-09-24T10:00:00Z'),
  newId: () => '11111111-1111-4111-8111-111111111111' };
describe('editTask', () => {
  it('mints a validated envelope containing only supplied changes', () => {
    const command = editTask(ctx, task, { text: 'Water the herbs', due: '2026-09-25' });
    expect(command).toMatchObject({ type: 'EditTask', operationId: ctx.newId(), baseRevision: ctx.baseRevision, schemaVersion: 1 });
    expect(command.payload).toEqual({ task, changes: { text: 'Water the herbs', due: '2026-09-25' } });
    expect(new Date(command.occurredAt)).toEqual(ctx.now);
    expect(exportText(command)).toBe('Water the herbs');
  });
  it('preserves explicit clearing and exports the original text for metadata-only edits', () => {
    const command = editTask(ctx, task, { due: null, scheduled: null, priority: null });
    expect(command.payload.changes).toEqual({ due: null, scheduled: null, priority: null });
    expect(exportText(command)).toBe(task.lineText);
  });
  it('rejects empty changes, multiline text and invalid dates', () => {
    expect(() => editTask(ctx, task, {})).toThrow();
    expect(() => editTask(ctx, task, { text: 'one\ntwo' })).toThrow();
    expect(() => editTask(ctx, task, { due: '2026-02-30' })).toThrow();
  });
});
