// Wire contracts shared by apps/web and apps/worker. See docs/commands.md.
import { z } from 'zod';

const isoInstant = z.iso.datetime({ offset: true });
const commitSha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-hex commit SHA');
const blobSha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-hex blob SHA');
// No newline characters: a locator always names exactly one line.
/**
 * Longest task line the app reads or writes (gate-3 G3-3). Submitted text is capped far lower (2,000 + 2,000 context), so
 * accepted mutations fit; the domain refuses a write whose resulting line would exceed it (never truncates).
 */
export const MAX_TASK_LINE = 16_000;
const singleLine = z.string().min(1).max(MAX_TASK_LINE).refine((s) => !/[\r\n]/.test(s), 'must be a single line');

export const TaskLocator = z.strictObject({
  path: z.literal('Tasks/To-Do List.md'),
  blobSha,
  lineIndex: z.number().int().nonnegative(),
  lineText: singleLine,
  /** Identical indexed lines in the blob that was read (vault-contract §3, review F2). */
  occurrencesAtRead: z.number().int().positive(),
});
export type TaskLocator = z.infer<typeof TaskLocator>;

export const CompleteTaskPayload = z.strictObject({ task: TaskLocator });


export const Priority = z.enum(['highest', 'high', 'medium', 'low', 'lowest']);
export type Priority = z.infer<typeof Priority>;

/** `[[wikilink]]` or http(s) URL naming where a capture came from (bootstrap §3.4). */
const Context = z
  .string()
  .max(2000)
  // No control characters or Unicode line/paragraph separators anywhere (K report gap 16, review F8).
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s), 'must not contain control or separator characters')
  .refine((s) => /^\[\[[^[\]]+\]\]$/.test(s) || /^https?:\/\/\S+$/.test(s), 'must be [[wikilink]] or http(s) URL');

export const CaptureTaskPayload = z.strictObject({
  text: z.string().min(1).max(2000),
  priority: Priority.optional(),
  due: z.iso.date().optional(),
  context: Context.optional(),
});

export const CaptureNotePayload = z.strictObject({
  text: z.string().min(1).max(50_000),
  context: Context.optional(),
});

const envelope = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({
    schemaVersion: z.literal(1),
    operationId: z.uuid(),
    type: z.literal(type),
    occurredAt: isoInstant,
    baseRevision: commitSha,
    payload,
  });

export const CompleteTaskCommand = envelope('CompleteTask', CompleteTaskPayload);
export type CompleteTaskCommand = z.infer<typeof CompleteTaskCommand>;

/**
 * Undo names its target by carrying the original CompleteTask envelope verbatim (commands.md, review F4/F5), plus the
 * completion's commit from its receipt as a token (ADR-0013). The server verifies the token against Git; a wrong one
 * can only be refused.
 */
export const UndoCompleteTaskPayload = z.strictObject({ target: CompleteTaskCommand, targetCommit: commitSha });

export const Command = z.discriminatedUnion('type', [
  CompleteTaskCommand,
  envelope('UndoCompleteTask', UndoCompleteTaskPayload),
  envelope('CaptureTask', CaptureTaskPayload),
  envelope('CaptureNote', CaptureNotePayload),
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command['type'];

export const CompleteEffect = z.strictObject({
  kind: z.literal('completed'),
  completedLineText: singleLine,
  openLineText: singleLine,
  completedInPlace: z.boolean(),
  doneDate: z.iso.date(),
});
export const ReopenEffect = z.strictObject({ kind: z.literal('reopened'), openLineText: singleLine });
export const CaptureTaskEffect = z.strictObject({ kind: z.literal('task-captured'), lineText: singleLine });
export const CaptureNoteEffect = z.strictObject({ kind: z.literal('note-captured'), path: z.string() });
export const Effect = z.discriminatedUnion('kind', [CompleteEffect, ReopenEffect, CaptureTaskEffect, CaptureNoteEffect]);
export type Effect = z.infer<typeof Effect>;

export const Receipt = z.strictObject({
  operationId: z.uuid(),
  status: z.enum(['applied', 'already-applied']),
  path: z.string(),
  commitSha,
  blobSha,
  effect: Effect,
  flags: z.array(z.literal('backdated')).optional(),
});
export type Receipt = z.infer<typeof Receipt>;

export const ErrorCode = z.enum([
  'refused:recurring',
  'refused:on-completion',
  'refused:structure',
  'refused:vault-conflict',
  'refused:too-large',
  'refused:already-completed',
  'refused:mixed-eol',
  'refused:encoding',
  'refused:unsupported-status',
  'refused:duplicate-field',
  'refused:path',
  'conflict:task-changed',
  'conflict:ambiguous',
  'conflict:stale',
  /** Undo: more than one compare page (250 commits) since the completion (ADR-0013). Undo it in Obsidian. */
  'refused:undo-expired',
  'operation-id-reused',
  'dedupe-unknown',
  /** POST's X-VC-Account differs from the authenticated identity (review A7). Not retryable. */
  'account-mismatch',
  'unauthorized',
  'forbidden',
  'invalid',
  'clock-skew',
  'upstream-unavailable',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.strictObject({
  operationId: z.string().optional(),
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
});
export type ApiError = z.infer<typeof ApiError>;

export const TaskView = z.strictObject({
  locator: TaskLocator,
  description: z.string(),
  status: z.enum(['open', 'done', 'cancelled', 'other']),
  section: z.enum(['open', 'done']),
  priority: Priority.nullable(),
  due: z.iso.date().nullable(),
  scheduled: z.iso.date().nullable(),
  start: z.iso.date().nullable(),
  created: z.iso.date().nullable(),
  done: z.iso.date().nullable(),
  recurring: z.boolean(),
  /** Why the app will not complete this task, if it will not. */
  readOnlyReason: ErrorCode.nullable(),
  links: z.array(z.string()),
});
export type TaskView = z.infer<typeof TaskView>;

export const TasksResponse = z.strictObject({
  revision: commitSha,
  blobSha,
  today: z.iso.date(),
  timeZone: z.string(),
  /** Present when the file cannot be written (duplicate headings, conflict markers). */
  writeBlock: ApiError.nullable(),
  /** For each `known=` commit the client asked about: is it contained in `revision`? (review F10) */
  known: z.record(commitSha, z.enum(['included', 'not-included'])),
  todayTasks: z.array(TaskView),
  overdue: z.array(TaskView),
  allOpen: z.array(TaskView),
  doneToday: z.array(TaskView),
  /** Task lines longer than MAX_TASK_LINE are left out of the views (never truncated); edit them in Obsidian. */
  omittedLongLines: z.number().int().nonnegative().optional(),
});
export type TasksResponse = z.infer<typeof TasksResponse>;

export const SessionResponse = z.strictObject({ accountKey: z.string().regex(/^[0-9a-f]{64}$/) });
