import { IDBFactory } from 'fake-indexeddb';
import { Command, type Receipt } from '@vault-companion/contracts';
import { expect, it } from 'vitest';
import { moodCheckin, undoMoodCheckin, undoMoodCheckinDraft } from '../commands.ts';
import { openPendingStore } from './db.ts';
import { PendingQueue, type LockManagerLike } from './queue.ts';

const payload = { date: '2026-10-02', mood: 1, energy: -1, sleep: 7.5, checkinAt: '2026-10-02T06:14:00.000Z' };

function serialLocks(): LockManagerLike {
  let tail: Promise<unknown> = Promise.resolve();
  return { request<T>(_name: string, fn: () => Promise<T>): Promise<T> { const next = tail.then(fn); tail = next.catch(() => undefined); return next; } };
}

it('fills a mood Undo draft from the durable rebased check-in and its receipt, once', async () => {
  const store = await openPendingStore(new IDBFactory());
  const bodies: Command[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const newest = '6'.repeat(40);
  const queue = await PendingQueue.open({
    store, latestRevision: () => newest, locks: serialLocks(),
    send: async (raw) => {
      const c = Command.parse(JSON.parse(raw)); bodies.push(c);
      if (c.type === 'MoodCheckin') await held;
      const receipt: Receipt = { operationId: c.operationId, status: 'applied', path: `Journal/Daily/${payload.date}.md`,
        commitSha: (c.type === 'MoodCheckin' ? '3' : '4').repeat(40), blobSha: '5'.repeat(40),
        effect: { kind: 'mood', op: c.type === 'MoodCheckin' ? 'checked-in' : 'undone' } };
      return new Response(JSON.stringify(receipt), { status: 200 });
    },
  });
  try {
    queue.setSession('a'.repeat(64));
    const target = moodCheckin({ baseRevision: '1'.repeat(40) }, payload);
    const options = { accountKey: 'a'.repeat(64), label: `Mood \u00b7 ${payload.date}`, taskKey: 'mood' };
    await queue.enqueue(target, options);
    await expect.poll(() => bodies.length).toBe(1);
    await queue.undoCompletion(target, undoMoodCheckinDraft({ baseRevision: newest }, target), options);
    expect(bodies).toHaveLength(1);
    release();
    await expect.poll(() => queue.getSnapshot().items.filter((i) => i.state === 'saved').length).toBe(2);
    expect(bodies[0]?.baseRevision).toBe(newest);
    expect(bodies[1]).toMatchObject({ type: 'UndoMoodCheckin', payload: { target: bodies[0], targetCommit: '3'.repeat(40) } });
  } finally {
    release();
    queue.dispose();
    store.close();
  }
});

it('cancels both locally when the check-in was never sent', async () => {
  const store = await openPendingStore(new IDBFactory());
  const bodies: Command[] = [];
  const queue = await PendingQueue.open({
    store, locks: serialLocks(),
    send: async (raw) => { bodies.push(Command.parse(JSON.parse(raw))); throw new Error('must not send'); },
  });
  try {
    const target = moodCheckin({ baseRevision: '1'.repeat(40) }, payload);
    const options = { accountKey: 'a'.repeat(64), label: `Mood \u00b7 ${payload.date}`, taskKey: 'mood' };
    await queue.enqueue(target, options);
    expect(await queue.undoCompletion(target, undoMoodCheckinDraft({ baseRevision: '6'.repeat(40) }, target), options)).toBe('cancelled');
    queue.setSession('a'.repeat(64));
    await queue.flush();
    expect(bodies).toHaveLength(0);
    expect(await store.all()).toEqual([]);
  } finally {
    queue.dispose();
    store.close();
  }
});

it('binds a tokened mood Undo to the durable rebased check-in (ADR-0013)', async () => {
  const store = await openPendingStore(new IDBFactory());
  const bodies: Command[] = [];
  const newest = '6'.repeat(40);
  const queue = await PendingQueue.open({
    store, latestRevision: () => newest, locks: serialLocks(),
    send: async (raw) => {
      const c = Command.parse(JSON.parse(raw)); bodies.push(c);
      const receipt: Receipt = { operationId: c.operationId, status: 'applied', path: `Journal/Daily/${payload.date}.md`,
        commitSha: (c.type === 'MoodCheckin' ? '3' : '4').repeat(40), blobSha: '5'.repeat(40),
        effect: { kind: 'mood', op: c.type === 'MoodCheckin' ? 'checked-in' : 'undone' } };
      return new Response(JSON.stringify(receipt), { status: 200 });
    },
  });
  try {
    queue.setSession('a'.repeat(64));
    const target = moodCheckin({ baseRevision: '1'.repeat(40) }, payload);
    const options = { accountKey: 'a'.repeat(64), label: `Mood \u00b7 ${payload.date}`, taskKey: 'mood' };
    await queue.enqueue(target, options);
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]?.baseRevision).toBe(newest); // the queue rebased the check-in before its first send
    await expect.poll(() => queue.getSnapshot().items.find((i) => i.operationId === target.operationId)?.receipt?.commitSha ?? null).toBe('3'.repeat(40));

    // The Undo carries the receipt token and the UI bytes; undoCompletion must rebind both to the durable envelope.
    await queue.undoCompletion(target, undoMoodCheckin({ baseRevision: newest }, target, '3'.repeat(40)), options);
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toMatchObject({ type: 'UndoMoodCheckin', payload: { targetCommit: '3'.repeat(40) } });
    expect(bodies[1]?.type === 'UndoMoodCheckin' && bodies[1].payload.target).toEqual(bodies[0]);
  } finally {
    queue.dispose();
    store.close();
  }
});
