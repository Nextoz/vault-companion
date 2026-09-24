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

/** Undo names its target by carrying the original CompleteTask envelope verbatim. */
export function undoCompleteTask(ctx: MintContext, target: CompleteTaskCommand): Command {
  return checked({ ...base(ctx), type: 'UndoCompleteTask', payload: { target } });
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
