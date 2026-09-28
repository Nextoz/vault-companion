import { afterEach, expect, it, vi } from 'vitest';
import { Command, TrainingSession } from './index.ts';
const run = { type: 'Run', when: '2026-09-28T10:00:00+02:00', distance: 5.2, duration: 28 };
afterEach(() => vi.useRealTimers());
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
it('accepts inclusive bounds, optional weight, notes with pipe/newline, and exactly one future day', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  for (const distance of [0.1, 100]) for (const duration of [1, 600])
    expect(TrainingSession.safeParse({ ...run, distance, duration, when: '2026-09-29T12:00:00Z', note: 'easy | loop\nagain' }).success).toBe(true);
  for (const weight of [undefined, 30, 250]) expect(TrainingSession.safeParse({ type: 'Gym', when: run.when, split: 'Legs', duration: 60, weight }).success).toBe(true);
  const target = Command.parse({ schemaVersion: 1, type: 'LogTraining', payload: { session: run }, operationId: '00000000-0000-4000-8000-000000000001', occurredAt: run.when, baseRevision: '1'.repeat(40) });
  expect(Command.safeParse({ ...target, type: 'UndoLogTraining', payload: { target, targetCommit: '2'.repeat(40) } }).success).toBe(true);
});
