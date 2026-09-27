import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from '@vault-companion/contracts';
import { activeWorkChanges, activeWorkRows, reviewInSevenDays, type ActiveWorkRead } from './active-work.ts';
import { captureActiveWork, editActiveWork, reviewActiveWork, undoActiveWork, undoActiveWorkDraft, isUndoDraft, withTargetCommit, exportText, bindUndoTarget } from './commands.ts';
import { getActiveWork, linkedNoteHeader } from './api.ts';
import { attentionText, canRetry } from './ui/ActionsPanel.tsx';
import type { QueueItem } from './queue/queue.ts';

const ctx = { baseRevision: '1'.repeat(40), now: new Date('2026-09-27T12:00:00Z'), newId: () => '11111111-1111-4111-8111-111111111111' };
const locator = { path: 'Tasks/Active Work Now.md' as const, blobSha: '2'.repeat(40), lineIndex: 3, lineText: '- [ ] **Garden:** Next: order seeds ⏳ 2026-09-01', occurrencesAtRead: 1 };
const item = { locator, name: 'Garden', next: 'order seeds', outcome: null, review: '2026-09-01', link: null, needsReview: true };
const read: ActiveWorkRead = { status: 'ok', revision: ctx.baseRevision, blobSha: locator.blobSha, markdown: '## Now', items: [item], unknownNowLines: ['hand-edited line'], today: '2026-09-27' };
const review = reviewActiveWork(ctx, { item: locator, action: 'done' });
const queued: QueueItem = { operationId: review.operationId, seq: 1, type: review.type, envelope: review, label: item.name, taskKey: 'active-work', accountKey: 'a', state: 'pending', error: null, everSent: false, accountMismatch: false, receipt: null, acknowledged: false };
afterEach(() => vi.unstubAllGlobals());

describe('Active Work builders and view', () => {
  it('builds captures and each review action; rejects invalid drop reasons', () => {
    const capture = captureActiveWork(ctx, { name: 'Garden', next: 'order seeds', review: '2026-10-04', link: '[[Garden Plan]]' });
    expect(Command.parse(capture).payload).toEqual(capture.payload);
    expect(exportText(capture)).toContain('Garden Plan');
    for (const action of ['keep', 'done', 'park'] as const) expect(reviewActiveWork(ctx, { item: locator, action }).payload).toEqual({ item: locator, action });
    expect(reviewActiveWork(ctx, { item: locator, action: 'drop', reason: 'No longer needed' }).payload.action).toBe('drop');
    for (const reason of ['', 'a'.repeat(201), 'a\nb']) expect(() => reviewActiveWork(ctx, { item: locator, action: 'drop', reason })).toThrow();
    expect(() => captureActiveWork(ctx, { name: '', link: 'bad' })).toThrow();
  });
  it('sends trimmed changed fields only, with null clearing', () => {
    expect(activeWorkChanges(item, 'Garden  ', 'order seeds ', '2026-09-01')).toEqual({});
    const changes = activeWorkChanges(item, 'Herbs ', ' ', '');
    expect(changes).toEqual({ name: 'Herbs', next: null, review: null });
    const edit = editActiveWork(ctx, locator, changes);
    expect(edit.payload).toEqual({ item: locator, changes });
    expect(exportText(edit)).toContain('Herbs');
    expect(() => editActiveWork(ctx, locator, {})).toThrow();
  });
  it('uses Copenhagen today plus seven calendar days across midnight and DST', () => {
    expect(reviewInSevenDays(new Date('2026-09-27T22:30:00Z'))).toBe('2026-10-05');
    expect(reviewInSevenDays(new Date('2026-10-24T22:30:00Z'))).toBe('2026-11-01');
  });
  it('retains the exact review envelope and validates the receipt token after drafting', () => {
    const draft = undoActiveWorkDraft(ctx, review);
    expect(isUndoDraft(draft)).toBe(true);
    expect(Command.safeParse(draft).success).toBe(false);
    const final = withTargetCommit(draft, '3'.repeat(40));
    expect(isUndoDraft(final)).toBe(false);
    expect(final).toEqual(undoActiveWork(ctx, review, '3'.repeat(40)));
    expect(final.payload).toEqual({ target: review, targetCommit: '3'.repeat(40) });
    expect(exportText(final)).toContain(locator.lineText);
    const rebased = { ...review, baseRevision: '4'.repeat(40) };
    expect(bindUndoTarget(draft, rebased)?.payload).toEqual({ target: rebased });
  });
  it('shows server items unchanged, blocks pending actions by occurrence, and isolates accounts', () => {
    expect(activeWorkRows(read, [queued], 'a')[0]).toEqual({ item, action: queued, blocked: true });
    expect(activeWorkRows(read, [queued], 'b')[0]?.blocked).toBe(false);
    const duplicate = { ...item, locator: { ...locator, lineIndex: 4 } };
    expect(activeWorkRows({ ...read, items: [item, duplicate] }, [queued], 'a').map((r) => r.blocked)).toEqual([true, false]);
    expect(read.unknownNowLines).toEqual(['hand-edited line']);
    expect(activeWorkRows(read, [{ ...queued, state: 'saved' }], 'a')[0]?.blocked).toBe(false);
  });
  it('shows exact inverse refusals and does not block Active Work retries on task-only guards', () => {
    const undo = undoActiveWork(ctx, review, '3'.repeat(40));
    const failed = { ...queued, type: undo.type, envelope: undo, state: 'attention' as const, error: { code: 'refused:undo-expired', message: 'No longer exact' } };
    expect(attentionText(failed)).toContain('undo it in Obsidian');
    expect(canRetry(failed)).toBe(false);
    expect(canRetry(queued, { writeBlock: { code: 'refused:structure', message: 'Blocked', retryable: false } })).toBe(true);
  });
  it('strips future read fields for every status while validating required fields', async () => {
    for (const body of [read, { status: 'absent', revision: ctx.baseRevision }, { status: 'refused', revision: ctx.baseRevision, code: 'encoding', message: 'Cannot read' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...body, future: true }))));
      expect(await getActiveWork()).toEqual({ kind: 'ok', data: body });
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...read, items: 'bad' }))));
    expect((await getActiveWork()).kind).toBe('error');
  });
  it('sends Active Work linked-note locators in the existing private header shape', () => {
    const req = { taskLocator: locator, linkIndex: 0 };
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(linkedNoteHeader(req).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    expect(decoded).toEqual(req);
  });
});
