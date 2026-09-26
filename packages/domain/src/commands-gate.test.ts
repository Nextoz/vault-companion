// Phase 1 gate regressions (docs/reviews/phase-1-reconciliation.md): the reviewers' concrete scenarios,
// run through the real command services, kernel and in-memory Git.
import { Command, type Receipt, type TaskView } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { createCommandService } from './commands.ts';
import { FileTooLarge, type WriteRequest } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const TODO = 'Tasks/To-Do List.md';
const NOW = new Date('2026-09-24T12:00:00Z');
let n = 0;
const uuid = () => `00000000-0000-4000-9000-${(++n).toString(16).padStart(12, '0')}`;

async function setup(todo: string) {
  return setupFiles({ [TODO]: todo });
}

async function setupFiles(files: Record<string, string>) {
  const store = await InMemoryStore.create(files);
  const svc = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  const base = store.headCommit;
  const env = (type: string, payload: unknown) => ({ schemaVersion: 1, operationId: uuid(), type, occurredAt: '2026-09-24T14:00:00+02:00', baseRevision: base, payload });
  const run = (raw: Record<string, unknown>) => svc.execute(Command.parse(raw), raw);
  const openTask = async (prefix: string): Promise<TaskView> => {
    const r = await svc.readTasks([]);
    if ('code' in r) throw new Error(r.code);
    return r.allOpen.find((t) => t.description.startsWith(prefix))!;
  };
  return { store, env, run, openTask };
}
const ok = (r: Receipt | { code: string }): Receipt => {
  if ('code' in r) throw new Error(`expected receipt, got ${r.code}`);
  return r;
};

describe('Phase 1 gate regressions', () => {
  it('A2 (Critical): a delayed duplicate Complete cannot land after a successful Undo (head-CAS, ADR-0011)', async () => {
    const original = '## Open\n\n- [ ] Water the plants #todo\n\n## Done\n\n- [x] Old #todo ✅ 2026-09-01\n';
    const { store, env, run, openTask } = await setup(original);
    const complete = env('CompleteTask', { task: (await openTask('Water the plants')).locator });
    let undo: ReturnType<typeof env> | null = null;

    // The first delivery of `complete` pauses right before its write; meanwhile a retry of the same envelope
    // lands and the user's Undo lands (restoring byte-identical content). Then the paused write resumes.
    const realWrite = store.writeFile.bind(store);
    let paused = false;
    store.writeFile = async (req: WriteRequest) => {
      if (!paused && req.trailers['Vault-Companion-Op'] === complete.operationId) {
        paused = true;
        const receipt = ok(await run(complete));
        undo = env('UndoCompleteTask', { target: complete, targetCommit: receipt.commitSha });
        ok(await run(undo));
      }
      return realWrite(req);
    };
    const delayed = ok(await run(complete));

    expect(delayed.status).toBe('already-applied');
    expect(store.commitsWithOp(complete.operationId)).toHaveLength(1);
    expect(store.commitsWithOp(undo!.operationId)).toHaveLength(1);
    expect(store.text(TODO)).toBe(original); // the Undo stands
  });

  it('rerun Astra N1 (Critical): an Inbox DIRECTORY with the note name is a taken name; its children survive', async () => {
    const { store, env, run } = await setupFiles({ [TODO]: '## Open\n\n## Done\n', 'Inbox/Alpha - 2026-09-24.md/keep.md': 'keep\n' });
    const r = ok(await run(env('CaptureNote', { text: 'Alpha' })));
    expect(r.path).toBe('Inbox/Alpha - 2026-09-24 (2).md');
    expect(store.text('Inbox/Alpha - 2026-09-24.md/keep.md')).toBe('keep\n');
  });

  it('rerun Opus N1: even with a wrong (empty) listing, create never overwrites an existing note', async () => {
    const { store, env, run } = await setupFiles({ [TODO]: '## Open\n\n## Done\n', 'Inbox/Alpha - 2026-09-24.md': 'PRECIOUS desktop note\n' });
    store.listDir = async () => []; // e.g. a transient 404 that a buggy adapter mapped to "empty"
    const head = store.headCommit;
    expect(await run(env('CaptureNote', { text: 'Alpha' }))).toMatchObject({ code: 'refused:structure' });
    expect(store.headCommit).toBe(head);
    expect(store.text('Inbox/Alpha - 2026-09-24.md')).toBe('PRECIOUS desktop note\n');
  });

  it('rerun Opus N6: a stale second Undo of an already-undone completion is refused and does not reopen a later completion', async () => {
    const { store, env, run, openTask } = await setup('## Open\n\n- [ ] A #todo\n\n## Done\n');
    const c1 = env('CompleteTask', { task: (await openTask('A')).locator });
    const r1 = ok(await run(c1));
    ok(await run(env('UndoCompleteTask', { target: c1, targetCommit: r1.commitSha })));
    const c2 = env('CompleteTask', { task: (await openTask('A')).locator });
    ok(await run(c2)); // same bytes as after c1
    const afterC2 = store.text(TODO);
    expect(await run(env('UndoCompleteTask', { target: c1, targetCommit: r1.commitSha }))).toMatchObject({ code: 'conflict:task-changed' });
    expect(store.text(TODO)).toBe(afterC2);
  });

  it('gate-3 F2 (ADR-0013 form): if C..X cannot be listed in one page, the Undo is refused, not applied', async () => {
    const { store, env, run, openTask } = await setup('## Open\n\n- [ ] A #todo\n\n## Done\n');
    const c1 = env('CompleteTask', { task: (await openTask('A')).locator });
    const r1 = ok(await run(c1));
    const afterC1 = store.text(TODO);
    store.commitsSince = async () => ({ kind: 'too-many' });
    expect(await run(env('UndoCompleteTask', { target: c1, targetCommit: r1.commitSha }))).toMatchObject({ code: 'refused:undo-expired' });
    expect(store.text(TODO)).toBe(afterC1);
  });

  it('rerun Astra N5 / Opus N3: a truncated Inbox listing is a non-retryable refusal, not an endless retry', async () => {
    const { store, env, run } = await setupFiles({ [TODO]: '## Open\n\n## Done\n' });
    store.listDir = async () => {
      throw new FileTooLarge('directory listing truncated');
    };
    expect(await run(env('CaptureNote', { text: 'Alpha' }))).toMatchObject({ code: 'refused:too-large', retryable: false });
  });

  it('rerun Opus N8 / A4: a case-variant note landing between planning and the write ends in (2), nothing overwritten', async () => {
    const { store, env, run } = await setupFiles({ [TODO]: '## Open\n\n## Done\n' });
    const realWrite = store.writeFile.bind(store);
    let injected = false;
    store.writeFile = async (req: WriteRequest) => {
      if (!injected) {
        injected = true;
        await store.commitFiles({ 'Inbox/alpha - 2026-09-24.md': 'desktop\n' });
      }
      return realWrite(req);
    };
    const r = ok(await run(env('CaptureNote', { text: 'Alpha' })));
    expect(r.path).toBe('Inbox/Alpha - 2026-09-24 (2).md');
    expect(store.text('Inbox/alpha - 2026-09-24.md')).toBe('desktop\n');
  });

  it.each([
    ['LF, no final newline', '## Done\n## Open\n- [ ] A #todo'],
    ['LF, final newline', '## Done\n## Open\n- [ ] A #todo\n'],
    ['CRLF', '## Done\r\n## Open\r\n- [ ] A #todo\r\n'],
    ['BOM', String.fromCharCode(0xfeff) + '## Done\n## Open\n- [ ] A #todo\n'],
    ['Done above Open with prose', '# T\n\n## Done\n\n_note_\n\n## Open\n\n- [ ] A #todo\n- [ ] B #todo\n'],
  ])('A1/R1 (Critical): exact Undo restores the original bytes when Done is above Open — %s', async (_n, original) => {
    const { store, env, run, openTask } = await setup(original);
    const complete = env('CompleteTask', { task: (await openTask('A')).locator });
    const r = ok(await run(complete));
    expect(store.text(TODO)).not.toBe(original);
    ok(await run(env('UndoCompleteTask', { target: complete, targetCommit: r.commitSha })));
    expect(store.text(TODO)).toBe(original);
  });
});
