import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureNote, captureTask } from './commands.ts';
import { DraftKeeper, type DraftStatus, type DraftStore } from './draft.ts';
import { openPendingStore, type Draft, type DraftBasis, type PendingRecord, type PendingStore } from './queue/db.ts';
import { PendingQueue } from './queue/queue.ts';

const ACCOUNT_A = 'a'.repeat(64);
const ACCOUNT_B = 'b'.repeat(64);
const REV = '1'.repeat(40);

type Send = (body: string, accountKey: string) => Promise<Response>;

interface Timer {
  fn: () => void;
  cancelled: boolean;
}

/** One app instance (tab/window): its own IndexedDB connection, queue, timers and clock, over a shared database. */
interface Instance {
  store: PendingStore;
  queue: PendingQueue;
  send: ReturnType<typeof vi.fn<Send>>;
  timers: Timer[];
  clock: { now: number };
  statuses: DraftStatus[];
  keeper: (accountKey?: string | null, store?: DraftStore) => DraftKeeper;
  /** Fire this instance's due debounce timers. */
  fire: () => void;
}

let factory: IDBFactory;
let opened: Instance[];
let ids: number;

async function instance(): Promise<Instance> {
  const store = await openPendingStore(factory);
  const send = vi.fn<Send>();
  const timers: Timer[] = [];
  const clock = { now: Date.UTC(2026, 8, 24, 10, 0, 0) };
  const statuses: DraftStatus[] = [];
  // No Web Locks: the draft guards must hold on IndexedDB transactions alone.
  const queue = await PendingQueue.open({ store, send, locks: null, now: () => clock.now, setTimer: () => () => undefined });
  const self: Instance = {
    store,
    queue,
    send,
    timers,
    clock,
    statuses,
    keeper: (accountKey = ACCOUNT_A, draftStore = store) =>
      new DraftKeeper({
        store: draftStore,
        accountKey,
        onStatus: (s) => statuses.push(s),
        now: () => clock.now,
        newId: () => `draft-${++ids}`,
        setTimer: (fn) => {
          const timer = { fn, cancelled: false };
          timers.push(timer);
          return () => (timer.cancelled = true);
        },
      }),
    fire: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    },
  };
  opened.push(self);
  return self;
}

/** Resolves once every IndexedDB request and promise continuation started so far has settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const saveCapture = (at: Instance, text: string, draft: DraftBasis) =>
  at.queue.enqueue(captureTask({ baseRevision: REV }, { text }), { accountKey: ACCOUNT_A, label: text, draft });

const commands = async (store: PendingStore) =>
  (await store.all()).map((r) => (JSON.parse(r.body) as { payload: { text: string } }).payload.text);

let a: Instance;

beforeEach(async () => {
  factory = new IDBFactory();
  opened = [];
  ids = 0;
  a = await instance();
});

afterEach(() => {
  for (const i of opened) {
    i.queue.dispose();
    i.store.close();
  }
});

describe('draft keeping (one instance)', () => {
  it('writes only after a pause in typing, with the latest text, and keeps following its own versions', async () => {
    const k = a.keeper();
    await k.restore();
    k.change({ kind: 'task', text: 'Buy' });
    k.change({ kind: 'task', text: 'Buy seed' });
    await settle();
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();

    a.fire();
    await settle();
    expect(await a.store.draft(ACCOUNT_A)).toEqual({
      accountKey: ACCOUNT_A,
      id: 'draft-1',
      version: 1,
      kind: 'task',
      text: 'Buy seed',
      updatedAt: a.clock.now,
    });

    k.change({ kind: 'task', text: 'Buy seed potatoes' });
    await k.flush();
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ id: 'draft-1', version: 2, text: 'Buy seed potatoes' });
    expect(k.basis).toEqual({ id: 'draft-1', version: 2 });
  });

  it('restores the same text and capture type on reopen', async () => {
    const first = a.keeper();
    await first.restore();
    first.change({ kind: 'note', text: 'Line one\nLine two' });
    await first.dispose();

    const again = a.keeper();
    expect(await again.restore()).toEqual({ kind: 'note', text: 'Line one\nLine two' });
    expect(again.basis).toEqual({ id: 'draft-1', version: 1 });
  });

  it('erasing all text removes the draft; discard removes it deliberately', async () => {
    const k = a.keeper();
    await k.restore();
    k.change({ kind: 'task', text: 'x' });
    await k.flush();
    k.change({ kind: 'task', text: '' });
    await k.flush();
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();

    k.change({ kind: 'task', text: 'again' });
    await k.flush();
    k.change({ kind: 'task', text: 'again and more' });
    await k.discard();
    a.fire();
    await settle();
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();
  });

  it('a change made before the draft is restored does not overwrite it early', async () => {
    const seed = a.keeper();
    await seed.restore();
    seed.change({ kind: 'note', text: 'kept' });
    await seed.flush();

    const k = a.keeper();
    k.change({ kind: 'task', text: 'typed' });
    await k.flush();
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ text: 'kept' });
    await k.restore();
    expect(a.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });

  it('restoring and typing never create a command', async () => {
    const k = a.keeper();
    await k.restore();
    k.change({ kind: 'task', text: 'kept' });
    await k.dispose();
    const again = a.keeper();
    await again.restore();
    again.change({ kind: 'task', text: 'kept and more' });
    await again.dispose();
    expect(await a.store.all()).toEqual([]);
    expect(a.send).not.toHaveBeenCalled();
  });

  it('without a known account nothing is kept', async () => {
    const k = a.keeper(null);
    expect(await k.restore()).toBeNull();
    k.change({ kind: 'task', text: 'orphan' });
    await k.flush();
    expect(a.timers).toHaveLength(0);
  });
});

describe('Save and the draft (one instance)', () => {
  it('Save enqueues the command and deletes the draft in one transaction', async () => {
    const k = a.keeper();
    await k.restore();
    k.change({ kind: 'task', text: 'Buy seed potatoes' });
    await k.flush();

    await k.suspend();
    expect(await saveCapture(a, 'Buy seed potatoes', k.basis)).toBe('enqueued');
    expect(await commands(a.store)).toEqual(['Buy seed potatoes']);
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();
  });

  it('a failed enqueue keeps the draft: never the command without deleting it, nor the reverse', async () => {
    const k = a.keeper();
    await k.restore();
    k.change({ kind: 'task', text: 'kept' });
    await k.flush();
    // An uncloneable field makes IndexedDB abort the transaction that holds it.
    const poisoned = { operationId: 'op', seq: 1, poison: () => 0 } as unknown as PendingRecord;
    await expect(a.store.add(poisoned, { accountKey: ACCOUNT_A, basis: k.basis })).rejects.toBeDefined();
    expect(await a.store.all()).toEqual([]);
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ text: 'kept' });
  });

  it('other enqueues never touch the draft', async () => {
    const k = a.keeper();
    await k.restore();
    k.change({ kind: 'task', text: 'kept' });
    await k.flush();
    await a.queue.enqueue(captureNote({ baseRevision: REV }, { text: 'other' }), { accountKey: ACCOUNT_A, label: 'other' });
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ text: 'kept' });
  });

  it('after suspend no pending or later change is written; resume follows the text again', async () => {
    const k = a.keeper();
    await k.restore();
    k.change({ kind: 'task', text: 'pending' });
    await k.suspend();
    k.change({ kind: 'task', text: 'later' });
    a.fire();
    await k.flush();
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();

    k.resume({ kind: 'task', text: 'after a failed save' });
    a.fire();
    await settle();
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ text: 'after a failed save' });
  });

  it('suspend waits for a draft write already started, so the basis Save claims is final', async () => {
    let finish!: () => void;
    const slow: DraftStore = {
      ...a.store,
      putDraft: (draft, basis) => new Promise<void>((resolve) => (finish = resolve)).then(() => a.store.putDraft(draft, basis)),
    };
    const k = a.keeper(ACCOUNT_A, slow);
    await k.restore();
    k.change({ kind: 'task', text: 'in flight' });
    void k.flush();
    let suspended = false;
    const suspending = k.suspend().then(() => (suspended = true));
    await settle();
    expect(suspended).toBe(false);
    finish();
    await suspending;
    expect(k.basis).toEqual({ id: 'draft-1', version: 1 });
  });

  it('(3) a debounced autosave firing after Save does not recreate the draft', async () => {
    const k = a.keeper();
    await k.restore();
    k.change({ kind: 'task', text: 'Buy seed potatoes' });
    await k.flush();
    // A change is pending when Save lands — here without suspend, to prove the store refuses it on its own.
    k.change({ kind: 'task', text: 'Buy seed potatoes!' });
    expect(await saveCapture(a, 'Buy seed potatoes', k.basis)).toBe('enqueued');

    a.fire();
    await settle();
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();
    expect(a.statuses.at(-1)).toBe('superseded');
    k.change({ kind: 'task', text: 'typing on' });
    await k.dispose();
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();
    expect(await commands(a.store)).toEqual(['Buy seed potatoes']);
  });
});

describe('two app instances, same account', () => {
  /** Instance A writes a draft; A and B both restore that version. */
  async function sharedDraft(text = 'Shared thought') {
    const b = await instance();
    const seed = a.keeper();
    await seed.restore();
    seed.change({ kind: 'note', text });
    await seed.dispose();
    const ka = a.keeper();
    const kb = b.keeper();
    expect(await ka.restore()).toEqual({ kind: 'note', text });
    expect(await kb.restore()).toEqual({ kind: 'note', text });
    return { b, ka, kb };
  }

  it('(1) both Save the same draft at once: exactly one command, the other is refused, no draft left', async () => {
    const { b, ka, kb } = await sharedDraft();
    await Promise.all([ka.suspend(), kb.suspend()]);
    const results = await Promise.all([saveCapture(a, 'Shared thought', ka.basis), saveCapture(b, 'Shared thought', kb.basis)]);
    expect(results.sort()).toEqual(['draft-conflict', 'enqueued']);
    expect(await commands(a.store)).toEqual(['Shared thought']);
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();
  });

  it('(1) both Save, one after the other: the second is refused', async () => {
    const { b, ka, kb } = await sharedDraft();
    expect(await saveCapture(b, 'Shared thought', kb.basis)).toBe('enqueued');
    expect(await saveCapture(a, 'Shared thought', ka.basis)).toBe('draft-conflict');
    expect(await commands(a.store)).toEqual(['Shared thought']);
  });

  it('(1) both edit the same draft: the first write wins, the other stops and cannot Save it', async () => {
    const { b, ka, kb } = await sharedDraft();
    ka.change({ kind: 'note', text: 'Shared thought, edited in A' });
    await ka.flush();
    kb.change({ kind: 'note', text: 'Shared thought, edited in B' });
    await kb.flush();

    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ version: 2, text: 'Shared thought, edited in A' });
    expect(kb.superseded).toBe(true);
    expect(b.statuses.at(-1)).toBe('superseded');
    expect(await saveCapture(b, 'Shared thought, edited in B', kb.basis)).toBe('draft-conflict');
    expect(await saveCapture(a, 'Shared thought, edited in A', ka.basis)).toBe('enqueued');
    expect(await commands(a.store)).toEqual(['Shared thought, edited in A']);
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();
  });

  it('(3) the other instance\'s debounced autosave after Save does not recreate the draft', async () => {
    const { b, ka, kb } = await sharedDraft();
    kb.change({ kind: 'note', text: 'Shared thought, still typing in B' }); // debounce armed in B
    await ka.suspend();
    expect(await saveCapture(a, 'Shared thought', ka.basis)).toBe('enqueued');

    b.fire(); // B's timer fires after A's Save
    await settle();
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();
    expect(kb.superseded).toBe(true);
    await kb.dispose(); // pagehide / close in B
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();
    expect(await saveCapture(b, 'Shared thought, still typing in B', kb.basis)).toBe('draft-conflict');
    expect(await commands(a.store)).toEqual(['Shared thought']);
  });

  it('interleaving: autosave transaction first, then Save — Save is refused, the newer draft stays', async () => {
    const { b, ka, kb } = await sharedDraft();
    const basis = ka.basis;
    const newer: Draft = { accountKey: ACCOUNT_A, id: 'draft-1', version: 2, kind: 'note', text: 'newer', updatedAt: b.clock.now + 1 };
    // Both transactions are created back to back, before either runs; IndexedDB runs them in creation order.
    const put = b.store.putDraft(newer, kb.basis);
    const record = { operationId: 'op-1', seq: 1 } as unknown as PendingRecord;
    const add = a.store.add(record, { accountKey: ACCOUNT_A, basis });
    expect(await Promise.all([put, add])).toEqual(['ok', 'draft-conflict']);
    expect(await a.store.all()).toEqual([]);
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ version: 2, text: 'newer' });
  });

  it('interleaving: Save transaction first, then autosave — the draft stays gone, one command', async () => {
    const { b, ka, kb } = await sharedDraft();
    const newer: Draft = { accountKey: ACCOUNT_A, id: 'draft-1', version: 2, kind: 'note', text: 'newer', updatedAt: b.clock.now + 1 };
    const record = { operationId: 'op-1', seq: 1 } as unknown as PendingRecord;
    const add = a.store.add(record, { accountKey: ACCOUNT_A, basis: ka.basis });
    const put = b.store.putDraft(newer, kb.basis);
    expect(await Promise.all([add, put])).toEqual(['ok', 'conflict']);
    expect(await a.store.all()).toHaveLength(1);
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();
  });

  it('interleaving: a draft recreated from nothing after Save is refused if it claims the saved version', async () => {
    const { ka } = await sharedDraft();
    const basis = ka.basis;
    expect(await saveCapture(a, 'Shared thought', basis)).toBe('enqueued');
    const resurrect: Draft = { accountKey: ACCOUNT_A, id: 'draft-1', version: 2, kind: 'note', text: 'Shared thought', updatedAt: a.clock.now + 1 };
    expect(await a.store.putDraft(resurrect, basis)).toBe('conflict');
    expect(await a.store.draft(ACCOUNT_A)).toBeUndefined();
  });

  it('(2) a stale write (older updatedAt) never overwrites a newer draft, even with a matching version', async () => {
    const k = a.keeper();
    await k.restore();
    k.change({ kind: 'task', text: 'newer' });
    await k.flush();
    const stale: Draft = { accountKey: ACCOUNT_A, id: 'draft-1', version: 2, kind: 'task', text: 'stale', updatedAt: a.clock.now - 1 };
    expect(await a.store.putDraft(stale, k.basis)).toBe('conflict');
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ text: 'newer', version: 1 });
  });

  it('(2) a stale instance (older basis) never overwrites a newer draft, even with a later clock', async () => {
    const { b, ka, kb } = await sharedDraft();
    ka.change({ kind: 'note', text: 'newer from A' });
    await ka.flush();
    b.clock.now += 60_000;
    kb.change({ kind: 'note', text: 'stale from B' });
    await kb.flush();
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ text: 'newer from A', version: 2 });
  });

  it('(2) a stale instance with an earlier clock never overwrites a newer draft', async () => {
    const { ka, kb } = await sharedDraft();
    a.clock.now += 60_000;
    ka.change({ kind: 'note', text: 'newer from A' });
    await ka.flush();
    kb.change({ kind: 'note', text: 'stale from B' });
    await kb.flush();
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ text: 'newer from A' });
    expect(kb.superseded).toBe(true);
  });

  it('discard in a stale instance does not delete the newer draft', async () => {
    const { ka, kb } = await sharedDraft();
    ka.change({ kind: 'note', text: 'newer from A' });
    await ka.flush();
    await kb.discard();
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ text: 'newer from A' });
  });

  it('two instances starting from no draft: the second does not overwrite the first, and may still Save its own text', async () => {
    const b = await instance();
    const ka = a.keeper();
    const kb = b.keeper();
    await Promise.all([ka.restore(), kb.restore()]);
    ka.change({ kind: 'task', text: 'from A' });
    await ka.flush();
    kb.change({ kind: 'task', text: 'from B' });
    await kb.flush();
    expect(b.statuses.at(-1)).toBe('elsewhere');
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ text: 'from A' });

    await kb.suspend();
    expect(kb.basis).toBeNull();
    expect(await saveCapture(b, 'from B', kb.basis)).toBe('enqueued');
    expect(await a.store.draft(ACCOUNT_A)).toMatchObject({ text: 'from A' }); // A's draft is A's to save
    expect(await commands(a.store)).toEqual(['from B']);
  });
});

describe('account isolation', () => {
  it('a draft is offered only to the account that wrote it; others neither see nor delete it', async () => {
    const ka = a.keeper(ACCOUNT_A);
    await ka.restore();
    ka.change({ kind: 'note', text: 'Only for A' });
    await ka.dispose();

    expect(await a.store.draft(ACCOUNT_B)).toBeUndefined();
    const kb = a.keeper(ACCOUNT_B);
    expect(await kb.restore()).toBeNull();
    kb.change({ kind: 'task', text: 'B writes its own' });
    await kb.flush();
    await kb.suspend();
    const envelope = captureTask({ baseRevision: REV }, { text: 'B writes its own' });
    expect(await a.queue.enqueue(envelope, { accountKey: ACCOUNT_B, label: 'B', draft: kb.basis })).toBe('enqueued');

    expect(await a.store.draft(ACCOUNT_B)).toBeUndefined();
    expect(await a.keeper(ACCOUNT_A).restore()).toEqual({ kind: 'note', text: 'Only for A' });
    expect(await commands(a.store)).toEqual(['B writes its own']);
    expect(a.send).not.toHaveBeenCalled();
  });

  it("a store answering with another account's draft is still not shown", async () => {
    const foreign: Draft = { accountKey: ACCOUNT_A, id: 'x', version: 1, kind: 'task', text: 'Only for A', updatedAt: 1 };
    const confused: DraftStore = { ...a.store, draft: async () => foreign };
    expect(await a.keeper(ACCOUNT_B, confused).restore()).toBeNull();
  });
});

describe('storage failure', () => {
  const failing: DraftStore = {
    draft: () => Promise.reject(new DOMException('synthetic', 'InvalidStateError')),
    putDraft: () => Promise.reject(new DOMException('synthetic', 'QuotaExceededError')),
    deleteDraft: () => Promise.reject(new DOMException('synthetic', 'InvalidStateError')),
  };

  it('reports the draft cannot be kept, and keeps accepting text', async () => {
    const k = a.keeper(ACCOUNT_A, failing);
    expect(await k.restore()).toBeNull();
    expect(a.statuses).toEqual(['unavailable']);

    k.change({ kind: 'task', text: 'still typing' });
    await expect(k.flush()).resolves.toBeUndefined();
    await expect(k.suspend()).resolves.toBeUndefined();
    expect(a.statuses).toEqual(['unavailable', 'unavailable']);
  });
});
