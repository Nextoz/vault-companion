// Adapter tests against a fake fetch replaying response bodies recorded from the real API
// (docs/discovery/github-api-probe-2026-09-24.md, github-gitdata-probe-2026-09-25.md).
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultPath } from '@vault-companion/domain';
import { describe, expect, it } from 'vitest';
import { GitHubContentsStore, parseTrailers } from './contents-store.ts';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function store(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const s = new GitHubContentsStore({
    owner: 'o',
    repo: 'r',
    token: async () => 'tkn',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch,
  });
  return { s, calls };
}

const SHA = (c: string) => c.repeat(40);

describe('GitHubContentsStore', () => {
  it('decodes base64 with embedded newlines exactly (captured shape) and pins the read to a commit', async () => {
    // Captured from octocat/Hello-World README: "SGVsbG8gV29ybGQhCg==\n"
    const { s, calls } = store(() => json(200, { type: 'file', sha: '980a0d5f19a64b4b30a87d4206aade58726b60e3', size: 13, encoding: 'base64', content: 'SGVsbG8gV29y\nbGQhCg==\n' }));
    const f = await s.readFile('Tasks/To-Do List.md' as VaultPath, SHA('a'));
    expect(new TextDecoder().decode(f!.bytes)).toBe('Hello World!\n');
    expect(f!.blobSha).toBe('980a0d5f19a64b4b30a87d4206aade58726b60e3');
    expect(calls[0]!.url).toBe(`https://api.github.com/repos/o/r/contents/Tasks/To-Do%20List.md?ref=${SHA('a')}`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tkn');
  });

  it('refuses files over 1 MB instead of parsing empty content', async () => {
    const { s } = store(() => json(200, { type: 'file', sha: SHA('b'), size: 2_000_000, encoding: 'none', content: '' }));
    await expect(s.readFile('Tasks/To-Do List.md' as VaultPath, SHA('a'))).rejects.toBeInstanceOf(FileTooLarge);
  });

  // Recorded shapes: docs/discovery/github-gitdata-probe-2026-09-25.md (Q1–Q6).
  function gitData(refStatus: number | 'throw', refBody: unknown = {}) {
    return store((url, init) => {
      const m = init.method ?? 'GET';
      if (m === 'GET' && url.includes('/git/commits/')) return json(200, { sha: SHA('a'), tree: { sha: SHA('7') } });
      if (m === 'POST' && url.endsWith('/git/blobs')) return json(201, { sha: SHA('b') });
      if (m === 'POST' && url.endsWith('/git/trees')) return json(201, { sha: SHA('e') });
      if (m === 'POST' && url.endsWith('/git/commits')) return json(201, { sha: SHA('c') });
      if (m === 'PATCH') {
        if (refStatus === 'throw') throw new TypeError('network connection lost');
        return json(refStatus, refBody);
      }
      return json(500, {});
    });
  }
  const req = {
    path: 'Tasks/To-Do List.md' as VaultPath,
    baseCommit: SHA('a'),
    bytes: new TextEncoder().encode('æ'),
    message: 'Vault Companion: complete task',
    trailers: { 'Vault-Companion-Op': 'op', 'Vault-Companion-Payload': 'sha256:h' },
  };

  it('head-CAS write: blob, tree on the base tree, commit parented on the base, non-force ref update', async () => {
    const { s, calls } = gitData(200, { object: { sha: SHA('c') } });
    expect(await s.writeFile(req)).toEqual({ ok: true, commitSha: SHA('c'), blobSha: SHA('b') });
    const bodies = calls.filter((c) => c.init.body).map((c) => [c.init.method, c.url.replace('https://api.github.com/repos/o/r', ''), JSON.parse(c.init.body as string)]);
    expect(bodies).toEqual([
      ['POST', '/git/blobs', { content: 'w6Y=', encoding: 'base64' }],
      ['POST', '/git/trees', { base_tree: SHA('7'), tree: [{ path: 'Tasks/To-Do List.md', mode: '100644', type: 'blob', sha: SHA('b') }] }],
      ['POST', '/git/commits', { message: 'Vault Companion: complete task\n\nVault-Companion-Op: op\nVault-Companion-Payload: sha256:h\n', tree: SHA('e'), parents: [SHA('a')] }],
      ['PATCH', '/git/refs/heads/main', { sha: SHA('c'), force: false }],
    ]);
  });

  it('maps the recorded 422 "Update is not a fast forward" to head-moved (A2 ABA rejection)', async () => {
    const { s } = gitData(422, { message: 'Update is not a fast forward', status: '422' });
    expect(await s.writeFile(req)).toEqual({ ok: false, reason: 'head-moved' });
  });

  it('a lost or 5xx ref update is an unknown outcome; a failure before the ref update is only unavailable', async () => {
    await expect(gitData('throw').s.writeFile(req)).rejects.toBeInstanceOf(StoreUnknownOutcome);
    await expect(gitData(502).s.writeFile(req)).rejects.toBeInstanceOf(StoreUnknownOutcome);
    const early = store((url, init) => {
      if ((init.method ?? 'GET') === 'GET') return json(200, { tree: { sha: SHA('7') } });
      throw new TypeError('network connection lost'); // blob creation never reached GitHub
    }).s;
    await expect(early.writeFile(req)).rejects.toBeInstanceOf(StoreUnavailable);
  });

  it('findOperation pages the compare API oldest-first until total_commits are seen (R9)', async () => {
    const commit = (sha: string, op: string) => ({ sha, commit: { message: `m\n\nVault-Companion-Op: ${op}\nVault-Companion-Payload: sha256:${op}` } });
    const page1 = Array.from({ length: 250 }, (_, i) => commit(SHA('1'), `x${i}`));
    const { s, calls } = store((url) => {
      if (url.includes('page=1')) return json(200, { status: 'ahead', total_commits: 251, commits: page1 });
      if (url.includes('page=2')) return json(200, { status: 'ahead', total_commits: 251, commits: [commit(SHA('2'), 'late-op')] });
      return json(200, { files: [{ filename: 'Tasks/To-Do List.md' }] });
    });
    expect(await s.findOperation(SHA('0'), SHA('2'), 'late-op')).toMatchObject({ kind: 'found', op: { commitSha: SHA('2') } });
    expect(calls.map((c) => c.url).filter((u) => u.includes('/compare/'))).toEqual([
      `https://api.github.com/repos/o/r/compare/${SHA('0')}...${SHA('2')}?per_page=250&page=1`,
      `https://api.github.com/repos/o/r/compare/${SHA('0')}...${SHA('2')}?per_page=250&page=2`,
    ]);
    const notFound = store(() => json(200, { status: 'ahead', total_commits: 1, commits: [commit(SHA('3'), 'other')] })).s;
    expect(await notFound.findOperation(SHA('0'), SHA('3'), 'nope')).toEqual({ kind: 'not-found' });
    const behind = store(() => json(200, { status: 'behind', total_commits: 0, commits: [] })).s;
    expect((await behind.findOperation(SHA('0'), SHA('2'), 'nope')).kind).toBe('unknown');
    const missing = store(() => json(404, {})).s;
    expect((await missing.findOperation(SHA('0'), SHA('2'), 'nope')).kind).toBe('unknown');
  });

  it('lists a directory through the trees API at a commit and refuses a truncated listing (R8)', async () => {
    const { s, calls } = store(() => json(200, { truncated: false, tree: [{ path: 'Note 1 - 2026-09-25.md', type: 'blob' }, { path: 'sub', type: 'tree' }] }));
    expect(await s.listDir('Inbox', SHA('a'))).toEqual(['Note 1 - 2026-09-25.md']);
    expect(calls[0]!.url).toBe(`https://api.github.com/repos/o/r/git/trees/${SHA('a')}:Inbox`);
    const cut = store(() => json(200, { truncated: true, tree: [] })).s;
    await expect(cut.listDir('Inbox', SHA('a'))).rejects.toBeInstanceOf(FileTooLarge);
  });

  it('rejects an unsafe path before any request is made (A8/R5)', async () => {
    const { s, calls } = gitData(200);
    await expect(s.writeFile({ ...req, path: '../../issues' as VaultPath })).rejects.toThrow('unsafe vault path');
    await expect(s.readFile('Tasks/../../x.md' as VaultPath, SHA('a'))).rejects.toThrow('unsafe vault path');
    expect(calls).toHaveLength(0);
  });

  it('parseTrailers only reads a final Key: value paragraph', () => {
    expect(parseTrailers('subj\n\nbody text\n\nA-B: 1\nC: two')).toEqual({ 'A-B': '1', C: 'two' });
    expect(parseTrailers('subj\n\nVault-Companion-Op: x\nnot a trailer')).toEqual({});
    expect(parseTrailers('Vault-Companion-Op: x')).toEqual({});
  });
});
