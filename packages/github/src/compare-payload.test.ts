import { StoreUnavailable } from '@vault-companion/domain';
import { describe, expect, it } from 'vitest';
import { GitHubContentsStore } from './contents-store.ts';

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const commit = (sha: string) => ({
  sha,
  commit: { message: 'Synthetic desktop edit', tree: { sha: '3'.repeat(40) } },
  parents: [{ sha: BASE }],
});

// Projected recorded page-2 shapes: public octocat/Hello-World probe, 2026-09-26 (ADR-0016).
// SHAs/messages are synthetic; unused URL, author and verification metadata omitted.
// Diverged is a synthetic status variant, not a live recorded case.
const cases = [
  { status: 'identical', ahead_by: 0, behind_by: 0, total_commits: 0, commits: [], expected: true },
  { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [], expected: true },
  { status: 'ahead', ahead_by: 2, behind_by: 0, total_commits: 2, commits: [commit(HEAD)], expected: true },
  { status: 'behind', ahead_by: 0, behind_by: 2, total_commits: 0, commits: [], expected: false },
  { status: 'diverged', ahead_by: 1, behind_by: 1, total_commits: 1, commits: [], expected: false },
];

function adapter(bodyFor: (url: URL) => unknown, status = 200) {
  const calls: string[] = [];
  const parsedBytes: number[] = [];
  const store = new GitHubContentsStore({
    owner: 'o', repo: 'r', token: async () => 'synthetic-token',
    fetch: (async (input: string) => {
      calls.push(input);
      const body = JSON.stringify(bodyFor(new URL(input)));
      const response = new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
      const parse = response.json.bind(response);
      response.json = async () => {
        parsedBytes.push(new TextEncoder().encode(body).byteLength);
        return parse();
      };
      return response;
    }) as typeof fetch,
  });
  return { store, calls, parsedBytes };
}

describe('O7 compare payload', () => {
  it.each(cases)('page 2 preserves $status ancestry with $total_commits commits', async ({ expected, ...body }) => {
    const { store, calls } = adapter(() => ({ ...body, base_commit: commit(BASE), merge_base_commit: commit(BASE) }));
    expect(await store.isAncestor(BASE, body.status === 'identical' ? BASE : HEAD)).toBe(expected);
    expect(calls).toEqual([
      `https://api.github.com/repos/o/r/compare/${BASE}...${body.status === 'identical' ? BASE : HEAD}?per_page=1&page=2`,
    ]);
  });

  it.each([404, 422, 403, 500, 503])('preserves HTTP %i handling in one request', async (status) => {
    const { store, calls } = adapter(() => ({ message: 'Synthetic upstream error' }), status);
    if (status === 404) expect(await store.isAncestor(BASE, HEAD)).toBe(false);
    else await expect(store.isAncestor(BASE, HEAD)).rejects.toBeInstanceOf(StoreUnavailable);
    expect(calls).toHaveLength(1);
  });

  it('reports parsed UTF-8 response bytes before/after for a synthetic 50-file range', async () => {
    const metadata = {
      status: 'ahead', ahead_by: 2, behind_by: 0, total_commits: 2,
      base_commit: commit(BASE), merge_base_commit: commit(BASE),
    };
    const files = Array.from({ length: 50 }, (_, i) => ({
      sha: '4'.repeat(40), filename: `Notes/Synthetic-${i}.md`, status: 'modified',
      additions: 100, deletions: 100, changes: 200,
      patch: '@@ -1,100 +1,100 @@\n' + '-Synthetic old line æøå\n+Synthetic new line æøå\n'.repeat(100),
    }));
    const page1 = { ...metadata, commits: [commit('5'.repeat(40))], files };
    const page2 = { ...metadata, commits: [commit(HEAD)] };
    const replay = (url: URL) => url.searchParams.get('page') === '2' ? page2 : page1;
    const after = adapter(replay);
    // Parse the former response body as a baseline; instrument the real adapter's selected response below.
    const previousResponse = new Response(JSON.stringify(page1));
    expect((await previousResponse.json()).status).toBe('ahead');
    const beforeBytes = new TextEncoder().encode(JSON.stringify(page1)).byteLength;
    expect(await after.store.isAncestor(BASE, HEAD)).toBe(true);
    const afterBytes = after.parsedBytes[0]!;
    expect(after.calls).toHaveLength(1);
    expect(afterBytes).toBe(new TextEncoder().encode(JSON.stringify(page2)).byteLength);
    expect(afterBytes).toBeLessThan(beforeBytes / 100);

    // The hot read/dedupe primitive is intentionally unchanged: its first-page commit range is required.
    const rangeBody = { ...page1, commits: [commit('5'.repeat(40)), commit(HEAD)] };
    const range = adapter(() => rangeBody);
    expect((await range.store.commitsSince(BASE, HEAD)).kind).toBe('ok');
    expect(range.calls).toEqual([`https://api.github.com/repos/o/r/compare/${BASE}...${HEAD}?per_page=250&page=1`]);
    expect(range.parsedBytes[0]).toBe(new TextEncoder().encode(JSON.stringify(rangeBody)).byteLength);
    console.info(`O7 synthetic 50-file parsed JSON bytes: isAncestor ${beforeBytes} -> ${afterBytes}; commitsSince ${range.parsedBytes[0]} -> ${range.parsedBytes[0]} (unchanged). Not wire/compressed bytes or Worker CPU.`);
  });
});
