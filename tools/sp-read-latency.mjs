// SP1 — synthetic read-latency measurement for the Worker read composition.
//
// Packet SP1: measure where note/tab *read* wall time goes, using the production Worker composition
// (apps/worker/src/index.ts -> createProductionApp) against a fake GitHub REST API that injects
// controlled per-endpoint delays. Everything here is synthetic: a made-up vault, made-up commit
// SHAs and an ephemeral RSA key created at run time. No network, no vault, no credentials.
//
// Measured (observable) vs inferred (unobservable):
//   * Measured: wall time of app.fetch() and the count/delay of GitHub REST requests the Worker makes.
//   * Inferred: Cloudflare Access, edge/origin and phone-network time, which this harness does NOT
//     reproduce. These numbers are not phone or production latency and must never be reported as such.
//
// Imported by apps/worker/test/sp-read-latency.test.ts. Run it through Vitest: plain `node` cannot strip the
// Worker's TS parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), so this module is not a CLI.

import { createHash, createPublicKey, createSign, generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { NOTE_HEADER, encodeNoteHeader } from '../packages/contracts/src/index.ts';

export const OWNER = 'sp1-bench-owner';
export const REPO = 'sp1-bench-vault';
export const BRANCH = 'main';
export const COMMIT = 'a'.repeat(40);
export const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
const API_PATH = `/repos/${OWNER}/${REPO}`;
export const APP_ORIGIN = 'https://bench.example.com';
export const TEAM_DOMAIN = 'https://bench-team.cloudflareaccess.com';
export const ACCESS_AUD = 'bench-aud';
export const OWNER_EMAIL = 'owner@example.com';
export const GITHUB_APP_ID = '1';
export const GITHUB_INSTALLATION_ID = '2';

/** Request kinds the fake GitHub API is asked for, and the only buckets the attribution uses. */
export const REQUEST_KINDS = ['token', 'head', 'tree', 'blob', 'other'];

/** Synthetic vault seed (public/synthetic only): the files the representative read routes touch. */
export const SYNTHETIC_VAULT = {
  'Tasks/To-Do List.md':
    '## Open\n\n- [ ] Synthetic task one\n- [ ] Synthetic task two\n\n## Done\n\n- [x] Finished item \u2705 2026-09-20\n',
  'Tasks/Active Work Now.md':
    '## Now\n\n- [ ] Synthetic active item \u23f3 2026-10-03\n\n## Dropped or done\n\n- 2026-09-18: synthetic older entry\n',
  'Inbox/Alpha note - 2026-09-25.md': '---\ntype: inbox-note\n---\nSynthetic body alpha\n',
  'Inbox/Beta note - 2026-09-24.md': '---\ntype: inbox-note\n---\nSynthetic body beta\n',
  'Inbox/Undated idea.md': 'Synthetic body untimed\n',
  'Health/Training Log.md':
    '## Sessions\n\n| Date | Time | Type | Distance | Duration | Weight | Split | Note |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- |\n' +
    '| 2026-09-20 | 07:00 | run | 5k | 25:00 | | | |\n',
};

const sha40 = (value) => createHash('sha1').update(value).digest('hex');
export const blobShaFor = (path, content) => sha40(`blob\u0000${path}\u0000${content}`);

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => jsonResponse({ message: 'Not Found' }, 404);

/** GitHub Trees entries for `dir` (paths relative to `dir`); `null` only when `dir` is confirmed absent. */
function treeFor(blobs, dir, recursive) {
  const prefix = dir === '' ? '' : `${dir}/`;
  const under = [...blobs.entries()].filter(([path]) => path.startsWith(prefix));
  if (dir !== '' && under.length === 0) return null;
  const entries = [];
  const dirs = new Set();
  for (const [path, item] of under) {
    const rest = path.slice(prefix.length);
    if (!recursive && rest.includes('/')) {
      dirs.add(rest.slice(0, rest.indexOf('/')));
      continue;
    }
    entries.push({ path: rest, mode: '100644', type: 'blob', sha: item.sha });
  }
  for (const name of dirs) entries.push({ path: name, mode: '040000', type: 'tree', sha: sha40(`dir:${prefix}${name}`) });
  return entries;
}
/**
 * Real timer (default): awaits the injected delay with `setTimeout` and reports the ms it handed to it.
 */
export function createRealClock() {
  let awaited = 0;
  return {
    kind: 'real',
    awaitedMs: () => awaited,
    async sleep(ms) {
      if (!(ms > 0)) return;
      awaited += ms;
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

/**
 * Deterministic virtual timer: never waits on the wall clock. `awaitedMs` accumulates only the delays
 * that were really passed through `sleep`, so an injected delay that is removed or bypassed shows up
 * as 0 instead of as an unpredictable wall-time delta.
 */
export function createVirtualClock() {
  let awaited = 0;
  return {
    kind: 'virtual',
    awaitedMs: () => awaited,
    sleep(ms) {
      if (ms > 0) awaited += ms;
      return Promise.resolve();
    },
  };
}

/**
 * Fake GitHub REST API: serves refs/trees/contents for one synthetic commit and counts every call by
 * kind. `delays` (ms) are injected before each kind's response; `faults` (consumed once, in order)
 * force a status or a malformed body so tests can prove honest failure.
 *
 * The injected `clock` performs the wait. Every request records the ms the clock *actually* awaited
 * (`awaitedMs`), so a test can prove an injected delay belongs to a call without trusting wall time.
 */
export function createFakeGitHub({ files = SYNTHETIC_VAULT, delays = {}, faults = [], clock = createRealClock() } = {}) {
  const blobs = new Map(Object.entries(files).map(([path, content]) => [path, { content, sha: blobShaFor(path, content) }]));
  const pendingFaults = [...faults];
  const requests = [];
  const delayFor = (kind) => (Number.isFinite(delays[kind]) ? delays[kind] : 0);

  function classify(pathname) {
    if (/^\/app\/installations\/[^/]+\/access_tokens$/.test(pathname)) return 'token';
    if (pathname.includes('/git/ref/')) return 'head';
    if (pathname.includes('/git/trees/')) return 'tree';
    if (pathname.includes('/contents/')) return 'blob';
    return 'other';
  }

  async function fetchImpl(input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init?.method ?? (typeof input === 'object' ? input.method : 'GET') ?? 'GET').toUpperCase();
    const kind = classify(url.pathname);
    const delayMs = delayFor(kind);
    const request = { kind, method, path: url.pathname, delayMs, awaitedMs: 0 };
    requests.push(request);

    const faultAt = pendingFaults.findIndex((f) => f.kind === kind);
    const fault = faultAt >= 0 ? pendingFaults.splice(faultAt, 1)[0] : null;
    const awaitedFrom = clock.awaitedMs();
    await clock.sleep(delayMs);
    request.awaitedMs = clock.awaitedMs() - awaitedFrom;

    if (fault?.mode === 'status500') return jsonResponse({ message: 'synthetic upstream failure' }, 500);
    if (fault?.mode === 'status404') return notFound();
    if (fault?.mode === 'malformed')
      return new Response('{not valid json', { status: 200, headers: { 'content-type': 'application/json' } });

    if (kind === 'token')
      return jsonResponse(
        { token: 'synthetic-installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        201,
      );

    if (url.pathname.startsWith(`${API_PATH}/git/ref/heads/`)) {
      const branch = decodeURIComponent(url.pathname.slice(`${API_PATH}/git/ref/heads/`.length));
      return branch === BRANCH ? jsonResponse({ object: { sha: COMMIT } }) : notFound();
    }

    if (url.pathname.startsWith(`${API_PATH}/git/trees/`)) {
      const ref = decodeURIComponent(url.pathname.slice(`${API_PATH}/git/trees/`.length));
      const colon = ref.indexOf(':');
      const dir = colon < 0 ? '' : ref.slice(colon + 1);
      const recursive = url.searchParams.get('recursive') === '1';
      const tree = treeFor(blobs, dir, recursive);
      if (tree === null) return notFound();
      return jsonResponse({ sha: sha40(`tree:${dir}:${recursive}`), truncated: false, tree });
    }

    if (url.pathname.startsWith(`${API_PATH}/contents/`)) {
      const rel = url.pathname
        .slice(`${API_PATH}/contents/`.length)
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
      const item = blobs.get(rel);
      if (!item) return notFound();
      return jsonResponse({
        type: 'file',
        sha: item.sha,
        size: Buffer.byteLength(item.content, 'utf8'),
        content: Buffer.from(item.content, 'utf8').toString('base64'),
        encoding: 'base64',
      });
    }

    return notFound();
  }

  return { fetch: fetchImpl, requests, calls: (kind) => requests.filter((request) => request.kind === kind).length };
}

const base64url = (value) => Buffer.from(value).toString('base64url');

/** Ephemeral synthetic Access key pair + a correctly signed Access JWT (nothing is persisted or logged). */
export function createSyntheticAccess() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const publicJwk = createPublicKey(publicKey).export({ format: 'jwk' });
  const keys = async () => ({ ...publicJwk, kid: 'sp1-bench-key', alg: 'RS256', use: 'sig' });
  const nowSec = Math.floor(Date.now() / 1000);
  const signingInput =
    `${base64url(JSON.stringify({ alg: 'RS256', kid: 'sp1-bench-key', typ: 'JWT' }))}.` +
    `${base64url(
      JSON.stringify({
        email: OWNER_EMAIL,
        iss: TEAM_DOMAIN,
        aud: ACCESS_AUD,
        sub: 'sp1-bench-user',
        iat: nowSec - 30,
        exp: nowSec + 3600,
      }),
    )}`;
  const token = `${signingInput}.${base64url(createSign('RSA-SHA256').update(signingInput).sign(privateKey))}`;
  return { keys, token, privateKeyPem: privateKey };
}

export function benchEnv(access) {
  return {
    AUTH_MODE: 'access',
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD,
    ALLOWED_EMAILS: OWNER_EMAIL,
    APP_ORIGIN,
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: access.privateKeyPem,
    GITHUB_INSTALLATION_ID,
    VAULT_OWNER: OWNER,
    VAULT_REPO: REPO,
    USER_TIME_ZONE: 'Europe/Copenhagen',
  };
}

/** Build the real production app with a fake GitHub API behind it. Fresh per call: cold caches. */
export async function createBenchHarness({ files = SYNTHETIC_VAULT, delays = {}, faults = [], clock } = {}) {
  const access = createSyntheticAccess();
  const fake = createFakeGitHub({ files, delays, faults, clock });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  let app;
  try {
    const { createProductionApp } = await import('../apps/worker/src/index.ts');
    app = createProductionApp(benchEnv(access), access.keys);
  } finally {
    // The store and token source captured fake.fetch at construction; restore the process global now.
    globalThis.fetch = previousFetch;
  }
  const request = (scenario) =>
    app.fetch(
      new Request(`${APP_ORIGIN}${scenario.path}`, {
        method: 'GET',
        headers: {
          'Cf-Access-Jwt-Assertion': access.token,
          ...(scenario.note ? { [NOTE_HEADER]: encodeNoteHeader(scenario.note) } : {}),
        },
      }),
    );
  return { app, fake, access, request };
}

/** Representative tab reads: notes list + note open, plus one read per other tab. */
export const SCENARIOS = [
  { name: 'notes-list', path: '/api/notes' },
  { name: 'note-read', path: '/api/notes/read', note: 'Inbox/Alpha note - 2026-09-25.md' },
  { name: 'active-work', path: '/api/active-work' },
  { name: 'training', path: '/api/training' },
  { name: 'scouts', path: '/api/scouts' },
  { name: 'history', path: '/api/history' },
];

export function countKinds(requests) {
  const counts = Object.fromEntries(REQUEST_KINDS.map((kind) => [kind, 0]));
  for (const request of requests) counts[request.kind] += 1;
  counts.total = requests.length;
  return counts;
}

/** Await hook: the ms the injected clock really awaited per request kind (0 if a delay was bypassed). */
export function awaitedSummary(requests) {
  const awaited = Object.fromEntries(REQUEST_KINDS.map((kind) => [kind, 0]));
  for (const request of requests) awaited[request.kind] += request.awaitedMs ?? 0;
  awaited.total = REQUEST_KINDS.reduce((sum, kind) => sum + awaited[kind], 0);
  return awaited;
}

/** The delay budget the injected delays add up to for a given request-count snapshot. */
export function attributeMs(counts, delays) {
  return REQUEST_KINDS.reduce((sum, kind) => sum + counts[kind] * (Number.isFinite(delays[kind]) ? delays[kind] : 0), 0);
}

export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Cold = the first request against a brand new app/store (token, head and tree caches all empty).
 * Repeat = the next `samples` requests against that same app (caches warm, per-call counts shown).
 *
 * `ms`/`medianMs` are always real `performance.now()` wall times and are reported as observations.
 * `awaited*` comes from the injected clock and is the deterministic oracle: under `createVirtualClock`
 * it is exact, and it is 0 if the per-kind delay was never actually awaited.
 *
 * Pass `clock` as a clock instance or a factory (e.g. `createVirtualClock`); a factory gets a fresh
 * clock per scenario so awaited totals stay isolated.
 */
export async function runLatencyBenchmark({ delays = {}, samples = 3, files = SYNTHETIC_VAULT, clock } = {}) {
  const rows = [];
  for (const scenario of SCENARIOS) {
    const harness = await createBenchHarness({ files, delays, clock: typeof clock === 'function' ? clock() : clock });

    const coldFrom = harness.fake.requests.length;
    const coldStart = performance.now();
    const coldRes = await harness.request(scenario);
    const coldMs = performance.now() - coldStart;
    const coldBody = await coldRes.json().catch(() => null);
    const coldRequests = harness.fake.requests.slice(coldFrom);
    const coldCounts = countKinds(coldRequests);

    const samplesMs = [];
    const countsAllCalls = [];
    const awaitedAllCalls = [];
    for (let i = 0; i < samples; i++) {
      const from = harness.fake.requests.length;
      const start = performance.now();
      const res = await harness.request(scenario);
      samplesMs.push(performance.now() - start);
      await res.json().catch(() => null);
      const callRequests = harness.fake.requests.slice(from);
      countsAllCalls.push(countKinds(callRequests));
      awaitedAllCalls.push(awaitedSummary(callRequests));
    }

    rows.push({
      scenario: scenario.name,
      path: scenario.path,
      cold: {
        ms: coldMs,
        status: coldRes.status,
        counts: coldCounts,
        attributedMs: attributeMs(coldCounts, delays),
        awaited: awaitedSummary(coldRequests),
        body: coldBody,
      },
      repeat: {
        samplesMs,
        medianMs: median(samplesMs),
        countsPerCall: countsAllCalls[0],
        countsAllCalls,
        attributedMs: attributeMs(countsAllCalls[0], delays),
        awaitedPerCall: awaitedAllCalls[0],
        awaitedAllCalls,
        awaitedMedianMs: median(awaitedAllCalls.map((awaited) => awaited.total)),
      },
    });
  }
  return { delays, samples, rows };
}

export const rowFor = (result, name) => result.rows.find((row) => row.scenario === name);

const countLine = (counts) => `token=${counts.token} head=${counts.head} tree=${counts.tree} blob=${counts.blob}`;

/** Compact markdown evidence table for docs/reviews/SP-read-latency.md. */
export function toMarkdown(result) {
  const lines = [
    `Delays (ms): ${JSON.stringify(result.delays)}; repeat samples: ${result.samples}`,
    '',
    '| scenario | cold ms | cold reqs | repeat median ms | repeat reqs/call | injected delay/repeat |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of result.rows) {
    lines.push(
      `| ${row.scenario} | ${row.cold.ms.toFixed(1)} | ${countLine(row.cold.counts)} | ${row.repeat.medianMs.toFixed(1)} | ${countLine(
        row.repeat.countsPerCall,
      )} | ${row.repeat.attributedMs} ms |`,
    );
  }
  return lines.join('\n');
}

export async function main() {
  const result = await runLatencyBenchmark({ delays: { token: 5, head: 30, tree: 20, blob: 10 }, samples: 5 });
  console.log(toMarkdown(result));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    console.error('sp-read-latency: run through Vitest; plain node cannot transform the Worker TS.', error?.message ?? error);
    process.exitCode = 1;
  });
}
