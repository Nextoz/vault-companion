import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrefetcher, type PrefetchDeps } from './prefetch.ts';

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

/** A Response stand-in carrying only what the prefetcher touches. */
function reply(options: { status?: number; type?: string; body?: 'ok' | 'throw' } = {}): Response {
  const status = options.status ?? 200;
  return {
    type: options.type ?? 'basic',
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => {
      if (options.body === 'throw') throw new Error('body failed');
      return new ArrayBuffer(0);
    },
  } as unknown as Response;
}

/** Drain the warm loop's microtasks (fetch + arrayBuffer) without touching the clock. */
async function drain(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

function harness(overrides: Partial<PrefetchDeps> = {}) {
  const sent: Sent[] = [];
  const scheduled: (() => void)[] = [];
  const replies: Response[] = [];
  const deps: PrefetchDeps = {
    fetch: (async (input: string, init?: RequestInit) => {
      sent.push({ url: input, init });
      const next = replies.shift();
      if (!next) throw new Error(`unexpected fetch to ${input}`);
      return next;
    }) as unknown as PrefetchDeps['fetch'],
    schedule: (run) => void scheduled.push(run),
    isOnline: () => true,
    isHidden: () => false,
    saveData: () => false,
    ...overrides,
  };
  const prefetcher = createPrefetcher(deps);
  const flush = async (): Promise<void> => {
    for (const run of scheduled.splice(0)) run();
    await drain();
  };
  return { prefetcher, sent, scheduled, replies, flush };
}

const urls = (sent: readonly Sent[]) => sent.map((s) => s.url);
const READS = ['/api/notes', '/api/history', '/api/training'];

describe('createPrefetcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('warms notes then history then training, at most once per (account, revision)', async () => {
    const h = harness();
    h.replies.push(reply(), reply(), reply());
    h.prefetcher.maybePrefetch('acct', 'rev1');
    h.prefetcher.maybePrefetch('acct', 'rev1');
    await h.flush();
    expect(urls(h.sent)).toEqual(READS);
    expect(h.scheduled).toEqual([]);
  });

  it('warms again for a new revision at the same account', async () => {
    const h = harness();
    h.replies.push(...Array.from({ length: 6 }, () => reply()));
    h.prefetcher.maybePrefetch('acct', 'rev1');
    await h.flush();
    h.prefetcher.maybePrefetch('acct', 'rev2');
    await h.flush();
    expect(urls(h.sent)).toEqual([...READS, ...READS]);
  });

  it('warms again for a new account at the same revision', async () => {
    const h = harness();
    h.replies.push(...Array.from({ length: 6 }, () => reply()));
    h.prefetcher.maybePrefetch('acct-1', 'rev1');
    await h.flush();
    h.prefetcher.maybePrefetch('acct-2', 'rev1');
    await h.flush();
    expect(urls(h.sent)).toEqual([...READS, ...READS]);
  });

  it('does nothing until the scheduled callback runs', () => {
    const h = harness();
    h.replies.push(reply(), reply(), reply());
    h.prefetcher.maybePrefetch('acct', 'rev1');
    expect(h.sent).toEqual([]);
    expect(h.scheduled).toHaveLength(1);
  });

  it('skips entirely when offline, hidden or metered', async () => {
    for (const override of [{ isOnline: () => false }, { isHidden: () => true }, { saveData: () => true }]) {
      const h = harness(override);
      h.prefetcher.maybePrefetch('acct', 'rev1');
      await h.flush();
      expect(h.sent).toEqual([]);
      expect(h.scheduled).toEqual([]);
    }
  });

  it('skips entirely when the account key or revision is empty', async () => {
    const h = harness();
    h.prefetcher.maybePrefetch('', 'rev1');
    h.prefetcher.maybePrefetch('acct', '');
    await h.flush();
    expect(h.sent).toEqual([]);
    expect(h.scheduled).toEqual([]);
  });

  it('stops at a signed-out answer (opaque redirect, 401, 403) and never throws', async () => {
    for (const stop of [reply({ type: 'opaqueredirect' }), reply({ status: 401 }), reply({ status: 403 })]) {
      const h = harness();
      h.replies.push(stop);
      h.prefetcher.maybePrefetch('acct', 'rev1');
      await expect(h.flush()).resolves.toBeUndefined();
      expect(urls(h.sent)).toEqual(['/api/notes']);
    }
  });

  it('stops at any other non-OK answer and never throws', async () => {
    const h = harness();
    h.replies.push(reply(), reply({ status: 500 }));
    h.prefetcher.maybePrefetch('acct', 'rev1');
    await expect(h.flush()).resolves.toBeUndefined();
    expect(urls(h.sent)).toEqual(['/api/notes', '/api/history']);
  });

  it('stops silently when the request rejects', async () => {
    const attempted: string[] = [];
    const h = harness({
      fetch: (async (input: string) => {
        attempted.push(input);
        throw new Error('network down');
      }) as unknown as PrefetchDeps['fetch'],
    });
    h.prefetcher.maybePrefetch('acct', 'rev1');
    await expect(h.flush()).resolves.toBeUndefined();
    expect(attempted).toEqual(['/api/notes']);
  });

  it('stops when reading a body fails', async () => {
    const h = harness();
    h.replies.push(reply({ body: 'throw' }));
    h.prefetcher.maybePrefetch('acct', 'rev1');
    await expect(h.flush()).resolves.toBeUndefined();
    expect(urls(h.sent)).toEqual(['/api/notes']);
  });

  it('sends plain GETs with the base init, an Accept header and an abort signal', async () => {
    const h = harness();
    h.replies.push(reply(), reply(), reply());
    h.prefetcher.maybePrefetch('acct', 'rev1');
    await h.flush();
    expect(h.sent).toHaveLength(3);
    for (const { init } of h.sent) {
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('manual');
      expect(init?.cache).toBe('no-store');
      expect(init?.credentials).toBe('same-origin');
      expect(init?.headers).toEqual({ Accept: 'application/json' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('aborts a fetch that never settles, so no later endpoint is asked', async () => {
    const sent: Sent[] = [];
    const h = harness({
      fetch: ((input: string, init?: RequestInit) => {
        sent.push({ url: input, init });
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as unknown as PrefetchDeps['fetch'],
    });
    h.prefetcher.maybePrefetch('acct', 'rev1');
    await h.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.init?.signal?.aborted).toBe(false);
    vi.advanceTimersByTime(10_000);
    await drain();
    expect(sent[0]?.init?.signal?.aborted).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('aborts a response body that never settles, so no later endpoint is asked', async () => {
    const sent: Sent[] = [];
    const h = harness({
      fetch: ((input: string, init?: RequestInit) => {
        sent.push({ url: input, init });
        return Promise.resolve({
          type: 'basic',
          status: 200,
          ok: true,
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((_, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        } as unknown as Response);
      }) as unknown as PrefetchDeps['fetch'],
    });
    h.prefetcher.maybePrefetch('acct', 'rev1');
    await h.flush();
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    await drain();
    expect(sent[0]?.init?.signal?.aborted).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
