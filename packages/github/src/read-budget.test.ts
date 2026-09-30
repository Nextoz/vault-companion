// Review O1: one task read costs ≤ 5 GitHub store requests whatever the number of `known` commits (ref, the task list,
// ≤ 2 single-page compares, one metadata read), where it used to cost one compare per commit. Recorded response shapes, fake network.
import { createCommandService, createResearchRadarService } from '@vault-companion/domain';
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
    if (u === `/git/commits/${x}`) return json(200, { committer: { date: NOW.toISOString() }, message: 'desktop sync' });
    if (u.startsWith('/contents/')) {
      return json(200, { type: 'file', sha: '2'.repeat(40), size: new TextEncoder().encode(TODO).byteLength, encoding: 'base64', content: btoa(TODO) });
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
  it.each([0, 1, 8, 50])('%i known commits: ≤ 5 GitHub store requests, at most 2 compares', async (n) => {
    const { svc, history, calls } = fakeGitHub();
    const asked = [history[10]!, ...history.slice(40, 40 + Math.max(0, n - 1))].slice(0, n);
    const r = await svc.readTasks(asked);
    if ('code' in r) throw new Error(r.code);
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(calls.filter((c) => c.startsWith('GET /git/commits/'))).toEqual([`GET /git/commits/${r.revision}`]);
    expect(calls.length).toBe(3 + calls.filter((c) => c.startsWith('GET /compare/')).length);
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
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(calls.filter((c) => c.startsWith('GET /git/commits/'))).toEqual([`GET /git/commits/${r.revision}`]);
    expect(calls.length).toBe(3 + calls.filter((c) => c.startsWith('GET /compare/')).length);
  });
});

describe('Research Radar read request budget (review 7 finding 5)', () => {
  it('cold read with 25 monthly logs and large Important/Explained directories stays ≤ 50 GitHub requests', async () => {
    const X = hex(1);
    const calls: string[] = [];
    const blob = 'b'.repeat(40);
    const months: string[] = [];
    const cursor = new Date('2026-09-01T00:00:00Z');
    for (let i = 0; i < 25; i += 1) {
      months.push(cursor.toISOString().slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    }
    const decisionFiles = new Map<string, string>();
    months.forEach((month, i) => {
      const decisionId = `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`;
      decisionFiles.set(`Research/Radar/Decisions/${month}.jsonl`, JSON.stringify({
        schemaVersion: 1, decisionId, paperId: '0'.repeat(20), decision: 'remove', undoes: null, at: `${month}-01T10:00:00Z`,
        card: { title: 'Synthetic', source: 'https://example.com/paper', topic: 'AI' },
      }) + '\n');
    });
    const important = (i: number) => `---\ntitle: Imp ${i}\ncreated: 2026-09-23\nstatus: active\nsource: https://example.com/imp-${i}\ntags:\n  - ai\n---\n## Curation decision\n- Synthetic\n`;
    const explained = (i: number) => `---\nsource: https://example.com/exp-${i}\ntags:\n  - ai\n---\n# Explanation\nSynthetic\n`;
    const applied = '{"schemaVersion":1,"updatedAt":"2026-09-24T10:00:00Z","decisions":{}}';

    const fetch = (async (url: string, init: RequestInit) => {
      const u = url.replace('https://api.github.com/repos/o/r', '');
      calls.push(`${init.method ?? 'GET'} ${u}`);
      if (u === '/git/ref/heads/main') return json(200, { object: { sha: X } });
      if (u.startsWith('/git/trees/')) {
        const refPart = u.slice('/git/trees/'.length).split('?')[0]!;
        const dir = decodeURIComponent(refPart.slice(refPart.indexOf(':') + 1));
        const entries = (names: string[]) => names.map((name) => ({ path: name, mode: '100644', type: 'blob', sha: blob }));
        if (dir === 'Research/Daily Research Scout' || dir === 'Research/Reading Briefs') return json(200, { sha: '6'.repeat(40), truncated: false, tree: [] });
        if (dir === 'Research/Important Research Updates') return json(200, { sha: '6'.repeat(40), truncated: false, tree: entries(Array.from({ length: 40 }, (_, i) => `Note ${String(i).padStart(2, '0')}.md`)) });
        if (dir === 'Research/Explained') return json(200, { sha: '6'.repeat(40), truncated: false, tree: entries(Array.from({ length: 40 }, (_, i) => `Expl ${String(i).padStart(2, '0')}.md`)) });
        if (dir === 'Research/Radar/Decisions') return json(200, { sha: '6'.repeat(40), truncated: false, tree: entries(months.map((m) => `${m}.jsonl`)) });
        return json(404, { message: 'Not Found' });
      }
      if (u.startsWith('/contents/')) {
        const path = decodeURIComponent(u.slice('/contents/'.length).split('?')[0]!);
        let content: string;
        if (path === 'Research/Radar/applied.json') content = applied;
        else if (decisionFiles.has(path)) content = decisionFiles.get(path)!;
        else if (path.startsWith('Research/Important Research Updates/')) content = important(Number(path.replace(/\D/g, '')) || 0);
        else if (path.startsWith('Research/Explained/')) content = explained(Number(path.replace(/\D/g, '')) || 0);
        else return json(404, { message: 'Not Found' });
        return json(200, { type: 'file', sha: blob, size: new TextEncoder().encode(content).byteLength, encoding: 'base64', content: btoa(content) });
      }
      return json(500, { unexpected: u });
    }) as unknown as typeof globalThis.fetch;

    const store = new GitHubContentsStore({ owner: 'o', repo: 'r', token: async () => 't', fetch });
    const service = createResearchRadarService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
    const result = await service.readResearchRadar();
    if ('code' in result) throw new Error(result.code);
    expect(calls.length).toBeLessThanOrEqual(50);
    expect(result.sources.importantUpdates).toEqual({ state: 'degraded', count: 16 });
    expect(result.sources.explained).toEqual({ state: 'degraded', count: 0 });
    expect(result.warnings.join(' ')).toContain('partial coverage');
  });
});
