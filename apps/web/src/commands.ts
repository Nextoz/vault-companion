// Envelope construction. Every envelope is minted once, at the moment of the user's action (commands.md, F19).
import {
  Command,
  type CompleteTaskCommand,
  type ReviewActiveWorkCommand,
  type LogTrainingCommand,
  type EditTrainingCommand,
  type MoodCheckinCommand,
  type ReportFeedbackCommand,
  type TrainingSession,
  type ActiveWorkLocator,
  type Priority,
  type TaskLocator,
} from '@vault-companion/contracts';
import { isoWithOffset } from './time.ts';

export type Envelope = Command;

export interface MintContext {
  baseRevision: string;
  now?: Date;
  newId?: () => string;
}

function base(ctx: MintContext) {
  return {
    schemaVersion: 1 as const,
    operationId: (ctx.newId ?? (() => crypto.randomUUID()))(),
    occurredAt: isoWithOffset(ctx.now ?? new Date()),
    baseRevision: ctx.baseRevision,
  };
}

/** Parse through the shared schema so an invalid envelope is caught on the device, before it is queued. */
function checked<T extends Command>(candidate: T): T {
  return Command.parse(candidate) as T;
}

export function completeTask(ctx: MintContext, task: TaskLocator): CompleteTaskCommand {
  return checked({ ...base(ctx), type: 'CompleteTask', payload: { task } }) as CompleteTaskCommand;
}

export type TaskChanges = Extract<Command, { type: 'EditTask' }>['payload']['changes'];

export function editTask(ctx: MintContext, task: TaskLocator, changes: TaskChanges) {
  return checked({ ...base(ctx), type: 'EditTask', payload: { task, changes } });
}

/**
 * Undo names its target by carrying the original CompleteTask envelope verbatim, and the completion's commit from its
 * receipt as a token (ADR-0013).
 */
export function undoCompleteTask(ctx: MintContext, target: CompleteTaskCommand, targetCommit: string): Command {
  return checked({ ...base(ctx), type: 'UndoCompleteTask', payload: { target, targetCommit } });
}

/**
 * An Undo of a completion that has no receipt yet (ADR-0013): everything but `targetCommit`. It is queued behind the
 * completion; the queue fills the token from the receipt once, before the first send (`withTargetCommit`), and
 * persists it, so every attempt sends the same bytes. Not a sendable Command until then.
 */
export function undoDraft(ctx: MintContext, target: CompleteTaskCommand): Command {
  const draft = { ...base(ctx), type: 'UndoCompleteTask' as const, payload: { target } };
  checked({ ...draft, payload: { target, targetCommit: '0'.repeat(40) } }); // valid once the token is filled in
  return draft as unknown as Command;
}

/** An Undo draft (no token yet), as the queue stores it. */
export function isUndoDraft(envelope: Command): boolean {
  return (envelope.type === 'UndoCompleteTask' || envelope.type === 'UndoActiveWork' || envelope.type === 'UndoLogTraining' || envelope.type === 'UndoEditTraining' || envelope.type === 'UndoMoodCheckin' || envelope.type === 'UndoReportFeedback') && !('targetCommit' in envelope.payload);
}

/** The draft with its token: a checked, sendable Undo whose other fields are unchanged. */
export function withTargetCommit(draft: Command, targetCommit: string): Command {
  if (draft.type === 'UndoLogTraining') return checked({ ...draft, payload: { target: draft.payload.target, targetCommit } });
  if (draft.type === 'UndoEditTraining') return checked({ ...draft, payload: { target: draft.payload.target, targetCommit } });
  if (draft.type === 'UndoMoodCheckin') return checked({ ...draft, payload: { target: draft.payload.target, targetCommit } });
  if (draft.type === 'UndoReportFeedback') return checked({ ...draft, payload: { target: draft.payload.target, targetCommit } });
  if (draft.type === 'UndoActiveWork') return checked({ ...draft, payload: { target: draft.payload.target, targetCommit } });
  if (draft.type !== 'UndoCompleteTask') throw new TypeError('not an Undo');
  return checked({ ...draft, payload: { target: draft.payload.target, targetCommit } });
}

export function captureTask(
  ctx: MintContext,
  input: { text: string; priority?: Priority; due?: string; context?: string },
): Command {
  return checked({ ...base(ctx), type: 'CaptureTask', payload: input });
}

export function captureNote(ctx: MintContext, input: { text: string; context?: string }): Command {
  return checked({ ...base(ctx), type: 'CaptureNote', payload: input });
}

export function triageDecide(ctx: MintContext, payload: Extract<Command, { type: 'TriageDecide' }>['payload']) {
  return checked({ ...base(ctx), type: 'TriageDecide', payload });
}

/** ADR-0022: the note as read (path + blob) and the whole new body; the server keeps frontmatter/BOM/EOL. */
export function editNote(ctx: MintContext, note: { path: string; blobSha: string }, body: string): Command {
  return checked({ ...base(ctx), type: 'EditNote', payload: { note, body } });
}

/** Human-readable text of a pending action, for "Export text" when it needs attention. */
export function exportText(envelope: Command): string {
  switch (envelope.type) {
    case 'LogTraining': return JSON.stringify(envelope.payload.session, null, 2);
    case 'UndoLogTraining': return exportText(envelope.payload.target);
    case 'EditTraining': return JSON.stringify(envelope.payload.session, null, 2);
    case 'UndoEditTraining': return exportText(envelope.payload.target);
    case 'LogLearning': return JSON.stringify(envelope.payload.session, null, 2);
    case 'UndoLogLearning': return exportText(envelope.payload.target);
    case 'MoodCheckin': return JSON.stringify(envelope.payload, null, 2);
    case 'UndoMoodCheckin': return exportText(envelope.payload.target);
    case 'ReportFeedback': return JSON.stringify(envelope.payload, null, 2);
    case 'UndoReportFeedback': return exportText(envelope.payload.target);
    case 'TriageDecide':
      return JSON.stringify(envelope.payload, null, 2);
    case 'CaptureActiveWork':
      return JSON.stringify(envelope.payload, null, 2);
    case 'EditActiveWork':
      return envelope.payload.item.lineText + '\n' + JSON.stringify(envelope.payload.changes, null, 2);
    case 'ReviewActiveWork':
      return envelope.payload.item.lineText + '\n' + JSON.stringify(envelope.payload, null, 2);
    case 'UndoActiveWork':
      return exportText(envelope.payload.target);
    case 'CaptureTask':
    case 'CaptureNote':
      return envelope.payload.text;
    case 'EditNote':
      return envelope.payload.body;
    case 'EditTask':
      return envelope.payload.changes.text ?? envelope.payload.task.lineText;
    case 'CompleteTask':
      return envelope.payload.task.lineText;
    case 'UndoCompleteTask':
      return envelope.payload.target.payload.task.lineText;
  }
}

export type ActiveWorkChanges = Extract<Command, { type: 'EditActiveWork' }>['payload']['changes'];
export function captureActiveWork(ctx: MintContext, payload: Extract<Command, { type: 'CaptureActiveWork' }>['payload']) {
  return checked({ ...base(ctx), type: 'CaptureActiveWork', payload });
}
export function editActiveWork(ctx: MintContext, item: ActiveWorkLocator, changes: ActiveWorkChanges) {
  return checked({ ...base(ctx), type: 'EditActiveWork', payload: { item, changes } });
}
export function reviewActiveWork(ctx: MintContext, payload: ReviewActiveWorkCommand['payload']): ReviewActiveWorkCommand {
  return checked({ ...base(ctx), type: 'ReviewActiveWork', payload });
}
export function undoActiveWork(ctx: MintContext, target: ReviewActiveWorkCommand, targetCommit: string): Command {
  return checked({ ...base(ctx), type: 'UndoActiveWork', payload: { target, targetCommit } });
}
export function undoActiveWorkDraft(ctx: MintContext, target: ReviewActiveWorkCommand): Command {
  const draft = { ...base(ctx), type: 'UndoActiveWork' as const, payload: { target } };
  checked({ ...draft, payload: { target, targetCommit: '0'.repeat(40) } });
  return draft as Command;
}
/** Bind to the durable, possibly rebased target, preserving the discriminated command pair. */
export function bindUndoTarget(undo: Command, target: Command): Command | null {
  if (undo.type === 'UndoCompleteTask' && target.type === 'CompleteTask')
    return { ...undo, payload: { ...undo.payload, target } };
  if (undo.type === 'UndoActiveWork' && target.type === 'ReviewActiveWork')
    return { ...undo, payload: { ...undo.payload, target } };
  if (undo.type === 'UndoLogTraining' && target.type === 'LogTraining')
    return { ...undo, payload: { ...undo.payload, target } };
  if (undo.type === 'UndoEditTraining' && target.type === 'EditTraining')
    return { ...undo, payload: { ...undo.payload, target } };
  if (undo.type === 'UndoMoodCheckin' && target.type === 'MoodCheckin')
    return { ...undo, payload: { ...undo.payload, target } };
  if (undo.type === 'UndoReportFeedback' && target.type === 'ReportFeedback')
    return { ...undo, payload: { ...undo.payload, target } };
  return null;
}

export function logTraining(ctx: MintContext, session: TrainingSession): LogTrainingCommand {
  return checked({ ...base(ctx), type: 'LogTraining', payload: { session } });
}
export function undoLogTraining(ctx: MintContext, target: LogTrainingCommand, targetCommit: string): Command {
  return checked({ ...base(ctx), type: 'UndoLogTraining', payload: { target, targetCommit } });
}
export function undoLogTrainingDraft(ctx: MintContext, target: LogTrainingCommand): Command {
  const draft = { ...base(ctx), type: 'UndoLogTraining' as const, payload: { target } };
  checked({ ...draft, payload: { target, targetCommit: '0'.repeat(40) } });
  return draft as Command;
}

export function editTraining(ctx: MintContext, row: EditTrainingCommand['payload']['row'], session: TrainingSession): EditTrainingCommand {
  return checked({ ...base(ctx), type: 'EditTraining', payload: { row, session } }) as EditTrainingCommand;
}
export function undoEditTraining(ctx: MintContext, target: EditTrainingCommand, targetCommit: string): Command {
  return checked({ ...base(ctx), type: 'UndoEditTraining', payload: { target, targetCommit } });
}
export function undoEditTrainingDraft(ctx: MintContext, target: EditTrainingCommand): Command {
  const draft = { ...base(ctx), type: 'UndoEditTraining' as const, payload: { target } };
  checked({ ...draft, payload: { target, targetCommit: '0'.repeat(40) } });
  return draft as Command;
}

export function moodCheckin(ctx: MintContext, payload: MoodCheckinCommand['payload']): MoodCheckinCommand {
  return checked({ ...base(ctx), type: 'MoodCheckin', payload });
}
export function undoMoodCheckin(ctx: MintContext, target: MoodCheckinCommand, targetCommit: string): Command {
  return checked({ ...base(ctx), type: 'UndoMoodCheckin', payload: { target, targetCommit } });
}
export function undoMoodCheckinDraft(ctx: MintContext, target: MoodCheckinCommand): Command {
  const draft = { ...base(ctx), type: 'UndoMoodCheckin' as const, payload: { target } };
  checked({ ...draft, payload: { target, targetCommit: '0'.repeat(40) } });
  return draft as Command;
}

/** ADR-0040: one line in the Ready Backlog note; the text travels only in the envelope, never in a log or label. */
export function reportFeedback(ctx: MintContext, payload: ReportFeedbackCommand['payload']): ReportFeedbackCommand {
  return checked({ ...base(ctx), type: 'ReportFeedback', payload });
}
export function undoReportFeedback(ctx: MintContext, target: ReportFeedbackCommand, targetCommit: string): Command {
  return checked({ ...base(ctx), type: 'UndoReportFeedback', payload: { target, targetCommit } });
}
export function undoReportFeedbackDraft(ctx: MintContext, target: ReportFeedbackCommand): Command {
  const draft = { ...base(ctx), type: 'UndoReportFeedback' as const, payload: { target } };
  checked({ ...draft, payload: { target, targetCommit: '0'.repeat(40) } });
  return draft as Command;
}
