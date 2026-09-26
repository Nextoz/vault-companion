// ADR-0015: every write command fits Workers Free's 50 subrequests per invocation in its worst case — a full dedupe
// page (250 commits since baseRevision), every attempt losing the ref race (3 attempts), a cold installation token and
// a cold Access JWKS fetch. Real service, adapter and token source; synthetic GitHub responses in the recorded shapes.
import { createCommandService, gitBlobSha, MAX_ATTEMPTS, payloadHash, TRAILER_OP, TRAILER_PAYLOAD } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { createInstallationTokenSource } from './app-token.ts';
import { GitHubContentsStore } from './contents-store.ts';

const NOW = new Date('2026-09-24T12:00:00Z');
const TODO = '## Open\n\n- [ ] Water the plants #todo\n\n## Done\n';
const WORKERS_FREE = 50;
/** The Worker verifies the Access JWT against a remotely fetched JWKS: one subrequest when that cache is cold. */
const JWKS = 1;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const hex = (n: number) => n.toString(16).padStart(40, '0');
const BASE = hex(1);
const X = hex(251); // 250 commits since BASE: one full page, the most a dedupe may read (ADR-0015)

interface Options {
  inbox: boolean;
  /** Ref update answer: 422 = another commit landed first (head-moved). */
  refStatus: number;
  /** The command's own commit already in the window, as after a lost response. */
  appliedAs?: { operationId: string; payloadHash: string; bytes: string };
}

async function fakeGitHub(o: Options) {
  const calls: string[] = [];
  const todoBlob = await gitBlobSha(new TextEncoder().encode(TODO));
  // Worst case: the head moves on every attempt (another commit won each ref race), so nothing cached for one head
  // helps the next. Head n is hex(248 + n), so every window still fits one page; each compare lists the 250 commits up to the head it was asked about.
  let heads = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const m = init.method ?? 'GET';
    const u = url.replace('https://api.github.com/repos/o/r', '');
    calls.push(`${m} ${u}`);
    if (m === 'POST' && u.endsWith('/access_tokens')) return json(201, { token: 'ghs_synthetic', expires_at: new Date(NOW.getTime() + 3_600_000).toISOString() });
    if (u === '/git/ref/heads/main') return json(200, { object: { sha: o.appliedAs ? X : hex(248 + ++heads) } });
    const cmp = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})\?per_page=250&page=1$/.exec(u);
    if (cmp && cmp[1] === BASE) {
      const head = parseInt(cmp[2]!, 16);
      if (head - 1 > 250) return json(200, { status: 'ahead', total_commits: head - 1, commits: [] });
      const commits = Array.from({ length: head - 1 }, (_, i) => {
        const sha = hex(i + 2);
        const own = o.appliedAs && sha === X;
        return {
          sha,
          commit: {
            message: own ? `Vault Companion\n\n${TRAILER_OP}: ${o.appliedAs!.operationId}\n${TRAILER_PAYLOAD}: ${o.appliedAs!.payloadHash}\n` : 'desktop edit',
            tree: { sha: '7'.repeat(40) },
          },
        };
      });
      return json(200, { status: 'ahead', total_commits: commits.length, commits });
    }
    if (u.startsWith('/compare/')) return json(200, { status: 'ahead', total_commits: 251, commits: [] });
    if (u === `/commits/${X}`) {
      return json(200, { sha: X, parents: [{ sha: hex(250) }], commit: { message: 'x', tree: { sha: '7'.repeat(40) } }, files: [{ filename: 'Tasks/To-Do List.md', sha: todoBlob, status: 'modified' }] });
    }
    if (u.startsWith('/contents/Tasks/')) {
      const text = o.appliedAs && u.endsWith(`ref=${X}`) ? o.appliedAs.bytes : TODO;
      const sha = await gitBlobSha(new TextEncoder().encode(text));
      return json(200, { type: 'file', sha, size: text.length, encoding: 'base64', content: btoa(String.fromCharCode(...new TextEncoder().encode(text))) });
    }
    if (u.startsWith('/contents/')) return json(200, { type: 'file', sha: '5'.repeat(40), size: 2, encoding: 'base64', content: btoa('x\n') });
    if (/^\/git\/trees\/[0-9a-f]{40}:Tasks$/.test(u)) return json(200, { sha: '6'.repeat(40), truncated: false, tree: [{ path: 'To-Do List.md', mode: '100644', type: 'blob' }] });
    if (/^\/git\/trees\/[0-9a-f]{40}:Inbox$/.test(u)) {
      return o.inbox ? json(200, { sha: '8'.repeat(40), truncated: false, tree: [{ path: 'Older - 2026-09-01.md', mode: '100644', type: 'blob' }] }) : json(404, { message: 'Not Found' });
    }
    if (/^\/git\/trees\/[0-9a-f]{40}$/.test(u)) {
      const tree = [{ path: 'Tasks', mode: '040000', type: 'tree' }, ...(o.inbox ? [{ path: 'Inbox', mode: '040000', type: 'tree' }] : [])];
      return json(200, { sha: '7'.repeat(40), truncated: false, tree });
    }
    if (m === 'GET' && u.startsWith('/git/commits/')) return json(200, { sha: X, tree: { sha: '7'.repeat(40) }, parents: [{ sha: hex(250) }] });
    if (m === 'POST' && u === '/git/blobs') return json(201, { sha: 'b'.repeat(40) });
    if (m === 'POST' && u === '/git/trees') return json(201, { sha: 'c'.repeat(40) });
    if (m === 'POST' && u === '/git/commits') return json(201, { sha: 'd'.repeat(40) });
    if (m === 'PATCH') return json(o.refStatus, {});
    return json(500, { unexpected: `${m} ${u}` });
  }) as unknown as typeof globalThis.fetch;
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const token = createInstallationTokenSource({ appId: '1', privateKeyPem: await exportPKCS8(privateKey), installationId: '1', fetch, now: () => NOW.getTime() });
  const store = new GitHubContentsStore({ owner: 'o', repo: 'r', token, fetch });
  return { svc: createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' }), calls, todoBlob };
}

const envelope = (type: string, payload: unknown, operationId = '00000000-0000-4000-8000-0000000000aa') => ({
  schemaVersion: 1,
  operationId,
  type,
  occurredAt: '2026-09-24T14:00:00+02:00',
  baseRevision: BASE,
  payload,
});

async function commands(todoBlob: string) {
  return {
    CompleteTask: envelope('CompleteTask', {
      task: { path: 'Tasks/To-Do List.md', blobSha: todoBlob, lineIndex: 2, lineText: '- [ ] Water the plants #todo', occurrencesAtRead: 1 },
    }),
    CaptureTask: envelope('CaptureTask', { text: 'Buy stamps' }),
    CaptureNote: envelope('CaptureNote', { text: 'A synthetic thought' }),
  } as const;
}

describe('write request budget on Workers Free (ADR-0015)', () => {
  it.each([
    ['CompleteTask', true],
    ['CaptureTask', true],
    ['CaptureNote', true],
    ['CaptureNote', false], // absent Inbox: Astra measured 56 before ADR-0015
  ] as const)('%s (Inbox present: %s): 3 head-moved attempts + cold token + JWKS ≤ 50', async (type, inbox) => {
    const { svc, calls, todoBlob } = await fakeGitHub({ inbox, refStatus: 422 });
    const cmd = (await commands(todoBlob))[type];
    expect(await svc.execute(cmd as never, cmd)).toMatchObject({ code: 'conflict:stale' });
    expect(calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(MAX_ATTEMPTS);
    expect(calls.filter((c) => c.startsWith('GET /compare/'))).toHaveLength(MAX_ATTEMPTS); // one page per attempt
    expect(calls.filter((c) => c.endsWith('/access_tokens'))).toHaveLength(1);
    expect(calls.length + JWKS).toBeLessThanOrEqual(WORKERS_FREE);
    // Per attempt: ref, compare, one listing or read, precondition from the same listing, blob/tree/commit/ref = 8.
    expect((calls.length - 1) / MAX_ATTEMPTS).toBeLessThanOrEqual(8);
    const trees = calls.filter((c) => c.startsWith('GET /git/trees/'));
    expect(new Set(trees).size).toBe(trees.length); // no tree listed twice for the same commit
    expect(calls.some((c) => c.startsWith('GET /git/commits/'))).toBe(false); // base tree reused from compare/root
  });

  it.each(['CompleteTask', 'CaptureTask'] as const)('%s already applied (lost response), found on the full page: already-applied within budget', async (type) => {
    const { todoBlob } = await fakeGitHub({ inbox: true, refStatus: 200 });
    const cmd = (await commands(todoBlob))[type];
    const { svc, calls } = await fakeGitHub({
      inbox: true,
      refStatus: 422,
      appliedAs: { operationId: cmd.operationId, payloadHash: await payloadHash(cmd), bytes: await producedBytes(cmd) },
    });
    expect(await svc.execute(cmd as never, cmd)).toMatchObject({ status: 'already-applied', commitSha: X });
    expect(calls.some((c) => c.startsWith('PATCH'))).toBe(false);
    expect(calls.length + JWKS).toBeLessThanOrEqual(WORKERS_FREE);
  });

  it('more than one page since baseRevision: typed dedupe-unknown after one compare, nothing written', async () => {
    const { svc, calls, todoBlob } = await fakeGitHub({ inbox: true, refStatus: 200 });
    const cmd = { ...(await commands(todoBlob)).CaptureTask, baseRevision: hex(999) }; // compare answers 251 total
    expect(await svc.execute(cmd as never, cmd)).toMatchObject({ code: 'dedupe-unknown', message: 'this may already be applied — check Obsidian' });
    expect(calls.filter((c) => c.startsWith('GET /compare/'))).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('PATCH') || c === 'POST /git/blobs')).toBe(false);
  });
});

/** The exact task list the command produces from TODO (the real kernel, via the in-memory store). */
async function producedBytes(cmd: { operationId: string }): Promise<string> {
  const mem = await InMemoryStore.create({ 'Tasks/To-Do List.md': TODO });
  const svc = createCommandService({ store: mem, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  const raw = { ...cmd, baseRevision: mem.headCommit };
  const r = await svc.execute(raw as never, raw);
  if (!('effect' in r)) throw new Error(`did not apply: ${r.code}`);
  return mem.text('Tasks/To-Do List.md')!;
}
