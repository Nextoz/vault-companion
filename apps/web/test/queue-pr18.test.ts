import { IDBFactory } from 'fake-indexeddb';
import { Command, type Receipt } from '@vault-companion/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandService } from '../../../packages/domain/src/commands.ts';
import { InMemoryStore } from '../../../packages/domain/src/testing/in-memory-store.ts';
import { captureTask, completeTask, undoCompleteTask, undoDraft } from '../src/commands.ts';
import { openPendingStore, type PendingStore } from '../src/queue/db.ts';
import { PendingQueue, type LockManagerLike } from '../src/queue/queue.ts';

const PATH = 'Tasks/To-Do List.md';
const ORIGINAL = '# Tasks\n\n## Open\n\n- [ ] Water the plants #todo\n\n## Done\n';
const NOW = new Date('2026-09-24T10:00:00Z');
const options = { accountKey: 'a'.repeat(64), label: 'Water the plants', taskKey: 'plants' };
const stores: PendingStore[] = [];
const queues: PendingQueue[] = [];
let factory: IDBFactory;
let vault: InMemoryStore;
let service: ReturnType<typeof createCommandService>;
let latest: string;
let locks: LockManagerLike;

beforeEach(async () => {
  factory = new IDBFactory();
  vault = await InMemoryStore.create({ [PATH]: ORIGINAL });
  service = createCommandService({ store: vault, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  latest = vault.headCommit;
  let tail: Promise<unknown> = Promise.resolve();
  locks = {
    request<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn);
      tail = run.catch(() => undefined);
      return run;
    },
  };
});

afterEach(() => {
  for (const queue of queues.splice(0)) queue.dispose();
  for (const store of stores.splice(0)) store.close();
});

async function execute(body: string): Promise<Response> {
  const raw: unknown = JSON.parse(body);
  const result = await service.execute(Command.parse(raw), raw);
  return Response.json(result, { status: 'code' in result ? 409 : 200 });
}

async function tab(lock: LockManagerLike | null = locks, wrap = (s: PendingStore) => s) {
  const store = await openPendingStore(factory);
  stores.push(store);
  const send = vi.fn(execute);
  const receipts: Receipt[] = [];
  const queue = await PendingQueue.open({
    store: wrap(store), send, locks: lock, now: () => NOW.getTime(),
    latestRevision: () => latest, setTimer: () => () => undefined,
    onReceipt: (receipt) => receipts.push(receipt),
  });
  queues.push(queue);
  return { store, send, queue, receipts };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('PR18 durable command bodies', () => {
  it('P18-1: without locks, B paused after load sends identical bytes after A applies and the latest read advances', async () => {
    const a = await tab(null);
    const loaded = deferred();
    const resume = deferred();
    let pause = false;
    const b = await tab(null, (store) => ({
      ...store,
      load: async () => {
        const snapshot = await store.load();
        if (pause) {
          pause = false;
          loaded.resolve();
          await resume.promise;
        }
        return snapshot;
      },
    }));
    const capture = captureTask({ baseRevision: latest, now: NOW }, { text: 'Buy seeds' });
    await a.queue.enqueue(capture, { ...options, taskKey: null });
    await a.queue.flush(); // no confirmed session yet

    pause = true;
    b.queue.setSession(options.accountKey);
    const bFlush = b.queue.flush();
    await loaded.promise;
    a.queue.setSession(options.accountKey);
    await a.queue.flush();
    expect(a.receipts.map((r) => r.status)).toEqual(['applied']);
    latest = vault.headCommit; // shared preferences updated by a task read after A's receipt
    resume.resolve();
    await bFlush;

    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(b.send.mock.calls[0]?.[0]).toBe(a.send.mock.calls[0]?.[0]);
    expect(b.receipts.map((r) => r.status)).toEqual(['already-applied']);
    expect(vault.commitsWithOp(capture.operationId)).toHaveLength(1);
    expect(vault.text(PATH)?.match(/Buy seeds/g)).toHaveLength(1);
  });

  it.each(['toast receipt', 'pending completion', 'stored draft'] as const)(
    'P18-2: %s Undo uses the rebased durable target, passes the real hash check and retries unchanged',
    async (source) => {
      const a = await tab();
      const read = await service.readTasks([]);
      if ('code' in read) throw new Error(read.code);
      const target = completeTask({ baseRevision: read.revision, now: NOW }, read.allOpen[0]!.locator);
      await a.queue.enqueue(target, options);
      await a.queue.flush();
      latest = await vault.commitFiles({ 'Inbox/Other.md': 'An unrelated change\n' });
      if (source === 'pending completion') {
        a.send.mockImplementationOnce(async (body) => {
          await execute(body); // completion applied; its response was lost
          throw new TypeError('Connection lost');
        });
      }
      a.queue.setSession(options.accountKey);
      await a.queue.flush();
      a.queue.setSignedOut();
      const durableTarget = Command.parse(JSON.parse(a.send.mock.calls[0]![0]));
      expect(durableTarget.baseRevision).toBe(latest);
      expect(durableTarget.baseRevision).not.toBe(target.baseRevision);

      const ctx = { baseRevision: latest, now: NOW };
      const undo = source === 'toast receipt'
        ? undoCompleteTask(ctx, target, a.receipts[0]!.commitSha)
        : undoDraft(ctx, target);
      if (source === 'stored draft') {
        // A draft already on disk (e.g. from an older client) must take BOTH target and token from the receipt.
        await a.queue.enqueue(undo, { ...options, dependsOn: target.operationId });
      } else {
        expect(await a.queue.undoCompletion(target, undo, options)).toBe('queued');
        const stored = JSON.parse((await a.store.get(undo.operationId))!.body) as Command;
        expect.soft(stored.type === 'UndoCompleteTask' && stored.payload.target).toEqual(durableTarget);
      }
      const undoResults: unknown[] = [];
      a.send.mockImplementation(async (body) => {
        const response = await execute(body);
        if ((JSON.parse(body) as Command).type === 'UndoCompleteTask') {
          undoResults.push(await response.clone().json());
          if (undoResults.length === 1) throw new TypeError('Undo response lost');
        }
        return response;
      });
      a.queue.setSession(options.accountKey);
      await a.queue.kick();
      a.queue.setSignedOut();
      expect(undoResults).toEqual([expect.objectContaining({ status: 'applied' })]);
      const firstBody = (await a.store.get(undo.operationId))!.body;
      const sentUndo = Command.parse(JSON.parse(firstBody));
      expect(sentUndo.type === 'UndoCompleteTask' && sentUndo.payload.target).toEqual(durableTarget);

      latest = await vault.commitFiles({ 'Inbox/Later.md': 'Another unrelated change\n' });
      // Repeating the stale UI callback for the same ID must not replace an already-sent Undo.
      await a.queue.undoCompletion(target, undo, options);
      expect((await a.store.get(undo.operationId))!.body).toBe(firstBody);
      a.queue.setSession(options.accountKey);
      await a.queue.kick();
      const undoBodies = a.send.mock.calls.map(([body]) => body)
        .filter((body) => (JSON.parse(body) as Command).type === 'UndoCompleteTask');
      expect(undoBodies).toEqual([firstBody, firstBody]);
      expect(undoResults[1]).toMatchObject({ status: 'already-applied' });
      expect(vault.commitsWithOp(undo.operationId)).toHaveLength(1);
      expect(vault.text(PATH)).toBe(ORIGINAL);
    },
  );
});
