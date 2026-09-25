import type { Receipt, TasksResponse } from '@vault-companion/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Fetched } from './api.ts';
import type { QueueItem } from './queue/queue.ts';
import { activeWorkState, knownCommits, MAX_KNOWN, ReadSequencer, TaskReads } from './reads.ts';

describe('ReadSequencer (N3)', () => {
  it('applies responses that arrive in order, and drops one older than the newest applied', () => {
    const reads = new ReadSequencer();
    const r0 = reads.begin();
    const r1 = reads.begin();
    const r2 = reads.begin();
    expect(reads.accept(r1)).toBe(true);
    expect(reads.accept(r0)).toBe(false);
    expect(reads.accept(r2)).toBe(true);
    expect(reads.accept(r2)).toBe(false);
  });
});

describe('knownCommits (N3)', () => {
  const saved = (n: number, acknowledged: boolean): QueueItem =>
    ({
      operationId: `op${n}`,
      seq: n,
      state: 'saved',
      acknowledged,
      receipt: { commitSha: n.toString(16).padStart(40, '0') } as Receipt,
    }) as QueueItem;

  it('asks about acknowledged receipts too, after the unacknowledged ones, within the Worker limit', () => {
    const items = [saved(1, true), saved(2, false), saved(3, true), saved(4, false)];
    expect(knownCommits(items).map((c) => parseInt(c, 16))).toEqual([4, 2, 3, 1]);

    const many = Array.from({ length: MAX_KNOWN + 5 }, (_, i) => saved(i + 1, i < 10));
    const asked = knownCommits(many);
    expect(asked).toHaveLength(MAX_KNOWN);
    expect(asked.slice(0, MAX_KNOWN - 10).every((c) => parseInt(c, 16) > 10)).toBe(true);
  });
});

describe('TaskReads — the read ordering App.refreshTasks uses (F3)', () => {
  const response = (revision: string): TasksResponse => ({
    revision,
    blobSha: '2'.repeat(40),
    today: '2026-09-24',
    timeZone: 'Europe/Copenhagen',
    writeBlock: null,
    known: {},
    todayTasks: [],
    overdue: [],
    allOpen: [],
    doneToday: [],
  });

  it('R0 → R1 → late R0 with both getTasks held: R1 applies, R0 is superseded', async () => {
    const replies: ((r: Fetched<TasksResponse>) => void)[] = [];
    const reads = new TaskReads({
      getTasks: () => new Promise((resolve) => replies.push(resolve)),
      watermark: async () => null,
      receipts: () => [],
    });
    const r0 = reads.read();
    const r1 = reads.read();
    await vi.waitFor(() => expect(replies).toHaveLength(2));

    replies[1]?.({ kind: 'ok', data: response('7'.repeat(40)) });
    expect(await r1).toMatchObject({ kind: 'apply', read: { data: { revision: '7'.repeat(40) }, watermarkVersion: 0 } });
    replies[0]?.({ kind: 'ok', data: response('1'.repeat(40)) });
    expect(await r0).toEqual({ kind: 'superseded' });
  });

  it('asks about the watermark first, then retained receipts, within the Worker limit', async () => {
    const asked: (readonly string[])[] = [];
    const receipts = Array.from({ length: MAX_KNOWN }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
    const reads = new TaskReads({
      getTasks: async (known) => {
        asked.push(known);
        return { kind: 'offline' };
      },
      watermark: async () => ({ commitSha: 'f'.repeat(40), receiptOpIds: [], version: 3 }),
      receipts: () => receipts,
    });
    expect(await reads.read()).toEqual({ kind: 'offline' });
    expect(asked[0]).toHaveLength(MAX_KNOWN);
    expect(asked[0]?.[0]).toBe('f'.repeat(40));
  });
});

describe('activeWorkState (quiet states)', () => {
  const rev = 'c'.repeat(40);
  it('maps every read outcome', () => {
    expect(activeWorkState(null)).toEqual({ kind: 'message', text: 'Loading…' });
    expect(activeWorkState({ kind: 'ok', data: { status: 'absent', revision: rev } })).toEqual({ kind: 'hidden' });
    expect(activeWorkState({ kind: 'ok', data: { status: 'ok', revision: rev, blobSha: rev, markdown: '# a' } })).toEqual({ kind: 'content', markdown: '# a' });
    expect(activeWorkState({ kind: 'ok', data: { status: 'refused', revision: rev, code: 'too-large', message: 'm' } })).toEqual({ kind: 'message', text: 'Too large to show here.' });
    expect(activeWorkState({ kind: 'ok', data: { status: 'refused', revision: rev, code: 'encoding', message: 'm' } })).toEqual({ kind: 'message', text: 'Cannot be displayed.' });
    expect(activeWorkState({ kind: 'offline' })).toEqual({ kind: 'message', text: 'Offline.' });
    expect(activeWorkState({ kind: 'error', message: 'x' })).toEqual({ kind: 'message', text: 'Not available right now.' });
    expect(activeWorkState({ kind: 'signed-out' })).toEqual({ kind: 'message', text: 'Not available right now.' });
  });
});
