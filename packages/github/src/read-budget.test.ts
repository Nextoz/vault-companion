// Review O1: one task read costs ≤ 4 GitHub store requests whatever the number of `known` commits (ref, the task list,
// ≤ 2 single-page compares), where it used to cost one compare per commit. Recorded response shapes, fake network.
import { createCommandService } from '@vault-companion/domain';
import { describe, expect, it } from 'vitest';
import { GitHubContentsStore } from './contents-store.ts';

const NOW = new Date('2026-09-24T12:00:00Z');
const TODO = '## Open\n\n- [ ] Water the plants #todo\n\n## Done\n';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const hex = (n: number) => n.toString(16).padStart(40, '0');

/** History h0 … h59 on main (X = h59); `known` asks about some of them, plus a commit that is not on main. */
function fakeGitHub() {
  const history = Array.from({ length: 60 }, (_, i) => hex(i + 1));
  const x = history.at(-1)!;
  const calls: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const u = url.replace('https://api.github.com/repos/o/r', '');
    calls.push(`${init.method ?? 'GET'} ${u}`);
    if (u === '/git/ref/heads/main') return json(200, { object: { sha: x } });
    if (u.startsWith('/contents/')) {
      return json(200, { type: 'file', sha: '2'.repeat(40), size: TODO.length, encoding: 'base64', content: btoa(TODO) });
    }
    const m = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})\?per_page=250&page=1$/.exec(u);
    if (m) {
      const at = history.indexOf(m[1]!);
      if (at < 0) return json(404, { message: 'Not Found' });
      const after = history.slice(at + 1);
      return json(200, {
        status: after.length === 0 ? 'identical' : 'ahead',
        total_commits: after.length,
        commits: after.map((sha) => ({ sha, commit: { message: 'desktop edit', tree: { sha: '7'.repeat(40) } } })),
      });
    }
    return json(500, { unexpected: u });
  }) as unknown as typeof globalThis.fetch;
  const store = new GitHubContentsStore({ owner: 'o', repo: 'r', token: async () => 't', fetch });
  return { svc: createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' }), history, calls };
}

describe('task read request budget (review O1)', () => {
  it.each([0, 1, 8, 50])('%i known commits: ≤ 4 GitHub store requests, at most 2 compares', async (n) => {
    const { svc, history, calls } = fakeGitHub();
    const asked = [history[10]!, ...history.slice(40, 40 + Math.max(0, n - 1))].slice(0, n);
    const r = await svc.readTasks(asked);
    if ('code' in r) throw new Error(r.code);
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.filter((c) => c.startsWith('GET /compare/')).length).toBeLessThanOrEqual(2);
    expect(Object.keys(r.known).length).toBe(Math.min(n, 8));
    expect(Object.values(r.known).every((v) => v === 'included')).toBe(true);
  });

  it('watermark first, then a receipt older than it and one not on main: exact answers within the budget', async () => {
    const { svc, history, calls } = fakeGitHub();
    const off = 'e'.repeat(40);
    const r = await svc.readTasks([history[30]!, history[35]!, history[5]!, off]);
    if ('code' in r) throw new Error(r.code);
    expect(r.known).toEqual({ [history[30]!]: 'included', [history[35]!]: 'included', [history[5]!]: 'included', [off]: 'not-included' });
    expect(calls.length).toBeLessThanOrEqual(4);
  });
});
