import { afterEach, expect, it, vi } from 'vitest';
import { Command, TrainingSession } from './index.ts';
const run = { type: 'Run', when: '2026-09-28T10:00:00+02:00', distance: 5.2, duration: 28 };
afterEach(() => vi.useRealTimers());
it('enforces the inclusive year-2000 instant lower bound', () => {
  for (const when of ['0001-01-01T12:00:00Z', '1999-12-31T23:59:59Z', '2000-01-01T00:00:00+01:00'])
    expect(TrainingSession.safeParse({ ...run, when }).success).toBe(false);
  for (const when of ['2000-01-01T00:00:00Z', '1999-12-31T23:00:00-01:00'])
    expect(TrainingSession.safeParse({ ...run, when }).success).toBe(true);
});
it.each([
  { distance: 0 }, { distance: 100.1 }, { duration: 0 }, { duration: 601 }, { duration: 1.1 },
  { when: '2026-09-28T10:00:00' }, { when: '2026-09-30T12:00:01Z' }, { note: 'x'.repeat(281) },
  { split: 'Bicep' }, { weight: 82.4 },
])('rejects invalid run %#', (changes) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  expect(TrainingSession.safeParse({ ...run, ...changes }).success).toBe(false);
});
it.each([{ split: 'Back' }, { weight: 29.9 }, { weight: 250.1 }, { distance: 2 }])('rejects invalid gym %#', (changes) => {
  expect(TrainingSession.safeParse({ type: 'Gym', when: run.when, split: 'Bicep', duration: 60, ...changes }).success).toBe(false);
});
const gym = { type: 'Gym', when: run.when, split: 'Bicep', duration: 60 } as const;
it('accepts Group with a class name, trimming it', () => {
  expect(TrainingSession.safeParse({ ...gym, split: 'Group', className: 'Functional Express' }).success).toBe(true);
  const parsed = TrainingSession.safeParse({ ...gym, split: 'Group', className: '  Functional Express  ' });
  expect(parsed.success && parsed.data.type === 'Gym' ? parsed.data.className : null).toBe('Functional Express');
});
it.each([
  { split: 'Group' }, { split: 'Group', className: '' }, { split: 'Group', className: '   ' },
  { split: 'Group', className: 'x'.repeat(61) }, { split: 'Group', className: 'a\rb' },
  { split: 'Group', className: 'a\nb' }, { split: 'Group', className: 'a\u2028b' }, { split: 'Group', className: 'a\u2029b' },
  { split: 'Bicep', className: 'Functional Express' }, { split: 'Legs', className: 'x' },
])('rejects invalid group class name %#', (changes) => {
  expect(TrainingSession.safeParse({ ...gym, ...changes }).success).toBe(false);
});
it('rejects a class name on a Run', () => {
  expect(TrainingSession.safeParse({ ...run, className: 'Functional Express' }).success).toBe(false);
});
it('accepts inclusive bounds, optional weight, notes with pipe/newline, and exactly one future day', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  for (const distance of [0.1, 100]) for (const duration of [1, 600])
    expect(TrainingSession.safeParse({ ...run, distance, duration, when: '2026-09-29T12:00:00Z', note: 'easy | loop\nagain' }).success).toBe(true);
  for (const weight of [undefined, 30, 250]) expect(TrainingSession.safeParse({ type: 'Gym', when: run.when, split: 'Legs', duration: 60, weight }).success).toBe(true);
  const target = Command.parse({ schemaVersion: 1, type: 'LogTraining', payload: { session: run }, operationId: '00000000-0000-4000-8000-000000000001', occurredAt: run.when, baseRevision: '1'.repeat(40) });
  expect(Command.safeParse({ ...target, type: 'UndoLogTraining', payload: { target, targetCommit: '2'.repeat(40) } }).success).toBe(true);
});
