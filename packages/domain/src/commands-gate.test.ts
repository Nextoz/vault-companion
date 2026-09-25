// Phase 1 gate regressions (docs/reviews/phase-1-reconciliation.md): the reviewers' concrete scenarios,
// run through the real command services, kernel and in-memory Git.
import { Command, type Receipt, type TaskView } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { createCommandService } from './commands.ts';
import type { WriteRequest } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const TODO = 'Tasks/To-Do List.md';
const NOW = new Date('2026-09-24T12:00:00Z');
let n = 0;
const uuid = () => `00000000-0000-4000-9000-${(++n).toString(16).padStart(12, '0')}`;

async function setup(todo: string) {
  const store = await InMemoryStore.create({ [TODO]: todo });
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
    const undo = env('UndoCompleteTask', { target: complete });

    // The first delivery of `complete` pauses right before its write; meanwhile a retry of the same envelope
    // lands and the user's Undo lands (restoring byte-identical content). Then the paused write resumes.
    const realWrite = store.writeFile.bind(store);
    let paused = false;
    store.writeFile = async (req: WriteRequest) => {
      if (!paused && req.trailers['Vault-Companion-Op'] === complete.operationId) {
        paused = true;
        ok(await run(complete));
        ok(await run(undo));
      }
      return realWrite(req);
    };
    const delayed = ok(await run(complete));

    expect(delayed.status).toBe('already-applied');
    expect(store.commitsWithOp(complete.operationId)).toHaveLength(1);
    expect(store.commitsWithOp(undo.operationId)).toHaveLength(1);
    expect(store.text(TODO)).toBe(original); // the Undo stands
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
    ok(await run(complete));
    expect(store.text(TODO)).not.toBe(original);
    ok(await run(env('UndoCompleteTask', { target: complete })));
    expect(store.text(TODO)).toBe(original);
  });
});
