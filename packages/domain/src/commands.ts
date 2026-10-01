// Application services: one WritePlan per command type (docs/commands.md) and the task read model.
// Pure orchestration over the VaultStore port and the Markdown kernel; no HTTP, no GitHub.
import { TRAINING_PATH, ACTIVE_WORK_PATH, MAX_KNOWN, MAX_TASK_LINE, type ApiError, type Command, type CompleteTaskCommand, type ErrorCode, type Receipt, type ResearchRadarDecideCommand, type TasksResponse, type TaskView } from '@vault-companion/contracts';
import * as md from '@vault-companion/vault-markdown';
import { executeWrite, findInOnePage, replayOnParent, type Planned, type Refused, type WritePlan } from './execute.ts';
import { MAX_NOTE_BYTES } from '@vault-companion/contracts';
import { appendDecisionLine, hasDecisionId, parseDecisionLines, type DecisionLine } from './triage-format.ts';
import { readTriageText, TRIAGE_DIR, triageDecisionPath } from './triage.ts';
import { canWrite, INBOX_DIR, isInboxNotePath, parseVaultPath, TODO_LIST_PATH } from './paths.ts';
import { payloadHash } from './payload-hash.ts';
import { researchRadarDecidePlan } from './research-radar-command.ts';
import { FileTooLarge, gitBlobSha, TRAILER_OP, TRAILER_PAYLOAD, TRAILER_UNDOES, type CommitInfo, type VaultPath, type VaultStore } from './store.ts';
import { checkOccurredAt, userDate } from './time.ts';

export interface CommandServiceDeps {
  readonly store: VaultStore;
  readonly now: () => Date;
  readonly timeZone: string;
}

const TODO = TODO_LIST_PATH as VaultPath;
const TRAINING = TRAINING_PATH as VaultPath;
const ACTIVE = ACTIVE_WORK_PATH as VaultPath;

/** Undo re-plans at most this often when the head moves (ADR-0013 budget: ≤ 3 × ≈ 10 GitHub calls). */
export const UNDO_MAX_ATTEMPTS = 3;

const refuse = (code: ErrorCode, message: string): Planned<never> => ({ ok: false, code, message });
const apiError = (code: ErrorCode, message: string, retryable = false): ApiError => ({ code, message, retryable });

const encoder = new TextEncoder();
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    // ignoreBOM keeps a leading BOM in the string so the kernel preserves it byte-for-byte.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Read the To-Do List at X as text, or a refusal. */
type TodoFile = { ok: true; text: string; blobSha: string; bytes: Uint8Array };

export async function readTodo(store: VaultStore, at: string, path: VaultPath = TODO): Promise<TodoFile | { ok: false; planned: Planned<never> }> {
  const label = path === TRAINING ? 'Training log' : path === ACTIVE ? 'Active Work' : path === TODO ? 'the task list' : 'the note';
  let file;
  try {
    file = await store.readFile(path, at);
  } catch (e) {
    if (e instanceof FileTooLarge) return { ok: false, planned: refuse('refused:too-large', `${label} is too large to edit safely`) };
    throw e;
  }
  if (!file) return { ok: false, planned: refuse('refused:structure', `${label} was not found`) };
  const text = decodeUtf8(file.bytes);
  if (text === null) return { ok: false, planned: refuse('refused:encoding', `${label} is not valid UTF-8`) };
  return { ok: true, text, blobSha: file.blobSha, bytes: file.bytes };
}

function fromKernel<E, R>(r: md.MutationOk<E> | md.Refusal, path: VaultPath, map: (e: E) => R): Planned<R> {
  if (!r.ok) return refuse(r.code, r.message);
  // Gate-3 G3-3: every task line this write produces must fit the receipt/read contract, or the durable receipt and all
  // later reads would be rejected by the client. Refuse before writing; never truncate vault text.
  for (const [k, v] of Object.entries(r.effect as object)) {
    if (/lineText$/i.test(k) && typeof v === 'string' && v.length > MAX_TASK_LINE) {
      return refuse('invalid', `the resulting task line would exceed ${MAX_TASK_LINE} characters`);
    }
  }
  return { ok: true, path, expect: 'regular-file', bytes: encoder.encode(r.text), effect: map(r.effect) };
}

/** The completion `cmd` applied to the To-Do List file `f`. */
function completeOn(cmd: CompleteTaskCommand, f: TodoFile, timeZone: string): Planned<md.CompleteEffect> {
  const t = cmd.payload.task;
  const r = md.completeTask(f.text, { lineIndex: t.lineIndex, lineText: t.lineText, occurrencesAtRead: t.occurrencesAtRead, sameRevision: f.blobSha === t.blobSha }, userDate(cmd.occurredAt, timeZone));
  return fromKernel(r, TODO, (e) => e);
}

export function completePlan(cmd: CompleteTaskCommand, timeZone: string): WritePlan<md.CompleteEffect> {
  return {
    message: 'Vault Companion: complete task',
    async compute(store, at) {
      const f = await readTodo(store, at);
      if (!f.ok) return f.planned;
      return completeOn(cmd, f, timeZone);
    },
  };
}

/** Uses the executor's parent replay and exact committed-byte verification for duplicate requests. */
export function editPlan(cmd: Extract<Command, { type: 'EditTask' }>): WritePlan<md.EditEffect> {
  return {
    message: 'Vault Companion: edit task',
    async compute(store, at) {
      const f = await readTodo(store, at);
      if (!f.ok) return f.planned;
      const t = cmd.payload.task;
      return fromKernel(md.editTask(f.text, {
        lineIndex: t.lineIndex, lineText: t.lineText, occurrencesAtRead: t.occurrencesAtRead,
        sameRevision: f.blobSha === t.blobSha,
      }, cmd.payload.changes), TODO, (e) => e);
    },
  };
}

/**
 * ADR-0022: replace an Inbox note's body. CAS on the blob the owner read (a newer blob is a visible conflict, never an
 * overwrite); BOM, frontmatter, EOL and final newline kept by the kernel. Dedupe/replay: the executor's default parent
 * replay, which reproduces the exact bytes because the parent still holds the blob this edit was computed against.
 */
export function editNotePlan(cmd: Extract<Command, { type: 'EditNote' }>): WritePlan<Receipt['effect']> {
  const { note, body } = cmd.payload;
  return {
    message: 'Vault Companion: edit note',
    async compute(store, at) {
      const path = parseVaultPath(note.path);
      if (!path || !isInboxNotePath(path) || !canWrite(path, 'update')) return refuse('refused:path', 'only notes directly in Inbox/ can be edited');
      const f = await readTodo(store, at, path);
      if (!f.ok) {
        const p = f.planned as Extract<Planned<never>, { ok: false }>;
        // Gone since the read: the same fix as a changed note (reload).
        return p.code === 'refused:structure' ? refuse('conflict:task-changed', 'the note changed on another device; reload it') : f.planned;
      }
      if (f.blobSha !== note.blobSha) return refuse('conflict:task-changed', 'the note changed on another device; reload it');
      return fromKernel(md.editNoteBody(f.text, body), path, () => ({ kind: 'note-edited' as const, path }));
    },
  };
}

const refused = (code: ErrorCode, message: string): Refused => ({ kind: 'refused', code, message });

/**
 * The verified completion behind an Undo token (ADR-0013): commit `C` carries the target's operation ID and payload
 * hash, changed only the To-Do List, and replaying the target on `C^` yields exactly `C`'s blob (review F4/F5).
 */
async function verifiedCompletion(
  store: VaultStore,
  c: CommitInfo,
  target: CompleteTaskCommand,
  timeZone: string,
): Promise<
  | { ok: true; before: TodoFile; afterBlob: string; effect: md.CompleteEffect; ambiguousInC: boolean }
  | { ok: false; planned: Planned<never> }
> {
  const changed = c.files.length === 1 ? c.files[0] : undefined;
  if (c.parent === null || changed?.path !== TODO || changed.blobSha === null) {
    return { ok: false, planned: refuse('invalid', 'undo target does not match the recorded completion') };
  }
  const before = await readTodo(store, c.parent);
  if (!before.ok) return { ok: false, planned: refuse('dedupe-unknown', 'the completion cannot be verified') };
  const replay = completeOn(target, before, timeZone);
  if (!replay.ok || (await gitBlobSha(replay.bytes)) !== changed.blobSha) {
    return { ok: false, planned: refuse('dedupe-unknown', 'the completion cannot be verified') };
  }
  // Review P4E-Astra #1: which Done line is "the" completed task is only knowable in C's own result. If C already held
  // an identical completed line, a later unique match at X may be the twin, not the task this completion produced.
  const inC = md.parseTodoList(decodeUtf8(replay.bytes) ?? '');
  const twins = inC.ok ? inC.tasks.filter((t) => t.section === 'done' && t.lineText === replay.effect.completedLineText).length : 2;
  return { ok: true, before, afterBlob: changed.blobSha, effect: replay.effect, ambiguousInC: twins !== 1 };
}

/**
 * Undo by token (ADR-0013). Per attempt at X: read commit `C` (the token) and check it is the target's completion; one
 * single-page listing of `C..X` answers whether `C` is on the branch, whether this Undo already applied (dedupe), and
 * whether another Undo of `C` exists. More than one page ⇒ `refused:undo-expired`. No paged search anywhere.
 */
function undoPlan(cmd: Extract<Command, { type: 'UndoCompleteTask' }>, raw: unknown, timeZone: string): WritePlan<Receipt['effect']> {
  const target = cmd.payload.target;
  const token = cmd.payload.targetCommit;
  const rawTarget = (raw as { payload: { target: unknown } }).payload.target;
  // Filled by `findApplied` for the X that `compute` then runs at.
  let checked: { x: string; completion: CommitInfo } | null = null;
  // Filled by `findApplied` when this Undo's own commit U is found: `deriveApplied` reuses both (call budget).
  let applied: { completion: CommitInfo; undo: CommitInfo } | null = null;

  /** The inverse of the verified completion `v` on the task list at `at` (X for a write, U^ to verify U). */
  const inverseAt = async (store: VaultStore, v: Extract<Awaited<ReturnType<typeof verifiedCompletion>>, { ok: true }>, at: string): Promise<Planned<Receipt['effect']>> => {
    const f = await readTodo(store, at);
    if (!f.ok) return f.planned;
    if (f.blobSha === v.afterBlob) {
      // Exact inverse (review A1/R1): nothing changed since the completion, so its parent's bytes are the original —
      // the replay just proved completing them yields exactly this file.
      return { ok: true, path: TODO, expect: 'regular-file', bytes: v.before.bytes, effect: { kind: 'reopened', openLineText: v.effect.openLineText } };
    }
    if (v.ambiguousInC) {
      return refuse('conflict:task-changed', 'identical completed tasks: this one cannot be told apart any more; undo it in Obsidian');
    }
    const r = md.undoCompleteTask(f.text, { completion: v.effect, unchangedSinceCompletion: false });
    return fromKernel(r, TODO, (e) => ({ kind: 'reopened' as const, openLineText: e.openLineText }));
  };

  const readToken = async (store: VaultStore): Promise<CommitInfo | Refused> => {
    const c = await store.readCommit(token);
    if (!c) return refused('conflict:task-changed', 'that completion is not in the vault');
    // Never trust the token: it must name the target's own commit, by operation ID and payload hash.
    if (c.trailers[TRAILER_OP] !== target.operationId || c.trailers[TRAILER_PAYLOAD] !== (await payloadHash(rawTarget))) {
      return refused('invalid', 'undo target does not match the recorded completion');
    }
    return c;
  };

  return {
    message: 'Vault Companion: undo completion',
    trailers: { [TRAILER_UNDOES]: target.operationId },
    maxAttempts: UNDO_MAX_ATTEMPTS,
    async findApplied(store, x, operationId) {
      checked = null;
      applied = null;
      const c = await readToken(store);
      if ('kind' in c) return c;
      const since = await store.commitsSince(c.sha, x);
      // Review O5: neither answer can tell whether an earlier attempt of THIS Undo already applied (its own commit would be
      // in the unlisted range), so neither may claim "not applied".
      if (since.kind === 'not-ancestor' || since.kind === 'too-many') {
        return refused('dedupe-unknown', 'this Undo may already have been applied; check the task in Obsidian');
      }
      const own = since.commits.find((k) => k.trailers[TRAILER_OP] === operationId);
      if (own) {
        const info = await store.readCommit(own.sha);
        if (info) applied = { completion: c, undo: info };
        return { kind: 'found', op: { commitSha: own.sha, payloadHash: own.trailers[TRAILER_PAYLOAD] ?? '', paths: (info?.files ?? []).map((f) => f.path) } };
      }
      // Rerun review Opus N6: a completion can be undone once; a stale second Undo would reopen a LATER completion.
      if (since.commits.some((k) => k.trailers[TRAILER_UNDOES] === target.operationId)) {
        return refused('conflict:task-changed', 'that completion was already undone');
      }
      checked = { x, completion: c };
      return { kind: 'not-found' };
    },
    async compute(store, at) {
      if (checked?.x !== at) return refuse('dedupe-unknown', 'the completion was not checked at this revision');
      const v = await verifiedCompletion(store, checked.completion, target, timeZone);
      if (!v.ok) return v.planned;
      return inverseAt(store, v, at);
    },
    // This Undo's own commit U (found by operation ID, payload hash checked by the executor). Review P4E-Astra #3: U
    // must actually be the inverse — rebuilt against U's first-parent task list, it must equal U's blob — before a
    // receipt certifies it. Reuses the C and U already read in this attempt.
    async deriveApplied(store, commitSha) {
      const u = applied?.undo.sha === commitSha ? applied.undo : await store.readCommit(commitSha);
      if (!u || u.trailers[TRAILER_UNDOES] !== target.operationId || u.parent === null) return { ok: false, reason: 'not an undo of this completion' };
      const changed = u.files.length === 1 ? u.files[0] : undefined;
      if (changed?.path !== TODO || changed.blobSha === null) return { ok: false, reason: 'the undo commit does not update the task list' };
      const c = applied?.completion ?? (await readToken(store));
      if ('kind' in c) return { ok: false, reason: c.message };
      const v = await verifiedCompletion(store, c, target, timeZone);
      if (!v.ok) return { ok: false, reason: 'the completion cannot be verified' };
      const rebuilt = await inverseAt(store, v, u.parent);
      if (!rebuilt.ok || (await gitBlobSha(rebuilt.bytes)) !== changed.blobSha) return { ok: false, reason: 'the undo commit is not the inverse' };
      return { ok: true, path: TODO, effect: rebuilt.effect };
    },
  };
}

type ActiveWriteCommand = Extract<Command, { type: 'CaptureActiveWork' | 'EditActiveWork' | 'ReviewActiveWork' }>;
function activeWorkOn(cmd: ActiveWriteCommand, f: TodoFile, timeZone: string): Planned<md.ActiveWorkEffect> {
  if (cmd.type === 'CaptureActiveWork') return fromKernel(md.captureActiveWork(f.text, cmd.payload), ACTIVE, (e) => e);
  const t = cmd.payload.item;
  const locator = { lineIndex: t.lineIndex, lineText: t.lineText, occurrencesAtRead: t.occurrencesAtRead, sameRevision: f.blobSha === t.blobSha };
  const r = cmd.type === 'EditActiveWork' ? md.editActiveWork(f.text, locator, cmd.payload.changes) :
    md.reviewActiveWork(f.text, locator, cmd.payload.action, userDate(cmd.occurredAt, timeZone), cmd.payload.action === 'drop' ? cmd.payload.reason : undefined);
  return fromKernel(r, ACTIVE, (e) => e);
}
export function activeWorkPlan(cmd: ActiveWriteCommand, timeZone: string): WritePlan<md.ActiveWorkEffect> {
  return {
    message: 'Vault Companion: update Active Work',
    async compute(store, at) {
      const f = await readTodo(store, at, ACTIVE);
      return f.ok ? activeWorkOn(cmd, f, timeZone) : f.planned;
    },
  };
}
async function verifiedActiveWork(store: VaultStore, c: CommitInfo, target: Extract<Command, { type: 'ReviewActiveWork' }>, timeZone: string) {
  const changed = c.files.length === 1 ? c.files[0] : undefined;
  if (c.parent === null || changed?.path !== ACTIVE || changed.blobSha === null) {
    return { ok: false as const, planned: refuse('invalid', 'undo target does not match the recorded review') };
  }
  const before = await readTodo(store, c.parent, ACTIVE);
  if (!before.ok) return { ok: false as const, planned: refuse('dedupe-unknown', 'the review cannot be verified') };
  const replay = activeWorkOn(target, before, timeZone);
  if (!replay.ok || (await gitBlobSha(replay.bytes)) !== changed.blobSha) {
    return { ok: false as const, planned: refuse('dedupe-unknown', 'the review cannot be verified') };
  }
  return { ok: true as const, before, afterBytes: replay.bytes, effect: replay.effect };
}
function undoActiveWorkPlan(cmd: Extract<Command, { type: 'UndoActiveWork' }>, raw: unknown, timeZone: string): WritePlan<Receipt['effect']> {
  const target = cmd.payload.target;
  const token = cmd.payload.targetCommit;
  const rawTarget = (raw as { payload: { target: unknown } }).payload.target;
  // Filled by `findApplied` for the X that `compute` then runs at.
  let checked: { x: string; review: CommitInfo } | null = null;
  // Filled by `findApplied` when this Undo's own commit U is found: `deriveApplied` reuses both (call budget).
  let applied: { review: CommitInfo; undo: CommitInfo } | null = null;

  /** The inverse of the verified review `v` on Active Work at `at` (X for a write, U^ to verify U). */
  const inverseAt = async (store: VaultStore, v: Extract<Awaited<ReturnType<typeof verifiedActiveWork>>, { ok: true }>, at: string): Promise<Planned<Receipt['effect']>> => {
    const f = await readTodo(store, at, ACTIVE);
    if (!f.ok) return f.planned;
    return fromKernel(md.undoActiveWork(f.text, decodeUtf8(v.afterBytes)!, v.before.text, v.effect), ACTIVE, (e) => e);
  };

  const readToken = async (store: VaultStore): Promise<CommitInfo | Refused> => {
    const c = await store.readCommit(token);
    if (!c) return refused('conflict:task-changed', 'that review is not in the vault');
    // Never trust the token: it must name the target's own commit, by operation ID and payload hash.
    if (c.trailers[TRAILER_OP] !== target.operationId || c.trailers[TRAILER_PAYLOAD] !== (await payloadHash(rawTarget))) {
      return refused('invalid', 'undo target does not match the recorded review');
    }
    return c;
  };

  return {
    message: 'Vault Companion: undo Active Work review',
    trailers: { [TRAILER_UNDOES]: target.operationId },
    maxAttempts: UNDO_MAX_ATTEMPTS,
    async findApplied(store, x, operationId) {
      checked = null;
      applied = null;
      const c = await readToken(store);
      if ('kind' in c) return c;
      const since = await store.commitsSince(c.sha, x);
      // Review O5: neither answer can tell whether an earlier attempt of THIS Undo already applied (its own commit would be
      // in the unlisted range), so neither may claim "not applied".
      if (since.kind === 'not-ancestor' || since.kind === 'too-many') {
        return refused('dedupe-unknown', 'this Undo may already have been applied; check the Active Work item in Obsidian');
      }
      const own = since.commits.find((k) => k.trailers[TRAILER_OP] === operationId);
      if (own) {
        const info = await store.readCommit(own.sha);
        if (info) applied = { review: c, undo: info };
        return { kind: 'found', op: { commitSha: own.sha, payloadHash: own.trailers[TRAILER_PAYLOAD] ?? '', paths: (info?.files ?? []).map((f) => f.path) } };
      }
      // Rerun review Opus N6: a review can be undone once; a stale second Undo would reopen a LATER review.
      if (since.commits.some((k) => k.trailers[TRAILER_UNDOES] === target.operationId)) {
        return refused('conflict:task-changed', 'that review was already undone');
      }
      checked = { x, review: c };
      return { kind: 'not-found' };
    },
    async compute(store, at) {
      if (checked?.x !== at) return refuse('dedupe-unknown', 'the review was not checked at this revision');
      const v = await verifiedActiveWork(store, checked.review, target, timeZone);
      if (!v.ok) return v.planned;
      return inverseAt(store, v, at);
    },
    // This Undo's own commit U (found by operation ID, payload hash checked by the executor). Review P4E-Astra #3: U
    // must actually be the inverse — rebuilt against U's first-parent Active Work, it must equal U's blob — before a
    // receipt certifies it. Reuses the C and U already read in this attempt.
    async deriveApplied(store, commitSha) {
      const u = applied?.undo.sha === commitSha ? applied.undo : await store.readCommit(commitSha);
      if (!u || u.trailers[TRAILER_UNDOES] !== target.operationId || u.parent === null) return { ok: false, reason: 'not an undo of this review' };
      const changed = u.files.length === 1 ? u.files[0] : undefined;
      if (changed?.path !== ACTIVE || changed.blobSha === null) return { ok: false, reason: 'the undo commit does not update Active Work' };
      const c = applied?.review ?? (await readToken(store));
      if ('kind' in c) return { ok: false, reason: c.message };
      const v = await verifiedActiveWork(store, c, target, timeZone);
      if (!v.ok) return { ok: false, reason: 'the review cannot be verified' };
      const rebuilt = await inverseAt(store, v, u.parent);
      if (!rebuilt.ok || (await gitBlobSha(rebuilt.bytes)) !== changed.blobSha) return { ok: false, reason: 'the undo commit is not the inverse' };
      return { ok: true, path: ACTIVE, effect: rebuilt.effect };
    },
  };
}

function trainingOn(cmd: Extract<Command, { type: 'LogTraining' }>, f: TodoFile): Planned<md.TrainingEffect> {
  return fromKernel(md.insertTrainingRow(f.text, cmd.payload.session), TRAINING, (e) => e);
}
export function trainingPlan(cmd: Extract<Command, { type: 'LogTraining' }>): WritePlan<md.TrainingEffect> {
  return { message: 'Vault Companion: log training', async compute(store, at) {
    if (!canWrite(TRAINING, 'update')) return refuse('refused:path', 'training path is not writable');
    const f = await readTodo(store, at, TRAINING);
    return f.ok ? trainingOn(cmd, f) : f.planned;
  } };
}
async function verifiedTraining(store: VaultStore, c: CommitInfo, target: Extract<Command, { type: 'LogTraining' }>) {
  const changed = c.files.length === 1 ? c.files[0] : undefined;
  if (c.parent === null || changed?.path !== TRAINING || changed.blobSha === null) {
    return { ok: false as const, planned: refuse('invalid', 'undo target does not match the recorded session') };
  }
  const before = await readTodo(store, c.parent, TRAINING);
  if (!before.ok) return { ok: false as const, planned: refuse('dedupe-unknown', 'the session cannot be verified') };
  const replay = trainingOn(target, before);
  if (!replay.ok || (await gitBlobSha(replay.bytes)) !== changed.blobSha) {
    return { ok: false as const, planned: refuse('dedupe-unknown', 'the session cannot be verified') };
  }
  return { ok: true as const, before, afterBytes: replay.bytes, effect: replay.effect };
}
function undoTrainingPlan(cmd: Extract<Command, { type: 'UndoLogTraining' }>, raw: unknown): WritePlan<Receipt['effect']> {
  const target = cmd.payload.target;
  const token = cmd.payload.targetCommit;
  const rawTarget = (raw as { payload: { target: unknown } }).payload.target;
  // Filled by `findApplied` for the X that `compute` then runs at.
  let checked: { x: string; session: CommitInfo } | null = null;
  // Filled by `findApplied` when this Undo's own commit U is found: `deriveApplied` reuses both (call budget).
  let applied: { session: CommitInfo; undo: CommitInfo } | null = null;

  /** The inverse of the verified session `v` on Training at `at` (X for a write, U^ to verify U). */
  const inverseAt = async (store: VaultStore, v: Extract<Awaited<ReturnType<typeof verifiedTraining>>, { ok: true }>, at: string): Promise<Planned<Receipt['effect']>> => {
    if (!canWrite(TRAINING, 'update')) return refuse('refused:path', 'training path is not writable');
    const f = await readTodo(store, at, TRAINING);
    if (!f.ok) return f.planned;
    return fromKernel(md.undoTraining(f.text, decodeUtf8(v.afterBytes)!, v.before.text, v.effect), TRAINING, (e) => e);
  };

  const readToken = async (store: VaultStore): Promise<CommitInfo | Refused> => {
    const c = await store.readCommit(token);
    if (!c) return refused('conflict:task-changed', 'that session is not in the vault');
    // Never trust the token: it must name the target's own commit, by operation ID and payload hash.
    if (c.trailers[TRAILER_OP] !== target.operationId || c.trailers[TRAILER_PAYLOAD] !== (await payloadHash(rawTarget))) {
      return refused('invalid', 'undo target does not match the recorded session');
    }
    return c;
  };

  return {
    message: 'Vault Companion: undo Training session',
    trailers: { [TRAILER_UNDOES]: target.operationId },
    maxAttempts: UNDO_MAX_ATTEMPTS,
    async findApplied(store, x, operationId) {
      checked = null;
      applied = null;
      const c = await readToken(store);
      if ('kind' in c) return c;
      const since = await store.commitsSince(c.sha, x);
      // Review O5: neither answer can tell whether an earlier attempt of THIS Undo already applied (its own commit would be
      // in the unlisted range), so neither may claim "not applied".
      if (since.kind === 'not-ancestor' || since.kind === 'too-many') {
        return refused('dedupe-unknown', 'this Undo may already have been applied; check the Training item in Obsidian');
      }
      const own = since.commits.find((k) => k.trailers[TRAILER_OP] === operationId);
      if (own) {
        const info = await store.readCommit(own.sha);
        if (info) applied = { session: c, undo: info };
        return { kind: 'found', op: { commitSha: own.sha, payloadHash: own.trailers[TRAILER_PAYLOAD] ?? '', paths: (info?.files ?? []).map((f) => f.path) } };
      }
      // An operation can be undone only once, even if later edits restore identical bytes.
      if (since.commits.some((k) => k.trailers[TRAILER_UNDOES] === target.operationId)) {
        return refused('conflict:task-changed', 'that session was already undone');
      }
      checked = { x, session: c };
      return { kind: 'not-found' };
    },
    async compute(store, at) {
      if (checked?.x !== at) return refuse('dedupe-unknown', 'the session was not checked at this revision');
      const v = await verifiedTraining(store, checked.session, target);
      if (!v.ok) return v.planned;
      return inverseAt(store, v, at);
    },
    // This Undo's own commit U (found by operation ID, payload hash checked by the executor). Review P4E-Astra #3: U
    // must actually be the inverse — rebuilt against U's first-parent Training, it must equal U's blob — before a
    // receipt certifies it. Reuses the C and U already read in this attempt.
    async deriveApplied(store, commitSha) {
      const u = applied?.undo.sha === commitSha ? applied.undo : await store.readCommit(commitSha);
      if (!u || u.trailers[TRAILER_UNDOES] !== target.operationId || u.parent === null) return { ok: false, reason: 'not an undo of this session' };
      const changed = u.files.length === 1 ? u.files[0] : undefined;
      if (changed?.path !== TRAINING || changed.blobSha === null) return { ok: false, reason: 'the undo commit does not update Training' };
      const c = applied?.session ?? (await readToken(store));
      if ('kind' in c) return { ok: false, reason: c.message };
      const v = await verifiedTraining(store, c, target);
      if (!v.ok) return { ok: false, reason: 'the session cannot be verified' };
      const rebuilt = await inverseAt(store, v, u.parent);
      if (!rebuilt.ok || (await gitBlobSha(rebuilt.bytes)) !== changed.blobSha) return { ok: false, reason: 'the undo commit is not the inverse' };
      return { ok: true, path: TRAINING, effect: rebuilt.effect };
    },
  };
}

export function triageDecidePlan(cmd: Extract<Command, { type: 'TriageDecide' }>, raw: unknown = cmd): WritePlan<Receipt['effect']> {
  const path = triageDecisionPath(cmd.occurredAt);
  const line: DecisionLine = { schemaVersion: 1, decisionId: cmd.operationId, at: cmd.occurredAt, ...cmd.payload };
  const effect = { kind: 'triage-decided' as const, path, decisionId: cmd.operationId };
  let lineEvidence: string | null = null;
  let cached: { at: string; text: string | null } | null = null;
  const read = async (store: VaultStore, at: string) => {
    if (cached?.at === at) return cached.text;
    const files = await store.listFiles(TRIAGE_DIR, at);
    const text = await readTriageText(store, at, files, path);
    cached = { at, text };
    return text;
  };
  const sameLine = (text: string | null) => {
    const matches = parseDecisionLines(text).filter((d) => d.decisionId === cmd.operationId);
    return matches.length === 1 && new TextDecoder().decode(appendDecisionLine(null, matches[0]!)) === new TextDecoder().decode(appendDecisionLine(null, line));
  };
  const plan: WritePlan<Receipt['effect']> = {
    message: 'Vault Companion: triage decision',
    async findApplied(store, at, operationId) {
      lineEvidence = null;
      const found = await findInOnePage(store, cmd.baseRevision, at, operationId);
      if (found.kind !== 'not-found') return found;
      try {
        const text = await read(store, at);
        if (!hasDecisionId(text, operationId)) return found;
        if (!sameLine(text)) return refused('operation-id-reused', 'decision ID already exists with different or unreadable contents');
        // A desktop commit can retain a decision but lose its app trailer. The line itself proves the effect.
        lineEvidence = at;
        return { kind: 'found', op: { commitSha: at, paths: [path], payloadHash: await payloadHash(raw) } };
      } catch (e) {
        if (e instanceof FileTooLarge) return refused('refused:too-large', 'decision file is larger than 1 MB');
        if (e instanceof TypeError) return refused('refused:encoding', 'decision file is not valid UTF-8');
        throw e;
      }
    },
    async deriveApplied(store, at, paths) {
      if (lineEvidence === at && sameLine(await read(store, at))) return { ok: true, path, effect };
      return replayOnParent(plan, store, at, paths);
    },
    async compute(store, at) {
      if (!canWrite(path, 'create') || !canWrite(path, 'update')) return refuse('refused:path', 'decision path is not writable');
      try {
        const text = await read(store, at);
        if (hasDecisionId(text, cmd.operationId)) return refuse('dedupe-unknown', 'decision ID already exists');
        const bytes = appendDecisionLine(text, line);
        if (bytes.length > MAX_NOTE_BYTES) return refuse('refused:too-large', 'decision file would exceed 1 MB');
        return { ok: true, path, expect: text === null ? 'absent' : 'regular-file', bytes, effect };
      } catch (e) {
        if (e instanceof FileTooLarge) return refuse('refused:too-large', 'decision file is larger than 1 MB');
        if (e instanceof TypeError) return refuse('refused:encoding', 'decision file is not valid UTF-8');
        throw e;
      }
    },
  };
  return plan;
}

function planFor(cmd: Command, raw: unknown, deps: CommandServiceDeps): WritePlan<Receipt['effect']> {
  switch (cmd.type) {
    case 'TriageDecide':
      return triageDecidePlan(cmd, raw);
    case 'LogTraining': return trainingPlan(cmd);
    case 'UndoLogTraining': return undoTrainingPlan(cmd, raw);
    case 'CaptureActiveWork':
    case 'EditActiveWork':
    case 'ReviewActiveWork':
      return activeWorkPlan(cmd, deps.timeZone);
    case 'UndoActiveWork':
      return undoActiveWorkPlan(cmd, raw, deps.timeZone);
    case 'EditTask':
      return editPlan(cmd);
    case 'EditNote':
      return editNotePlan(cmd);
    case 'CompleteTask': {
      const inner = completePlan(cmd, deps.timeZone);
      return {
        message: inner.message,
        async compute(store, at) {
          const p = await inner.compute(store, at);
          return p.ok ? { ...p, effect: { kind: 'completed', completedLineText: p.effect.completedLineText, openLineText: p.effect.openLineText, completedInPlace: p.effect.completedInPlace, doneDate: p.effect.doneDate } } : p;
        },
      };
    }
    case 'UndoCompleteTask':
      return undoPlan(cmd, raw, deps.timeZone);
    case 'CaptureTask': {
      const p = cmd.payload;
      const createdDate = userDate(cmd.occurredAt, deps.timeZone);
      return {
        message: 'Vault Companion: capture task',
        async compute(store, at) {
          const f = await readTodo(store, at);
          if (!f.ok) return f.planned;
          const input: md.CaptureTaskInput = {
            text: p.text,
            createdDate,
            ...(p.priority ? { priority: p.priority } : {}),
            ...(p.due ? { due: p.due } : {}),
            ...(p.context ? { context: p.context } : {}),
          };
          return fromKernel(md.captureTask(f.text, input), TODO, (e) => ({ kind: 'task-captured' as const, lineText: e.lineText }));
        },
      };
    }
    case 'CaptureNote': {
      const date = userDate(cmd.occurredAt, deps.timeZone);
      const noteInput: md.NoteInput = { text: cmd.payload.text, date, capturedAt: cmd.occurredAt, ...(cmd.payload.context ? { context: cmd.payload.context } : {}) };
      // renderNote throws on bad input by signature; checkNoteInput is its non-throwing guard (K follow-up).
      const invalid = md.checkNoteInput(noteInput);
      const bytes = invalid ? new Uint8Array() : encoder.encode(md.renderNote(noteInput));
      return {
        message: 'Vault Companion: capture note',
        async compute(store, at) {
          if (invalid) return refuse(invalid.code, invalid.message);
          let names: readonly string[];
          try {
            names = await store.listDir(INBOX_DIR, at);
          } catch (e) {
            // Rerun review Astra N5 / Opus N3: a truncated listing is permanent, not a retryable outage.
            if (e instanceof FileTooLarge) return refuse('refused:too-large', 'the Inbox folder is too large to check for name collisions');
            throw e;
          }
          const path = parseVaultPath(md.noteFileName(cmd.payload.text, date, names));
          if (!path || !canWrite(path, 'create')) return refuse('refused:path', 'note path is not allowed');
          // The Inbox listing and the create refer to the same X; head-CAS publishes only if nothing landed since
          // (review A4). Exact-path existence is covered by the listing too.
          return { ok: true, path, expect: 'absent', bytes, effect: { kind: 'note-captured', path } };
        },
        // The chosen name depends on Inbox/ contents at write time, so verify by content, not replay.
        async deriveApplied(store, commitSha, paths) {
          const path = paths.length === 1 ? parseVaultPath(paths[0]!) : null;
          if (!path || !path.startsWith(`${INBOX_DIR}/`)) return { ok: false, reason: 'unexpected paths' };
          const file = await store.readFile(path, commitSha);
          if (!file || decodeUtf8(file.bytes) !== decodeUtf8(bytes)) return { ok: false, reason: 'note content differs' };
          return { ok: true, path, effect: { kind: 'note-captured', path } };
        },
      };
    }
  }
}

/** Ordered Today rule from docs/product-contract.md; dates are parsed YYYY-MM-DD values. */
export function classifyOpenTask(view: TaskView, today: string): 'overdue' | 'today' | 'other' {
  if (view.status !== 'open') return 'other';
  if (view.due !== null && view.due < today) return 'overdue';
  if (view.due === today) return 'today';
  if ((view.start !== null && view.start > today) || (view.scheduled !== null && view.scheduled > today)) return 'other';
  if (view.scheduled !== null && view.scheduled <= today) return 'today';
  if (view.priority === 'highest' || view.priority === 'high') return 'today';
  return 'other';
}

export function createCommandService(deps: CommandServiceDeps) {
  return {
    async execute(cmd: Command, raw: unknown): Promise<Receipt | ApiError> {
      const skew = checkOccurredAt(cmd.occurredAt, deps.now());
      if (!skew.ok) return apiError('clock-skew', 'the device clock is ahead; check the time settings');
      let r;
      try {
        r = await executeWrite(deps.store, { operationId: cmd.operationId, baseRevision: cmd.baseRevision, payloadHash: await payloadHash(raw) }, planFor(cmd, raw, deps));
      } catch (e) {
        // A kernel post-condition failed: a bug, never a write. Retrying the same input cannot help.
        if (e instanceof md.KernelInvariantError) return apiError('refused:structure', 'a safety check refused this change; nothing was written');
        throw e;
      }
      if (!r.ok) return apiError(r.code, r.message, r.retryable);
      return {
        operationId: cmd.operationId,
        status: r.status,
        path: r.path,
        commitSha: r.commitSha,
        blobSha: r.blobSha,
        effect: r.effect,
        ...(skew.backdated ? { flags: ['backdated' as const] } : {}),
      };
    },

    /** ADR-0032 Radar decisions use the same executor/CAS/trailers, on their own wire command type. */
    async executeRadarDecide(cmd: ResearchRadarDecideCommand, raw: unknown): Promise<Receipt | ApiError> {
      const skew = checkOccurredAt(cmd.occurredAt, deps.now());
      if (!skew.ok) return apiError('clock-skew', 'the device clock is ahead; check the time settings');
      let r;
      try {
        r = await executeWrite(deps.store, { operationId: cmd.operationId, baseRevision: cmd.baseRevision, payloadHash: await payloadHash(raw) }, researchRadarDecidePlan(cmd, deps.now()));
      } catch (e) {
        if (e instanceof md.KernelInvariantError) return apiError('refused:structure', 'a safety check refused this change; nothing was written');
        throw e;
      }
      if (!r.ok) return apiError(r.code, r.message, r.retryable);
      return {
        operationId: cmd.operationId,
        status: r.status,
        path: r.path,
        commitSha: r.commitSha,
        blobSha: r.blobSha,
        effect: r.effect,
        ...(skew.backdated ? { flags: ['backdated' as const] } : {}),
      };
    },

    async readTasks(known: readonly string[]): Promise<TasksResponse | ApiError> {
      const { commitSha: x } = await deps.store.head();
      const f = await readTodo(deps.store, x);
      if (!f.ok) {
        const p = f.planned as Extract<Planned<never>, { ok: false }>;
        return apiError(p.code, p.message);
      }
      const parsed = md.parseTodoList(f.text);
      if (!parsed.ok) return apiError(parsed.code, parsed.message);
      const today = userDate(deps.now(), deps.timeZone);
      // Gate-3 G3-3: an over-long existing line must not invalidate the whole response; leave it out and count it.
      const fitting = parsed.tasks.filter((t) => t.lineText.length <= MAX_TASK_LINE);
      const views = fitting.map((t) => toView(t, f.blobSha));
      const open = views.filter((v) => v.status === 'open');
      const overdue = open.filter((v) => classifyOpenTask(v, today) === 'overdue');
      const isToday = (v: TaskView) => classifyOpenTask(v, today) === 'today';
      const knownMap = await answerKnown(deps.store, known, x);
      let vault: TasksResponse['vault'] = null;
      try { vault = await deps.store.commitMeta(x); } catch { /* Display metadata must never block task reads. */ }
      return {
        revision: x,
        vault,
        blobSha: f.blobSha,
        today,
        timeZone: deps.timeZone,
        writeBlock: parsed.writeBlock ? apiError(parsed.writeBlock.code, parsed.writeBlock.message) : null,
        known: knownMap,
        todayTasks: open.filter(isToday),
        overdue,
        allOpen: open,
        doneToday: views.filter((v) => v.status === 'done' && v.done === today),
        omittedLongLines: parsed.tasks.length - fitting.length,
      };
    },
  };
}

/** Single-page listings a task read may make to answer `known` (review O1): ≤ 5 store calls per read with head + file + metadata. */
export const KNOWN_LISTINGS = 2;

/**
 * Review O1: answer up to `MAX_KNOWN` commits with at most `KNOWN_LISTINGS` single-page listings, never one call per
 * commit. Each listing is `commitsSince(first unanswered, X)`: its base is answered exactly (a listing — even one too long
 * to return — exists only for an ancestor of X, per the port), every commit it lists is `included`, and X itself is.
 * The client asks the watermark first, then the oldest unacknowledged receipts, so under W1 the first listing usually
 * answers everything; a receipt older than the watermark becomes the base of the second. Anything still unanswered is
 * `not-included`: the client keeps overlaying it and asks again.
 */
async function answerKnown(store: VaultStore, known: readonly string[], x: string): Promise<Record<string, 'included' | 'not-included'>> {
  const answer: Record<string, 'included' | 'not-included'> = {};
  let pending = [...new Set(known)].slice(0, MAX_KNOWN).filter((sha) => {
    if (sha === x) answer[sha] = 'included';
    return sha !== x;
  });
  for (let listing = 0; listing < KNOWN_LISTINGS && pending.length > 0; listing++) {
    const [base] = pending as [string];
    const since = await store.commitsSince(base, x);
    answer[base] = since.kind === 'not-ancestor' ? 'not-included' : 'included';
    if (since.kind === 'ok') for (const c of since.commits) if (pending.includes(c.sha)) answer[c.sha] = 'included';
    pending = pending.filter((sha) => answer[sha] === undefined);
  }
  for (const sha of pending) answer[sha] = 'not-included';
  return answer;
}

export function toView(t: md.ParsedTask, blobSha: string): TaskView {
  return {
    locator: { path: TODO_LIST_PATH, blobSha, lineIndex: t.lineIndex, lineText: t.lineText, occurrencesAtRead: t.occurrences },
    description: t.description,
    status: t.status,
    section: t.section,
    priority: t.priority,
    due: t.due,
    scheduled: t.scheduled,
    start: t.start,
    created: t.created,
    done: t.done,
    recurring: t.recurrence !== null,
    readOnlyReason: t.readOnlyReason,
    links: [...t.links],
  };
}
