import { afterEach, expect, it, vi } from 'vitest';
import { Command, LearningResponse, LearningSession } from './index.ts';

const base = { kind: 'dictation', date: '2026-10-04', minutes: 15, score: 7, detail: 'acc 8', topic: 'weather report' };

it('accepts a valid LearningSession and its Undo command', () => {
  expect(LearningSession.safeParse(base).success).toBe(true);
  const target = Command.parse({
    schemaVersion: 1,
    operationId: '00000000-0000-4000-8000-000000000001',
    type: 'LogLearning',
    payload: { session: base },
    occurredAt: '2026-10-04T10:00:00Z',
    baseRevision: '1'.repeat(40),
  });
  expect(Command.safeParse({ ...target, type: 'UndoLogLearning', payload: { target, targetCommit: '2'.repeat(40) } }).success).toBe(true);
});

it.each([
  { kind: '' }, { kind: 'a\rb' }, { kind: 'a|b' },
  { date: '2026-02-30' }, { date: '04/10/2026' },
  { minutes: -1 }, { minutes: 1.5 }, { minutes: 601 },
  { score: '123456789' }, { score: 'a|b' },
  { detail: 'a\nb' }, { topic: 'a\rb' }, { note: 'a\u2028b' },
])('rejects invalid session %#', (changes) => {
  expect(LearningSession.safeParse({ ...base, ...changes }).success).toBe(false);
});

it('accepts a numeric or 3/5-style score and no minutes', () => {
  expect(LearningSession.safeParse({ kind: 'dictation', date: '2026-10-04', score: '3/5' }).success).toBe(true);
  expect(LearningSession.safeParse({ kind: 'dictation', date: '2026-10-04', score: 10 }).success).toBe(true);
});

it('parses a learning response', () => {
  expect(LearningResponse.parse({
    status: 'ok',
    revision: '1'.repeat(40),
    blobSha: '2'.repeat(40),
    kinds: [{ id: 'dictation', name: 'Dictation', scoreMeans: 'accuracy', status: 'active' }],
    rows: [{ date: '2026-10-04', kind: 'dictation', minutes: '15', score: '7', detail: 'acc 8', topic: 'weather report', note: '' }],
    unknownLines: [],
  }).status).toBe('ok');
});

afterEach(() => vi.useRealTimers());
