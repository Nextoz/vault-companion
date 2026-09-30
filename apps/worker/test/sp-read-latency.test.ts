// SP1 read-latency benchmark assertions (synthetic only; harness in tools/sp-read-latency.mjs).
// Delay attribution is asserted through the harness's injected clock/await hook, not wall-clock intervals.
//
// The test lives under apps/worker/test so the shared vitest.config.ts `test.include`
// (`apps/*/test/**/*.test.ts`) discovers it through the normal command with no config change.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActiveWorkResponse,
  HistoryResponse,
  NoteReadResponse,
  NotesResponse,
  TrainingResponse,
} from '../../../packages/contracts/src/index.ts';
import {
  API_BASE,
  BRANCH,
  createBenchHarness,
  createFakeGitHub,
  createVirtualClock,
  runLatencyBenchmark,
  rowFor,
  toMarkdown,
} from '../../../tools/sp-read-latency.mjs';

const ZERO = { token: 0, head: 0, tree: 0, blob: 0 };
const NOTE = 'Inbox/Alpha note - 2026-09-25.md';
const NOTE_READ = { path: '/api/notes/read', note: NOTE };
const OWNER_PATH = '/repos/sp1-bench-owner/sp1-bench-vault';

afterEach(() => vi.restoreAllMocks());

describe('SP1: the benchmark invokes the production read composition', () => {
  it('serves real contracts through createProductionApp behind a signed Access token', async () => {
    const harness = await createBenchHarness({ delays: ZERO });

    // Production auth is wired: no token is a 401, a valid Access token reaches the session route.
    expect((await harness.app.fetch(new Request('https://bench.example.com/api/notes'))).status).toBe(401);
    const session = await harness.app.fetch(
      new Request('https://bench.example.com/api/session', {
        headers: { 'Cf-Access-Jwt-Assertion': harness.access.token },
      }),
    );
    expect(session.status).toBe(200);

    const notes = await harness.request({ path: '/api/notes' });
    expect(notes.status).toBe(200);
    expect(NotesResponse.safeParse(await notes.json()).success).toBe(true);

    const read = await harness.request(NOTE_READ);
    expect(read.status).toBe(200);
    expect(NoteReadResponse.safeParse(await read.json()).success).toBe(true);

    const work = await harness.request({ path: '/api/active-work' });
    expect(work.status).toBe(200);
    expect(ActiveWorkResponse.safeParse(await work.json()).success).toBe(true);

    const training = await harness.request({ path: '/api/training' });
    expect(TrainingResponse.safeParse(await training.json()).success).toBe(true);

    const history = await harness.request({ path: '/api/history' });
    expect(HistoryResponse.safeParse(await history.json()).success).toBe(true);

    // The fake GitHub API was really reached, on the paths the store builds.
    expect(harness.fake.requests.some((r) => r.kind === 'head' && r.path === `${OWNER_PATH}/git/ref/heads/main`)).toBe(true);
    expect(harness.fake.requests.some((r) => r.kind === 'tree' && r.path.startsWith(`${OWNER_PATH}/git/trees/`))).toBe(true);
    expect(harness.fake.requests.some((r) => r.kind === 'blob' && r.path.startsWith(`${OWNER_PATH}/contents/`))).toBe(true);
  });
});

describe('SP1: injected GitHub delays are attributed deterministically', () => {
  it('awaits the injected head delay on every repeated notes read, with unchanged request counts', async () => {
    // The virtual clock makes the await hook exact; assertions never ride on wall-clock scheduling.
    const base = await runLatencyBenchmark({ delays: { head: 5 }, samples: 3, clock: createVirtualClock });
    const slow = await runLatencyBenchmark({ delays: { head: 65 }, samples: 3, clock: createVirtualClock });

    const baseList = rowFor(base, 'notes-list')!;
    const slowList = rowFor(slow, 'notes-list')!;

    // Time, not extra calls: the injected delay changes nothing about what is requested.
    expect(baseList.repeat.countsPerCall).toMatchObject({ token: 0, head: 1, tree: 0, blob: 0 });
    expect(slowList.repeat.countsPerCall).toEqual(baseList.repeat.countsPerCall);

    // Oracle: the await hook rises by exactly the injected head delta on every repeat call, and is 0
    // for every other request kind. A removed or bypassed head delay drops `head` to 0 and fails here.
    expect(baseList.repeat.awaitedPerCall).toEqual({ token: 0, head: 5, tree: 0, blob: 0, other: 0, total: 5 });
    expect(slowList.repeat.awaitedPerCall).toEqual({ token: 0, head: 65, tree: 0, blob: 0, other: 0, total: 65 });
    expect(slowList.repeat.awaitedPerCall.head - baseList.repeat.awaitedPerCall.head).toBe(60);
    for (const awaited of slowList.repeat.awaitedAllCalls) expect(awaited).toMatchObject({ head: 65, total: 65 });
    for (const awaited of baseList.repeat.awaitedAllCalls) expect(awaited).toMatchObject({ head: 5, total: 5 });

    // Wall time is still measured for the report, but only as an observation, never the assertion.
    expect(slowList.repeat.medianMs).toBeGreaterThanOrEqual(0);
    expect(baseList.repeat.medianMs).toBeGreaterThanOrEqual(0);
  });

  it('a repeat note read is served from the immutable cache, so an injected blob delay is never awaited', async () => {
    const base = await runLatencyBenchmark({ delays: { head: 5 }, samples: 3, clock: createVirtualClock });
    const blobSlow = await runLatencyBenchmark({ delays: { head: 5, blob: 65 }, samples: 3, clock: createVirtualClock });

    const baseRead = rowFor(base, 'note-read')!;
    const slowRead = rowFor(blobSlow, 'note-read')!;
    const baseList = rowFor(base, 'notes-list')!;
    const slowList = rowFor(blobSlow, 'notes-list')!;

    expect(baseRead.cold.counts).toMatchObject({ token: 1, head: 1, tree: 1, blob: 1 });
    // Cold really awaited the injected blob delay; the repeat did not, because the blob is cached.
    expect(slowRead.cold.awaited).toMatchObject({ head: 5, blob: 65 });
    expect(baseRead.repeat.countsPerCall).toMatchObject({ token: 0, head: 1, tree: 0, blob: 0 });
    expect(baseRead.repeat.awaitedPerCall).toMatchObject({ head: 5, blob: 0 });
    expect(slowRead.repeat.countsPerCall).toEqual(baseRead.repeat.countsPerCall);
    expect(slowRead.repeat.awaitedPerCall).toEqual(baseRead.repeat.awaitedPerCall);
    expect(slowList.repeat.countsPerCall).toEqual(baseList.repeat.countsPerCall);
    expect(slowList.repeat.awaitedPerCall).toEqual(baseList.repeat.awaitedPerCall);
  });

  it('the oracle observes the head delay only because the fake API really awaits it', async () => {
    const clock = createVirtualClock();
    const fake = createFakeGitHub({ delays: { head: 65 }, clock });
    await fake.fetch(`${API_BASE}/git/ref/heads/${BRANCH}`);

    expect(fake.requests).toHaveLength(1);
    // awaitedMs must equal the injected delay; if the wait is removed or bypassed it becomes 0 and fails.
    expect(fake.requests[0]).toMatchObject({ kind: 'head', delayMs: 65, awaitedMs: 65 });
    expect(clock.awaitedMs()).toBe(65);
  });
});

it('Lead oracle: no HTTP answer is returned before the injected delay promise settles', async () => {
  let release!: () => void;
  let elapsed = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const clock = {
    awaitedMs: () => elapsed,
    sleep: async (ms: number) => { await gate; elapsed += ms; },
  };
  const fake = createFakeGitHub({ delays: { head: 65 }, clock });
  let answered = false;
  const request = fake.fetch(`${API_BASE}/git/ref/heads/${BRANCH}`).then((response: Response) => {
    answered = true;
    return response;
  });
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  const answeredBeforeRelease = answered;
  release();
  await request;
  expect(answeredBeforeRelease).toBe(false);
  expect(fake.requests[0]).toMatchObject({ kind: 'head', awaitedMs: 65 });
});

describe('SP1: repeat reads issue real API requests', () => {
  it('pays one head lookup per action and serves repeat immutable blob reads from the cache', async () => {
    const result = await runLatencyBenchmark({ delays: ZERO, samples: 3 });

    const list = rowFor(result, 'notes-list')!;
    // Cold: token + head + one recursive tree listing of Inbox; the list itself reads no note bodies.
    expect(list.cold.counts).toMatchObject({ token: 1, head: 1, tree: 1, blob: 0 });
    // Repeat: the commit-addressed tree listing is cached in the store; the mutable head is not.
    expect(list.repeat.countsPerCall).toMatchObject({ token: 0, head: 1, tree: 0, blob: 0 });
    expect(list.repeat.countsAllCalls).toHaveLength(3);
    for (const counts of list.repeat.countsAllCalls) expect(counts).toMatchObject({ head: 1, tree: 0, blob: 0 });

    const read = rowFor(result, 'note-read')!;
    expect(read.cold.counts).toMatchObject({ token: 1, head: 1, tree: 1, blob: 1 });
    expect(read.repeat.countsPerCall).toMatchObject({ token: 0, head: 1, tree: 0, blob: 0 });

    const work = rowFor(result, 'active-work')!;
    expect(work.cold.counts).toMatchObject({ head: 1, tree: 1, blob: 1 });
    expect(work.repeat.countsPerCall).toMatchObject({ head: 1, tree: 0, blob: 0 });
  });

  it('keeps fetching the head on every note read, and refetches a different note path', async () => {
    const harness = await createBenchHarness({ delays: ZERO });

    for (let i = 0; i < 2; i += 1) await (await harness.request(NOTE_READ)).json();
    await (await harness.request({ path: '/api/notes/read', note: 'Inbox/Beta note - 2026-09-24.md' })).json();

    expect(harness.fake.requests.filter((r) => r.kind === 'head')).toHaveLength(3);
    expect(harness.fake.requests.filter((r) => r.kind === 'blob')).toHaveLength(2);
  });
});

describe('SP1: malformed or missing upstream responses fail honestly', () => {
  it('maps an upstream 500 on the head lookup to a typed 503', async () => {
    const harness = await createBenchHarness({ faults: [{ kind: 'head', mode: 'status500' }] });
    const res = await harness.request({ path: '/api/notes' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
  });

  it('maps a missing branch ref (404) to a typed 503', async () => {
    const harness = await createBenchHarness({ faults: [{ kind: 'head', mode: 'status404' }] });
    expect((await harness.request({ path: '/api/notes' })).status).toBe(503);
  });

  it('maps a malformed blob body to a typed 503 instead of a crash', async () => {
    const harness = await createBenchHarness({ faults: [{ kind: 'blob', mode: 'malformed' }] });
    const res = await harness.request(NOTE_READ);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('upstream-unavailable');
  });

  it('refuses a note that is not listed, without throwing', async () => {
    const harness = await createBenchHarness({});
    const res = await harness.request({ path: '/api/notes/read', note: 'Inbox/Missing - 2026-09-25.md' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'refused', code: 'not-found' });
  });
});

describe('SP1: no note content or clear-text path leaks into logs', () => {
  it('carries the note only in the response payload, never in the structured log lines', async () => {
    const printed: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args));
    }
    const harness = await createBenchHarness({});
    await harness.request({ path: '/api/notes' });
    const res = await harness.request(NOTE_READ);
    expect(await res.text()).toContain('Synthetic body alpha'); // the payload is the note, by design

    const logs = JSON.stringify(printed);
    expect(logs).not.toContain('Inbox/');
    expect(logs).not.toContain('Synthetic body');
    expect(logs).not.toContain('Alpha note');
  });
});

describe('SP1: reproducible evidence table', () => {
  it('prints the benchmark numbers (also copied into docs/reviews/SP-read-latency.md)', async () => {
    const result = await runLatencyBenchmark({ delays: { token: 5, head: 30, tree: 20, blob: 10 }, samples: 5 });
    console.log(toMarkdown(result));
    expect(result.rows).toHaveLength(6);
  });
});
