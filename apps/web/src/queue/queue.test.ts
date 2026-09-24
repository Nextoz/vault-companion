import { IDBFactory } from 'fake-indexeddb';
import { Command, type CompleteTaskCommand, type Receipt } from '@vault-companion/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureNote, completeTask, undoCompleteTask } from '../commands.ts';
import { backoffMs } from './classify.ts';
import { openPendingStore, type PendingStore } from './db.ts';
import { PendingQueue } from './queue.ts';

const ACCOUNT_A = 'a'.repeat(64);
const ACCOUNT_B = 'b'.repeat(64);
const REV = '1'.repeat(40);
const BLOB = '2'.repeat(40);
const LOCATOR = {
  path: 'Tasks/To-Do List.md' as const,
  blobSha: BLOB,
  lineIndex: 12,
  lineText: '- [ ] Water the plants 📅 2026-09-24',
  occurrencesAtRead: 1,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function receiptFor(body: string): Receipt {
  const envelope = Command.parse(JSON.parse(body));
  return {
    operationId: envelope.operationId,
    status: 'applied',
    path: 'Tasks/To-Do List.md',
    commitSha: '3'.repeat(40),
    blobSha: '4'.repeat(40),
    effect: { kind: 'task-captured', lineText: '- [ ] synthetic' },
  };
}
const ok = (body: string) => json(200, receiptFor(body));
const refused409 = () =>
  json(409, { code: 'conflict:task-changed', message: 'The task changed.', retryable: false });
const unavailable503 = () =>
  json(503, { code: 'upstream-unavailable', message: 'GitHub is unavailable.', retryable: true });

let factory: IDBFactory;
let store: PendingStore;
let clock: number;
let send: ReturnType<typeof vi.fn<(body: string) => Promise<Response>>>;
let receipts: Receipt[];

async function openQueue(): Promise<PendingQueue> {
  store = await openPendingStore(factory);
  return PendingQueue.open({
    store,
    send,
    now: () => clock,
    setTimer: () => () => undefined, // tests drive time and flushes explicitly
    onReceipt: (r) => receipts.push(r),
  });
}

const mint = () => ({ baseRevision: REV, now: new Date(clock) });
const note = (text = 'A synthetic thought') => captureNote(mint(), { text });

beforeEach(() => {
  factory = new IDBFactory();
  clock = Date.UTC(2026, 8, 24, 10, 0, 0);
  send = vi.fn<(body: string) => Promise<Response>>();
  receipts = [];
});

afterEach(() => store.close());

describe('pending queue', () => {
  it('persists the envelope before the first send and sends the identical bytes on every retry', async () => {
    const queue = await openQueue();
    const envelope = note();
    let storedBeforeSend: string | undefined;
    send
      .mockImplementationOnce(async () => {
        storedBeforeSend = (await store.get(envelope.operationId))?.body;
        throw new TypeError('Failed to fetch');
      })
      .mockImplementationOnce(async () => unavailable503())
      .mockImplementation(async (body) => ok(body));

    await queue.enqueue(envelope, { accountKey: ACCOUNT_A, label: 'note' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();
    clock += backoffMs(1);
    await queue.flush();
    clock += backoffMs(2);
    await queue.flush();

    expect(send).toHaveBeenCalledTimes(3);
    const bodies = send.mock.calls.map(([b]) => b);
    expect(storedBeforeSend).toBe(JSON.stringify(envelope));
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify(envelope)]));
  });

  it('removes the item on receipt and reports it as saved', async () => {
    const queue = await openQueue();
    const envelope = note();
    send.mockImplementation(async (body) => ok(body));

    await queue.enqueue(envelope, { accountKey: ACCOUNT_A, label: 'note' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();

    expect(await store.all()).toEqual([]);
    expect(receipts.map((r) => r.operationId)).toEqual([envelope.operationId]);
    const [item] = queue.getSnapshot().items;
    expect(item?.state).toBe('saved');
    expect(item?.receipt?.commitSha).toBe('3'.repeat(40));
  });

  it('never sends an item bound to another account; it needs attention instead', async () => {
    const queue = await openQueue();
    send.mockImplementation(async (body) => ok(body));

    await queue.enqueue(note(), { accountKey: ACCOUNT_A, label: 'note' });
    queue.setSession(ACCOUNT_B);
    await queue.flush();
    await queue.kick();

    expect(send).not.toHaveBeenCalled();
    const [item] = queue.getSnapshot().items;
    expect(item).toMatchObject({ state: 'attention', accountMismatch: true });
    expect(await store.all()).toHaveLength(1);

    queue.setSession(ACCOUNT_A);
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not send anything before a session is confirmed', async () => {
    const queue = await openQueue();
    await queue.enqueue(note(), { accountKey: ACCOUNT_A, label: 'note' });
    await queue.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('stops retrying on a non-retryable 409 until the user retries', async () => {
    const queue = await openQueue();
    const envelope = note();
    send.mockImplementationOnce(async () => refused409()).mockImplementation(async (body) => ok(body));

    await queue.enqueue(envelope, { accountKey: ACCOUNT_A, label: 'note' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();
    clock += 10 * 60_000;
    await queue.kick();

    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().items[0]).toMatchObject({
      state: 'attention',
      error: { code: 'conflict:task-changed', message: 'The task changed.' },
    });
    expect((await store.get(envelope.operationId))?.state).toBe('attention');

    await queue.retry(envelope.operationId);
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBe(JSON.stringify(envelope));
    expect(await store.all()).toEqual([]);
  });

  it('retries a 503 after backoff, and not before', async () => {
    const queue = await openQueue();
    send.mockImplementationOnce(async () => unavailable503()).mockImplementation(async (body) => ok(body));

    await queue.enqueue(note(), { accountKey: ACCOUNT_A, label: 'note' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();
    expect(queue.getSnapshot().items[0]).toMatchObject({ state: 'pending', error: { code: 'upstream-unavailable' } });

    clock += backoffMs(1) - 1;
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);

    clock += 1;
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await store.all()).toEqual([]);
  });

  it('backs off from 1 s to a 60 s ceiling', () => {
    expect([1, 2, 3, 6, 7, 30].map(backoffMs)).toEqual([1000, 2000, 4000, 32_000, 60_000, 60_000]);
  });

  it('keeps the item and pauses on 401 until a session is confirmed again', async () => {
    const queue = await openQueue();
    const first = note('first');
    const second = note('second');
    send.mockImplementationOnce(async () => new Response('', { status: 401 })).mockImplementation(async (b) => ok(b));

    await queue.enqueue(first, { accountKey: ACCOUNT_A, label: 'first' });
    await queue.enqueue(second, { accountKey: ACCOUNT_A, label: 'second' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().signedOut).toBe(true);
    expect(await store.all()).toHaveLength(2);
    expect(queue.getSnapshot().items.map((i) => i.state)).toEqual(['pending', 'pending']);

    queue.setSession(ACCOUNT_A);
    await queue.flush();
    expect(send.mock.calls.map(([b]) => b)).toEqual([JSON.stringify(first), JSON.stringify(first), JSON.stringify(second)]);
    expect(await store.all()).toEqual([]);
  });

  it('treats a non-API 403 (Access) as signed out, but an API 403 as needing attention', async () => {
    const queue = await openQueue();
    send
      .mockImplementationOnce(async () => new Response('<html>Access</html>', { status: 403 }))
      .mockImplementationOnce(async () => json(403, { code: 'forbidden', message: 'Bad origin.', retryable: false }));

    await queue.enqueue(note(), { accountKey: ACCOUNT_A, label: 'note' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();
    expect(queue.getSnapshot()).toMatchObject({ signedOut: true, items: [{ state: 'pending' }] });

    queue.setSession(ACCOUNT_A);
    await queue.flush();
    expect(queue.getSnapshot()).toMatchObject({ signedOut: false, items: [{ state: 'attention' }] });
  });

  it('keeps an item across a simulated reload and resends the identical envelope', async () => {
    let queue = await openQueue();
    const envelope = note();
    send.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await queue.enqueue(envelope, { accountKey: ACCOUNT_A, label: 'note' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();
    queue.dispose();
    store.close();

    send.mockImplementation(async (body) => ok(body));
    queue = await openQueue();
    const [restored] = queue.getSnapshot().items;
    expect(restored).toMatchObject({ operationId: envelope.operationId, state: 'pending', everSent: true });

    queue.setSession(ACCOUNT_A);
    await queue.kick();
    expect(send.mock.calls.map(([b]) => b)).toEqual([JSON.stringify(envelope), JSON.stringify(envelope)]);
    expect(await store.all()).toEqual([]);
  });

  describe('Undo of a completion (F4)', () => {
    const complete = () => completeTask(mint(), LOCATOR);
    const undoOf = (target: CompleteTaskCommand) => undoCompleteTask(mint(), target);
    const opts = { accountKey: ACCOUNT_A, label: 'Water the plants', taskKey: LOCATOR.lineText };

    it('cancels both locally when the completion was never sent', async () => {
      const queue = await openQueue();
      const target = complete();
      await queue.enqueue(target, opts);

      expect(await queue.undoCompletion(target, undoOf(target), opts)).toBe('cancelled');
      queue.setSession(ACCOUNT_A);
      await queue.flush();

      expect(send).not.toHaveBeenCalled();
      expect(await store.all()).toEqual([]);
    });

    it('queues a real Undo behind a completion that was ever sent, and sends it only after the receipt', async () => {
      const queue = await openQueue();
      const target = complete();
      const undo = undoOf(target);
      send
        .mockImplementationOnce(async () => unavailable503()) // completion outcome unknown to the user
        .mockImplementation(async (body) => ok(body));

      await queue.enqueue(target, opts);
      queue.setSession(ACCOUNT_A);
      await queue.flush();
      expect(await queue.undoCompletion(target, undo, opts)).toBe('queued');
      await queue.flush(); // completion is still backing off: the Undo must not overtake it
      expect(send).toHaveBeenCalledTimes(1);

      clock += backoffMs(1);
      await queue.flush();
      const sent = send.mock.calls.map(([b]) => Command.parse(JSON.parse(b)));
      expect(sent.map((c) => c.type)).toEqual(['CompleteTask', 'CompleteTask', 'UndoCompleteTask']);
      const sentUndo = sent[2];
      expect(sentUndo?.type === 'UndoCompleteTask' && sentUndo.payload.target).toEqual(target);
      expect(await store.all()).toEqual([]);
    });

    it('holds a dependent back by dependsOn alone, even without a shared task key', async () => {
      const queue = await openQueue();
      const target = complete();
      send.mockImplementationOnce(async () => unavailable503()).mockImplementation(async (body) => ok(body));

      await queue.enqueue(target, opts);
      queue.setSession(ACCOUNT_A);
      await queue.flush();
      await queue.undoCompletion(target, undoOf(target), { accountKey: ACCOUNT_A, label: 'undo', taskKey: null });
      await queue.flush();

      expect(send).toHaveBeenCalledTimes(1);
    });

    it('sends a dependent Undo after its completion is terminally refused', async () => {
      const queue = await openQueue();
      const target = complete();
      send.mockImplementationOnce(async () => unavailable503()).mockImplementationOnce(async () => refused409())
        .mockImplementation(async (body) => ok(body));

      await queue.enqueue(target, opts);
      queue.setSession(ACCOUNT_A);
      await queue.flush();
      await queue.undoCompletion(target, undoOf(target), opts);
      await queue.kick();

      expect(send.mock.calls.map(([b]) => (JSON.parse(b) as Command).type)).toEqual([
        'CompleteTask',
        'CompleteTask',
        'UndoCompleteTask',
      ]);
    });
  });

  it('sends items for the same task strictly FIFO, even without a dependency', async () => {
    const queue = await openQueue();
    const first = completeTask(mint(), LOCATOR);
    const again = completeTask(mint(), LOCATOR); // e.g. complete → undo → complete again
    send.mockImplementationOnce(async () => unavailable503()).mockImplementation(async (body) => ok(body));

    await queue.enqueue(first, { accountKey: ACCOUNT_A, label: 't', taskKey: LOCATOR.lineText });
    await queue.enqueue(again, { accountKey: ACCOUNT_A, label: 't', taskKey: LOCATOR.lineText });
    queue.setSession(ACCOUNT_A);
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);

    clock += backoffMs(1);
    await queue.flush();
    expect(send.mock.calls.map(([b]) => (JSON.parse(b) as Command).operationId)).toEqual([
      first.operationId,
      first.operationId,
      again.operationId,
    ]);
  });

  it('does not let a backing-off task item block an unrelated capture', async () => {
    const queue = await openQueue();
    const target = completeTask(mint(), LOCATOR);
    const capture = note();
    send.mockImplementationOnce(async () => unavailable503()).mockImplementation(async (body) => ok(body));

    await queue.enqueue(target, { accountKey: ACCOUNT_A, label: 't', taskKey: LOCATOR.lineText });
    await queue.enqueue(capture, { accountKey: ACCOUNT_A, label: 'n' });
    queue.setSession(ACCOUNT_A);
    await queue.flush();

    expect(send.mock.calls.map(([b]) => (JSON.parse(b) as Command).operationId)).toEqual([
      target.operationId,
      capture.operationId,
    ]);
  });
});
