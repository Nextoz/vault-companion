import { describe, expect, it } from 'vitest';
import { bindUndoTarget, editTask, exportText, isUndoDraft, logLearning, logReading, reportFeedback, saveReflection, startBook, undoLogLearning, undoLogLearningDraft, undoLogReading, undoLogReadingDraft, undoReportFeedback, undoReportFeedbackDraft, undoSaveReflection, undoSaveReflectionDraft, undoStartBook, undoStartBookDraft } from './commands.ts';
import { Command, type TaskLocator } from '@vault-companion/contracts';

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

const report = () => reportFeedback(ctx, { kind: 'bug', text: 'A synthetic thing broke', screen: 'Today', appVersion: 'dev', date: '2026-10-02' });

describe('reportFeedback (ADR-0040)', () => {
  it('mints a validated bug/wish envelope', () => {
    const command = report();
    expect(command).toMatchObject({ type: 'ReportFeedback', operationId: ctx.newId(), baseRevision: ctx.baseRevision, schemaVersion: 1 });
    expect(command.payload).toEqual({ kind: 'bug', text: 'A synthetic thing broke', screen: 'Today', appVersion: 'dev', date: '2026-10-02' });
  });
  it('rejects blank text, an oversized body and a screen the contract refuses', () => {
    expect(() => reportFeedback(ctx, { kind: 'bug', text: '   ', screen: 'Today', appVersion: 'dev', date: '2026-10-02' })).toThrow();
    expect(() => reportFeedback(ctx, { kind: 'wish', text: 'x'.repeat(1001), screen: 'Today', appVersion: 'dev', date: '2026-10-02' })).toThrow();
    expect(() => reportFeedback(ctx, { kind: 'wish', text: 'ok', screen: '1 screen', appVersion: 'dev', date: '2026-10-02' })).toThrow();
  });
  it('queues an Undo as an unsendable draft, then binds and tokens it to the durable target', () => {
    const target = report();
    const draft = undoReportFeedbackDraft(ctx, target);
    expect(draft).toMatchObject({ type: 'UndoReportFeedback', payload: { target } });
    expect(isUndoDraft(draft)).toBe(true);
    expect(() => Command.parse(draft)).toThrow(); // no targetCommit yet: never sent as-is

    const bound = bindUndoTarget(draft, target);
    expect(bound).toMatchObject({ type: 'UndoReportFeedback', payload: { target } });
    const other = reportFeedback(ctx, { kind: 'wish', text: 'other', screen: 'Notes', appVersion: 'dev', date: '2026-10-02' });
    expect(bindUndoTarget(draft, other)).toMatchObject({ payload: { target: other } });

    const token = 'a'.repeat(40);
    const undo = undoReportFeedback(ctx, target, token);
    expect(undo).toMatchObject({ type: 'UndoReportFeedback', payload: { target, targetCommit: token } });
    expect(Command.safeParse(undo).success).toBe(true);
    expect(exportText(undo)).toBe(exportText(target));
  });
});

const learning = () => logLearning(ctx, { kind: 'dictation', date: '2026-10-04', minutes: 15, score: '3/5', detail: 'acc 8', topic: 'weather report' });

describe('logLearning (ADR-0053)', () => {
  it('mints a validated envelope and exports its session', () => {
    const command = learning();
    expect(command).toMatchObject({ type: 'LogLearning', operationId: ctx.newId(), baseRevision: ctx.baseRevision, schemaVersion: 1 });
    expect(command.payload.session).toEqual({ kind: 'dictation', date: '2026-10-04', minutes: 15, score: '3/5', detail: 'acc 8', topic: 'weather report' });
    expect(exportText(command)).toContain('"3/5"');
  });
  it('rejects an unknown kind shape and a bad date', () => {
    expect(() => logLearning(ctx, { kind: 'a|b', date: '2026-10-04' })).toThrow();
    expect(() => logLearning(ctx, { kind: 'dictation', date: '2026-02-30' })).toThrow();
  });
  it('queues an Undo as an unsendable draft, then binds and tokens it', () => {
    const target = learning();
    const draft = undoLogLearningDraft(ctx, target);
    expect(draft).toMatchObject({ type: 'UndoLogLearning', payload: { target } });
    expect(isUndoDraft(draft)).toBe(true);
    expect(() => Command.parse(draft)).toThrow();
    expect(bindUndoTarget(draft, target)).toMatchObject({ type: 'UndoLogLearning', payload: { target } });
    const token = 'b'.repeat(40);
    const undo = undoLogLearning(ctx, target, token);
    expect(undo).toMatchObject({ type: 'UndoLogLearning', payload: { target, targetCommit: token } });
    expect(Command.safeParse(undo).success).toBe(true);
    expect(exportText(undo)).toBe(exportText(target));
  });
});

const openBook = () => startBook(ctx, { title: 'Synthetic Book', author: 'A. Author', totalPages: 120 });

describe('startBook / logReading / saveReflection (READ1-A2, ADR-0062)', () => {
  it('mints validated envelopes and exports their payload', () => {
    const started = openBook();
    expect(started).toMatchObject({ type: 'StartBook', operationId: ctx.newId(), baseRevision: ctx.baseRevision, schemaVersion: 1 });
    expect(started.payload).toEqual({ title: 'Synthetic Book', author: 'A. Author', totalPages: 120 });
    expect(exportText(started)).toContain('Synthetic Book');

    const logged = logReading(ctx, { title: 'Synthetic Book', page: 40, date: '2026-10-11' });
    expect(logged).toMatchObject({ type: 'LogReading', operationId: ctx.newId(), baseRevision: ctx.baseRevision, schemaVersion: 1 });
    expect(logged.payload).toEqual({ title: 'Synthetic Book', page: 40, date: '2026-10-11' });

    // The export-text switch must know SaveReflection: a missing case would fall through to the wrong text.
    const reflection = saveReflection(ctx, { title: 'Synthetic Book', date: '2026-10-11', text: 'A synthetic thought.' });
    expect(reflection).toMatchObject({ type: 'SaveReflection', operationId: ctx.newId(), baseRevision: ctx.baseRevision, schemaVersion: 1 });
    expect(exportText(reflection)).toContain('A synthetic thought.');
    expect(Command.safeParse(reflection).success).toBe(true);
  });
  it('refuses a zero page count, a bad date and a multiline author on the wire', () => {
    expect(() => startBook(ctx, { title: 'x', author: 'y', totalPages: 0 })).toThrow();
    expect(() => startBook(ctx, { title: 'x', author: 'two\nlines', totalPages: 10 })).toThrow();
    expect(() => logReading(ctx, { title: 'x', page: 5, date: '2026-02-30' })).toThrow();
  });
});

describe('reading Undos (READ1-A2)', () => {
  it('Start book: a draft without a token, then a checked, tokenised Undo that exports its target', () => {
    const target = openBook();
    const draft = undoStartBookDraft(ctx, target);
    expect(draft).toMatchObject({ type: 'UndoStartBook', payload: { target } });
    expect(isUndoDraft(draft)).toBe(true);
    expect(() => Command.parse(draft)).toThrow();
    expect(bindUndoTarget(draft, target)).toMatchObject({ type: 'UndoStartBook', payload: { target } });
    const token = 'c'.repeat(40);
    const undo = undoStartBook(ctx, target, token);
    expect(undo).toMatchObject({ type: 'UndoStartBook', payload: { target, targetCommit: token } });
    expect(Command.safeParse(undo).success).toBe(true);
    expect(exportText(undo)).toBe(exportText(target));
  });
  it('Log reading: a draft without a token, then a checked, tokenised Undo that exports its target', () => {
    const target = logReading(ctx, { title: 'Synthetic Book', page: 40, date: '2026-10-11' });
    const draft = undoLogReadingDraft(ctx, target);
    expect(draft).toMatchObject({ type: 'UndoLogReading', payload: { target } });
    expect(isUndoDraft(draft)).toBe(true);
    expect(() => Command.parse(draft)).toThrow();
    expect(bindUndoTarget(draft, target)).toMatchObject({ type: 'UndoLogReading', payload: { target } });
    const token = 'd'.repeat(40);
    const undo = undoLogReading(ctx, target, token);
    expect(undo).toMatchObject({ type: 'UndoLogReading', payload: { target, targetCommit: token } });
    expect(Command.safeParse(undo).success).toBe(true);
    expect(exportText(undo)).toBe(exportText(target));
  });
  it('Reflection: a draft without a token, then a checked, tokenised Undo that exports its target', () => {
    const target = saveReflection(ctx, { title: 'Synthetic Book', date: '2026-10-11', text: 'A synthetic thought.' });
    const draft = undoSaveReflectionDraft(ctx, target);
    expect(draft).toMatchObject({ type: 'UndoSaveReflection', payload: { target } });
    expect(isUndoDraft(draft)).toBe(true);
    expect(() => Command.parse(draft)).toThrow();
    expect(bindUndoTarget(draft, target)).toMatchObject({ type: 'UndoSaveReflection', payload: { target } });
    const token = 'e'.repeat(40);
    const undo = undoSaveReflection(ctx, target, token);
    expect(undo).toMatchObject({ type: 'UndoSaveReflection', payload: { target, targetCommit: token } });
    expect(Command.safeParse(undo).success).toBe(true);
    expect(exportText(undo)).toBe(exportText(target));
  });
});