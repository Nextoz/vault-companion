import { describe, expect, it } from 'vitest';
import { completeTask } from '../commands.ts';
import type { QueueItem } from '../queue/queue.ts';
import { attentionText, canRetry, CLOCK_SKEW_TEXT } from './ActionsPanel.tsx';

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

  it('explains a changed task in plain words; other errors keep the server message', () => {
    expect(attentionText(attention('conflict:task-changed'))).toBe('This task changed on another device.');
    expect(attentionText(attention('refused:recurring'))).toBe('Server words.');
    expect(attentionText(attention('clock-skew'))).toBe("Check your phone's date and time, then redo the action.");
    expect(CLOCK_SKEW_TEXT).toBe("Check your phone's date and time, then redo the action.");
  });
});
