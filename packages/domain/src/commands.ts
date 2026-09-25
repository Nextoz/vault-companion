// Application services: one WritePlan per command type (docs/commands.md) and the task read model.
// Pure orchestration over the VaultStore port and the Markdown kernel; no HTTP, no GitHub.
import type { ApiError, Command, CompleteTaskCommand, ErrorCode, Receipt, TasksResponse, TaskView } from '@vault-companion/contracts';
import * as md from '@vault-companion/vault-markdown';
import { executeWrite, replayOnParent, type Planned, type WritePlan } from './execute.ts';
import { canWrite, INBOX_DIR, parseVaultPath, TODO_LIST_PATH } from './paths.ts';
import { payloadHash } from './payload-hash.ts';
import { FileTooLarge, TRAILER_UNDOES, type VaultPath, type VaultStore } from './store.ts';
import { checkOccurredAt, userDate } from './time.ts';

export interface CommandServiceDeps {
  readonly store: VaultStore;
  readonly now: () => Date;
  readonly timeZone: string;
}

const TODO = TODO_LIST_PATH as VaultPath;

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
async function readTodo(store: VaultStore, at: string): Promise<{ ok: true; text: string; blobSha: string } | { ok: false; planned: Planned<never> }> {
  let file;
  try {
    file = await store.readFile(TODO, at);
  } catch (e) {
    if (e instanceof FileTooLarge) return { ok: false, planned: refuse('refused:too-large', 'the task list is too large to edit safely') };
    throw e;
  }
  if (!file) return { ok: false, planned: refuse('refused:structure', 'the task list was not found') };
  const text = decodeUtf8(file.bytes);
  if (text === null) return { ok: false, planned: refuse('refused:encoding', 'the task list is not valid UTF-8') };
  return { ok: true, text, blobSha: file.blobSha };
}

function fromKernel<E, R>(r: md.MutationOk<E> | md.Refusal, path: VaultPath, map: (e: E) => R): Planned<R> {
  if (!r.ok) return refuse(r.code, r.message);
  return { ok: true, path, expect: 'regular-file', bytes: encoder.encode(r.text), effect: map(r.effect) };
}

export function completePlan(cmd: CompleteTaskCommand, timeZone: string): WritePlan<md.CompleteEffect> {
  const doneDate = userDate(cmd.occurredAt, timeZone);
  return {
    message: 'Vault Companion: complete task',
    async compute(store, at) {
      const f = await readTodo(store, at);
      if (!f.ok) return f.planned;
      const t = cmd.payload.task;
      const r = md.completeTask(f.text, { lineIndex: t.lineIndex, lineText: t.lineText, occurrencesAtRead: t.occurrencesAtRead, sameRevision: f.blobSha === t.blobSha }, doneDate);
      return fromKernel(r, TODO, (e) => e);
    },
  };
}

function planFor(cmd: Command, raw: unknown, deps: CommandServiceDeps): WritePlan<Receipt['effect']> {
  switch (cmd.type) {
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
    case 'UndoCompleteTask': {
      const target = cmd.payload.target;
      const rawTarget = (raw as { payload: { target: unknown } }).payload.target;
      return {
        message: 'Vault Companion: undo completion',
        trailers: { [TRAILER_UNDOES]: target.operationId },
        async compute(store, at) {
          // Authenticate the target by its commit trailer and re-derive its effect (review F4/F5).
          const found = await store.findOperation(target.baseRevision, at, target.operationId);
          if (found.kind === 'unknown') return refuse('dedupe-unknown', 'cannot locate the completion to undo');
          if (found.kind === 'not-found') return refuse('conflict:task-changed', 'that completion is not in the vault');
          if (found.op.payloadHash !== (await payloadHash(rawTarget))) return refuse('invalid', 'undo target does not match the recorded completion');
          // Rerun review Opus N6: a completion can be undone once; a stale second Undo would reopen a LATER completion.
          const undone = await store.findOperation(found.op.commitSha, at, target.operationId, TRAILER_UNDOES);
          if (undone.kind === 'unknown') return refuse('dedupe-unknown', 'cannot establish whether this completion was already undone');
          if (undone.kind === 'found') return refuse('conflict:task-changed', 'that completion was already undone');
          const derived = await replayOnParent(completePlan(target, deps.timeZone), store, found.op.commitSha, found.op.paths);
          if (!derived.ok) return refuse('dedupe-unknown', 'the completion cannot be verified');
          const f = await readTodo(store, at);
          if (!f.ok) return f.planned;
          const completedFile = await store.readFile(TODO, found.op.commitSha);
          if (completedFile !== null && completedFile.blobSha === f.blobSha) {
            // Exact inverse (review A1/R1): nothing changed since the completion, so its parent's bytes are the
            // original — replayOnParent just proved completing them yields exactly the current file.
            const original = await store.readFile(TODO, await store.parentOf(found.op.commitSha));
            if (!original) return refuse('dedupe-unknown', 'the original task list cannot be read');
            return { ok: true, path: TODO, expect: 'regular-file', bytes: original.bytes, effect: { kind: 'reopened', openLineText: derived.effect.openLineText } };
          }
          const r = md.undoCompleteTask(f.text, { completion: derived.effect, unchangedSinceCompletion: false });
          return fromKernel(r, TODO, (e) => ({ kind: 'reopened' as const, openLineText: e.openLineText }));
        },
      };
    }
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
      const views = parsed.tasks.map((t) => toView(t, f.blobSha));
      const open = views.filter((v) => v.status === 'open');
      const overdue = open.filter((v) => v.due !== null && v.due < today);
      const isToday = (v: TaskView) =>
        !overdue.includes(v) && ([v.due, v.scheduled, v.start].some((d) => d !== null && d <= today) || v.priority === 'highest' || v.priority === 'high');
      const knownMap: Record<string, 'included' | 'not-included'> = {};
      for (const sha of known) knownMap[sha] = (await deps.store.isAncestor(sha, x)) ? 'included' : 'not-included';
      return {
        revision: x,
        blobSha: f.blobSha,
        today,
        timeZone: deps.timeZone,
        writeBlock: parsed.writeBlock ? apiError(parsed.writeBlock.code, parsed.writeBlock.message) : null,
        known: knownMap,
        todayTasks: open.filter(isToday),
        overdue,
        allOpen: open,
        doneToday: views.filter((v) => v.status === 'done' && v.done === today),
      };
    },
  };
}

function toView(t: md.ParsedTask, blobSha: string): TaskView {
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
