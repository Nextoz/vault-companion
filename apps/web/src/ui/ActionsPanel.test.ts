import { describe, expect, it } from 'vitest';
import { completeTask } from '../commands.ts';
import type { QueueItem } from '../queue/queue.ts';
import { knownNotApplied } from '../queue/classify.ts';
import { attentionText, canRetry, CLOCK_SKEW_TEXT, UNDO_UNKNOWN_TEXT } from './ActionsPanel.tsx';

const envelope = completeTask({ baseRevision: '1'.repeat(40) }, {
  path: 'Tasks/To-Do List.md',
  blobSha: '2'.repeat(40),
  lineIndex: 3,
  lineText: '- [ ] Water the plants',
  occurrencesAtRead: 1,
});

const attention = (code: string, extra: Partial<QueueItem> = {}): QueueItem => ({
  operationId: envelope.operationId,
  seq: 1,
  type: 'CompleteTask',
  envelope,
  label: 'Water the plants',
  taskKey: null,
  accountKey: 'a'.repeat(64),
  state: 'attention',
  error: { code, message: 'Server words.' },
  everSent: true,
  accountMismatch: false,
  receipt: null,
  acknowledged: false,
  ...extra,
});

describe('attention next steps (P4-B)', () => {
  it('offers no Retry for refusals the same bytes cannot get past', () => {
    for (const code of ['conflict:task-changed', 'conflict:ambiguous', 'conflict:stale', 'refused:recurring', 'operation-id-reused', 'invalid']) {
      expect(canRetry(attention(code)), code).toBe(false);
    }
    expect(canRetry(attention('account-mismatch', { accountMismatch: true }))).toBe(false);
    // The stored envelope keeps its occurredAt: identical bytes are refused again (Lead addendum 4).
    expect(canRetry(attention('clock-skew'))).toBe(false);
  });

  it('keeps Retry where resending may still succeed, including after a sync conflict is resolved', () => {
    for (const code of ['dedupe-unknown', 'http-418', 'forbidden', 'refused:vault-conflict']) expect(canRetry(attention(code)), code).toBe(true);
  });

  it('withholds Retry for task-list actions while the read on screen is write-blocked, and restores it after', () => {
    const blocked = { writeBlock: { code: 'refused:vault-conflict' as const, message: 'Conflict markers.', retryable: false } };
    const conflicted = attention('refused:vault-conflict');
    expect(canRetry(conflicted, blocked)).toBe(false);
    expect(canRetry({ ...conflicted, type: 'CaptureTask' }, blocked)).toBe(false);
    expect(canRetry({ ...conflicted, type: 'UndoCompleteTask' }, blocked)).toBe(false);
    // A note does not touch the task list.
    expect(canRetry({ ...conflicted, type: 'CaptureNote' }, blocked)).toBe(true);
    // A fresh, unblocked read (or none yet): Retry is back.
    expect(canRetry(conflicted, { writeBlock: null })).toBe(true);
    expect(canRetry(conflicted, null)).toBe(true);
  });

  it('review O5: an Undo with an unknown outcome says it may already be applied, keeps Retry, and is not known-not-applied', () => {
    const undo = attention('dedupe-unknown', { type: 'UndoCompleteTask' });
    expect(attentionText(undo)).toBe(UNDO_UNKNOWN_TEXT);
    expect(UNDO_UNKNOWN_TEXT).toMatch(/may already have been applied/);
    expect(attentionText(undo)).not.toMatch(/Obsidian/);
    expect(canRetry(undo)).toBe(true);
    expect(knownNotApplied(undo.error)).toBe(false);
  });

  it('explains a changed task in plain words; other errors keep the server message', () => {
    expect(attentionText(attention('conflict:task-changed'))).toBe('This task changed on another device.');
    expect(attentionText(attention('refused:recurring'))).toBe('Server words.');
    expect(attentionText(attention('clock-skew'))).toBe("Check your phone's date and time, then redo the action.");
    expect(CLOCK_SKEW_TEXT).toBe("Check your phone's date and time, then redo the action.");
  });
});
