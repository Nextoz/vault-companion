// Adapter tests against a fake fetch replaying response bodies recorded from the real API
// (docs/discovery/github-api-probe-2026-09-24.md).
import { FileTooLarge, StoreUnknownOutcome, type VaultPath } from '@vault-companion/domain';
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

  it('PUT sends base64 content, branch, sha and trailers; maps recorded 409/422 bodies', async () => {
    const results = [
      json(409, { message: 'Inbox/n.md does not match cccccccccccccccccccccccccccccccccccccccc', status: '409' }),
      json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.', status: '422' }),
      json(409, { message: 'is at c30497f6265d5437fd32a384079d1cafe5938a3b but expected 05b9ce4ee3ce265bf32057041889dd18bc0fcfdc' }),
    ];
    const { s, calls } = store(() => results.shift()!);
    const req = { path: 'Inbox/n.md' as VaultPath, bytes: new TextEncoder().encode('æ\n'), message: 'Vault Companion: capture note', trailers: { 'Vault-Companion-Op': 'op', 'Vault-Companion-Payload': 'sha256:h' } };
    expect(await s.writeFile({ ...req, expectedBlobSha: SHA('c') })).toEqual({ ok: false, reason: 'cas-mismatch' });
    expect(await s.writeFile({ ...req, expectedBlobSha: null })).toEqual({ ok: false, reason: 'exists' });
    // Ref race on a different file (G1 P12): not applied, must re-dedupe like a CAS loss.
    expect(await s.writeFile({ ...req, expectedBlobSha: null })).toEqual({ ok: false, reason: 'cas-mismatch' });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ message: 'Vault Companion: capture note\n\nVault-Companion-Op: op\nVault-Companion-Payload: sha256:h\n', content: 'w6YK', branch: 'main', sha: SHA('c') });
    expect(JSON.parse(calls[1]!.init.body as string).sha).toBeUndefined();
  });

  it('a PUT whose response is lost or 5xx is an unknown outcome, never a failure', async () => {
    const lost = store(() => {
      throw new TypeError('network connection lost');
    }).s;
    await expect(lost.writeFile({ path: 'Inbox/n.md' as VaultPath, expectedBlobSha: null, bytes: new Uint8Array(), message: 'm', trailers: {} })).rejects.toBeInstanceOf(StoreUnknownOutcome);
    const five = store(() => json(502, {})).s;
    await expect(five.writeFile({ path: 'Inbox/n.md' as VaultPath, expectedBlobSha: null, bytes: new Uint8Array(), message: 'm', trailers: {} })).rejects.toBeInstanceOf(StoreUnknownOutcome);
  });

  it('findOperation: found via trailers, unknown when truncated or not an ancestor', async () => {
    const commit = (sha: string, op: string) => ({ sha, commit: { message: `Vault Companion: complete task\n\nVault-Companion-Op: ${op}\nVault-Companion-Payload: sha256:${op}` } });
    const { s } = store((url) => {
      if (url.includes('/compare/')) return json(200, { status: 'ahead', total_commits: 2, commits: [commit(SHA('1'), 'x'), commit(SHA('2'), 'op-9')] });
      return json(200, { files: [{ filename: 'Tasks/To-Do List.md' }] });
    });
    expect(await s.findOperation(SHA('0'), SHA('2'), 'op-9')).toEqual({ kind: 'found', op: { commitSha: SHA('2'), payloadHash: 'sha256:op-9', paths: ['Tasks/To-Do List.md'] } });
    expect(await s.findOperation(SHA('0'), SHA('2'), 'nope')).toEqual({ kind: 'not-found' });
    const trunc = store(() => json(200, { status: 'ahead', total_commits: 300, commits: [] })).s;
    expect((await trunc.findOperation(SHA('0'), SHA('2'), 'nope')).kind).toBe('unknown');
    const div = store(() => json(200, { status: 'diverged', total_commits: 1, commits: [] })).s;
    expect((await div.findOperation(SHA('0'), SHA('2'), 'nope')).kind).toBe('unknown');
    const missing = store(() => json(404, {})).s;
    expect((await missing.findOperation(SHA('0'), SHA('2'), 'nope')).kind).toBe('unknown');
  });

  it('parseTrailers only reads a final Key: value paragraph', () => {
    expect(parseTrailers('subj\n\nbody text\n\nA-B: 1\nC: two')).toEqual({ 'A-B': '1', C: 'two' });
    expect(parseTrailers('subj\n\nVault-Companion-Op: x\nnot a trailer')).toEqual({});
    expect(parseTrailers('Vault-Companion-Op: x')).toEqual({});
  });
});
