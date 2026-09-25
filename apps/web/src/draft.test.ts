import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureNote, captureTask } from './commands.ts';
import { DraftKeeper, type DraftStore } from './draft.ts';
import { openPendingStore, type PendingRecord, type PendingStore } from './queue/db.ts';
import { PendingQueue } from './queue/queue.ts';

const ACCOUNT_A = 'a'.repeat(64);
const ACCOUNT_B = 'b'.repeat(64);
const REV = '1'.repeat(40);

let store: PendingStore;
let clock: number;
let timers: { fn: () => void; ms: number; cancelled: boolean }[];

const fire = () => {
  for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
};

function keeper(accountKey: string | null, options: { store?: DraftStore; onUnavailable?: () => void } = {}) {
  return new DraftKeeper({
    store: options.store ?? store,
    accountKey,
    onUnavailable: options.onUnavailable ?? (() => undefined),
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => (timer.cancelled = true);
    },
  });
}

/** Resolves once every IndexedDB request started so far has settled (fake-indexeddb schedules with setImmediate). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openQueue(send = vi.fn<(body: string, accountKey: string) => Promise<Response>>()) {
  const queue = await PendingQueue.open({
    store,
    send,
    locks: null,
    now: () => clock,
    setTimer: () => () => undefined,
  });
  return { queue, send };
}

beforeEach(async () => {
  store = await openPendingStore(new IDBFactory());
  clock = Date.UTC(2026, 8, 24, 10, 0, 0);
  timers = [];
});

afterEach(() => store.close());

describe('draft keeping', () => {
  it('writes only after a pause in typing, with the latest text', async () => {
    const k = keeper(ACCOUNT_A);
    await k.restore();
    k.change({ kind: 'task', text: 'Buy' });
    k.change({ kind: 'task', text: 'Buy seed' });
    k.change({ kind: 'task', text: 'Buy seed potatoes' });
    await settle();
    expect(await store.draft(ACCOUNT_A)).toBeUndefined();

    fire();
    await settle();
    expect(await store.draft(ACCOUNT_A)).toEqual({
      accountKey: ACCOUNT_A,
      kind: 'task',
      text: 'Buy seed potatoes',
      updatedAt: clock,
    });
  });

  it('flush (visibilitychange / pagehide / close) writes at once', async () => {
    const k = keeper(ACCOUNT_A);
    await k.restore();
    k.change({ kind: 'note', text: 'A synthetic thought' });
    await k.flush();
    expect(await store.draft(ACCOUNT_A)).toMatchObject({ kind: 'note', text: 'A synthetic thought' });
    fire(); // the cancelled debounce does not write again
    await settle();
  });

  it('restores the same text and capture type on reopen', async () => {
    const first = keeper(ACCOUNT_A);
    await first.restore();
    first.change({ kind: 'note', text: 'Line one\nLine two' });
    await first.dispose();

    expect(await keeper(ACCOUNT_A).restore()).toEqual({ kind: 'note', text: 'Line one\nLine two' });
  });

  it('erasing all text removes the draft; discard removes it deliberately', async () => {
    const k = keeper(ACCOUNT_A);
    await k.restore();
    k.change({ kind: 'task', text: 'x' });
    await k.flush();
    k.change({ kind: 'task', text: '' });
    await k.flush();
    expect(await store.draft(ACCOUNT_A)).toBeUndefined();

    k.change({ kind: 'task', text: 'again' });
    await k.discard();
    fire();
    await settle();
    expect(await store.draft(ACCOUNT_A)).toBeUndefined();
  });

  it('a change made before the draft is restored does not overwrite it early', async () => {
    await store.putDraft({ accountKey: ACCOUNT_A, kind: 'note', text: 'kept', updatedAt: 1 });
    const k = keeper(ACCOUNT_A);
    k.change({ kind: 'task', text: 'typed' });
    await k.flush();
    expect(await store.draft(ACCOUNT_A)).toMatchObject({ text: 'kept' });
    await k.restore();
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });

  it('restoring and typing never create a command', async () => {
    const { send } = await openQueue();
    await store.putDraft({ accountKey: ACCOUNT_A, kind: 'task', text: 'kept', updatedAt: 1 });
    const k = keeper(ACCOUNT_A);
    await k.restore();
    k.change({ kind: 'task', text: 'kept and more' });
    await k.dispose();
    expect(await store.all()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('without a known account nothing is kept', async () => {
    const k = keeper(null);
    expect(await k.restore()).toBeNull();
    k.change({ kind: 'task', text: 'orphan' });
    await k.flush();
    expect(timers).toHaveLength(0);
  });
});

describe('Save and the draft', () => {
  it('Save deletes the draft in the same transaction that enqueues the command', async () => {
    const { queue } = await openQueue();
    const k = keeper(ACCOUNT_A);
    await k.restore();
    k.change({ kind: 'task', text: 'Buy seed potatoes' });
    await k.flush();

    await k.suspend();
    const envelope = captureTask({ baseRevision: REV }, { text: 'Buy seed potatoes' });
    await queue.enqueue(envelope, { accountKey: ACCOUNT_A, label: 'Buy seed potatoes', clearDraft: true });

    expect((await store.all()).map((r) => r.operationId)).toEqual([envelope.operationId]);
    expect(await store.draft(ACCOUNT_A)).toBeUndefined();
    queue.dispose();
  });

  it('a failed enqueue keeps the draft: never the command without deleting it, nor the reverse', async () => {
    await store.putDraft({ accountKey: ACCOUNT_A, kind: 'task', text: 'kept', updatedAt: 1 });
    const envelope = captureTask({ baseRevision: REV }, { text: 'kept' });
    // An uncloneable field makes IndexedDB abort the transaction that holds it.
    const poisoned = { operationId: envelope.operationId, seq: 1, poison: () => 0 } as unknown as PendingRecord;
    await expect(store.add(poisoned, ACCOUNT_A)).rejects.toBeDefined();
    expect(await store.all()).toEqual([]);
    expect(await store.draft(ACCOUNT_A)).toMatchObject({ text: 'kept' });
  });

  it('other enqueues never touch the draft', async () => {
    const { queue } = await openQueue();
    await store.putDraft({ accountKey: ACCOUNT_A, kind: 'task', text: 'kept', updatedAt: 1 });
    await queue.enqueue(captureNote({ baseRevision: REV }, { text: 'other' }), { accountKey: ACCOUNT_A, label: 'other' });
    expect(await store.draft(ACCOUNT_A)).toMatchObject({ text: 'kept' });
    queue.dispose();
  });

  it('after suspend no pending or later change is written; resume follows the text again', async () => {
    const k = keeper(ACCOUNT_A);
    await k.restore();
    k.change({ kind: 'task', text: 'pending' });
    await k.suspend();
    k.change({ kind: 'task', text: 'later' });
    fire();
    await k.flush();
    expect(await store.draft(ACCOUNT_A)).toBeUndefined();

    k.resume({ kind: 'task', text: 'after a failed save' });
    fire();
    await settle();
    expect(await store.draft(ACCOUNT_A)).toMatchObject({ text: 'after a failed save' });
  });

  it('suspend waits for a draft write already started', async () => {
    let finish!: () => void;
    const slow: DraftStore = {
      ...store,
      putDraft: (draft) => new Promise<void>((resolve) => (finish = resolve)).then(() => store.putDraft(draft)),
    };
    const k = keeper(ACCOUNT_A, { store: slow });
    await k.restore();
    k.change({ kind: 'task', text: 'in flight' });
    void k.flush();
    let suspended = false;
    const suspending = k.suspend().then(() => (suspended = true));
    await settle();
    expect(suspended).toBe(false);
    finish();
    await suspending;
    expect(await store.draft(ACCOUNT_A)).toMatchObject({ text: 'in flight' });
  });
});

describe('account isolation', () => {
  it('a draft is offered only to the account that wrote it; others neither see nor delete it', async () => {
    const a = keeper(ACCOUNT_A);
    await a.restore();
    a.change({ kind: 'note', text: 'Only for A' });
    await a.dispose();

    expect(await store.draft(ACCOUNT_B)).toBeUndefined();
    const b = keeper(ACCOUNT_B);
    expect(await b.restore()).toBeNull();
    b.change({ kind: 'task', text: 'B writes its own' });
    await b.flush();
    await b.discard();

    const { queue, send } = await openQueue();
    const envelope = captureTask({ baseRevision: REV }, { text: 'B saves' });
    await queue.enqueue(envelope, { accountKey: ACCOUNT_B, label: 'B saves', clearDraft: true });

    expect(await store.draft(ACCOUNT_A)).toMatchObject({ kind: 'note', text: 'Only for A' });
    expect(await keeper(ACCOUNT_A).restore()).toEqual({ kind: 'note', text: 'Only for A' });
    // A's draft never became a command, under any account.
    expect((await store.all()).map((r) => r.operationId)).toEqual([envelope.operationId]);
    expect(send).not.toHaveBeenCalled();
    queue.dispose();
  });

  it('a store answering with another account\'s draft is still not shown', async () => {
    const foreign = { accountKey: ACCOUNT_A, kind: 'task' as const, text: 'Only for A', updatedAt: 1 };
    const confused: DraftStore = { ...store, draft: async () => foreign };
    expect(await keeper(ACCOUNT_B, { store: confused }).restore()).toBeNull();
  });
});

describe('storage failure', () => {
  const failing: DraftStore = {
    draft: () => Promise.reject(new DOMException('synthetic', 'InvalidStateError')),
    putDraft: () => Promise.reject(new DOMException('synthetic', 'QuotaExceededError')),
    deleteDraft: () => Promise.reject(new DOMException('synthetic', 'InvalidStateError')),
  };

  it('reports the draft cannot be kept, and keeps accepting text', async () => {
    const onUnavailable = vi.fn();
    const k = keeper(ACCOUNT_A, { store: failing, onUnavailable });
    expect(await k.restore()).toBeNull();
    expect(onUnavailable).toHaveBeenCalledTimes(1);

    k.change({ kind: 'task', text: 'still typing' });
    await expect(k.flush()).resolves.toBeUndefined();
    await expect(k.discard()).resolves.toBeUndefined();
    await expect(k.suspend()).resolves.toBeUndefined();
    expect(onUnavailable).toHaveBeenCalledTimes(3);
  });
});
