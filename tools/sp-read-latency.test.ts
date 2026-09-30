// SP1 read-latency benchmark assertions (synthetic only; harness in tools/sp-read-latency.mjs).
//
// Test-discovery note (packet SP1): the shared vitest.config.ts `test.include` does NOT cover tools/**,
// so `pnpm exec vitest run tools/sp-read-latency.test.ts` finds no test file until that config adds
// `tools/**/*.test.ts`. This packet forbids editing the shared config, so the integration line is
// reported in docs/reviews/SP-read-latency.md and .agent/handoffs/SP1.md instead of applied here.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActiveWorkResponse,
  HistoryResponse,
  NoteReadResponse,
  NotesResponse,
  TrainingResponse,
} from '../packages/contracts/src/index.ts';
import {
  createBenchHarness,
  runLatencyBenchmark,
  rowFor,
  toMarkdown,
} from './sp-read-latency.mjs';

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

describe('SP1: injected GitHub delays change the measured attribution', () => {
  it('adds roughly the injected head delay to a repeated notes read, with unchanged request counts', async () => {
    const base = await runLatencyBenchmark({ delays: { head: 5 }, samples: 3 });
    const slow = await runLatencyBenchmark({ delays: { head: 65 }, samples: 3 });

    const delta = rowFor(slow, 'notes-list').repeat.medianMs - rowFor(base, 'notes-list').repeat.medianMs;
    expect(delta).toBeGreaterThan(40);
    expect(delta).toBeLessThan(90);
    // Time, not extra calls: the injected delay changes nothing about what is requested.
    expect(rowFor(slow, 'notes-list').repeat.countsPerCall).toEqual(rowFor(base, 'notes-list').repeat.countsPerCall);
  });

  it('charges a blob delay to the note read and not to the list', async () => {
    const base = await runLatencyBenchmark({ delays: { head: 5 }, samples: 3 });
    const blobSlow = await runLatencyBenchmark({ delays: { head: 5, blob: 65 }, samples: 3 });

    const readDelta = rowFor(blobSlow, 'note-read').repeat.medianMs - rowFor(base, 'note-read').repeat.medianMs;
    const listDelta = rowFor(blobSlow, 'notes-list').repeat.medianMs - rowFor(base, 'notes-list').repeat.medianMs;
    expect(readDelta).toBeGreaterThan(40);
    expect(readDelta).toBeLessThan(90);
    expect(Math.abs(listDelta)).toBeLessThan(30);
  });
});

describe('SP1: repeat reads issue real API requests', () => {
  it('pays one head lookup per read and reads a blob only when a note is opened', async () => {
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
    expect(read.repeat.countsPerCall).toMatchObject({ token: 0, head: 1, tree: 0, blob: 1 });

    const work = rowFor(result, 'active-work')!;
    expect(work.cold.counts).toMatchObject({ head: 1, tree: 1, blob: 1 });
    expect(work.repeat.countsPerCall).toMatchObject({ head: 1, tree: 0, blob: 1 });
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
