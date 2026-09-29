// Wire contracts shared by apps/web and apps/worker. See docs/commands.md.
import { z } from 'zod';

// Disallow runtime code generation (eval/Function probe) under strict CSP (script-src 'self') and Cloudflare Workers.
z.config({ jitless: true });

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

/**
 * Most `known=` commits a task read asks about and the Worker answers (review O1): the watermark plus the oldest
 * unacknowledged receipts. The server answers them all with at most two single-page listings.
 */
export const MAX_KNOWN = 8;

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

/** ADR-0017: edit one open task's first line in place; only the named changes; null removes a date/priority. */
export const EditTaskChanges = z
  .strictObject({
    text: z.string().min(1).max(2000).refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s), 'must be a single line without control characters').optional(),
    due: z.iso.date().nullable().optional(),
    scheduled: z.iso.date().nullable().optional(),
    priority: Priority.nullable().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, 'at least one change');
export const EditTaskPayload = z.strictObject({ task: TaskLocator, changes: EditTaskChanges });

/** ADR-0019: an item line in Tasks/Active Work Now.md, addressed like a task (ADR-0003). */
export const ActiveWorkLocator = z.strictObject({
  path: z.literal('Tasks/Active Work Now.md'),
  blobSha,
  lineIndex: z.number().int().nonnegative(),
  lineText: singleLine,
  occurrencesAtRead: z.number().int().positive(),
});
export type ActiveWorkLocator = z.infer<typeof ActiveWorkLocator>;
const awText = singleLine.pipe(z.string().max(500));
const awLink = z.string().regex(/^\[\[[^[\]]+\]\]$/, 'must be a [[wikilink]]');
export const CaptureActiveWorkPayload = z.strictObject({
  name: awText,
  next: awText.optional(),
  review: z.iso.date().optional(),
  link: awLink.optional(),
});
export const EditActiveWorkPayload = z.strictObject({
  item: ActiveWorkLocator,
  changes: z
    .strictObject({ name: awText.optional(), next: awText.nullable().optional(), review: z.iso.date().nullable().optional() })
    .refine((c) => Object.keys(c).length > 0, 'at least one change'),
});
export const ReviewActiveWorkPayload = z.discriminatedUnion('action', [
  z.strictObject({ item: ActiveWorkLocator, action: z.literal('keep') }),
  z.strictObject({ item: ActiveWorkLocator, action: z.literal('done') }),
  z.strictObject({ item: ActiveWorkLocator, action: z.literal('park') }),
  z.strictObject({ item: ActiveWorkLocator, action: z.literal('drop'), reason: singleLine.pipe(z.string().max(200)) }),
]);

/** ADR-0022: an Inbox note as read (path + blob), and its new body; frontmatter/BOM/EOL are kept by the server. */
/**
 * A note directly in Inbox/, accepted only in the exact form the server's path policy accepts (paths.ts
 * isStructurallySafePath + NFC): no backslash, %, control or separator characters, no dot-leading or padded name, NFC
 * only — so contract validation and server resolution can never disagree about which file a path names.
 */
const isInboxNoteName = (name: string): boolean =>
  name.length > 3 && name.endsWith('.md') && !name.startsWith('.') && name === name.trim() &&
  ![...name].some((ch) => { const c = ch.codePointAt(0)!; return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029; });
export const InboxNotePath = z
  .string()
  .max(512)
  .regex(/^Inbox\/[^/\\%]+$/, 'must be a note directly in Inbox/')
  .refine((p) => p === p.normalize('NFC') && isInboxNoteName(p.slice('Inbox/'.length)), 'must be a safe, NFC note name');
export const EditNotePayload = z.strictObject({
  note: z.strictObject({ path: InboxNotePath, blobSha }),
  body: z.string().max(50_000),
});

/** ADR-0024: one swipe decision, appended as one line to Events/Triage/Decisions/YYYY-MM.jsonl. */
export const TriageDecision = z.enum(['go', 'maybe', 'skip', 'attended', 'undo']);
export const TriageOutcome = z.enum(['worth', 'not-worth', 'missed']);
export const TriageSkipReason = z.enum(['topic', 'too-far', 'bad-time', 'too-basic', 'busy']);
export const TriageEventId = z.string().regex(/^[0-9a-f]{20}$/);
export const TriageDecidePayload = z
  .strictObject({
    eventId: TriageEventId,
    decision: TriageDecision,
    outcome: TriageOutcome.nullable().default(null),
    reason: TriageSkipReason.nullable(),
    undoes: z.uuid().nullable(),
    explore: z.boolean(),
    card: z.strictObject({
      title: z.string().max(500),
      category: z.string().max(100).nullable(),
      sourceName: z.string().max(200).nullable(),
      aiScore: z.number().min(0).max(100).nullable(),
      start: isoInstant,
    }),
  })
  .refine((d) => (d.decision === 'attended') === (d.outcome !== null), 'outcome exactly on attended')
  .refine((d) => d.decision !== 'attended' || (d.card.category === null && d.card.sourceName === null && d.card.aiScore === null), 'attended snapshot metadata is null')
  .refine((d) => ['attended', 'undo'].includes(d.decision) || (d.card.category !== null && d.card.sourceName !== null && d.card.aiScore !== null), 'card decision snapshot metadata is present')
  .refine((d) => d.decision !== 'undo' || [d.card.category, d.card.sourceName, d.card.aiScore].every((v) => v === null) ||
    [d.card.category, d.card.sourceName, d.card.aiScore].every((v) => v !== null), 'undo snapshot metadata is consistently null or present')
  .refine((d) => d.reason === null || d.decision === 'skip', 'reason only on skip')
  .refine((d) => (d.decision === 'undo') === (d.undoes !== null), 'undoes exactly on undo');

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

/** Undo of a review action names it verbatim plus its receipt commit; exact inverse only (ADR-0019). */
export const ReviewActiveWorkCommand = envelope('ReviewActiveWork', ReviewActiveWorkPayload);
export type ReviewActiveWorkCommand = z.infer<typeof ReviewActiveWorkCommand>;

export const TRAINING_PATH = 'Health/Training Log.md';
const trainingCommon = {
  when: isoInstant.refine((s) => Date.parse(s) >= Date.parse('2000-01-01T00:00:00Z'), 'must be on or after 2000-01-01T00:00:00Z')
    .refine((s) => Date.parse(s) <= Date.now() + 86_400_000, 'must not be more than one day in the future'),
  duration: z.number().int().min(1).max(600),
  note: z.string().max(280).optional(),
};
export const TrainingSession = z.discriminatedUnion('type', [
  z.strictObject({ ...trainingCommon, type: z.literal('Run'), distance: z.number().min(0.1).max(100) }),
  z.strictObject({ ...trainingCommon, type: z.literal('Gym'), split: z.enum(['Bicep', 'Tricep', 'Legs']), weight: z.number().min(30).max(250).optional() }),
]);
export type TrainingSession = z.infer<typeof TrainingSession>;
export const LogTrainingCommand = envelope('LogTraining', z.strictObject({ session: TrainingSession }));
export type LogTrainingCommand = z.infer<typeof LogTrainingCommand>;

export const Command = z.discriminatedUnion('type', [
  CompleteTaskCommand,
  LogTrainingCommand,
  envelope('UndoLogTraining', z.strictObject({ target: LogTrainingCommand, targetCommit: commitSha })),
  envelope('UndoCompleteTask', UndoCompleteTaskPayload),
  envelope('CaptureTask', CaptureTaskPayload),
  envelope('CaptureNote', CaptureNotePayload),
  envelope('TriageDecide', TriageDecidePayload),
  envelope('EditNote', EditNotePayload),
  envelope('EditTask', EditTaskPayload),
  envelope('CaptureActiveWork', CaptureActiveWorkPayload),
  envelope('EditActiveWork', EditActiveWorkPayload),
  ReviewActiveWorkCommand,
  envelope('UndoActiveWork', z.strictObject({ target: ReviewActiveWorkCommand, targetCommit: commitSha })),
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
export const EditEffect = z.strictObject({ kind: z.literal('edited'), beforeLineText: singleLine, afterLineText: singleLine });
export const NoteEditedEffect = z.strictObject({ kind: z.literal('note-edited'), path: InboxNotePath });
export const TriageDecidedEffect = z.strictObject({ kind: z.literal('triage-decided'), path: z.string().regex(/^Events\/Triage\/Decisions\/\d{4}-\d{2}\.jsonl$/), decisionId: z.uuid() });
export const ActiveWorkEffect = z.strictObject({
  kind: z.literal('active-work'),
  op: z.enum(['captured', 'edited', 'keep', 'done', 'park', 'drop', 'undone']),
  beforeLineText: singleLine.nullable(),
  afterLineText: singleLine.nullable(),
});
export const TrainingEffect = z.strictObject({ kind: z.literal('training'), op: z.enum(['logged', 'undone']), lineText: singleLine });
export const Effect = z.discriminatedUnion('kind', [TrainingEffect, CompleteEffect, ReopenEffect, CaptureTaskEffect, CaptureNoteEffect, EditEffect, ActiveWorkEffect, NoteEditedEffect, TriageDecidedEffect]);
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
  'refused:training-table-missing',
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
  /** ADR-0017: the edit would not round-trip as the requested task line, or changes nothing. */
  'refused:invalid-edit',
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
  vault: z.strictObject({ committedAt: z.iso.datetime({ offset: true }), fromApp: z.boolean() }).nullable(),
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
  /** A task line, or (ADR-0019) an Active Work item line: each locator's path is a fixed literal, never client-chosen. */
  taskLocator: z.union([TaskLocator, ActiveWorkLocator]),
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
  z.strictObject({
    status: z.literal('ok'),
    revision: commitSha,
    blobSha,
    markdown: z.string().max(MAX_NOTE_BYTES),
    /** ADR-0019: parsed items of `## Now`, in file order; `needsReview` = review date before today. */
    items: z.array(
      z.strictObject({
        locator: ActiveWorkLocator,
        name: z.string(),
        outcome: z.string().nullable(),
        next: z.string().nullable(),
        review: z.iso.date().nullable(),
        link: z.string().nullable(),
        needsReview: z.boolean(),
      }),
    ),
    /** Lines inside `## Now` that are not items (prose, odd hand edits): shown read-only, never rewritten. */
    unknownNowLines: z.array(z.string()),
    today: z.iso.date(),
  }),
  /** No regular file at the path: an ordinary state, not an error. */
  z.strictObject({ status: z.literal('absent'), revision: commitSha }),
  z.strictObject({ status: z.literal('refused'), revision: commitSha, code: ActiveWorkRefusalCode, message: z.string() }),
]);
export type ActiveWorkResponse = z.infer<typeof ActiveWorkResponse>;

// ---- Scout status page (ADR-0020): read-only projection of Automation/Scout Status/*.json ----

export const SCOUT_STATUS_DIR = 'Automation/Scout Status';
const nullableCount = z.number().int().nonnegative().nullable();
/** One status file (schemaVersion 1). Unknown fields are ignored (`z.object` strips); most fields may be null. */
export const ScoutStatus = z.object({
  schemaVersion: z.literal(1),
  scoutId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  displayName: z.string().min(1).max(100),
  schedule: z.string().max(100).nullable(),
  expectedEveryHours: z.number().positive().max(24 * 31).nullable(),
  lastAttemptAt: isoInstant.nullable(),
  lastSuccessAt: isoInstant.nullable(),
  runStatus: z.enum(['running', 'success', 'degraded', 'failed']).nullable(),
  sources: z.object({ configured: z.number().int().nonnegative(), successful: z.number().int().nonnegative() }).nullable(),
  aiHealth: z.enum(['healthy', 'degraded', 'failed']).nullable(),
  findings: nullableCount,
  added: nullableCount,
  errors: nullableCount,
  /** Shown as one line, truncated by the server to 200 characters. */
  lastError: z.string().max(200).nullable(),
  latestOutput: z.string().max(500).nullable(),
  history: z
    .array(z.object({
      at: isoInstant,
      status: z.enum(['running', 'success', 'degraded', 'failed']),
      findings: nullableCount,
      /** ADR-0029 amendment: the run's operation ID, so an app-run job can dedupe a re-run. Optional (older records). */
      operationId: z.string().regex(/^[0-9a-f-]{36}$/).optional(),
    }))
    .max(30),
  /**
   * ADR-0029 amendment 2: papers picked but not yet explained (failed or deferred), retried first for 3 days. `path` is
   * the pending note this job wrote and `blobSha` its content, so a note the owner edited is never replaced.
   */
  pending: z.array(z.object({
    url: z.string().max(500),
    title: z.string().max(300).nullable(),
    why: z.string().max(500),
    scoutNote: z.string().max(200),
    firstSeen: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    path: z.string().max(400),
    blobSha: z.string().regex(/^[0-9a-f]{40}$/),
    lastReason: z.enum(['models-unavailable', 'invalid-json', 'url-unreadable', 'budget']),
  })).max(40).optional(),
});
export type ScoutStatus = z.infer<typeof ScoutStatus>;

/** "This morning" (ADR-0029 Part 2): the day's Reading Brief and the explanations of the last days, newest first. */
export const MorningResponse = z.strictObject({
  revision: commitSha,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  brief: LinkedNoteResponse.nullable(),
  explained: z.array(LinkedNoteResponse).max(10),
});
export type MorningResponse = z.infer<typeof MorningResponse>;

export const ScoutsResponse = z.strictObject({
  revision: commitSha,
  /** Server time: staleness never depends on the phone clock. */
  now: isoInstant,
  scouts: z.array(
    z.discriminatedUnion('state', [
      z.strictObject({ state: z.literal('ok'), file: z.string(), status: ScoutStatus }),
      z.strictObject({ state: z.literal('unreadable'), file: z.string() }),
    ]),
  ),
});
export type ScoutsResponse = z.infer<typeof ScoutsResponse>;

// ---- Completion history (ADR-0021): completed tasks by day, read-only ----

export const MAX_HISTORY_ITEMS = 1000;
export const HistoryItem = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('todo'), description: z.string(), doneDate: z.iso.date(), locator: TaskLocator, links: z.array(z.string()) }),
  z.strictObject({ source: z.literal('active-work'), description: z.string(), doneDate: z.iso.date(), locator: ActiveWorkLocator, links: z.array(z.string()) }),
]);
export type HistoryItem = z.infer<typeof HistoryItem>;
export const HistoryResponse = z.strictObject({
  revision: commitSha,
  today: z.iso.date(),
  /** Newest done date first; stable file order within a day; at most MAX_HISTORY_ITEMS. */
  items: z.array(HistoryItem).max(MAX_HISTORY_ITEMS),
});
export type HistoryResponse = z.infer<typeof HistoryResponse>;

// ---- Notes in the app (ADR-0022): Inbox notes list, view, edit ----

export const MAX_NOTES_LISTED = 200;
export const NotesResponse = z.strictObject({
  revision: commitSha,
  /** Newest first by the " - YYYY-MM-DD" name suffix; undated names after, by name. No contents are read. */
  notes: z
    .array(z.strictObject({ path: InboxNotePath, title: z.string(), date: z.iso.date().nullable(), blobSha }))
    .max(MAX_NOTES_LISTED),
});
export type NotesResponse = z.infer<typeof NotesResponse>;
export const NoteReadResponse = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    revision: commitSha,
    path: InboxNotePath,
    blobSha,
    markdown: z.string().max(MAX_NOTE_BYTES),
    /** The leading --- … --- block incl. its line break, or "" (kept byte for byte on edit). */
    frontmatter: z.string(),
    /** Everything after the frontmatter: what the editor shows and replaces. */
    body: z.string(),
  }),
  z.strictObject({ status: z.literal('refused'), revision: commitSha, code: LinkedNoteRefusalCode, message: z.string() }),
]);
export type NoteReadResponse = z.infer<typeof NoteReadResponse>;

/**
 * `GET /api/notes/read` names the note in this header, never in the URL (no note names in access logs). The value is
 * `encodeURIComponent(path)`: header values must be ASCII, note names often are not; `InboxNotePath` rejects `%`, so
 * decoding is unambiguous.
 */
export const NOTE_HEADER = 'X-VC-Note';
export const encodeNoteHeader = (path: string): string => encodeURIComponent(path);
/** `null` unless the header decodes to exactly a valid `InboxNotePath`. */
export function decodeNoteHeader(value: string | undefined): string | null {
  if (!value || value.length > 4096) return null;
  try {
    const parsed = InboxNotePath.safeParse(decodeURIComponent(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---- Event triage (ADR-0024): feed, decisions and applier status, read-only except TriageDecide ----

/** A feed card; unknown fields are ignored (`z.object` strips). Invalid cards are dropped by the server, not fatal. */
export const TriageCard = z.object({
  eventId: TriageEventId,
  rank: z.number().int(),
  explore: z.boolean(),
  resurfaced: z.boolean(),
  summary: z.string().max(300).default(''),
  title: z.string().max(500),
  start: isoInstant,
  end: isoInstant.nullable(),
  location: z.string().max(500),
  online: z.boolean(),
  cost: z.string().max(200),
  registration: z.object({ state: z.enum(['open', 'unknown', 'not-required']), deadline: isoInstant.nullable() }),
  aiScore: z.number().min(0).max(100),
  why: z.string().max(1000),
  category: z.string().max(100),
  scouts: z.array(z.string().max(64)).max(10),
  sourceName: z.string().max(200),
  sourceUrl: z.url().max(2000),
  calendar: z.object({
    inCalendar: z.enum(['auto', 'own', 'go']).nullable(),
    clash: z.object({ title: z.string().max(300), start: isoInstant, end: isoInstant, kind: z.enum(['go', 'own']).default('own') }).nullable(),
    freeThatEvening: z.boolean(),
  }),
});
export type TriageCard = z.infer<typeof TriageCard>;

export const TriageCheckin = z.object({ eventId: TriageEventId, title: z.string().max(300), start: isoInstant });
export type TriageCheckin = z.infer<typeof TriageCheckin>;

export const TriageResponse = z.strictObject({
  revision: commitSha,
  now: isoInstant,
  feedState: z.enum(['ok', 'absent', 'unreadable']),
  generatedAt: isoInstant.nullable(),
  cards: z.array(TriageCard).max(500),
  checkins: z.array(TriageCheckin).max(500).default([]),
  /** Cards dropped because they failed validation (shown as a small note, never fatal). */
  droppedCards: z.number().int().nonnegative(),
  droppedCheckins: z.number().int().nonnegative().default(0),
  /** Decision lines of the current and previous month, file order. `title`/`start` come from the stored card snapshot
   * (ADR-0027); responses from before that change parse with null. */
  decisions: z
    .array(z.strictObject({ decisionId: z.uuid(), eventId: TriageEventId, decision: TriageDecision, outcome: TriageOutcome.nullable().default(null), undoes: z.uuid().nullable(), at: isoInstant,
      title: z.string().max(500).nullable().default(null), start: isoInstant.nullable().default(null) }))
    .max(5000),
  applied: z.record(z.string(), z.strictObject({ status: z.enum(['applied', 'failed', 'skipped']), at: isoInstant, message: z.string().max(300) })),
  appliedUpdatedAt: isoInstant.nullable(),
});
export type TriageResponse = z.infer<typeof TriageResponse>;

/** Only sessions and unknown table lines, never the surrounding health note. */
export const TrainingRow = z.strictObject({ date: z.iso.date(), time: z.string(), type: z.string(), distance: z.string(), duration: z.string(), weight: z.string(), split: z.string(), note: z.string() });
export type TrainingRow = z.infer<typeof TrainingRow>;
export const TrainingResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), revision: commitSha, blobSha, rows: z.array(TrainingRow), unknownLines: z.array(z.string()) }),
  z.strictObject({ status: z.literal('absent'), revision: commitSha }),
  z.strictObject({ status: z.literal('refused'), revision: commitSha, code: ErrorCode, message: z.string() }),
]);
export type TrainingResponse = z.infer<typeof TrainingResponse>;
