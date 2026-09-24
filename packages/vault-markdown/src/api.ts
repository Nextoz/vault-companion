// Public API of the Markdown safety kernel. Normative spec: docs/vault-contract.md.
// Pure functions over decoded strings. No I/O. Every mutation returns either the full new
// text (a splice of the old text) or a typed refusal; it never throws for expected cases.

export type Eol = '\n' | '\r\n';

export type Priority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

/** vault-contract.md §5 (the subset the pure kernel can produce). */
export type RefusalCode =
  | 'refused:recurring'
  | 'refused:on-completion'
  | 'refused:structure'
  | 'refused:vault-conflict'
  | 'refused:mixed-eol'
  | 'refused:encoding'
  | 'refused:unsupported-status'
  | 'refused:duplicate-field'
  | 'refused:already-completed'
  | 'conflict:task-changed'
  | 'conflict:ambiguous';

export interface Refusal {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly message: string;
}

export interface ParsedTask {
  /** 0-based line index in the file. */
  readonly lineIndex: number;
  /** Exact line text without EOL. */
  readonly lineText: string;
  /** Number of indexed task lines in the file with identical `lineText` (locator F2 rule). */
  readonly occurrences: number;
  readonly section: 'open' | 'done';
  /** Raw status character between the brackets. */
  readonly statusChar: string;
  readonly status: 'open' | 'done' | 'cancelled' | 'other';
  readonly description: string;
  readonly priority: Priority | null;
  readonly due: string | null;
  readonly scheduled: string | null;
  readonly start: string | null;
  readonly created: string | null;
  readonly done: string | null;
  readonly cancelled: string | null;
  readonly recurrence: string | null;
  readonly onCompletion: string | null;
  readonly id: string | null;
  readonly blockId: string | null;
  readonly tags: readonly string[];
  /** Wikilink targets (text before `|` / `#`), in order of appearance. */
  readonly links: readonly string[];
  /** Number of lines in the task block (1 = no children). */
  readonly blockLineCount: number;
  /** Set when the kernel will not complete this task. */
  readonly readOnlyReason: RefusalCode | null;
}

export interface ParsedTodoList {
  readonly eol: Eol;
  readonly hasFinalNewline: boolean;
  /** Structural problems that block writes (duplicate/missing headings, conflict markers). */
  readonly writeBlock: Refusal | null;
  readonly tasks: readonly ParsedTask[];
}

/** Only encoding/EOL failures make a file unparseable; structure problems surface as `writeBlock`. */
export type ParseResult = ({ readonly ok: true } & ParsedTodoList) | Refusal;

export interface LocatorInput {
  readonly lineIndex: number;
  readonly lineText: string;
  readonly occurrencesAtRead: number;
  /** True when the file's current blob SHA equals the locator's blobSha. */
  readonly sameRevision: boolean;
}

export interface MutationOk<E> {
  readonly ok: true;
  readonly text: string;
  readonly effect: E;
}

/** vault-contract.md §4.1. Everything the exact and the semantic inverse need. */
export interface CompleteEffect {
  readonly completedLineText: string;
  readonly openLineText: string;
  /** Line index the block was removed from (in the input text). */
  readonly removedAt: number;
  readonly blockLineCount: number;
  /** Line index the block starts at in the output text. */
  readonly insertedAt: number;
  /** Nearest preceding non-blank line in Open before removal (may be the `## Open` heading). */
  readonly anchorBefore: string;
  readonly blankLinesAfterAnchor: number;
  readonly completedInPlace: boolean;
  readonly doneDate: string;
}

export interface UndoInput {
  readonly completion: CompleteEffect;
  /** True when the current text is byte-identical to the completion's output text. */
  readonly unchangedSinceCompletion: boolean;
}

export interface CaptureTaskInput {
  readonly text: string;
  readonly createdDate: string;
  readonly priority?: Priority;
  readonly due?: string;
  /** Already validated `[[wikilink]]` or http(s) URL. */
  readonly context?: string;
}

export interface NoteInput {
  readonly text: string;
  readonly date: string;
  /** ISO-8601 instant with offset. */
  readonly capturedAt: string;
  readonly context?: string;
}
