#!/usr/bin/env node
// Gate G1 probe (owner-approved 2026-09-24): real GitHub Contents/Compare behaviour on the private sandbox
// repository. Synthetic content only; every run uses a fresh prefix. The token comes from `gh auth token`
// and is never printed. Usage: node tools/spikes/github-api-probe.mjs [owner/repo]
import { execFileSync } from 'node:child_process';

const REPO = process.argv[2] ?? 'Nextoz/vault-companion-sandbox';
const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const RUN = `run-${new Date().toISOString().replace(/[:.]/g, '')}`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const say = (s) => console.log(`\n### ${s}`);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));

async function api(method, path, body, accept = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vc-probe', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text, etag: res.headers.get('etag') };
}
const put = (path, body) => api('PUT', `contents/${enc(path)}`, body);
const head = async () => (await api('GET', 'git/ref/heads/main')).json.object.sha;

const TODO = `${RUN}/Tasks/To-Do List.md`;

say('P1 create file without sha');
let r = await put(TODO, { message: 'probe: seed\n\nVault-Companion-Op: probe-1\nVault-Companion-Payload: sha256:aa\n', content: b64('## Open\n\n- [ ] Water the plants #todo\n') });
console.log(r.status, JSON.stringify({ content: pick(r.json?.content, ['path', 'sha', 'size']), commit: { sha: r.json?.commit?.sha, message: r.json?.commit?.message, parents: r.json?.commit?.parents?.map((p) => p.sha) } }));
const seedCommit = r.json.commit.sha;
const seedBlob = r.json.content.sha;

say('P2 create again without sha (create-over-existing)');
r = await put(TODO, { message: 'probe', content: b64('x') });
console.log(r.status, JSON.stringify(pick(r.json, ['message', 'status'])));

say('P3 update with correct sha');
r = await put(TODO, { message: 'probe: update', sha: seedBlob, content: b64('## Open\n\n- [ ] Water the plants #todo\n- [ ] Call the bike shop #todo\n') });
console.log(r.status, JSON.stringify({ blob: r.json?.content?.sha, commit: r.json?.commit?.sha }));

say('P4 update with stale sha (true CAS loss)');
r = await put(TODO, { message: 'probe', sha: seedBlob, content: b64('y') });
console.log(r.status, JSON.stringify(pick(r.json, ['message', 'status'])));

say('P5 update with a well-formed unknown sha');
r = await put(TODO, { message: 'probe', sha: 'f'.repeat(40), content: b64('y') });
console.log(r.status, JSON.stringify(pick(r.json, ['message', 'status'])));

say('P5b update WITHOUT sha on an existing file');
r = await put(TODO, { message: 'probe', content: b64('y') });
console.log(r.status, JSON.stringify(pick(r.json, ['message', 'status'])));

say('P6 read pinned to the seed commit');
r = await api('GET', `contents/${enc(TODO)}?ref=${seedCommit}`);
console.log(r.status, JSON.stringify({ sha: r.json.sha, size: r.json.size, encoding: r.json.encoding, etag: r.etag, contentHasNewlines: /\n/.test(r.json.content), decoded: Buffer.from(r.json.content, 'base64').toString('utf8') }));

say('P6b read of a path absent at that ref');
r = await api('GET', `contents/${enc(`${RUN}/nope.md`)}?ref=${seedCommit}`);
console.log(r.status, JSON.stringify(pick(r.json, ['message', 'status'])));

say('P7 Unicode path with space and æ');
const note = `${RUN}/Inbox/Første idé - 2026-09-24.md`;
r = await put(note, { message: 'probe: note', content: b64('hej æøå 😀\n') });
console.log(r.status, JSON.stringify(pick(r.json?.content, ['path', 'name'])));

say('P8 list a directory');
r = await api('GET', `contents/${enc(`${RUN}/Inbox`)}`);
console.log(r.status, JSON.stringify(r.json.map((e) => pick(e, ['name', 'type']))));

say('P9 case-variant create (collides on Windows)');
r = await put(`${RUN}/Inbox/første idé - 2026-09-24.md`, { message: 'probe: case variant', content: b64('x') });
console.log(r.status);

say('P10 compare seed...HEAD');
const h = await head();
r = await api('GET', `compare/${seedCommit}...${h}`);
console.log(r.status, JSON.stringify({ ...pick(r.json, ['status', 'ahead_by', 'behind_by', 'total_commits']), n: r.json.commits.length, firstMsg: r.json.commits[0]?.commit?.message, filesPresent: Array.isArray(r.json.files) }));
say('P10b compare reversed (HEAD...seed)');
r = await api('GET', `compare/${h}...${seedCommit}`);
console.log(r.status, JSON.stringify(pick(r.json, ['status', 'ahead_by', 'behind_by', 'total_commits'])));
say('P10c compare with unknown base');
r = await api('GET', `compare/${'e'.repeat(40)}...${h}`);
console.log(r.status, JSON.stringify(pick(r.json, ['message', 'status'])));
say('P10d seed commit message (trailers) via git/commits');
r = await api('GET', `git/commits/${seedCommit}`);
console.log(r.status, JSON.stringify(r.json.message));
say('P10e commits/{sha} files list');
r = await api('GET', `commits/${seedCommit}`);
console.log(r.status, JSON.stringify(r.json.files.map((f) => pick(f, ['filename', 'status']))));

say('P11 read-after-write: ref, compare and contents immediately after PUT (8 rounds)');
let rwSha = null;
for (let i = 1; i <= 8; i++) {
  const w = await put(`${RUN}/Inbox/rw.md`, { message: `probe rw ${i}\n\nVault-Companion-Op: rw-${i}\n`, content: b64(`v${i}\n`), ...(rwSha ? { sha: rwSha } : {}) });
  rwSha = w.json.content.sha;
  const ref = await head();
  const cmp = await api('GET', `compare/${seedCommit}...${ref}`);
  const seen = cmp.json.commits.some((c) => c.commit.message.includes(`Vault-Companion-Op: rw-${i}`));
  const read = await api('GET', `contents/${enc(`${RUN}/Inbox/rw.md`)}?ref=main`);
  console.log(`round ${i} put=${w.status} refIsNewCommit=${ref === w.json.commit.sha} trailerInCompare=${seen} contentsMainFresh=${read.json?.sha === rwSha}`);
}

say('P12 concurrent PUTs to different files on the same branch');
const race = await Promise.all([1, 2, 3, 4].map((i) => put(`${RUN}/Inbox/race-${i}.md`, { message: `probe race ${i}`, content: b64(`r${i}\n`) })));
race.forEach((x, i) => console.log(`race-${i + 1}`, x.status, JSON.stringify(pick(x.json, ['message']))));
say('P12b were the 409 losers applied anyway?');
for (let i = 1; i <= 4; i++) {
  const g = await api('GET', `contents/${enc(`${RUN}/Inbox/race-${i}.md`)}?ref=main`);
  console.log(`race-${i} exists=${g.status === 200}`);
}

say('P13 file > 1 MB');
const big = 'a'.repeat(1_100_000);
r = await put(`${RUN}/Inbox/big.md`, { message: 'probe big', content: b64(big) });
console.log('put', r.status);
r = await api('GET', `contents/${enc(`${RUN}/Inbox/big.md`)}?ref=main`);
console.log('object', r.status, JSON.stringify({ size: r.json?.size, encoding: r.json?.encoding, contentLen: r.json?.content?.length, etag: r.etag }));
r = await api('GET', `contents/${enc(`${RUN}/Inbox/big.md`)}?ref=main`, undefined, 'application/vnd.github.raw+json');
console.log('raw', r.status, JSON.stringify({ len: r.text.length, etag: r.etag }));
