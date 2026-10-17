import { describe, expect, it } from 'vitest';
import { mapBounded } from './bounded.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('mapBounded', () => {
  it('keeps input order when calls settle out of order, and never runs more than the limit at once', async () => {
    const gates = Array.from({ length: 7 }, () => deferred<string>());
    let inFlight = 0;
    let maxInFlight = 0;
    const started: number[] = [];
    const out = mapBounded([0, 1, 2, 3, 4, 5, 6], 3, async (item) => {
      started.push(item);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await gates[item]!.promise;
      } finally {
        inFlight -= 1;
      }
    });
    await flush();
    expect(started).toEqual([0, 1, 2]);
    gates[2]!.resolve('c');
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    for (const index of [6, 5, 4, 3, 1, 0]) {
      gates[index]!.resolve(String.fromCharCode(97 + index));
      await flush();
    }
    expect(await out).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(maxInFlight).toBe(3);
  });

  it('rejects with the first failure and starts no further calls', async () => {
    const started: number[] = [];
    const failure = new Error('boom');
    const out = mapBounded([0, 1, 2, 3], 1, async (item) => {
      started.push(item);
      if (item === 1) throw failure;
      return item;
    });
    await expect(out).rejects.toBe(failure);
    await flush();
    expect(started).toEqual([0, 1]);
  });

  it('returns [] for no items and refuses a limit below one', async () => {
    expect(await mapBounded([], 6, async () => 1)).toEqual([]);
    await expect(mapBounded([1], 0, async () => 1)).rejects.toBeInstanceOf(RangeError);
  });
});
