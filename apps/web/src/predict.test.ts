import { Command, type GameRecordWire, type GameResponse } from '@vault-companion/contracts';
import { characterConfig, computeCharacter, gameFeedback, wireCharacter } from '@vault-companion/domain/game';
import { describe, expect, it } from 'vitest';
import { dateIn, PredictionLedger, predictGame, recordFor, undoTarget, type LedgerItem } from './predict.ts';

const OP = '11111111-1111-4111-8111-111111111111';
const envelope = (type: string, payload: unknown) => Command.parse({ schemaVersion: 1, operationId: OP, type, occurredAt: '2026-10-23T10:00:00Z', baseRevision: 'a'.repeat(40), payload });
const NOW = new Date('2026-10-23T21:30:00Z');

function read(records: GameRecordWire[], overrides: Partial<GameResponse> = {}): GameResponse {
  const c = computeCharacter(records, characterConfig, '2026-10-23');
  return {
    revision: 'a'.repeat(40), now: NOW.toISOString(), character: wireCharacter(c), feedback: gameFeedback(c, characterConfig),
    rules: {} as GameResponse['rules'], stepMilestones: null, unavailable: [], records, timeZone: 'Europe/Copenhagen', ...overrides,
  };
}

describe('recordFor (ADR-0067)', () => {
  it('shapes each earning command like the Worker slim record', () => {
    const gym = envelope('LogTraining', { session: { type: 'Gym', split: 'Legs', when: '2026-10-23T22:30:00Z', duration: 35 } });
    // 22:30 UTC is 00:30 the next day in Copenhagen: the row's date, as formatTrainingRow writes it.
    expect(recordFor(gym, 'Europe/Copenhagen')).toEqual({ source: 'training', date: '2026-10-24', type: 'Gym', duration: '35 min' });
    const dictation = envelope('LogLearning', { session: { kind: 'dictation', date: '2026-10-23', minutes: 20, topic: 'H.C. Andersen' } });
    expect(recordFor(dictation, 'Europe/Copenhagen')).toEqual({ source: 'learning', date: '2026-10-23', kind: 'dictation', minutes: '20', topic: 'H.C. Andersen' });
    expect(recordFor(envelope('LogLearning', { session: { kind: 'dictation', date: '2026-10-23' } }), 'Europe/Copenhagen')).toMatchObject({ minutes: '' });
    const done = envelope('CompleteTask', { task: { path: 'Tasks/To-Do List.md', blobSha: 'b'.repeat(40), lineIndex: 3, lineText: '- [ ] Synthetic', occurrencesAtRead: 1 } });
    expect(recordFor(done, 'Europe/Copenhagen')).toEqual({ source: 'task', date: '2026-10-23', id: `local:${OP}`, overdueDays: 0 });
  });

  it('makes a finished Active Work item a quest and predicts nothing for other reviews', () => {
    const review = (action: string) => envelope('ReviewActiveWork', { item: { path: 'Tasks/Active Work Now.md', blobSha: 'b'.repeat(40), lineIndex: 4, lineText: '- Synthetic item', occurrencesAtRead: 1 }, action });
    expect(recordFor(review('done'), 'Europe/Copenhagen')).toEqual({ source: 'quest', date: '2026-10-23', id: `local:${OP}` });
    expect(recordFor(review('keep'), 'Europe/Copenhagen')).toBeNull();
  });

  it('names the target of an Undo', () => {
    const target = envelope('LogLearning', { session: { kind: 'dictation', date: '2026-10-23' } });
    const undo = Command.parse({ ...target, operationId: '22222222-2222-4222-8222-222222222222', type: 'UndoLogLearning', payload: { target, targetCommit: 'c'.repeat(40) } });
    expect(undoTarget(undo)).toBe(OP);
    expect(undoTarget(target)).toBeNull();
  });
});

describe('predictGame (ADR-0067)', () => {
  const tasks = Array.from({ length: 9 }, (_, i): GameRecordWire => ({ source: 'task', date: '2026-10-23', id: `t${i}`, overdueDays: 0 }));
  const tenth: GameRecordWire = { source: 'task', date: '2026-10-23', id: 'local:x', overdueDays: 0 };

  it('equals what the Worker computes once the record is saved', () => {
    const predicted = predictGame(read(tasks), [tenth], NOW)!;
    const server = read([...tasks, tenth]);
    expect(predicted.character).toEqual(server.character);
    expect(predicted.feedback).toEqual(server.feedback);
    expect(predicted.character.achievements.find((a) => a.id === 'quartermaster-tasks-10')?.earned).toBe(true);
    // A new revision each time, so the reward diff never mistakes a prediction for "nothing changed".
    expect(predicted.revision).not.toBe(read(tasks).revision);
  });

  it('refuses reads it cannot extend safely', () => {
    expect(predictGame(read(tasks, { records: undefined }), [tenth], NOW)).toBeNull();
    expect(predictGame(read(tasks, { timeZone: undefined }), [tenth], NOW)).toBeNull();
    expect(predictGame(read(tasks, { unavailable: ['tasks'] }), [tenth], NOW)).toBeNull();
    const old = read(tasks);
    expect(predictGame({ ...old, character: { ...old.character, rulesVersion: 2 } }, [tenth], NOW)).toBeNull();
  });

  it('dates in the given zone', () => {
    expect(dateIn('2026-10-23T22:30:00Z', 'Europe/Copenhagen')).toBe('2026-10-24');
    expect(dateIn('2026-10-23T22:30:00Z', 'UTC')).toBe('2026-10-23');
  });
});

describe('PredictionLedger (ADR-0067 review: Undo, refusals, cancels, lagging reads)', () => {
  const ACC = 'acct';
  const TZ = 'Europe/Copenhagen';
  const opId = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const learnCmd = (n: number) => Command.parse({ schemaVersion: 1, operationId: opId(n), type: 'LogLearning', occurredAt: '2026-10-23T10:00:00Z', baseRevision: 'a'.repeat(40), payload: { session: { kind: 'dictation', date: '2026-10-23', topic: `text ${n}` } } });
  const undoCmd = (n: number, target: number) => Command.parse({ schemaVersion: 1, operationId: opId(n), type: 'UndoLogLearning', occurredAt: '2026-10-23T10:01:00Z', baseRevision: 'a'.repeat(40), payload: { target: learnCmd(target), targetCommit: 'c'.repeat(40) } });
  const item = (envelope: Command, state: LedgerItem['state'] = 'pending', acknowledged = false): LedgerItem => ({ operationId: envelope.operationId, state, envelope, accountKey: ACC, accountMismatch: false, acknowledged });
  const row = (n: number): GameRecordWire => ({ source: 'learning', date: '2026-10-23', kind: 'dictation', minutes: '', topic: `text ${n}` });
  const base = read([]);

  it('predicts a new unsaved action once, and never one first seen saved', () => {
    const ledger = new PredictionLedger();
    expect(ledger.observe([item(learnCmd(1))], ACC, TZ)).toEqual({ changed: true, gain: true });
    expect(ledger.observe([item(learnCmd(1), 'saving')], ACC, TZ)).toEqual({ changed: false, gain: false });
    expect(ledger.observe([item(learnCmd(1), 'saving'), item(learnCmd(2), 'saved')], ACC, TZ).changed).toBe(false);
    expect(ledger.records()).toEqual([row(1)]);
  });

  it('drops a prediction whose action left the queue unsaved (local Undo of an unsent action, discard)', () => {
    const ledger = new PredictionLedger();
    ledger.observe([item(learnCmd(1))], ACC, TZ);
    expect(ledger.observe([], ACC, TZ)).toEqual({ changed: true, gain: false });
    expect(ledger.records()).toEqual([]);
  });

  it('keeps a saved prediction when the item leaves the queue, until a read shows it', () => {
    const ledger = new PredictionLedger();
    ledger.observe([item(learnCmd(1))], ACC, TZ);
    ledger.observe([item(learnCmd(1), 'saved')], ACC, TZ);
    ledger.observe([], ACC, TZ);
    expect(ledger.records()).toEqual([row(1)]);
    // A read with a new revision that does not show the record yet (lagging) keeps it.
    ledger.settle(base, { ...base, revision: 'd'.repeat(40) }, new Set([opId(1)]), new Set());
    expect(ledger.records()).toEqual([row(1)]);
    ledger.settle(base, { ...base, revision: 'e'.repeat(40), records: [{ ...row(1) }] }, new Set(), new Set());
    expect(ledger.records()).toEqual([]);
  });

  it('settles by content, not timing: a read showing B but not A settles only B', () => {
    const ledger = new PredictionLedger();
    ledger.observe([item(learnCmd(1)), item(learnCmd(2))], ACC, TZ);
    ledger.settle(base, { ...base, revision: 'd'.repeat(40), records: [row(2)] }, new Set([opId(1), opId(2)]), new Set());
    expect(ledger.records()).toEqual([row(1)]);
  });

  it('drops a prediction the queue acknowledged before the read, even without a content match', () => {
    const ledger = new PredictionLedger();
    ledger.observe([item(learnCmd(1))], ACC, TZ);
    ledger.settle(base, { ...base, revision: 'd'.repeat(40) }, new Set(), new Set([opId(1)]));
    expect(ledger.records()).toEqual([]);
  });

  it('drops a refused action silently', () => {
    const ledger = new PredictionLedger();
    ledger.observe([item(learnCmd(1))], ACC, TZ);
    expect(ledger.observe([item(learnCmd(1), 'attention')], ACC, TZ)).toEqual({ changed: true, gain: false });
    expect(ledger.records()).toEqual([]);
  });

  it('Undo lowers at once, stays quiet until the Undo is read, and a refused Undo restores silently', () => {
    const ledger = new PredictionLedger();
    ledger.observe([item(learnCmd(1), 'saving')], ACC, TZ);
    expect(ledger.observe([item(learnCmd(1), 'saving'), item(undoCmd(2, 1))], ACC, TZ)).toEqual({ changed: true, gain: false });
    expect(ledger.records()).toEqual([]);
    expect(ledger.quiet).toBe(true);
    expect(ledger.observe([item(learnCmd(1), 'saved'), item(undoCmd(2, 1), 'attention')], ACC, TZ)).toEqual({ changed: true, gain: false });
    expect(ledger.records()).toEqual([row(1)]);
    expect(ledger.quiet).toBe(false);
  });

  it('an undone target the read already shows is never restored (no double count)', () => {
    const ledger = new PredictionLedger();
    ledger.observe([item(learnCmd(1), 'saving')], ACC, TZ);
    ledger.observe([item(learnCmd(1), 'saved'), item(undoCmd(2, 1))], ACC, TZ);
    ledger.settle(base, { ...base, revision: 'd'.repeat(40), records: [row(1)] }, new Set([opId(1)]), new Set());
    expect(ledger.quiet).toBe(true);
    ledger.observe([item(learnCmd(1), 'saved'), item(undoCmd(2, 1), 'attention')], ACC, TZ);
    expect(ledger.records()).toEqual([]);
  });

  it('a saved Undo ends the quiet period once a read starts after it', () => {
    const ledger = new PredictionLedger();
    ledger.observe([item(learnCmd(1), 'saving'), item(undoCmd(2, 1))], ACC, TZ);
    ledger.observe([item(learnCmd(1), 'saved'), item(undoCmd(2, 1), 'saved')], ACC, TZ);
    ledger.settle(base, { ...base, revision: 'd'.repeat(40) }, new Set([opId(1), opId(2)]), new Set());
    expect(ledger.quiet).toBe(false);
  });

  it('ignores other accounts and waits for a time zone', () => {
    const ledger = new PredictionLedger();
    expect(ledger.observe([{ ...item(learnCmd(1)), accountKey: 'other' }], ACC, TZ).changed).toBe(false);
    expect(ledger.observe([item(learnCmd(2))], ACC, null).changed).toBe(false);
    expect(ledger.records()).toEqual([]);
  });
});

it('PredictionLedger: a saved Undo whose receipt already left the queue still ends the quiet period', () => {
  const ACC = 'acct';
  const target = Command.parse({ schemaVersion: 1, operationId: '33333333-1111-4111-8111-111111111111', type: 'LogLearning', occurredAt: '2026-10-23T10:00:00Z', baseRevision: 'a'.repeat(40), payload: { session: { kind: 'dictation', date: '2026-10-23' } } });
  const undo = Command.parse({ ...target, operationId: '44444444-1111-4111-8111-111111111111', type: 'UndoLogLearning', payload: { target, targetCommit: 'c'.repeat(40) } });
  const item = (envelope: Command, state: LedgerItem['state']): LedgerItem => ({ operationId: envelope.operationId, state, envelope, accountKey: ACC, accountMismatch: false, acknowledged: false });
  const ledger = new PredictionLedger();
  ledger.observe([item(target, 'saving'), item(undo, 'pending')], ACC, 'Europe/Copenhagen');
  ledger.observe([item(target, 'saved'), item(undo, 'saved')], ACC, 'Europe/Copenhagen');
  // Both receipts are evicted before any read settles.
  ledger.observe([], ACC, 'Europe/Copenhagen');
  expect(ledger.quiet).toBe(true);
  const base = read([]);
  ledger.settle(base, { ...base, revision: 'd'.repeat(40) }, ledger.savedSnapshot(), new Set());
  expect(ledger.quiet).toBe(false);
});
