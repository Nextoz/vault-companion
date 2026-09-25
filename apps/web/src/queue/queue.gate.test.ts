// Phase 1 gate reproductions (docs/reviews/phase-1-reconciliation.md, owner F2): A3/R3, A7, A9, R4, R12.
// Multi-tab cases use two independently opened queues, each with its own IndexedDB connection to one database.
import { IDBFactory } from 'fake-indexeddb';
import {
  Command,
  type CompleteTaskCommand,
  type Receipt,
  type TaskView,
  type TasksResponse,
} from '@vault-companion/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postCommand } from '../api.ts';
import { captureNote, completeTask, undoCompleteTask } from '../commands.ts';
import { buildView } from '../view.ts';
import { backoffMs } from './classify.ts';
import { openPendingStore, type PendingStore } from './db.ts';
import { PendingQueue, type LockManagerLike } from './queue.ts';

const ACCOUNT_A = 'a'.repeat(64);
const ACCOUNT_B = 'b'.repeat(64);
const REV = '1'.repeat(40);
const BLOB = '2'.repeat(40);
const COMMIT = '3'.repeat(40);
const LINE = '- [ ] Water the plants 📅 2026-09-24';
const LOCATOR = { path: 'Tasks/To-Do List.md' as const, blobSha: BLOB, lineIndex: 12, lineText: LINE, occurrencesAtRead: 1 };

type Send = (body: string, accountKey: string) => Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function receiptFor(body: string, overrides: Partial<Receipt> = {}): Receipt {
  const envelope = Command.parse(JSON.parse(body));
  return {
    operationId: envelope.operationId,
    status: 'applied',
    path: 'Tasks/To-Do List.md',
    commitSha: COMMIT,
    blobSha: '4'.repeat(40),
    effect: { kind: 'task-captured', lineText: '- [ ] synthetic' },
    ...overrides,
  };
}
const ok = (body: string) => json(200, receiptFor(body));
const refusal = (code: string, retryable = false) => json(409, { code, message: `synthetic ${code}`, retryable });
const unavailable503 = () => refusal('upstream-unavailable', true);
const typeOf = (body: string) => (JSON.parse(body) as Command).type;

/** In-process stand-in for navigator.locks: FIFO per name, shared by every queue that receives it. */
function sharedLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const run = (tails.get(name) ?? Promise.resolve()).then(fn);
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let factory: IDBFactory;
let locks: LockManagerLike;
let clock: number;
const stores: PendingStore[] = [];

interface Tab {
  queue: PendingQueue;
  store: PendingStore;
  send: ReturnType<typeof vi.fn<Send>>;
  receipts: Receipt[];
}

async function openTab(options: { locks?: LockManagerLike | null; wrap?: (s: PendingStore) => PendingStore } = {}) {
  const raw = await openPendingStore(factory);
  stores.push(raw);
  const store = options.wrap ? options.wrap(raw) : raw;
  const send = vi.fn<Send>();
  const receipts: Receipt[] = [];
  const queue = await PendingQueue.open({
    store,
    send,
    locks: options.locks === undefined ? locks : options.locks,
    now: () => clock,
    setTimer: () => () => undefined,
    onReceipt: (r) => receipts.push(r),
  });
  return { queue, store: raw, send, receipts } satisfies Tab;
}

const mint = () => ({ baseRevision: REV, now: new Date(clock) });
const complete = () => completeTask(mint(), LOCATOR);
const undoOf = (target: CompleteTaskCommand) => undoCompleteTask(mint(), target);
const taskOpts = { accountKey: ACCOUNT_A, label: 'Water the plants', taskKey: LINE };

beforeEach(() => {
  factory = new IDBFactory();
  locks = sharedLocks();
  clock = Date.UTC(2026, 8, 24, 10, 0, 0);
});

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  vi.unstubAllGlobals();
});

describe('A3 / R3 — two tabs over one IndexedDB database', () => {
  it('Undo in tab A after tab B sent and settled the completion is a real Undo, never cancelled', async () => {
    const a = await openTab();
    const b = await openTab();
    b.send.mockImplementation(async (body) => ok(body));
    a.send.mockImplementation(async (body) => ok(body));

    const target = complete();
    await a.queue.enqueue(target, taskOpts); // A has no confirmed session: it cannot send
    b.queue.setSession(ACCOUNT_A);
    await b.queue.flush();
    expect(b.send.mock.calls.map(([body]) => typeOf(body))).toEqual(['CompleteTask']);

    expect(await a.queue.undoCompletion(target, undoOf(target), taskOpts)).toBe('queued');
    a.queue.setSession(ACCOUNT_A);
    await a.queue.flush();

    expect(a.send.mock.calls.map(([body]) => typeOf(body))).toEqual(['UndoCompleteTask']);
    expect(await a.store.all()).toEqual([]);
  });

  it('Undo in tab A while tab B has the completion in flight: queued, and sent only after B settles it', async () => {
    const a = await openTab();
    const b = await openTab();
    const inFlight = deferred<Response>();
    let completionBody = '';
    b.send.mockImplementationOnce(async (body) => {
      completionBody = body;
      return inFlight.promise;
    });
    a.send.mockImplementation(async (body) => ok(body));

    const target = complete();
    await a.queue.enqueue(target, taskOpts);
    b.queue.setSession(ACCOUNT_A);
    const bFlush = b.queue.flush();
    await vi.waitFor(() => expect(b.send).toHaveBeenCalledTimes(1));

    expect(await a.queue.undoCompletion(target, undoOf(target), taskOpts)).toBe('queued');
    expect(await a.queue.discard(target.operationId)).toBe(false); // outcome unknown while B's request is out
    a.queue.setSession(ACCOUNT_A);
    await a.queue.flush();
    expect(a.send).not.toHaveBeenCalled(); // neither the in-flight completion nor its dependent Undo

    inFlight.resolve(ok(completionBody));
    await bFlush;
    await a.queue.kick();
    expect(a.send.mock.calls.map(([body]) => typeOf(body))).toEqual(['UndoCompleteTask']);
    expect(await a.store.all()).toEqual([]);
  });

  it("a tab's late failure does not resurrect an item another tab already settled", async () => {
    const a = await openTab();
    const b = await openTab();
    const aReply = deferred<Response>();
    a.send.mockImplementationOnce(async () => aReply.promise);
    b.send.mockImplementation(async (body) => ok(body));

    await a.queue.enqueue(captureNote(mint(), { text: 'synthetic' }), { accountKey: ACCOUNT_A, label: 'n' });
    a.queue.setSession(ACCOUNT_A);
    const aFlush = a.queue.flush();
    await vi.waitFor(() => expect(a.send).toHaveBeenCalledTimes(1));

    clock += 10 * 60_000; // A's lease has long expired: B may resend (deduplicated server-side)
    b.queue.setSession(ACCOUNT_A);
    await b.queue.flush();
    expect(b.send).toHaveBeenCalledTimes(1);

    aReply.resolve(unavailable503());
    await aFlush;
    expect(await a.store.all()).toEqual([]);
    expect(await a.store.receipts()).toHaveLength(1);
  });

  it("a tab's late failure does not overwrite another tab's newer claim", async () => {
    const a = await openTab();
    const b = await openTab();
    const aReply = deferred<Response>();
    const bReply = deferred<Response>();
    let body = '';
    a.send.mockImplementationOnce(async () => aReply.promise);
    b.send.mockImplementationOnce(async (sent) => {
      body = sent;
      return bReply.promise;
    });

    const envelope = captureNote(mint(), { text: 'synthetic' });
    await a.queue.enqueue(envelope, { accountKey: ACCOUNT_A, label: 'n' });
    a.queue.setSession(ACCOUNT_A);
    const aFlush = a.queue.flush();
    await vi.waitFor(() => expect(a.send).toHaveBeenCalledTimes(1));
    clock += 10 * 60_000;
    b.queue.setSession(ACCOUNT_A);
    const bFlush = b.queue.flush();
    await vi.waitFor(() => expect(b.send).toHaveBeenCalledTimes(1));
    const bClaim = (await a.store.get(envelope.operationId))?.claimId;

    aReply.resolve(refusal('conflict:stale'));
    await aFlush;
    expect(await a.store.get(envelope.operationId)).toMatchObject({ state: 'pending', claimId: bClaim });
    expect(await a.queue.discard(envelope.operationId)).toBe(false); // B's request is still out

    bReply.resolve(ok(body));
    await bFlush;
    expect(await a.store.all()).toEqual([]);
  });

  it('without Web Locks, local cancellation is disabled: Undo is always sent', async () => {
    const a = await openTab({ locks: null });
    a.send.mockImplementation(async (body) => ok(body));
    const target = complete();
    await a.queue.enqueue(target, taskOpts);

    expect(await a.queue.undoCompletion(target, undoOf(target), taskOpts)).toBe('queued');
    a.queue.setSession(ACCOUNT_A);
    await a.queue.flush();
    expect(a.send.mock.calls.map(([body]) => typeOf(body))).toEqual(['CompleteTask', 'UndoCompleteTask']);
  });

  it('with Web Locks, a completion no tab ever sent is still cancelled locally', async () => {
    const a = await openTab();
    const b = await openTab();
    const target = complete();
    await a.queue.enqueue(target, taskOpts);

    expect(await b.queue.undoCompletion(target, undoOf(target), taskOpts)).toBe('cancelled');
    expect(await a.store.all()).toEqual([]);
  });
});

describe('A7 — account binding', () => {
  /** Runs `during` inside the claim's persistence of everSent:true, before it returns. */
  const interceptClaim = (during: () => void) => (s: PendingStore): PendingStore => ({
    ...s,
    async put(record) {
      const before = await s.get(record.operationId);
      await s.put(record);
      if (record.everSent && before && !before.everSent) during();
    },
  });

  it('a session change during the awaited claim releases the item unsent', async () => {
    const late: { queue?: PendingQueue } = {};
    const tab = await openTab({ wrap: interceptClaim(() => late.queue?.setSession(ACCOUNT_B)) });
    const queue = (late.queue = tab.queue);
    tab.send.mockImplementation(async (body) => ok(body));

    const envelope = captureNote(mint(), { text: 'synthetic' });
    await queue.enqueue(envelope, { accountKey: ACCOUNT_A, label: 'n' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();

    expect(tab.send).not.toHaveBeenCalled();
    expect(queue.getSnapshot().items[0]).toMatchObject({ state: 'attention', accountMismatch: true });
    expect(await tab.store.get(envelope.operationId)).toMatchObject({ state: 'pending', attempts: 0 });

    queue.setSession(ACCOUNT_A);
    await queue.flush();
    expect(tab.send).toHaveBeenCalledTimes(1);
  });

  it('signing out during the awaited claim releases the item unsent', async () => {
    const late: { queue?: PendingQueue } = {};
    const tab = await openTab({ wrap: interceptClaim(() => late.queue?.setSignedOut()) });
    const queue = (late.queue = tab.queue);
    tab.send.mockImplementation(async (body) => ok(body));

    await queue.enqueue(captureNote(mint(), { text: 'synthetic' }), { accountKey: ACCOUNT_A, label: 'n' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();
    expect(tab.send).not.toHaveBeenCalled();
    expect(queue.getSnapshot().items[0]?.state).toBe('pending');
  });

  it('a session change between the committed claim and the request releases the item unsent', async () => {
    const late: { queue?: PendingQueue; raw?: PendingStore } = {};
    let fired = false;
    // Fires after the claim's lock is released (the lease is durable), before the sender continues.
    const hooked: LockManagerLike = {
      async request(name, fn) {
        const result = await locks.request(name, fn);
        if (!fired && (await late.raw?.all())?.some((r) => (r.leaseUntil ?? 0) > clock)) {
          fired = true;
          late.queue?.setSession(ACCOUNT_B);
        }
        return result;
      },
    };
    const tab = await openTab({ locks: hooked });
    const queue = (late.queue = tab.queue);
    const raw = (late.raw = tab.store);
    tab.send.mockImplementation(async (body) => ok(body));
    await queue.enqueue(captureNote(mint(), { text: 'synthetic' }), { accountKey: ACCOUNT_A, label: 'n' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();

    expect(fired).toBe(true);
    expect(tab.send).not.toHaveBeenCalled();
    expect((await raw.all())[0]).toMatchObject({ state: 'pending', attempts: 0, leaseUntil: 0 });
  });

  it('every POST carries the item account as X-VC-Account', async () => {
    const tab = await openTab();
    tab.send.mockImplementation(async (body) => ok(body));
    await tab.queue.enqueue(captureNote(mint(), { text: 'synthetic' }), { accountKey: ACCOUNT_A, label: 'n' });
    tab.queue.setSession(ACCOUNT_A);
    await tab.queue.flush();
    expect(tab.send.mock.calls[0]?.[1]).toBe(ACCOUNT_A);

    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await postCommand('{"x":1}', ACCOUNT_A);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('X-VC-Account')).toBe(ACCOUNT_A);
    expect(init.body).toBe('{"x":1}');
  });

  it('a 409 account-mismatch needs attention and is never retried automatically', async () => {
    const tab = await openTab();
    // Even if a reply wrongly marks it retryable, account-mismatch is final for automatic sending.
    tab.send.mockImplementation(async () => refusal('account-mismatch', true));
    await tab.queue.enqueue(captureNote(mint(), { text: 'synthetic' }), { accountKey: ACCOUNT_A, label: 'n' });
    tab.queue.setSession(ACCOUNT_A);
    await tab.queue.flush();
    clock += 10 * 60_000;
    await tab.queue.kick();

    expect(tab.send).toHaveBeenCalledTimes(1);
    expect(tab.queue.getSnapshot().items[0]).toMatchObject({ state: 'attention', error: { code: 'account-mismatch' } });
  });
});

describe('A9 — receipts persist until a read includes them', () => {
  const task = (lineText: string, done = false): TaskView => ({
    locator: { ...LOCATOR, lineText },
    description: 'Water the plants',
    status: done ? 'done' : 'open',
    section: done ? 'done' : 'open',
    priority: null,
    due: '2026-09-24',
    scheduled: null,
    start: null,
    created: null,
    done: done ? '2026-09-24' : null,
    recurring: false,
    readOnlyReason: null,
    links: [],
  });
  const staleRead: TasksResponse = {
    revision: REV,
    blobSha: BLOB,
    today: '2026-09-24',
    timeZone: 'Europe/Copenhagen',
    writeBlock: null,
    known: { [COMMIT]: 'not-included' },
    todayTasks: [task(LINE)],
    overdue: [],
    allOpen: [task(LINE)],
    doneToday: [],
  };

  it('save, reload, stale read: the completion still overlays the open task', async () => {
    let tab = await openTab();
    tab.send.mockImplementation(async (body) => ok(body));
    await tab.queue.enqueue(complete(), taskOpts);
    tab.queue.setSession(ACCOUNT_A);
    await tab.queue.flush();
    expect(await tab.store.all()).toEqual([]);
    tab.queue.dispose();

    tab = await openTab(); // reload
    const items = tab.queue.getSnapshot().items;
    expect(items).toMatchObject([{ state: 'saved', receipt: { commitSha: COMMIT } }]);

    const view = buildView(staleRead, items);
    expect(view.today).toEqual([]);
    expect(view.doneToday.map((r) => r.description)).toEqual(['Water the plants']);
  });

  it('a receipt is written in the same transaction that removes the pending record', async () => {
    const tab = await openTab();
    const envelope = captureNote(mint(), { text: 'synthetic' });
    await tab.queue.enqueue(envelope, { accountKey: ACCOUNT_A, label: 'n' });
    const pending = await tab.store.get(envelope.operationId);
    if (!pending) throw new Error('not persisted');
    const receipt = receiptFor(pending.body);
    // An uncloneable receipt makes the receipt write fail: the pending record must survive.
    const broken = { ...pending, receipt: { ...receipt, bad: () => 1 } as unknown as Receipt, acknowledged: false, savedAt: clock };
    await expect(tab.store.settle(broken)).rejects.toBeDefined();
    expect(await tab.store.get(envelope.operationId)).toBeDefined();
    expect(await tab.store.receipts()).toEqual([]);
  });

  it('only acknowledged receipts may be evicted', async () => {
    const tab = await openTab();
    tab.send.mockImplementation(async (body) => ok(body));
    for (let i = 0; i < 25; i++) {
      await tab.queue.enqueue(captureNote(mint(), { text: `n${i}` }), { accountKey: ACCOUNT_A, label: `n${i}` });
    }
    tab.queue.setSession(ACCOUNT_A);
    await tab.queue.flush();
    expect(await tab.store.receipts()).toHaveLength(25); // no silent cap on unacknowledged evidence

    const ids = tab.queue.getSnapshot().items.map((i) => i.operationId);
    await tab.queue.forgetSaved(ids);
    expect(await tab.store.receipts()).toHaveLength(25); // "Clear saved" cannot drop unacknowledged receipts

    await tab.queue.acknowledge({ [COMMIT]: 'not-included' });
    expect(tab.queue.getSnapshot().items.every((i) => !i.acknowledged)).toBe(true);
    expect(await tab.store.receipts()).toHaveLength(25);

    await tab.queue.acknowledge({ [COMMIT]: 'included' });
    expect((await tab.store.receipts()).length).toBeLessThanOrEqual(20); // acknowledged history is bounded
    await tab.queue.forgetSaved(ids);
    expect(await tab.store.receipts()).toEqual([]);
  });
});

describe('R4 — dependents are released only by an outcome known not to have applied', () => {
  async function completionThenUndo(second: () => Response) {
    const tab = await openTab();
    const target = complete();
    const undo = undoOf(target);
    tab.send
      .mockImplementationOnce(async () => unavailable503()) // makes it ever-sent, so Undo is real
      .mockImplementationOnce(async () => second())
      .mockImplementation(async (body) => ok(body));
    await tab.queue.enqueue(target, taskOpts);
    tab.queue.setSession(ACCOUNT_A);
    await tab.queue.flush();
    await tab.queue.undoCompletion(target, undo, taskOpts);
    await tab.queue.kick();
    return { tab, target, undo };
  }

  it.each([
    ['dedupe-unknown', () => refusal('dedupe-unknown')],
    ['a non-JSON 4xx', () => new Response('<html>teapot</html>', { status: 418 })],
    ['an API forbidden', () => json(403, { code: 'forbidden', message: 'x', retryable: false })],
  ])('%s on the completion keeps its Undo waiting', async (_name, second) => {
    const { tab } = await completionThenUndo(second);
    await tab.queue.kick();
    expect(tab.send.mock.calls.map(([body]) => typeOf(body))).toEqual(['CompleteTask', 'CompleteTask']);
  });

  it.each(['conflict:task-changed', 'refused:structure', 'operation-id-reused', 'invalid', 'account-mismatch'])(
    '%s on the completion releases its Undo',
    async (code) => {
      const { tab } = await completionThenUndo(() => refusal(code));
      expect(tab.send.mock.calls.map(([body]) => typeOf(body))).toEqual([
        'CompleteTask',
        'CompleteTask',
        'UndoCompleteTask',
      ]);
    },
  );

  it('dedupe-unknown keeps a dependent waiting by dependsOn alone (no shared task key)', async () => {
    const tab = await openTab();
    const target = complete();
    tab.send
      .mockImplementationOnce(async () => unavailable503())
      .mockImplementationOnce(async () => refusal('dedupe-unknown'))
      .mockImplementation(async (body) => ok(body));
    await tab.queue.enqueue(target, taskOpts);
    tab.queue.setSession(ACCOUNT_A);
    await tab.queue.flush();
    await tab.queue.undoCompletion(target, undoOf(target), { ...taskOpts, taskKey: null });
    await tab.queue.kick();
    await tab.queue.kick();
    expect(tab.send.mock.calls.map(([body]) => typeOf(body))).toEqual(['CompleteTask', 'CompleteTask']);
  });

  it('a non-final attention also holds later items for the same task (FIFO)', async () => {
    const tab = await openTab();
    const first = complete();
    const again = complete(); // same task, no dependency
    tab.send.mockImplementationOnce(async () => refusal('dedupe-unknown')).mockImplementation(async (body) => ok(body));
    await tab.queue.enqueue(first, taskOpts);
    await tab.queue.enqueue(again, taskOpts);
    tab.queue.setSession(ACCOUNT_A);
    await tab.queue.flush();
    await tab.queue.kick();
    expect(tab.send.mock.calls.map(([body]) => (JSON.parse(body) as Command).operationId)).toEqual([first.operationId]);
  });

  it('Retry on the predecessor puts its dependent back behind it', async () => {
    const tab = await openTab();
    const target = complete();
    const undo = undoOf(target);
    tab.send
      .mockImplementationOnce(async () => unavailable503())
      .mockImplementationOnce(async () => refusal('conflict:stale'))
      .mockImplementationOnce(async () => refusal('conflict:task-changed')) // the released Undo fails
      .mockImplementation(async (body) => ok(body));
    await tab.queue.enqueue(target, taskOpts);
    tab.queue.setSession(ACCOUNT_A);
    await tab.queue.flush();
    await tab.queue.undoCompletion(target, undo, taskOpts);
    await tab.queue.kick();
    expect(tab.queue.getSnapshot().items.map((i) => i.state)).toEqual(['attention', 'attention']);

    await tab.queue.retry(target.operationId);
    await tab.queue.flush();
    expect(tab.send.mock.calls.map(([body]) => (JSON.parse(body) as Command).operationId)).toEqual([
      target.operationId,
      target.operationId,
      undo.operationId,
      target.operationId,
      undo.operationId,
    ]);
    expect(await tab.store.all()).toEqual([]);
  });
});

describe('R12 — a receipt must name the operation that was sent', () => {
  it('a 200 for another operation is retried, never settles the item', async () => {
    const tab = await openTab();
    tab.send
      .mockImplementationOnce(async (body) => json(200, receiptFor(body, { operationId: crypto.randomUUID() })))
      .mockImplementation(async (body) => ok(body));
    const envelope = captureNote(mint(), { text: 'synthetic' });
    await tab.queue.enqueue(envelope, { accountKey: ACCOUNT_A, label: 'n' });
    tab.queue.setSession(ACCOUNT_A);
    await tab.queue.flush();

    expect(tab.receipts).toEqual([]);
    expect(await tab.store.get(envelope.operationId)).toMatchObject({ state: 'pending', attempts: 1 });
    expect(await tab.store.receipts()).toEqual([]);

    clock += backoffMs(1);
    await tab.queue.flush();
    expect(tab.receipts.map((r) => r.operationId)).toEqual([envelope.operationId]);
  });
});
