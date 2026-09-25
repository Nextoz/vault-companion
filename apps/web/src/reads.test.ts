import type { Receipt } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import type { QueueItem } from './queue/queue.ts';
import { knownCommits, MAX_KNOWN, ReadSequencer } from './reads.ts';

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
