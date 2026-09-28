import { IDBFactory } from 'fake-indexeddb';
import { Command, type Receipt } from '@vault-companion/contracts';
import { expect, it } from 'vitest';
import { logTraining, undoLogTrainingDraft } from '../commands.ts';
import { openPendingStore } from './db.ts';
import { PendingQueue } from './queue.ts';

it('fills a training Undo draft from the durable rebased session and its receipt, once', async () => {
  const store = await openPendingStore(new IDBFactory());
  const bodies: Command[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const newest = '6'.repeat(40);
  let tail: Promise<unknown> = Promise.resolve();
  const queue = await PendingQueue.open({
    store, latestRevision: () => newest,
    locks: { request: (_name, fn) => { const next = tail.then(fn); tail = next.catch(() => undefined); return next; } },
    send: async (raw) => {
      const c = Command.parse(JSON.parse(raw)); bodies.push(c);
      if (c.type === 'LogTraining') await held;
      const receipt: Receipt = { operationId: c.operationId, status: 'applied', path: 'Health/Training Log.md',
        commitSha: (c.type === 'LogTraining' ? '3' : '4').repeat(40), blobSha: '5'.repeat(40),
        effect: { kind: 'training', op: c.type === 'LogTraining' ? 'logged' : 'undone', lineText: '| synthetic session |' } };
      return new Response(JSON.stringify(receipt), { status: 200 });
    },
  });
  try {
    queue.setSession('a'.repeat(64));
    const target = logTraining({ baseRevision: '1'.repeat(40) }, {
      type: 'Run', when: '2026-09-28T10:00:00Z', distance: 5.2, duration: 28,
    });
    const options = { accountKey: 'a'.repeat(64), label: 'Garden', taskKey: 'training' };
    await queue.enqueue(target, options);
    await expect.poll(() => bodies.length).toBe(1);
    await queue.undoCompletion(target, undoLogTrainingDraft({ baseRevision: newest }, target), options);
    expect(bodies).toHaveLength(1);
    release();
    await expect.poll(() => queue.getSnapshot().items.filter(i => i.state === 'saved').length).toBe(2);
    expect(bodies[0]?.baseRevision).toBe(newest);
    expect(bodies[1]).toMatchObject({ type: 'UndoLogTraining', payload: { target: bodies[0], targetCommit: '3'.repeat(40) } });
  } finally {
    release();
    queue.dispose();
    store.close();
  }
});
