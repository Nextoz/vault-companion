// ADR-0029 scenarios end to end in the Worker: real Gemini client over a fake fetch, InMemoryStore (Git semantics).
import { ScoutStatus } from '@vault-companion/contracts';
import {
  EXPLAINED_DIR,
  EXPLAINER_STATUS_PATH,
  explainerOperationId,
  MODEL_CHAIN,
  MODEL_TIME_BUDGET_MS,
  TRAILER_OP,
  type VaultPath,
} from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { describe, expect, it } from 'vitest';
import { createGeminiExplainer } from './gemini.ts';
import type { LogRecord } from './log.ts';
import { runExplainerJob } from './research-explainer.ts';

const DATE = '2026-09-28';
const PRIMARY = '30 4 * * *';
const CATCHUP = '30 6 * * *';
const KEY = 'SENTINEL-key-7f2a';
const WHY = 'SENTINEL-why-1c9e';
const BRIEF = `Research/Reading Briefs/Research Reading Brief - ${DATE}.md`;
const SCOUT = `Research/Daily Research Scout/Daily Research Scout - ${DATE}.md`;
const brief = (n: number) => [
  `# Research Reading Brief - ${DATE}`, '', '## Read today', '',
  ...Array.from({ length: n }, (_, i) => `- [Synthetic Paper ${i + 1}](https://arxiv.org/abs/2601.0000${i + 1}) — ${WHY}`), '',
].join('\n');
const note = (i: number, date = DATE) => `${EXPLAINED_DIR}/${date} - synthetic-paper-${i}.md`;

const explanation = (title: string) => ({
  title,
  authors: ['A. Example'],
  venue: null,
  plainWords: `SENTINEL-model-text about ${title}.`,
  keyIdeas: [1, 2, 3].map((k) => ({ idea: `Idea ${k}`, example: `Example ${k}` })),
  whyItMatters: 'It may help.',
  glossary: [],
  tryIt: [{ experiment: 'Try a small run', minutes: 20 }],
  howSolid: { limits: ['Small study'], evidence: 'One benchmark.' },
});

type Reply = number | { json?: unknown; text?: string; url?: string; quota?: boolean };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeGemini(replies: Reply[]) {
  const calls: { url: string; model: string; body: { contents: { parts: { text: string }[] }[]; tools: unknown[]; generationConfig: Record<string, unknown> }; key: string | null }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as (typeof calls)[number]['body'];
    calls.push({ url, model: /models\/([^:]+):/.exec(url)![1]!, body, key: new Headers(init.headers).get('x-goog-api-key') });
    const r = replies.shift() ?? 503;
    if (typeof r === 'number') {
      return r === 429 ? json(429, { error: { status: 'RESOURCE_EXHAUSTED' } }) : json(r, { error: { message: 'x' } });
    }
    if (r.quota) return json(429, { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure' }] } });
    const text = r.text ?? JSON.stringify(r.json);
    return json(200, {
      candidates: [{
        content: { parts: [{ text: 'thinking', thought: true }, { text }] },
        finishReason: 'STOP',
        urlContextMetadata: { urlMetadata: [{ retrievedUrl: 'x', urlRetrievalStatus: r.url ?? 'URL_RETRIEVAL_STATUS_SUCCESS' }] },
      }],
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const ok = (i: number): Reply => ({ json: explanation(`Synthetic Paper ${i}`) });

async function run(store: InMemoryStore, replies: Reply[], opts: { cron?: string; budget?: number; now?: string; elapsedMs?: () => number } = {}) {
  const gemini = fakeGemini(replies);
  const logs: LogRecord[] = [];
  const before = store.calls.length; // per invocation, like the Worker's counting fetch
  await runExplainerJob(opts.cron ?? PRIMARY, {
    store,
    explainer: createGeminiExplainer({ apiKey: KEY, fetch: gemini.fetch }),
    now: () => new Date(opts.now ?? `${DATE}T04:30:05Z`),
    timeZone: 'Europe/Copenhagen',
    subrequests: () => store.calls.length - before + gemini.calls.length,
    log: (r) => logs.push(r),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.elapsedMs ? { elapsedMs: opts.elapsedMs } : {}),
  });
  return { gemini, logs };
}

async function statusOf(store: InMemoryStore) {
  return ScoutStatus.parse(JSON.parse(store.text(EXPLAINER_STATUS_PATH)!));
}
const changed = async (store: InMemoryStore) => (await store.readCommit(store.headCommit))!.files.map((f) => f.path).sort();

describe('research explainer job (ADR-0029)', () => {
  it('no brief today ⇒ nothing read from the model, no commit', async () => {
    const store = await InMemoryStore.create({ [`Research/Reading Briefs/Research Reading Brief - 2026-09-27.md`]: brief(2) });
    const head = store.headCommit;
    const { gemini, logs } = await run(store, []);
    expect(store.headCommit).toBe(head);
    expect(store.writeCalls).toBe(0);
    expect(gemini.calls).toHaveLength(0);
    expect(logs).toMatchObject([{ route: 'cron:research-explainer', errorCode: 'no-input', status: 204 }]);
  });

  it('3 items ⇒ 3 notes + the status record in ONE commit with the deterministic operation ID', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(3) });
    const { gemini, logs } = await run(store, [ok(1), ok(2), ok(3)]);
    const op = await explainerOperationId(DATE, 'primary');
    expect(store.writeCalls).toBe(1);
    expect(store.commitsWithOp(op)).toEqual([store.headCommit]);
    expect((await store.readCommit(store.headCommit))!.trailers).toMatchObject({ [TRAILER_OP]: op, 'Vault-Companion-Job': 'research-explainer' });
    expect(await changed(store)).toEqual([EXPLAINER_STATUS_PATH, note(1), note(2), note(3)].sort());
    expect(store.text(note(1))).toContain('source: "https://arxiv.org/abs/2601.00001"\nscout_note: "[[Research Reading Brief - 2026-09-28]]"\nmodel: gemini-3.5-flash-lite\n');
    expect(store.text(note(2))).toContain('# Synthetic Paper 2\n');
    expect(await statusOf(store)).toMatchObject({
      scoutId: 'research-explainer', runStatus: 'success', aiHealth: 'healthy', findings: 3, errors: 0, lastError: null,
      latestOutput: note(3), history: [{ status: 'success', findings: 3, operationId: op }],
    });
    // The model reads the paper by URL (arXiv abs → pdf) with the URL-context tool and JSON output; key only in the header.
    expect(gemini.calls[0]!.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_CHAIN[0]}:generateContent`);
    expect(gemini.calls[0]!.key).toBe(KEY);
    expect(gemini.calls[0]!.body.tools).toEqual([{ url_context: {} }]);
    expect(gemini.calls[0]!.body.generationConfig).toMatchObject({ responseMimeType: 'application/json' });
    expect(gemini.calls[0]!.body.contents[0]!.parts[0]!.text).toContain('https://arxiv.org/pdf/2601.00001');
    expect(gemini.calls[0]!.body.contents[0]!.parts[0]!.text).toContain(WHY);
    expect(logs).toMatchObject([{ status: 200, operationId: op, commitSha: store.headCommit }]);
    // Never the key, the scout's text, model text or a note path in a log or a commit message.
    const leaked = JSON.stringify([logs, store.commitMessages()]);
    for (const s of [KEY, WHY, 'SENTINEL-model-text', 'Synthetic Paper', 'Research/']) expect(leaked).not.toContain(s);
  });

  it('an already explained paper (any date) is skipped without a model call', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(3), [note(2, '2026-09-20')]: 'mine\n' });
    const { gemini } = await run(store, [ok(1), ok(3)]);
    expect(gemini.calls).toHaveLength(2);
    expect(await changed(store)).toEqual([EXPLAINER_STATUS_PATH, note(1), note(3)].sort());
    expect(store.text(note(2, '2026-09-20'))).toBe('mine\n');
    expect(await statusOf(store)).toMatchObject({ runStatus: 'success', findings: 2, sources: { configured: 2, successful: 2 } });
  });

  it('falls back to the scout note when the brief has nothing under Read today', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: '## Read today\n\nnothing\n', [SCOUT]: '## Most relevant items\n- [Synthetic Paper 1](https://arxiv.org/abs/2601.00001)\n' });
    await run(store, [ok(1)]);
    expect(store.text(note(1))).toContain('scout_note: "[[Daily Research Scout - 2026-09-28]]"');
  });

  it('a 503 is retried once on the same model, then succeeds', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    const { gemini } = await run(store, [503, ok(1)]);
    expect(gemini.calls.map((c) => c.model)).toEqual([MODEL_CHAIN[0], MODEL_CHAIN[0]]);
    expect(store.text(note(1))).toContain(`model: ${MODEL_CHAIN[0]}`);
    expect(await statusOf(store)).toMatchObject({ runStatus: 'success', aiHealth: 'degraded', findings: 1 });
  });

  it('quota moves to the next model at once; other errors too', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    const { gemini } = await run(store, [{ quota: true }, 500, ok(1)]);
    expect(gemini.calls.map((c) => c.model)).toEqual([...MODEL_CHAIN]);
    expect(store.text(note(1))).toContain(`model: ${MODEL_CHAIN[2]}`);
  });

  it('all models fail ⇒ a pending note at once, status degraded, the paper kept for retry', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    const { gemini } = await run(store, [503, 503, 429, 429, 503, 503]);
    expect(gemini.calls.map((c) => c.model)).toEqual(MODEL_CHAIN.flatMap((m) => [m, m]));
    expect(await changed(store)).toEqual([EXPLAINER_STATUS_PATH, note(1)].sort());
    expect(store.text(note(1))).toContain('status: pending');
    expect(store.text(note(1))).toContain(`Why the scout picked it: ${WHY}`);
    expect(await statusOf(store)).toMatchObject({
      runStatus: 'degraded', aiHealth: 'failed', findings: 0, errors: 1, lastError: '1 of 1 papers not explained (all models failed)', lastSuccessAt: null,
      pending: [{ url: 'https://arxiv.org/abs/2601.00001', firstSeen: DATE, path: note(1), lastReason: 'models-unavailable' }],
    });
  });

  it('invalid model JSON ⇒ that paper gets a pending note, the others are explained', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(2) });
    const { gemini } = await run(store, [{ text: '{"title": "no other fields"}' }, ok(2)]);
    expect(gemini.calls).toHaveLength(2);
    expect(await changed(store)).toEqual([EXPLAINER_STATUS_PATH, note(1), note(2)].sort());
    expect(store.text(note(1))).toContain('status: pending');
    expect(store.text(note(2))).toContain('status: complete');
    expect(await statusOf(store)).toMatchObject({ runStatus: 'degraded', findings: 1, errors: 1, lastError: '1 of 2 papers not explained (invalid model output)' });
  });

  it('a paper the model could not open is never explained from a guess: pending note only', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    const { gemini } = await run(store, [{ json: explanation('Synthetic Paper 1'), url: 'URL_RETRIEVAL_STATUS_ERROR' }]);
    expect(gemini.calls).toHaveLength(1);
    expect(store.text(note(1))).toContain('status: pending');
    expect(store.text(note(1))).not.toContain('SENTINEL-model-text');
    expect((await statusOf(store)).lastError).toContain('paper could not be read');
  });

  it('a re-run of the same slot dedupes: no model call, no second commit', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(2) });
    await run(store, [ok(1), 503, 503, 503, 503, 503, 503]);
    const head = store.headCommit;
    const again = await run(store, [ok(2)], { now: `${DATE}T05:10:00Z` });
    expect(again.gemini.calls).toHaveLength(0);
    expect(store.headCommit).toBe(head);
    expect(again.logs).toMatchObject([{ errorCode: 'already-ran' }]);
    // The catch-up slot is a different operation: it retries the failed paper and commits once.
    const catchup = await run(store, [ok(2)], { cron: CATCHUP, now: `${DATE}T06:30:04Z` });
    expect(catchup.gemini.calls).toHaveLength(1);
    expect(store.commitsWithOp(await explainerOperationId(DATE, 'catchup'))).toEqual([store.headCommit]);
    expect(await changed(store)).toEqual([EXPLAINER_STATUS_PATH, note(2)].sort());
    expect((await run(store, [ok(2)], { cron: CATCHUP })).gemini.calls).toHaveLength(0);
    expect((await statusOf(store)).history.map((h) => h.status)).toEqual(['degraded', 'success']);
  });

  it('a lost response that landed is found through the status record (one commit)', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    store.writeFaults.push('apply-then-unknown');
    const { logs } = await run(store, [ok(1)]);
    expect(store.commitsWithOp(await explainerOperationId(DATE, 'primary'))).toHaveLength(1);
    expect(logs).toMatchObject([{ errorCode: 'already-ran' }]);
  });

  it('head moved ⇒ one re-plan at the new head without new model calls', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    let once = true;
    store.afterHead = async () => {
      if (once) {
        once = false;
        await store.commitFiles({ 'Inbox/desktop.md': 'x\n' });
      }
    };
    const { gemini, logs } = await run(store, [ok(1)]);
    expect(gemini.calls).toHaveLength(1);
    expect(store.writeCalls).toBe(2);
    expect(logs).toMatchObject([{ status: 200 }]);
    expect(store.text('Inbox/desktop.md')).toBe('x\n');
    expect(store.text(note(1))).not.toBeNull();
  });

  it('stops model calls before the subrequest budget cannot pay for the commit; the catch-up retries pending papers first', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(3) });
    // Reads: head, status, brief, listing = 4. A call needs used + 1 + commitCost(reserve) ≤ budget; reserve = planned
    // files + remaining new papers + this retry + the status record. Paper 1: 4 + 1 + (4 + 7) = 16; paper 2: 17; paper 3: 18.
    const { gemini } = await run(store, [{ text: 'not json' }, ok(2), ok(3)], { budget: 17 });
    expect(gemini.calls).toHaveLength(2);
    expect(await changed(store)).toEqual([EXPLAINER_STATUS_PATH, note(1), note(2), note(3)].sort());
    expect(store.text(note(3))).toContain('status: pending');
    const first = await statusOf(store);
    expect(first).toMatchObject({ runStatus: 'degraded', findings: 1, errors: 1 });
    expect(first.pending?.map((p) => [p.url, p.lastReason])).toEqual([
      ['https://arxiv.org/abs/2601.00001', 'invalid-json'], ['https://arxiv.org/abs/2601.00003', 'budget'],
    ]);
    expect(first.lastError).toBe('1 of 3 papers not explained (invalid model output); 1 deferred to the next run (run limits)');
    // Room for one call (4 + 1 + (2 + 7) = 14): pending paper 1 is retried and replaced; paper 3 waits (deferred again).
    const catchup = await run(store, [ok(1)], { cron: CATCHUP, budget: 14 });
    expect(catchup.gemini.calls).toHaveLength(1);
    expect(catchup.gemini.calls[0]!.body.contents[0]!.parts[0]!.text).toContain('2601.00001');
    expect(await changed(store)).toEqual([EXPLAINER_STATUS_PATH, note(1)].sort());
    expect(store.text(note(1))).toContain('status: complete');
    expect((await statusOf(store)).pending?.map((p) => p.url)).toEqual(['https://arxiv.org/abs/2601.00003']);
  });

  it('carries a failed paper over for 3 days, then marks its note unavailable without another model call', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    const allFail = [503, 503, 503, 503, 503, 503];
    await run(store, allFail);
    // No brief on the next days: the run still retries what is pending.
    expect((await run(store, allFail, { now: '2026-09-29T04:30:05Z' })).gemini.calls).toHaveLength(6);
    expect((await run(store, allFail, { now: '2026-09-30T04:30:05Z' })).gemini.calls).toHaveLength(6);
    expect(store.text(note(1))).toContain('status: pending');
    const day4 = await run(store, [ok(1)], { now: '2026-10-01T04:30:05Z' });
    expect(day4.gemini.calls).toHaveLength(0);
    expect(store.text(note(1))).toContain('status: unavailable');
    expect(store.text(note(1))).toContain('No explanation: all models failed (tried for 3 days).');
    const s = await statusOf(store);
    expect(s).toMatchObject({ runStatus: 'degraded', lastError: '1 given up after 3 days' });
    expect(s).not.toHaveProperty('pending');
    expect((await run(store, [ok(1)], { now: '2026-10-02T04:30:05Z' })).logs).toMatchObject([{ errorCode: 'no-input' }]);
  });

  it('a retry that succeeds replaces its pending note; a pending note the owner edited is never overwritten', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(2) });
    await run(store, Array.from({ length: 12 }, () => 503));
    expect(store.text(note(1))).toContain('status: pending');
    await store.commitFiles({ [note(2)]: 'my own notes\n' });
    const next = await run(store, [ok(1), ok(2)], { now: '2026-09-29T04:30:05Z' });
    expect(next.gemini.calls).toHaveLength(1);
    expect(store.text(note(1))).toContain('status: complete');
    expect(store.text(note(1))).toContain('created: 2026-09-28');
    expect(store.text(note(2))).toBe('my own notes\n');
    expect(await statusOf(store)).not.toHaveProperty('pending');
  });

  it('stops model calls after the wall-time budget; the paper waits as pending', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    const { gemini } = await run(store, [ok(1)], { elapsedMs: () => MODEL_TIME_BUDGET_MS });
    expect(gemini.calls).toHaveLength(0);
    expect(store.text(note(1))).toContain('status: pending');
    expect((await statusOf(store)).pending?.[0]?.lastReason).toBe('budget');
  });

  it('an owner edit to a pending note during a head-moved re-plan is kept (blob SHA re-checked at the new head)', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    await run(store, Array.from({ length: 6 }, () => 503));
    let once = true;
    store.afterHead = async () => {
      if (once) {
        once = false;
        await store.commitFiles({ [note(1)]: 'edited on the desktop\n' });
      }
    };
    const { gemini } = await run(store, [ok(1)], { now: '2026-09-29T04:30:05Z' });
    expect(gemini.calls).toHaveLength(1);
    expect(store.writeCalls).toBe(3);
    expect(store.text(note(1))).toBe('edited on the desktop\n');
    expect(await statusOf(store)).not.toHaveProperty('pending');
  });

  it('a pending paper listed again (other link text) is retried once, not explained twice', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    await run(store, Array.from({ length: 6 }, () => 503));
    await store.commitFiles({ ['Research/Reading Briefs/Research Reading Brief - 2026-09-29.md']: brief(1).replace('Synthetic Paper 1', 'Renamed Paper') });
    const { gemini } = await run(store, [ok(1), ok(1)], { now: '2026-09-29T04:30:05Z' });
    expect(gemini.calls).toHaveLength(1);
    expect(await changed(store)).toEqual([EXPLAINER_STATUS_PATH, note(1)].sort());
  });

  it('an unknown cron does nothing', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    const { gemini, logs } = await run(store, [ok(1)], { cron: '0 0 * * *' });
    expect([gemini.calls.length, store.writeCalls, store.calls.length]).toEqual([0, 0, 0]);
    expect(logs).toMatchObject([{ errorCode: 'unknown-cron' }]);
  });

  it('the Gemini client gives up after its per-call timeout', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const client = createGeminiExplainer({ apiKey: KEY, fetch: hang, timeoutMs: 5 });
    expect(await client.explain({ model: MODEL_CHAIN[0], url: 'https://arxiv.org/pdf/2601.00001', prompt: 'p' })).toEqual({ kind: 'error' });
  });

  it('a multi-file write refuses duplicate paths before any store work', async () => {
    const store = await InMemoryStore.create({ [BRIEF]: brief(1) });
    await expect(store.writeFiles({
      baseCommit: store.headCommit, message: 'm', trailers: {},
      files: [{ path: 'Research/Explained/a.md' as VaultPath, expect: 'absent', bytes: new Uint8Array() }, { path: 'Research/Explained/a.md' as VaultPath, expect: 'absent', bytes: new Uint8Array() }],
    })).rejects.toThrow('distinct');
  });
});
