#!/usr/bin/env node
// Phase 1 gate follow-up probe (review A2/A4/R8/R9) on the owner-approved private sandbox (G1).
// Synthetic content only. Token from `gh auth token`, never printed.
// Usage: node tools/spikes/github-gitdata-probe.mjs [owner/repo]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.argv[2] ?? 'Nextoz/vault-companion-sandbox';
const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const RUN = `gd-${new Date().toISOString().replace(/[:.]/g, '')}`;
const say = (s) => console.log(`\n### ${s}`);
async function api(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vc-probe', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json };
}
const head = async () => (await api('GET', 'git/ref/heads/main')).json.object.sha;

// Build a commit on top of `parent` that sets one file, without moving any ref.
async function commitOn(parent, path, content, message) {
  const pc = await api('GET', `git/commits/${parent}`);
  const blob = await api('POST', 'git/blobs', { content: Buffer.from(content).toString('base64'), encoding: 'base64' });
  const tree = await api('POST', 'git/trees', { base_tree: pc.json.tree.sha, tree: [{ path, mode: '100644', type: 'blob', sha: blob.json.sha }] });
  const commit = await api('POST', 'git/commits', { message, tree: tree.json.sha, parents: [parent] });
  return { blob: blob.status, tree: tree.status, commit: commit.status, sha: commit.json.sha, blobSha: blob.json.sha };
}

const X = await head();
say('Q1 blob/tree/commit on parent X (no ref move)');
const c1 = await commitOn(X, `${RUN}/Tasks/To-Do List.md`, '## Open\n\n- [ ] Water the plants #todo\n', 'probe: head-cas 1\n\nVault-Companion-Op: gd-1');
console.log(JSON.stringify(c1));

say('Q2 fast-forward ref update X -> c1 (force:false)');
let r = await api('PATCH', 'git/refs/heads/main', { sha: c1.sha, force: false });
console.log(r.status, JSON.stringify({ ref: r.json?.object?.sha === c1.sha }));

say('Q3 stale: commit parented on X (not current head) -> ref update must be rejected');
const c2 = await commitOn(X, `${RUN}/Inbox/other.md`, 'x\n', 'probe: stale parent');
r = await api('PATCH', 'git/refs/heads/main', { sha: c2.sha, force: false });
console.log(r.status, JSON.stringify({ message: r.json?.message }), 'head unchanged:', (await head()) === c1.sha);

say('Q4 ABA shape: restore identical bytes in a later commit, then try a delayed commit parented on the ORIGINAL X');
const Y = await head();
const undo = await commitOn(Y, `${RUN}/Tasks/To-Do List.md`, '## Open\n\n- [ ] Water the plants #todo\n', 'probe: identical bytes again');
await api('PATCH', 'git/refs/heads/main', { sha: undo.sha, force: false });
const delayed = await commitOn(X, `${RUN}/Tasks/To-Do List.md`, '## Open\n\n- [x] Water the plants #todo ✅ 2026-09-25\n', 'probe: delayed duplicate');
r = await api('PATCH', 'git/refs/heads/main', { sha: delayed.sha, force: false });
console.log('delayed ref update', r.status, JSON.stringify({ message: r.json?.message }));

say('Q5 tree listing of a directory at a commit (for Inbox collision check)');
for (const i of [1, 2]) {
  const h = await head();
  const c = await commitOn(h, `${RUN}/Inbox/Note ${i} - 2026-09-25.md`, `n${i}\n`, `probe: note ${i}`);
  await api('PATCH', 'git/refs/heads/main', { sha: c.sha, force: false });
}
const H = await head();
r = await api('GET', `git/trees/${H}:${encodeURIComponent(`${RUN}/Inbox`)}`);
console.log('trees by commit:path', r.status, JSON.stringify({ truncated: r.json?.truncated, entries: r.json?.tree?.map((e) => ({ path: e.path, type: e.type })) }));

say('Q6 compare pagination beyond 250 commits (push 260 tiny commits via local git)');
const dir = mkdtempSync(join(tmpdir(), 'vc-gd-'));
const url = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid' } });
try {
  git('clone', '-q', '--depth', '1', url, '.');
  const base = git('rev-parse', 'HEAD').trim();
  for (let i = 0; i < 260; i++) {
    writeFileSync(join(dir, `${RUN}-bulk.md`), `v${i}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', i === 3 ? `probe bulk ${i}\n\nVault-Companion-Op: early-op` : `probe bulk ${i}`);
  }
  git('push', '-q', 'origin', 'HEAD:main');
  const top = git('rev-parse', 'HEAD').trim();
  for (const q of ['', '?per_page=250', '?per_page=100&page=2', '?per_page=250&page=2']) {
    r = await api('GET', `compare/${base}...${top}${q}`);
    const msgs = r.json?.commits?.map((c) => c.commit.message) ?? [];
    console.log(`compare${q || ' (default)'}`, r.status, JSON.stringify({ total_commits: r.json?.total_commits, returned: msgs.length, first: msgs[0]?.split('\n')[0], last: msgs.at(-1)?.split('\n')[0], hasEarlyOp: msgs.some((m) => m.includes('early-op')) }));
  }
  r = await api('GET', `commits?sha=${top}&per_page=100`);
  console.log('commits list', r.status, JSON.stringify({ returned: r.json?.length }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
