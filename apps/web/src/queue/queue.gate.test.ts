// Phase 1 gate reproductions (docs/reviews/phase-1-reconciliation.md): A3/R3, A7, A9, R4, R12 (owner F2);
// N2, N3, N5 from the gate rerun (owner F3).
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
import { COMMAND_TIMEOUT_MS, postCommand } from '../api.ts';
import { captureNote, completeTask, undoCompleteTask, undoDraft } from '../commands.ts';
import type { Fetched } from '../api.ts';
import { knownCommits, ReadSequencer, renderable, TaskReads } from '../reads.ts';
import { buildView } from '../view.ts';
import { backoffMs } from './classify.ts';
import { openPendingStore, type PendingRecord, type PendingStore } from './db.ts';
import { LEASE_MS, PendingQueue, type LockManagerLike } from './queue.ts';

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
// A tokened Undo (not a draft): these suites test the queue's dependency rules for any dependent (R4, N2, G3-2).
// Drafts (ADR-0013) are covered in queue.test.ts.
const undoOf = (target: CompleteTaskCommand) => undoCompleteTask(mint(), target, '5'.repeat(40));
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

describe('review P4E-Astra #2 — a tab never acts on a stale parse of a record another tab rewrote', () => {
  it("tab A cached the tokenless draft; tab B filled the token, sent, failed and cleared the receipt; A still sends it", async () => {
    const a = await openTab();
    const b = await openTab();
    const target = complete();
    a.send.mockImplementationOnce(async () => unavailable503()); // C: ever sent, no receipt
    await a.queue.enqueue(target, taskOpts);
    a.queue.setSession(ACCOUNT_A);
    await a.queue.flush();
    const draft = undoDraft(mint(), target);
    expect(await a.queue.undoCompletion(target, draft, taskOpts)).toBe('queued'); // A parses and caches the draft
    a.queue.setSignedOut(); // A pauses (e.g. backgrounded)

    clock += 60_000;
    b.send
      .mockImplementationOnce(async (body) => ok(body)) // C: receipt
      .mockImplementationOnce(async () => unavailable503()); // U (token filled by B): transient failure
    b.queue.setSession(ACCOUNT_A);
    await b.queue.flush();
    expect(b.send.mock.calls.map(([body]) => typeOf(body))).toEqual(['CompleteTask', 'UndoCompleteTask']);
    const persisted = (await b.store.get(draft.operationId))!.body;
    expect((Command.parse(JSON.parse(persisted)) as { payload: { targetCommit?: string } }).payload.targetCommit).toBe(COMMIT);
    // B acknowledges and clears C's receipt: allowed, the Undo no longer needs it.
    const read = { revision: COMMIT, known: { [COMMIT]: 'included' as const } };
    await b.queue.acknowledge(read);
    await b.queue.forgetSaved([target.operationId], read);
    expect(await b.store.receipts()).toEqual([]);

    clock += 60_000;
    a.send.mockImplementation(async (body) => ok(body));
    a.queue.setSession(ACCOUNT_A);
    await a.queue.kick();
    expect(a.send.mock.calls.map(([body]) => body).slice(1)).toEqual([persisted]); // the stored bytes, not a stale draft
    expect(await a.store.get(draft.operationId)).toBeUndefined();
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
    await tab.queue.forgetSaved(ids, { revision: REV, known: { [COMMIT]: 'included' } });
    expect(await tab.store.receipts()).toHaveLength(25); // "Clear saved" cannot drop unacknowledged receipts

    await tab.queue.acknowledge({ revision: REV, known: { [COMMIT]: 'not-included' } });
    expect(tab.queue.getSnapshot().items.every((i) => !i.acknowledged)).toBe(true);
    expect(await tab.store.receipts()).toHaveLength(25);

    await tab.queue.acknowledge({ revision: REV, known: { [COMMIT]: 'included' } });
    expect((await tab.store.receipts()).length).toBeLessThanOrEqual(20); // acknowledged history is bounded
    await tab.queue.forgetSaved(ids, { revision: REV, known: { [COMMIT]: 'included' } });
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

// ---- Phase 1 gate rerun (docs/reviews/phase-1-reconciliation.md, F3): N2, N3, N5 -------------------------------

const ids = (send: Tab['send']) => send.mock.calls.map(([body]) => (JSON.parse(body) as Command).operationId);

/** C refused (known not applied) in tab A, so its Undo U is released and queued behind it. */
async function refusedCompletionWithUndo(a: Tab) {
  const target = complete();
  const undo = undoOf(target);
  await a.queue.enqueue(target, taskOpts);
  a.queue.setSession(ACCOUNT_A);
  await a.queue.flush();
  expect(await a.queue.undoCompletion(target, undo, taskOpts)).toBe('queued');
  return { target, undo };
}

describe('N2 — Retry on a predecessor while its dependent Undo is in flight', () => {
  it("the Undo's late refusal is not final: it goes back behind the retried completion", async () => {
    const a = await openTab();
    const b = await openTab();
    const undoReply = deferred<Response>();
    a.send
      .mockImplementationOnce(async () => refusal('refused:structure'))
      .mockImplementationOnce(async () => undoReply.promise)
      .mockImplementation(async (body) => ok(body));
    b.send.mockImplementation(async (body) => ok(body));

    const { target, undo } = await refusedCompletionWithUndo(a);
    const aFlush = a.queue.flush();
    await vi.waitFor(() => expect(a.send).toHaveBeenCalledTimes(2)); // U is out, C needs attention

    await b.queue.retry(target.operationId);
    b.queue.setSession(ACCOUNT_A);
    await b.queue.flush();
    expect(ids(b.send)).toEqual([target.operationId]); // C commits; U is still A's

    // The service answered U before C existed.
    undoReply.resolve(refusal('conflict:task-changed'));
    await aFlush;

    expect(ids(a.send)).toEqual([target.operationId, undo.operationId, undo.operationId]);
    const undoBodies = a.send.mock.calls.slice(1).map(([body]) => body);
    expect(undoBodies[0]).toBe(undoBodies[1]); // envelope bytes never change
    expect(await a.store.all()).toEqual([]);
    expect((await a.store.receipts()).map((r) => r.operationId).sort()).toEqual(
      [target.operationId, undo.operationId].sort(),
    );
  });

  it('after lease expiry and reclaim, only the live claim requeues; the expired claim stays ignored', async () => {
    const a = await openTab();
    const b = await openTab();
    const aUndo = deferred<Response>();
    const bUndo = deferred<Response>();
    a.send
      .mockImplementationOnce(async () => refusal('refused:structure'))
      .mockImplementationOnce(async () => aUndo.promise)
      .mockImplementation(async (body) => ok(body));
    b.send.mockImplementationOnce(async () => bUndo.promise).mockImplementation(async (body) => ok(body));

    const { target, undo } = await refusedCompletionWithUndo(a);
    const aFlush = a.queue.flush();
    await vi.waitFor(() => expect(a.send).toHaveBeenCalledTimes(2));

    clock += 10 * 60_000; // A's lease on U expires; B reclaims and resends U
    b.queue.setSession(ACCOUNT_A);
    const bFlush = b.queue.flush();
    await vi.waitFor(() => expect(b.send).toHaveBeenCalledTimes(1));

    aUndo.resolve(refusal('conflict:task-changed')); // expired claim: ignored
    await aFlush;
    await a.queue.retry(target.operationId); // U is leased by B: it cannot be reset, only marked
    await a.queue.flush();
    expect(ids(a.send)).toEqual([target.operationId, undo.operationId, target.operationId]);

    bUndo.resolve(refusal('conflict:task-changed')); // B's claim predates the retry
    await bFlush;
    expect(ids(b.send)).toEqual([undo.operationId, undo.operationId]);
    const undoBodies = [...a.send.mock.calls, ...b.send.mock.calls]
      .map(([body]) => body)
      .filter((body) => typeOf(body) === 'UndoCompleteTask');
    expect(new Set(undoBodies).size).toBe(1); // envelope bytes never change
    expect(await a.store.all()).toEqual([]);
    expect(await a.store.receipts()).toHaveLength(2);
  });

  it('a refusal from the same generation is still final', async () => {
    const a = await openTab();
    a.send
      .mockImplementationOnce(async () => refusal('refused:structure'))
      .mockImplementationOnce(async () => refusal('conflict:task-changed'));
    const { undo } = await refusedCompletionWithUndo(a);
    await a.queue.flush();
    expect(await a.store.get(undo.operationId)).toMatchObject({
      state: 'attention',
      lastError: { code: 'conflict:task-changed' },
    });
  });
});

describe('G3-2 — Retry persists the predecessor and every affected dependent in one transaction', () => {
  const READS = new Set(['all', 'get', 'receipts', 'load', 'watermark', 'close']);
  /** Every write passes while `gate.budget` lasts; the next throws before reaching IndexedDB (the tab dies there). */
  const interruptWrites = (gate: { budget: number }) => (s: PendingStore): PendingStore =>
    Object.fromEntries(
      Object.entries(s).map(([name, fn]: [string, (...args: unknown[]) => Promise<unknown>]) => [
        name,
        READS.has(name)
          ? fn
          : async (...args: unknown[]) => {
              if (gate.budget-- <= 0) throw new Error('synthetic interruption');
              return fn(...args);
            },
      ]),
    ) as unknown as PendingStore;
  /** Writes of `target.id` carry an uncloneable field: IndexedDB aborts the transaction that holds them. */
  const poisonWrites = (target: { id: string }) => (s: PendingStore): PendingStore => ({
    ...s,
    put: (...records: PendingRecord[]) =>
      (s.put as (...r: PendingRecord[]) => Promise<void>)(
        ...records.map((r) => (r.operationId === target.id ? ({ ...r, poison: () => 0 } as PendingRecord) : r)),
      ),
  });

  /** Tab A: C refused, its Undo U sent and its (refusal) response held. */
  async function heldUndo(a: Tab) {
    const undoReply = deferred<Response>();
    a.send
      .mockImplementationOnce(async () => refusal('refused:structure'))
      .mockImplementationOnce(async () => undoReply.promise)
      .mockImplementation(async (body) => ok(body));
    const { target, undo } = await refusedCompletionWithUndo(a);
    const aFlush = a.queue.flush();
    await vi.waitFor(() => expect(a.send).toHaveBeenCalledTimes(2));
    return { target, undo, undoReply, aFlush };
  }

  async function restart(b: Tab) {
    b.queue.dispose();
    const next = await openTab();
    next.send.mockImplementation(async (body) => ok(body));
    next.queue.setSession(ACCOUNT_A);
    await next.queue.flush();
    return next;
  }

  it('an interruption at the transaction boundary cannot split them: after a restart the Undo still follows', async () => {
    const a = await openTab();
    const gate = { budget: Infinity };
    const b = await openTab({ wrap: interruptWrites(gate) });
    const { target, undo, undoReply, aFlush } = await heldUndo(a);

    gate.budget = 1; // one write transaction may commit; tab B dies at the next boundary
    await b.queue.retry(target.operationId).catch(() => undefined);
    const b2 = await restart(b);
    expect(ids(b2.send)).toEqual([target.operationId]);

    undoReply.resolve(refusal('conflict:task-changed')); // the service answered U before C existed
    await aFlush;

    expect(ids(a.send)).toEqual([target.operationId, undo.operationId, undo.operationId]);
    expect(await a.store.all()).toEqual([]);
    expect((await a.store.receipts()).map((r) => r.operationId).sort()).toEqual(
      [target.operationId, undo.operationId].sort(),
    );
  });

  it('a failure inside the transaction rolls back both, publishes nothing, and a later Retry still works', async () => {
    const a = await openTab();
    const poisoned = { id: '' };
    const b = await openTab({ wrap: poisonWrites(poisoned) });
    const { target, undo, undoReply, aFlush } = await heldUndo(a);

    poisoned.id = undo.operationId;
    await b.queue.kick(); // B has no session: this only loads and publishes the current state
    const before = await a.store.all();
    await expect(b.queue.retry(target.operationId)).rejects.toBeDefined();
    expect(await a.store.all()).toEqual(before); // neither C's reset nor U's generation
    expect(b.queue.getSnapshot().items.find((i) => i.operationId === target.operationId)).toMatchObject({
      state: 'attention',
    });

    const b2 = await restart(b);
    expect(b2.send).not.toHaveBeenCalled(); // C was never retried
    undoReply.resolve(refusal('conflict:task-changed')); // answers the unchanged state: final
    await aFlush;
    expect(await a.store.get(undo.operationId)).toMatchObject({ state: 'attention' });

    await b2.queue.retry(target.operationId);
    await b2.queue.flush();
    expect(ids(b2.send)).toEqual([target.operationId, undo.operationId]);
    expect(await a.store.all()).toEqual([]);
  });
});

describe('G3-1 — a shared durable read watermark protects receipts evicted by any tab', () => {
  const N = 21;
  const REV_B = '7'.repeat(40);
  const open = (i: number) => `- [ ] Synthetic ${i} 📅 2026-09-24`;
  const closed = (i: number) => `- [x] Synthetic ${i} 📅 2026-09-24 ✅ 2026-09-24`;
  const commitOf = (i: number) => (0xc000 + i).toString(16).padStart(40, '0');
  const indexOf = (lineText: string) => Number(/Synthetic (\d+)/.exec(lineText)?.[1]);
  const task = (i: number, done: boolean): TaskView => ({
    locator: { ...LOCATOR, lineIndex: i, lineText: done ? closed(i) : open(i) },
    description: `Synthetic ${i}`,
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
  const upTo = (n: number) => Array.from({ length: n }, (_, k) => k + 1);
  /** Tasks 1..N at `revision`, those in `done` completed; `known` as the Worker would answer it. */
  const readAt = (revision: string, done: number[], known: TasksResponse['known']): TasksResponse => {
    const openTasks = upTo(N)
      .filter((i) => !done.includes(i))
      .map((i) => task(i, false));
    return {
      revision,
      blobSha: BLOB,
      today: '2026-09-24',
      timeZone: 'Europe/Copenhagen',
      writeBlock: null,
      known,
      todayTasks: openTasks,
      overdue: [],
      allOpen: openTasks,
      doneToday: done.map((i) => task(i, true)),
    };
  };
  const included = (commits: string[]) => Object.fromEntries(commits.map((c) => [c, 'included' as const]));
  const allDone = () => readAt(REV_B, upTo(N), included(upTo(N).map(commitOf)));

  /** Tab B completes tasks 1..n, each landing in its own commit. */
  async function completeAll(b: Tab, n: number) {
    b.send.mockImplementation(async (body) => {
      const envelope = JSON.parse(body) as CompleteTaskCommand;
      const i = indexOf(envelope.payload.task.lineText);
      return json(
        200,
        receiptFor(body, {
          commitSha: commitOf(i),
          effect: { kind: 'completed', completedLineText: closed(i), openLineText: open(i), completedInPlace: false, doneDate: '2026-09-24' },
        }),
      );
    });
    const ops: string[] = [];
    for (const i of upTo(n)) {
      const envelope = completeTask(mint(), { ...LOCATOR, lineIndex: i, lineText: open(i) });
      ops.push(envelope.operationId);
      await b.queue.enqueue(envelope, { accountKey: ACCOUNT_A, label: `Synthetic ${i}`, taskKey: open(i) });
    }
    b.queue.setSession(ACCOUNT_A);
    await b.queue.flush();
    return ops;
  }

  /** The tab's real read path over its own queue; the test answers each `getTasks`. */
  function readerOf(tab: Tab) {
    const calls: { known: readonly string[]; reply: ReturnType<typeof deferred<Fetched<TasksResponse>>> }[] = [];
    const reads = new TaskReads({
      getTasks: (known) => {
        const reply = deferred<Fetched<TasksResponse>>();
        calls.push({ known, reply });
        return reply.promise;
      },
      watermark: () => tab.queue.readWatermark(),
      receipts: () => knownCommits(tab.queue.getSnapshot().items),
    });
    const call = (i: number) => {
      const c = calls[i];
      if (!c) throw new Error(`read ${i} was not issued`);
      return c;
    };
    return { reads, calls, call };
  }
  const openShown = (read: TasksResponse, tab: Tab) =>
    buildView(read, tab.queue.getSnapshot().items).all.map((r) => r.description);

  it("Astra's scenario: B completes 21, reads, acknowledges and evicts; A reloads, then its held R0 is stale", async () => {
    const a = await openTab();
    const b = await openTab();
    const { reads, calls, call } = readerOf(a);
    const r0 = reads.read(); // before any completion
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const R0 = readAt(REV, [], {});

    const ops = await completeAll(b, N);
    await b.queue.acknowledge(allDone());
    expect(await b.store.receipts()).toHaveLength(20); // the production eviction rule dropped receipt 1
    expect(await b.queue.readWatermark()).toMatchObject({ commitSha: REV_B, receiptOpIds: [ops[0]] });

    await a.queue.kick(); // A reloads durable state: receipt 1 is gone from its cache too
    // What rendering R0 would show: the hazard. Since O1 acknowledged receipts rely on the watermark too, so all 21
    // would reappear open; only the watermark gate below keeps R0 off the screen.
    expect(openShown(R0, a)).toHaveLength(N);
    call(0).reply.resolve({ kind: 'ok', data: R0 });
    expect(await r0).toEqual({ kind: 'stale', retry: true }); // R0 never asked about the watermark

    const r1 = reads.read();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(call(1).known[0]).toBe(REV_B); // every read asks about the watermark first
    call(1).reply.resolve({ kind: 'ok', data: readAt(REV_B, upTo(N), included([REV_B, ...upTo(N).map(commitOf)])) });
    const applied = await r1;
    if (applied.kind !== 'apply') throw new Error(`not applied: ${applied.kind}`);
    expect(openShown(applied.read.data, a)).toEqual([]);
    expect(renderable(applied.read, a.queue.getSnapshot().watermark)).toBe(true);
  });

  it('a read that asked about the watermark and reports it not included is stale, with no automatic re-read', async () => {
    const a = await openTab();
    const b = await openTab();
    await completeAll(b, N);
    await b.queue.acknowledge(allDone());
    await a.queue.kick();

    const { reads, calls, call } = readerOf(a);
    const r = reads.read();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(call(0).known[0]).toBe(REV_B);
    call(0).reply.resolve({ kind: 'ok', data: readAt(REV, [], { [REV_B]: 'not-included' }) }); // a lagging replica
    expect(await r).toEqual({ kind: 'stale', retry: false });
  });

  it('reload variant: a screen rendered before the eviction stops being renderable once the tab sees the watermark', async () => {
    const a = await openTab();
    const b = await openTab();
    const { reads, calls, call } = readerOf(a);
    const r0 = reads.read();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    call(0).reply.resolve({ kind: 'ok', data: readAt(REV, [], {}) });
    const rendered = await r0;
    if (rendered.kind !== 'apply') throw new Error(`not applied: ${rendered.kind}`);
    expect(renderable(rendered.read, a.queue.getSnapshot().watermark)).toBe(true);

    await completeAll(b, N);
    await b.queue.acknowledge(allDone());

    const reloaded = await openTab(); // a page reload of tab A
    expect(renderable(rendered.read, reloaded.queue.getSnapshot().watermark)).toBe(false);
    await a.queue.kick(); // or the same page, once any queue operation reloads durable state
    expect(renderable(rendered.read, a.queue.getSnapshot().watermark)).toBe(false);
  });

  it('acknowledging sets the watermark in the same transaction; "Clear saved" then evicts under it (O1)', async () => {
    const a = await openTab();
    const b = await openTab();
    const { reads, calls, call } = readerOf(a);
    const r0 = reads.read();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const ops = await completeAll(b, 2);
    const RB = readAt(REV_B, [1, 2], included([commitOf(1), commitOf(2)]));
    await b.queue.acknowledge(RB);
    expect(await b.queue.readWatermark()).toMatchObject({ commitSha: REV_B }); // the acknowledgement moved it
    await b.queue.forgetSaved(ops, RB);
    expect(await b.store.receipts()).toEqual([]);
    expect(await b.queue.readWatermark()).toMatchObject({ commitSha: REV_B });

    await a.queue.kick();
    call(0).reply.resolve({ kind: 'ok', data: readAt(REV, [], {}) });
    expect(await r0).toEqual({ kind: 'stale', retry: true });
  });

  it('only acknowledged receipts are evicted: the watermark written with their acknowledgement contains them (O1)', async () => {
    const b = await openTab();
    const ops = await completeAll(b, N);
    // A read that reports none of them included acknowledges nothing and moves nothing.
    await b.queue.acknowledge(readAt(REV, [], {}));
    await b.queue.forgetSaved(ops, readAt(REV, [], {}));
    expect(await b.store.receipts()).toHaveLength(N);
    expect(await b.queue.readWatermark()).toBeNull();

    await b.queue.acknowledge(readAt(REV_B, upTo(20), included(upTo(20).map(commitOf))));
    expect(await b.queue.readWatermark()).toMatchObject({ commitSha: REV_B });
    // Receipt 21 was not answered: it stays unacknowledged, and "Clear saved" cannot evict it.
    await b.queue.forgetSaved(ops, readAt(REV_B, [], {}));
    expect((await b.store.receipts()).map((r) => r.operationId)).toEqual([ops[N - 1]]);
  });

  it('a read that does not satisfy the current watermark can neither evict nor move it', async () => {
    const b = await openTab();
    const ops = await completeAll(b, N);
    await b.queue.acknowledge(allDone());
    const watermark = await b.queue.readWatermark();

    // An older read that reports receipts 2 and 3 included, but not the watermark.
    const older = readAt(REV, [2, 3], included([commitOf(2), commitOf(3)]));
    await b.queue.forgetSaved(ops.slice(1, 3), older);
    expect(await b.store.receipts()).toHaveLength(20);
    expect(await b.queue.readWatermark()).toEqual(watermark);
  });
});

describe('N3 — a late stale read never regresses the screen', () => {
  const COMMIT_C = '5'.repeat(40);
  const DONE_LINE = '- [x] Water the plants 📅 2026-09-24 ✅ 2026-09-24';
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
  const readAt = (revision: string, done: boolean, known: TasksResponse['known']): TasksResponse => ({
    revision,
    blobSha: BLOB,
    today: '2026-09-24',
    timeZone: 'Europe/Copenhagen',
    writeBlock: null,
    known,
    todayTasks: done ? [] : [task(LINE)],
    overdue: [],
    allOpen: done ? [] : [task(LINE)],
    doneToday: done ? [task(DONE_LINE, true)] : [],
  });
  const completed = (body: string) =>
    json(
      200,
      receiptFor(body, {
        commitSha: COMMIT_C,
        effect: { kind: 'completed', completedLineText: DONE_LINE, openLineText: LINE, completedInPlace: false, doneDate: '2026-09-24' },
      }),
    );
  /** What the screen shows: open rows, and each Done row as the overlay's state or `server`. */
  const shown = (view: ReturnType<typeof buildView>) => ({
    open: view.all.length,
    done: view.doneToday.map((r) => (r.task ? 'server' : (r.action?.state ?? '?'))),
  });

  async function savedCompletion() {
    const tab = await openTab();
    tab.send.mockImplementation(async (body) => completed(body));
    await tab.queue.enqueue(complete(), taskOpts);
    tab.queue.setSession(ACCOUNT_A);
    await tab.queue.flush();
    return tab;
  }

  it('R0 → C → R1 (acknowledges) → late R0: R0 is not applied, and could not regress the view if it were', async () => {
    const reads = new ReadSequencer();
    let rendered: TasksResponse | null = null;
    const r0 = reads.begin(); // started before C

    const tab = await savedCompletion();
    const r1 = reads.begin();
    const R1 = readAt('7'.repeat(40), true, { [COMMIT_C]: 'included' });
    expect(reads.accept(r1)).toBe(true);
    rendered = R1;
    await tab.queue.acknowledge(R1);
    expect(tab.queue.getSnapshot().items).toMatchObject([{ state: 'saved', acknowledged: true }]);
    expect(shown(buildView(rendered, tab.queue.getSnapshot().items))).toEqual({ open: 0, done: ['server'] });

    const R0 = readAt(REV, false, { [COMMIT_C]: 'not-included' });
    expect(reads.accept(r0)).toBe(false);
    expect(shown(buildView(rendered, tab.queue.getSnapshot().items))).toEqual({ open: 0, done: ['server'] });

    // Reflection follows the response being rendered, never a sticky acknowledgement.
    expect(shown(buildView(R0, tab.queue.getSnapshot().items))).toEqual({ open: 0, done: ['saved'] });
  });

  it('reload variant: an acknowledged receipt still overlays a later read that says not-included', async () => {
    let tab = await savedCompletion();
    await tab.queue.acknowledge({ revision: '7'.repeat(40), known: { [COMMIT_C]: 'included' } });
    tab.queue.dispose();

    tab = await openTab(); // reload: nothing in memory survives
    const items = tab.queue.getSnapshot().items;
    expect(items).toMatchObject([{ state: 'saved', acknowledged: true }]);
    // O1: an acknowledged receipt is no longer asked about; the watermark written with its acknowledgement covers it,
    // and only reads that contain the watermark are rendered.
    expect(knownCommits(items)).toEqual([]);
    expect(await tab.queue.readWatermark()).toMatchObject({ commitSha: '7'.repeat(40) });
    // A read that does answer for it still decides (N3)…
    expect(shown(buildView(readAt(REV, false, { [COMMIT_C]: 'not-included' }), items))).toEqual({ open: 0, done: ['saved'] });
    // …and a rendered read that does not answer reflects it through the watermark.
    expect(shown(buildView(readAt('7'.repeat(40), true, {}), items))).toEqual({ open: 0, done: ['server'] });
  });
});

describe('N5 — a command request that never settles', () => {
  it('is aborted before the lease expires, retried later, and the tab keeps flushing other items', async () => {
    expect(COMMAND_TIMEOUT_MS).toBeLessThan(LEASE_MS);
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const bodies: string[] = [];
    // Like real fetch against a server that never answers the first request: it settles only by abort.
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      if (bodies.length > 1) return Promise.resolve(ok(init.body as string));
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = await openPendingStore(factory);
    stores.push(store);
    const queue = await PendingQueue.open({ store, send: postCommand, locks, now: () => clock, setTimer: () => () => undefined });
    const first = captureNote(mint(), { text: 'first' });
    const second = captureNote(mint(), { text: 'second' });
    await queue.enqueue(first, { accountKey: ACCOUNT_A, label: 'n1' });
    await queue.enqueue(second, { accountKey: ACCOUNT_A, label: 'n2' });
    queue.setSession(ACCOUNT_A);
    const flushed = queue.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(timeoutSpy).toHaveBeenCalledWith(COMMAND_TIMEOUT_MS);

    timeout.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    await flushed;

    expect(bodies.map((b) => (JSON.parse(b) as Command).operationId)).toEqual([first.operationId, second.operationId]);
    expect(await store.get(first.operationId)).toMatchObject({
      state: 'pending',
      attempts: 1,
      leaseUntil: 0,
      lastError: { code: 'timeout' },
    });
    expect(await store.get(second.operationId)).toBeUndefined();
    timeoutSpy.mockRestore();
  });
});
