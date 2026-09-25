// Envelope construction. Every envelope is minted once, at the moment of the user's action (commands.md, F19).
import {
  Command,
  type CompleteTaskCommand,
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
  return envelope.type === 'UndoCompleteTask' && !('targetCommit' in envelope.payload);
}

/** The draft with its token: a checked, sendable Undo whose other fields are unchanged. */
export function withTargetCommit(draft: Command, targetCommit: string): Command {
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

/** Human-readable text of a pending action, for "Export text" when it needs attention. */
export function exportText(envelope: Command): string {
  switch (envelope.type) {
    case 'CaptureTask':
    case 'CaptureNote':
      return envelope.payload.text;
    case 'CompleteTask':
      return envelope.payload.task.lineText;
    case 'UndoCompleteTask':
      return envelope.payload.target.payload.task.lineText;
  }
}
