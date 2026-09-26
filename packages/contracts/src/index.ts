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

/** Most wikilinks a request may address in one task line (bounds the index; real lines carry a handful). */
export const MAX_LINK_INDEX = 99;

/**
 * Read-only linked note (vault-contract §1 "Linked notes"): the server resolves the n-th wikilink of the task the
 * locator names. There is deliberately no path field — a client path is never accepted.
 */
export const LinkedNoteRequest = z.strictObject({
  taskLocator: TaskLocator,
  linkIndex: z.number().int().nonnegative().max(MAX_LINK_INDEX),
});
export type LinkedNoteRequest = z.infer<typeof LinkedNoteRequest>;

/** The request travels base64url(JSON) in this header, so task text never appears in a URL or an access log. */
export const LINKED_NOTE_HEADER = 'X-VC-Locator';
/** Header values above this are refused before decoding (a maximal task line is 16,000 code points). */
export const MAX_LINKED_NOTE_HEADER = 96 * 1024;

export function encodeLinkedNoteHeader(req: LinkedNoteRequest): string {
  const bytes = new TextEncoder().encode(JSON.stringify(req));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `null` for anything that is not exactly a valid request. */
export function decodeLinkedNoteHeader(value: string | undefined): LinkedNoteRequest | null {
  if (!value || value.length > MAX_LINKED_NOTE_HEADER || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const parsed = LinkedNoteRequest.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const LinkedNoteRefusalCode = z.enum([
  /** The link names no allowlisted note (or the task has no link at that index). */
  'not-found',
  /** A bare-name link matches several notes. */
  'ambiguous',
  /** Unsafe or out-of-scope target: traversal, absolute, backslash, `%`, denied or non-allowlisted root. */
  'outside-allowlist',
  /** The note, or a folder that must be searched, exceeds what can be read safely (1 MB guard). */
  'too-large',
  /** The task line is no longer where, or what, the locator says. Reload the task list. */
  'task-changed',
  /** The note is not valid UTF-8. */
  'encoding',
]);
export type LinkedNoteRefusalCode = z.infer<typeof LinkedNoteRefusalCode>;

/** 1 MB guard (vault-contract §1): the same limit the GitHub adapter enforces. */
export const MAX_NOTE_BYTES = 1024 * 1024;

export const LinkedNoteResponse = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    /** Commit X every read of this request was pinned to. */
    revision: commitSha,
    path: z.string().min(1).max(512),
    blobSha,
    /** Raw Markdown. The client renders it with raw HTML disabled, then sanitises. */
    markdown: z.string().max(MAX_NOTE_BYTES),
  }),
  z.strictObject({
    status: z.literal('refused'),
    revision: commitSha,
    code: LinkedNoteRefusalCode,
    message: z.string(),
  }),
]);
export type LinkedNoteResponse = z.infer<typeof LinkedNoteResponse>;

/** Read-only context the owner keeps by hand (vault-contract §1, ADR-0012 "chosen work"). Never written by the app. */
export const ACTIVE_WORK_PATH = 'Tasks/Active Work Now.md';

export const ActiveWorkRefusalCode = z.enum([
  /** Larger than the 1 MB guard, or the folder listing needed to prove it is a regular file was truncated. */
  'too-large',
  /** Not valid UTF-8. */
  'encoding',
]);
export type ActiveWorkRefusalCode = z.infer<typeof ActiveWorkRefusalCode>;

export const ActiveWorkResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), revision: commitSha, blobSha, markdown: z.string().max(MAX_NOTE_BYTES) }),
  /** No regular file at the path: an ordinary state, not an error. */
  z.strictObject({ status: z.literal('absent'), revision: commitSha }),
  z.strictObject({ status: z.literal('refused'), revision: commitSha, code: ActiveWorkRefusalCode, message: z.string() }),
]);
export type ActiveWorkResponse = z.infer<typeof ActiveWorkResponse>;
