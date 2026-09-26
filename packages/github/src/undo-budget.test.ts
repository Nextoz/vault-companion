// ADR-0013 request budget: one Undo attempt against the GitHub adapter makes ≤ 10 API calls and no paged search.
// The fake API serves files produced by a real completion (kernel + in-memory Git), in the recorded response shapes.
import { createCommandService, payloadHash, TRAILER_OP, TRAILER_PAYLOAD, UNDO_MAX_ATTEMPTS } from '@vault-companion/domain';
import { gitBlobSha, InMemoryStore } from '@vault-companion/domain/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { createInstallationTokenSource } from './app-token.ts';
import { GitHubContentsStore } from './contents-store.ts';

const TODO = 'Tasks/To-Do List.md';
const NOW = new Date('2026-09-24T12:00:00Z');
const TZ = 'Europe/Copenhagen';
const ORIGINAL = '## Open\n\n- [ ] Water the plants #todo\n\n## Done\n';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const sha = (c: string) => c.repeat(40);

async function completed() {
  const mem = await InMemoryStore.create({ [TODO]: ORIGINAL });
  const svc = createCommandService({ store: mem, now: () => NOW, timeZone: TZ });
  const open = await svc.readTasks([]);
  if ('code' in open) throw new Error(open.code);
  const raw = {
    schemaVersion: 1,
    operationId: '00000000-0000-4000-8000-00000000000a',
    type: 'CompleteTask',
    occurredAt: '2026-09-24T14:00:00+02:00',
    baseRevision: open.revision,
    payload: { task: open.allOpen[0]!.locator },
  };
  const receipt = await svc.execute(raw as never, raw);
  if ('code' in receipt) throw new Error(receipt.code);
  const c = receipt.commitSha;
  return { raw, c, parent: await mem.parentOf(c), done: mem.text(TODO, c)!, hash: await payloadHash(raw) };
}

/** `commitsAfterC`: unrelated desktop commits between the completion C and head X (they leave the task list alone). */
function fakeGitHub(
  k: Awaited<ReturnType<typeof completed>>,
  commitsAfterC: number,
  refStatus = 200,
  /** Replace the compare answer (commits listed after C). */
  compare?: (x: string) => Response,
  /** Token source built on the same fake API (default: a constant token, no auth requests). */
  tokenSource?: (f: typeof globalThis.fetch) => () => Promise<string>,
) {
  const x = commitsAfterC === 0 ? k.c : sha('d');
  const calls: string[] = [];
  const blobs: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const u = url.replace('https://api.github.com/repos/o/r', '');
    const m = init.method ?? 'GET';
    calls.push(`${m} ${u}`);
    if (m === 'POST' && u.endsWith('/app/installations/1/access_tokens')) {
      return json(201, { token: 'ghs_synthetic', expires_at: new Date(NOW.getTime() + 3_600_000).toISOString() });
    }
    if (m === 'GET' && u === '/git/ref/heads/main') return json(200, { object: { sha: x } });
    if (m === 'GET' && u === `/commits/${k.c}`) {
      return json(200, {
        sha: k.c,
        parents: [{ sha: k.parent }],
        commit: { message: `Vault Companion: complete task\n\n${TRAILER_OP}: ${k.raw.operationId}\n${TRAILER_PAYLOAD}: ${k.hash}\n`, tree: { sha: sha('7') } },
        files: [{ filename: TODO, sha: await gitBlobSha(new TextEncoder().encode(k.done)), status: 'modified' }],
      });
    }
    if (m === 'GET' && u.startsWith(`/compare/${k.c}...${x}?`)) {
      if (compare) return compare(x);
      const commits = Array.from({ length: commitsAfterC }, (_, i) => ({
        sha: i === commitsAfterC - 1 ? x : sha(String(i)),
        commit: { message: 'desktop edit', tree: { sha: sha('e') } },
      }));
      return json(200, { status: commitsAfterC === 0 ? 'identical' : 'ahead', total_commits: commitsAfterC, commits });
    }
    if (m === 'GET' && u.startsWith('/contents/')) {
      const ref = new URL(`https://h${u}`).searchParams.get('ref');
      const text = ref === k.parent ? ORIGINAL : k.done; // C and X hold the completed list
      return json(200, { type: 'file', sha: await gitBlobSha(new TextEncoder().encode(text)), size: text.length, encoding: 'base64', content: b64(text) });
    }
    if (m === 'GET' && u.startsWith('/git/trees/')) return json(200, { truncated: false, tree: [{ path: 'To-Do List.md', mode: '100644', type: 'blob' }] });
    if (m === 'POST' && u === '/git/blobs') {
      blobs.push(JSON.parse(init.body as string).content);
      return json(201, { sha: sha('b') });
    }
    if (m === 'POST' && u === '/git/trees') return json(201, { sha: sha('f') });
    if (m === 'POST' && u === '/git/commits') return json(201, { sha: sha('9') });
    if (m === 'PATCH') return json(refStatus, {});
    return json(500, { unexpected: `${m} ${u}` });
  }) as unknown as typeof globalThis.fetch;
  const store = new GitHubContentsStore({ owner: 'o', repo: 'r', token: tokenSource ? tokenSource(fetch) : async () => 't', fetch });
  return { store, calls, blobs };
}

const undoOf = (k: Awaited<ReturnType<typeof completed>>) => ({
  schemaVersion: 1,
  operationId: '00000000-0000-4000-8000-00000000000e',
  type: 'UndoCompleteTask',
  occurredAt: '2026-09-24T14:01:00+02:00',
  baseRevision: k.c,
  payload: { target: k.raw, targetCommit: k.c },
});

describe('GitHub commitsSince guards through a full Undo (review P4E-Astra #4)', () => {
  const listed = (n: number, x: string) =>
    Array.from({ length: n }, (_, i) => ({ sha: i === n - 1 ? x : sha(String(i % 10)), commit: { message: 'desktop edit', tree: { sha: sha('e') } } }));
  it.each([
    // X holds exactly C's completed bytes, so only the ancestry guard stands between the token and a write.
    ['diverged, matching bytes at X', () => json(200, { status: 'diverged', total_commits: 1, commits: listed(1, sha('d')) }), 'conflict:task-changed'],
    ['behind', () => json(200, { status: 'behind', total_commits: 0, commits: [] }), 'conflict:task-changed'],
    ['404', () => json(404, { message: 'Not Found' }), 'conflict:task-changed'],
    ['422', () => json(422, { message: 'No common ancestor' }), 'conflict:task-changed'],
    ['251 total, 250 returned (the real overflow shape)', () => json(200, { status: 'ahead', total_commits: 251, commits: listed(250, sha('d')) }), 'refused:undo-expired'],
    ['short page below the limit (2 total, 1 returned)', () => json(200, { status: 'ahead', total_commits: 2, commits: listed(1, sha('d')) }), 'refused:undo-expired'],
  ] as const)('%s ⇒ typed refusal, one compare, no writes', async (_name, answer, code) => {
    const k = await completed();
    const { store, calls } = fakeGitHub(k, 1, 200, answer);
    const svc = createCommandService({ store, now: () => NOW, timeZone: TZ });
    const undo = undoOf(k);
    expect(await svc.execute(undo as never, undo)).toMatchObject({ code, retryable: false });
    expect(calls.filter((c) => c.startsWith('GET /compare/'))).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('POST') || c.startsWith('PATCH'))).toBe(false);
  });
});

describe('Undo request budget (ADR-0013)', () => {
  it.each([0, 1, 250])('one attempt with %i commits since the completion: ≤ 10 GitHub calls, one compare page', async (after) => {
    const k = await completed();
    const { store, calls, blobs } = fakeGitHub(k, after);
    const svc = createCommandService({ store, now: () => NOW, timeZone: TZ });
    const undo = { schemaVersion: 1, operationId: '00000000-0000-4000-8000-00000000000b', type: 'UndoCompleteTask', occurredAt: '2026-09-24T14:01:00+02:00', baseRevision: k.c, payload: { target: k.raw, targetCommit: k.c } };
    const r = await svc.execute(undo as never, undo);
    expect(r).toMatchObject({ status: 'applied', effect: { kind: 'reopened' } });
    expect(calls.length).toBeLessThanOrEqual(10);
    expect(calls.filter((c) => c.startsWith('GET /compare/'))).toEqual([`GET /compare/${k.c}...${after === 0 ? k.c : sha('d')}?per_page=250&page=1`]);
    expect(calls.some((c) => c.startsWith('GET /git/commits/'))).toBe(false); // the base tree came from the compare/commit
    expect(atob(blobs[0]!)).toBe(ORIGINAL); // exact inverse
  });

  it('beyond one page: refused:undo-expired after one compare, nothing written', async () => {
    const k = await completed();
    const { store, calls } = fakeGitHub(k, 251);
    const svc = createCommandService({ store, now: () => NOW, timeZone: TZ });
    const undo = { schemaVersion: 1, operationId: '00000000-0000-4000-8000-00000000000c', type: 'UndoCompleteTask', occurredAt: '2026-09-24T14:01:00+02:00', baseRevision: k.c, payload: { target: k.raw, targetCommit: k.c } };
    expect(await svc.execute(undo as never, undo)).toMatchObject({ code: 'refused:undo-expired' });
    expect(calls.filter((c) => c.startsWith('GET /compare/'))).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('POST') || c.startsWith('PATCH'))).toBe(false);
  });

  it(`a head that keeps moving: at most ${UNDO_MAX_ATTEMPTS} attempts, ≤ 10 calls each`, async () => {
    const k = await completed();
    const { store, calls } = fakeGitHub(k, 1, 422); // every ref update: not a fast forward
    const svc = createCommandService({ store, now: () => NOW, timeZone: TZ });
    const undo = { schemaVersion: 1, operationId: '00000000-0000-4000-8000-00000000000d', type: 'UndoCompleteTask', occurredAt: '2026-09-24T14:01:00+02:00', baseRevision: k.c, payload: { target: k.raw, targetCommit: k.c } };
    expect(await svc.execute(undo as never, undo)).toMatchObject({ code: 'conflict:stale' });
    expect(UNDO_MAX_ATTEMPTS).toBe(3);
    expect(calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(UNDO_MAX_ATTEMPTS);
    expect(calls.length).toBeLessThanOrEqual(10 * UNDO_MAX_ATTEMPTS);
  });
});


describe('Undo request budget with authentication (review P4E-Astra #5)', () => {
  // The budget is 10 store requests per attempt, plus token/authentication overhead: a cold installation token costs
  // one more request, once per token lifetime (cached until 5 minutes before expiry).
  const realTokens = async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(privateKey);
    return (f: typeof globalThis.fetch) =>
      createInstallationTokenSource({ appId: '1', privateKeyPem, installationId: '1', fetch: f, now: () => NOW.getTime() });
  };
  const auth = (calls: string[]) => calls.filter((c) => c.endsWith('/access_tokens'));

  it('cold token: one Undo attempt = 10 store requests + 1 token request; a second Undo reuses the token', async () => {
    const k = await completed();
    const { store, calls } = fakeGitHub(k, 1, 200, undefined, await realTokens());
    const svc = createCommandService({ store, now: () => NOW, timeZone: TZ });
    const undo = undoOf(k);
    expect(await svc.execute(undo as never, undo)).toMatchObject({ status: 'applied' });
    expect(auth(calls)).toHaveLength(1);
    expect(calls.length - auth(calls).length).toBe(10);
    expect(calls).toHaveLength(11);

    calls.length = 0; // warm: a second Undo attempt (this fixture re-plans and writes again) reuses the cached token — no token request
    await svc.execute(undo as never, undo);
    expect(auth(calls)).toHaveLength(0);
  });

  it(`cold token, head keeps moving: ${UNDO_MAX_ATTEMPTS} attempts × ≤ 10 store requests + 1 token request`, async () => {
    const k = await completed();
    const { store, calls } = fakeGitHub(k, 1, 422, undefined, await realTokens());
    const svc = createCommandService({ store, now: () => NOW, timeZone: TZ });
    const undo = undoOf(k);
    expect(await svc.execute(undo as never, undo)).toMatchObject({ code: 'conflict:stale' });
    expect(auth(calls)).toHaveLength(1);
    expect(calls.length - auth(calls).length).toBeLessThanOrEqual(10 * UNDO_MAX_ATTEMPTS);
    expect(calls.length).toBeLessThanOrEqual(10 * UNDO_MAX_ATTEMPTS + 1);
  });
});
