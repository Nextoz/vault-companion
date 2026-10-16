// Tests for tools/glm-workflow.mjs — local mock upstream + injected clock only.
// No real inference, no secrets: SCW_* values are synthetic test values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DEFAULTS, ROLES, QueueStore, LockHeld, RequestGuard, createProxy,
  buildConfig, validateBounds, validateProjectId, buildUpstreamUrl,
  enqueue, runNext, recover, clearCircuit, runTask,
  parseReset, parseRetryAfter, parseRateHeaders, extractUsage, classifyUpstream,
  parseRunOutput, sanitizeChildEnv, SNAPSHOT_SKIP,
} from './glm-workflow.mjs';

const PROJECT = '11111111-1111-1111-1111-111111111111';
const ENV = { SCW_SECRET_KEY: 'SYNTHETIC-KEY', SCW_PROJECT_ID: PROJECT };

async function tmpdir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'glmwf-'));
}

function fakeClock(start = 1_000_000) {
  let t = start;
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, slept, advance: (ms) => { t += ms; } };
}

// Mock upstream: scripts responses in order; records received requests.
function mockUpstream() {
  const hits = [];
  const script = [];
  let url = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      const step = script.shift() ?? { status: 200, body: JSON.stringify({ id: 'x', usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }) };
      const headers = { 'content-type': 'application/json', ...(step.headers ?? {}) };
      setTimeout(() => { res.writeHead(step.status, headers); res.end(step.body); }, step.delayMs ?? 0);
    });
  });
  test.after(() => { server.closeAllConnections(); server.close(); });
  return {
    hits, script,
    get url() { return url; },
    start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => { url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`; r(url); })),
    close: () => new Promise((r) => server.close(r)),
  };
}

const BODY = (max_tokens = 100) => JSON.stringify({ model: 'glm-5.3', max_tokens, messages: [{ role: 'user', content: 'synthetic' }] });

function client(port, body = BODY(), auth = 'test-nonce') {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body,
  });
}

async function withProxy({ bounds = validateBounds(), clock = fakeClock(), upstream, onCircuit = () => {} } = {}, fn) {
  const guard = new RequestGuard({ clock, bounds });
  const proxy = createProxy({ guard, nonce: 'test-nonce', secretKey: 'SYNTHETIC-KEY', projectId: PROJECT, clock, upstreamUrl: upstream, onCircuit });
  const port = await proxy.listen();
  try { return await fn(port, guard, proxy); } finally { await proxy.close(); }
}

const EVENT_TEXT = JSON.stringify({ type: 'text', part: { text: 'synthetic final text' } });

async function writePrompt(dir, text = 'Do the synthetic task. Produce a final report.') {
  const f = path.join(dir, `brief-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}.md`);
  await fsp.writeFile(f, text, 'utf8');
  return f;
}

// Fake spawnFn: reads the generated V2 config, traverses the proxy once like a
// real worker would, and returns crafted run output.
function proxiedSpawn(promptText, { stdout = EVENT_TEXT, extra } = {}) {
  return async (opts) => {
    assert.equal(opts.prompt, promptText, 'validated prompt must be delivered to the spawned process');
    const cfg = JSON.parse(await fsp.readFile(opts.configPath, 'utf8'));
    const r = await fetch(`${cfg.providers['vc-scaleway'].settings.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.providers['vc-scaleway'].settings.apiKey}`, 'content-type': 'application/json' },
      body: BODY(),
    });
    if (extra) await extra(opts, r, cfg);
    return { code: 0, stdout };
  };
}

// ---------- parsing / pure units ----------

test('parseReset handles ms, s, m', () => {
  assert.equal(parseReset('20ms'), 20);
  assert.equal(parseReset('5s'), 5000);
  assert.equal(parseReset('2m'), 120000);
  assert.equal(parseReset('bogus'), null);
});

test('parseRetryAfter handles delta-seconds, reset strings, and HTTP-date', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter('120ms', now), 120);
  assert.equal(parseRetryAfter('Thu, 15 Oct 2026 12:00:10 GMT', now), 10000);
  assert.equal(parseRetryAfter(null, now), null);
});

test('extractUsage: SSE final usage, JSON body, absent -> unknown', () => {
  const sse = 'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\ndata: [DONE]\n\n';
  assert.equal(extractUsage(sse).usage.total_tokens, 7);
  assert.equal(extractUsage('{"usage":{"total_tokens":9}}').usage.total_tokens, 9);
  const absent = extractUsage('{"id":"no-usage"}');
  assert.equal(absent.usage, null);
  assert.equal(absent.usageKnown, false);
});

test('classifyUpstream: terminal quota vs temporary vs ambiguous', () => {
  assert.equal(classifyUpstream(402, 'INSUFFICIENT QUOTA').kind, 'quota');
  assert.equal(classifyUpstream(429, 'rate limit exceeded, slow down').kind, 'temporary');
  assert.equal(classifyUpstream(429, 'quota policy applies to this key').kind, 'ambiguous');
  assert.equal(classifyUpstream(401, 'unauthorized').kind, 'auth');
  assert.equal(classifyUpstream(503, 'oops').kind, 'temporary');
});

test('parseRateHeaders reads remaining, limit, and reset values', () => {
  const h = new Map([
    ['x-ratelimit-remaining-tokens', '199000'],
    ['x-ratelimit-limit-tokens', '200000'],
    ['x-ratelimit-remaining-requests', '299'],
    ['x-ratelimit-reset-tokens', '8s'],
  ]);
  const parsed = parseRateHeaders(h);
  assert.equal(parsed.tpmRemaining, 199000);
  assert.equal(parsed.tpmLimit, 200000);
  assert.equal(parsed.rpmRemaining, 299);
  assert.equal(parsed.resetTokensMs, 8000);
});

test('project ID validation and verified endpoint URL', () => {
  assert.equal(buildUpstreamUrl(PROJECT), `https://api.scaleway.ai/${PROJECT}/v1/chat/completions`);
  assert.throws(() => buildUpstreamUrl('SYNTHETIC-PROJECT'), /SCW_PROJECT_ID must be a Scaleway project UUID/);
  assert.throws(() => validateProjectId('../etc'), /UUID/);
  assert.ok(!buildUpstreamUrl(PROJECT).includes('api.scaleway.com'));
});

test('parseRunOutput: final assistant text only; error events flagged', () => {
  const stdout = [
    JSON.stringify({ type: 'message', role: 'user', parts: [{ type: 'text', text: 'prompt echo' }] }),
    JSON.stringify({ type: 'tool', tool: 'read' }),
    JSON.stringify({ type: 'message', role: 'assistant', parts: [{ type: 'text', text: 'first' }] }),
    JSON.stringify({ type: 'message', role: 'assistant', parts: [{ type: 'text', text: 'final report' }] }),
  ].join('\n');
  const { finalText, errorEvents } = parseRunOutput(stdout);
  assert.equal(finalText, 'final report');
  assert.equal(errorEvents.length, 0);
  const bad = parseRunOutput(`${stdout}\n${JSON.stringify({ type: 'error', message: 'boom' })}`);
  assert.equal(bad.errorEvents.length, 1);
  assert.equal(parseRunOutput('').finalText, null);
});

test('sanitizeChildEnv strips credentials and config overrides', () => {
  const env = sanitizeChildEnv({ SCW_SECRET_KEY: 'K', SCW_PROJECT_ID: 'P', PATH: 'x', HOME: 'y' }, 'C:/cfg.json');
  assert.equal(env.SCW_SECRET_KEY, undefined);
  assert.equal(env.SCW_PROJECT_ID, undefined);
  assert.equal(env.PATH, 'x');
  assert.equal(env.OPENCODE_CONFIG, undefined);
});

// ---------- guard / proxy behavior against mock upstream ----------

test('temporary 429 with Retry-After retries once then succeeds', async () => {
  const up = mockUpstream();
  up.script.push({ status: 429, body: 'rate limited', headers: { 'retry-after': '1' } });
  up.script.push({ status: 200, body: JSON.stringify({ ok: true }) });
  const url = await up.start();
  const clock = fakeClock();
  await withProxy({ clock, upstream: url }, async (port, guard) => {
    const res = await client(port);
    assert.equal(res.status, 200);
    assert.equal(guard.upstreamAttempts, 2);
    assert.deepEqual(clock.slept, [1000]); // Retry-After honored, never shortened below server delay
  });
  await up.close();
});

test('persistent 429: bounded retries then nonretryable local 400 (never 502)', async () => {
  const up = mockUpstream();
  for (let i = 0; i < 6; i++) up.script.push({ status: 429, body: 'rate limited' });
  const url = await up.start();
  const clock = fakeClock();
  await withProxy({ clock, upstream: url }, async (port, guard) => {
    const res = await client(port);
    assert.equal(res.status, 400); // terminal exhaustion is 400, not 502
    assert.equal(guard.upstreamAttempts, DEFAULTS.maxRetries + 1);
  });
  await up.close();
});

test('maxAttempts=1 with upstream 429 => exactly 1 upstream call, local 400', async () => {
  const up = mockUpstream();
  up.script.push({ status: 429, body: 'rate limited' });
  const url = await up.start();
  const clock = fakeClock();
  const bounds = validateBounds({ maxUpstreamAttempts: 1, retryBaseMs: 1, maxRetryElapsedMs: 5000 });
  await withProxy({ bounds, clock, upstream: url }, async (port, guard) => {
    const res = await client(port);
    assert.equal(res.status, 400); // guard before EACH attempt incl. the retry
    assert.equal(up.hits.length, 1); // exactly one paid call
    assert.equal(guard.upstreamAttempts, 1);
  });
  await up.close();
});

test('excessive Retry-After => no sleep, no second call, nonretryable local 400', async () => {
  const up = mockUpstream();
  up.script.push({ status: 429, body: 'rate limited', headers: { 'retry-after': '120' } }); // 120s cannot fit the 30s retry budget
  const url = await up.start();
  const clock = fakeClock();
  await withProxy({ clock, upstream: url }, async (port, guard) => {
    const res = await client(port);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.type, /retry_deadline_nonretryable/);
    assert.deepEqual(clock.slept, []); // never slept beyond the deadline
    assert.equal(up.hits.length, 1); // never retried early
    assert.equal(guard.upstreamAttempts, 1);
  });
  await up.close();
});

test('terminal quota: single call, nonretryable local 400, proxy circuit blocks the NEXT client call immediately', async () => {
  const up = mockUpstream();
  up.script.push({ status: 402, body: JSON.stringify({ error: { message: 'INSUFFICIENT QUOTA for your billing plan' } }) });
  const url = await up.start();
  const clock = fakeClock();
  await withProxy({ clock, upstream: url }, async (port, guard, proxy) => {
    const first = await client(port);
    assert.equal(first.status, 400);
    assert.equal(guard.upstreamAttempts, 1);
    assert.ok(proxy.latched.open);
    const second = await client(port); // client retry after terminal quota
    assert.equal(second.status, 400);
    assert.match((await second.json()).error.type, /circuit_nonretryable/);
    assert.equal(up.hits.length, 1); // no second upstream call
  });
  await up.close();
});

test('auth failure 401: single attempt, latch, nonretryable', async () => {
  const up = mockUpstream();
  up.script.push({ status: 401, body: 'bad key' });
  const url = await up.start();
  const clock = fakeClock();
  await withProxy({ clock, upstream: url, onCircuit: (kind) => assert.equal(kind, 'auth') }, async (port, guard) => {
    const res = await client(port);
    assert.equal(res.status, 400);
    assert.equal(guard.upstreamAttempts, 1);
  });
  await up.close();
});

test('session attempt budget: local nonretryable 400 before upstream is hit', async () => {
  const up = mockUpstream();
  const url = await up.start();
  const bounds = validateBounds({ maxUpstreamAttempts: 1 });
  await withProxy({ bounds, upstream: url }, async (port, guard) => {
    const first = await client(port);
    assert.equal(first.status, 200);
    const second = await client(port);
    assert.equal(second.status, 400); // nonretryable: OpenCode inner retries cannot multiply paid calls
    assert.equal(guard.upstreamAttempts, 1);
  });
  await up.close();
});

test('upstream timeout retried then local 400 without extra paid calls; tokens reserved even on network failure', async () => {
  const up = mockUpstream();
  for (let i = 0; i < 4; i++) up.script.push({ status: 200, body: '{}', delayMs: 5000 });
  const url = await up.start();
  const bounds = validateBounds({ upstreamTimeoutMs: 20, retryBaseMs: 1, maxRetryElapsedMs: 5000 });
  const clock = { now: () => Date.now(), sleep: async () => {} }; // wall clock; fast sleeps
  await withProxy({ bounds, clock, upstream: url }, async (port, guard) => {
    const res = await client(port);
    assert.equal(res.status, 400);
    assert.equal(guard.upstreamAttempts, DEFAULTS.maxRetries + 1); // bounded
    assert.ok(guard.reservedTotal > 0, 'reservation must be counted BEFORE fetch, even on network failure (unknown billing)');
  });
  await up.close();
});

test('missing max_tokens inserted (capped) into forwarded body; max_completion_tokens stripped; stream asks for usage', async () => {
  const up = mockUpstream();
  up.script.push({ status: 200, body: JSON.stringify({ ok: true }) });
  up.script.push({ status: 200, body: JSON.stringify({ ok: true }) });
  const url = await up.start();
  const bounds = validateBounds({ maxOutputTokens: 50 });
  await withProxy({ bounds, upstream: url }, async (port) => {
    const res = await client(port, JSON.stringify({ model: 'glm-5.3', max_completion_tokens: 99999, stream: true, messages: [] }));
    assert.equal(res.status, 200);
    const sent = JSON.parse(up.hits[0].body);
    assert.equal(sent.max_tokens, 50, 'missing max_tokens must be INSERTED into the forwarded body, capped');
    assert.equal(sent.max_completion_tokens, undefined, 'conflicting max_completion_tokens must be stripped');
    assert.equal(sent.stream_options.include_usage, true, 'streaming must request usage');
  });
  await up.close();
});

test('token reservation includes margin and preflight blocks over-reservation', () => {
  const clock = fakeClock();
  const guard = new RequestGuard({ clock, bounds: validateBounds() });
  const body = BODY(100);
  const reserve = guard.reserve(body, 100);
  const bytes = Buffer.byteLength(body, 'utf8');
  assert.ok(reserve > bytes + 100); // margin applied
  assert.equal(reserve, Math.ceil((bytes + 100) * 1.2));
  // Live header leaves less room than the reservation -> local 429 (free, retryable)
  guard.live = { tpmRemaining: 100, resetTokensMs: 5000, updatedAt: clock.now() };
  const pre = guard.preflight(body, 100);
  assert.equal(pre.ok, false);
  assert.equal(pre.status, 429);
  assert.equal(pre.retryAfterMs, 5000);
});

test('no double-subtract: server-updated remaining wins; local rolling covers header-absent usage', () => {
  const clock = fakeClock();
  const guard = new RequestGuard({ clock, bounds: validateBounds() });
  const h = new Map([['x-ratelimit-remaining-tokens', '1000'], ['x-ratelimit-limit-tokens', '200000']]);
  guard.noteSuccess(h, { total_tokens: 400 });
  assert.equal(guard.live.tpmRemaining, 1000);
  assert.equal(guard.localTokens.length, 0, 'usage must NOT be subtracted again when the server already updated remaining');
  const h2 = new Map(); // no rate headers
  guard.noteSuccess(h2, { total_tokens: 400 });
  assert.equal(guard.localTokens.length, 1, 'header-absent usage counts in the local rolling window');
  assert.equal(guard.effectiveTpmRemaining(clock.now()), 600);
  guard.noteSuccess(new Map(), null);
  assert.equal(guard.usageKnown, false, 'missing usage must be unknown, never zero');
});

test('header-based quota resets with the clock', async () => {
  const up = mockUpstream();
  up.script.push({ status: 200, body: JSON.stringify({ ok: true }), headers: { 'x-ratelimit-remaining-tokens': '100', 'x-ratelimit-limit-tokens': '200000', 'x-ratelimit-reset-tokens': '5s' } });
  up.script.push({ status: 200, body: JSON.stringify({ ok: true }) });
  const url = await up.start();
  const clock = fakeClock();
  await withProxy({ clock, upstream: url }, async (port, guard) => {
    const first = await client(port);
    assert.equal(first.status, 200);
    const blocked = await client(port);
    assert.equal(blocked.status, 200); // remaining=100 minus margin cannot fit the next reservation
    clock.advance(6000); // past the 5s reset window
    const third = await client(port);
    assert.equal(third.status, 200); // quota recovered with the clock
    assert.equal(guard.upstreamAttempts, 3);
  });
  await up.close();
});

test('usage recorded from proxy responses (actual prompt/completion/total)', async () => {
  const up = mockUpstream();
  up.script.push({ status: 200, body: JSON.stringify({ ok: true, usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } }) });
  const url = await up.start();
  await withProxy({ upstream: url }, async (port, guard) => {
    await client(port);
    assert.deepEqual(guard.usage, { promptTokens: 11, completionTokens: 22, totalTokens: 33 });
    assert.equal(guard.usageKnown, true);
  });
  await up.close();
});

test('proxy rejects wrong model and bad credentials; only chat/completions routed', async () => {
  await withProxy({}, async (port) => {
    const badModel = await client(port, JSON.stringify({ model: 'gpt-4', max_tokens: 10 }));
    assert.equal(badModel.status, 400);
    const badAuth = await client(port, BODY(), 'wrong');
    assert.equal(badAuth.status, 401);
    const other = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, { method: 'POST', headers: { authorization: 'Bearer test-nonce' } });
    assert.equal(other.status, 404);
  });
});

// ---------- config + roles (exact valid V2 keys) ----------

test('V2 config: exact valid root keys, provider/settings/models body, agents with permission objects', () => {
  const cfg = buildConfig({ port: 1234, nonce: 'N', role: 'developer', allowedPaths: ['src/**'] });
  // exact valid V2 root keys — no legacy provider/options/agent/permission shapes
  assert.deepEqual(Object.keys(cfg).sort(), ['$schema', 'agents', 'compaction', 'model', 'providers', 'snapshots', 'tool_output', 'warming'].sort());
  assert.equal(cfg.model, 'vc-scaleway/glm-5.3');
  assert.ok(!('provider' in cfg) && !('agent' in cfg) && !('permission' in cfg) && !('options' in cfg));
  const sc = cfg.providers['vc-scaleway'];
  assert.equal(sc.package, '@opencode/ai/providers/openai-compatible');
  assert.ok(sc.settings.baseURL.startsWith('http://127.0.0.1:'));
  assert.equal(sc.settings.apiKey, 'N');
  assert.equal(sc.models['glm-5.3'].modelID, 'glm-5.3');
  assert.equal(sc.models['glm-5.3'].body.max_tokens, DEFAULTS.maxOutputTokens);
  assert.equal(typeof sc.models['glm-5.3'].body.reasoning_effort, 'string');
  assert.equal(cfg.snapshots, false);
  assert.equal(cfg.compaction.auto, false);
  assert.equal(cfg.warming, false);
  const agent = cfg.agents.developer;
  assert.equal(agent.mode, 'primary');
  assert.equal(typeof agent.system, 'string');
  assert.equal(agent.steps, DEFAULTS.stepsCap);
  const flat = (k) => agent.permissions.filter((r) => r.action === k);
  assert.ok(flat('edit').find((r) => r.effect === 'deny' && r.resource === '**'));
  assert.ok(flat('edit').find((r) => r.effect === 'allow' && r.resource === 'src/**'));
  assert.ok(agent.permissions.findIndex((r) => r.action === 'edit' && r.effect === 'deny')
    < agent.permissions.findIndex((r) => r.action === 'edit' && r.effect === 'allow'), 'deny edit must precede allow edit');
  for (const a of ['bash', 'shell', 'external_directory', 'subagent', 'web']) {
    assert.ok(agent.permissions.find((r) => r.action === a && r.effect === 'deny' && r.resource === '**'), `${a} must be blanket-denied`);
  }
  for (const a of ['read', 'glob', 'grep']) {
    assert.ok(agent.permissions.find((r) => r.action === a && r.effect === 'allow'), `${a} must be allowed`);
  }
  assert.ok(agent.permissions.every((r) => typeof r.action === 'string' && typeof r.resource === 'string' && (r.effect === 'allow' || r.effect === 'deny')));
});

test('reviewer config: no edits/shell/writes, read-only, never contains the upstream secret', () => {
  const cfg = buildConfig({ port: 9, nonce: 'NONCE', role: 'reviewer' });
  const perm = cfg.agents.reviewer.permissions;
  assert.ok(!perm.find((r) => r.action === 'edit' && r.effect === 'allow'), 'reviewer gets no edit allows');
  for (const a of ['edit', 'bash', 'shell', 'subagent', 'web', 'external_directory', 'write']) {
    assert.ok(perm.find((r) => r.action === a && r.effect === 'deny'), `${a} must be denied`);
  }
  assert.ok(perm.find((r) => r.action === 'read' && r.effect === 'allow'));
  assert.ok(!JSON.stringify(cfg).includes('api.scaleway'));
  assert.ok(!JSON.stringify(cfg).includes('api.scaleway.com'));
});

test('bounds are configurable downward only; margin configurable; test-analyst cannot approve', () => {
  assert.equal(validateBounds({ maxUpstreamAttempts: 5 }).maxUpstreamAttempts, 5);
  assert.throws(() => validateBounds({ maxUpstreamAttempts: 41 }));
  assert.throws(() => validateBounds({ maxSessionMs: 13 * 60_000 }));
  assert.equal(validateBounds({ margin: 0.5 }).margin, 0.5);
  assert.throws(() => validateBounds({ margin: 1 }));
  assert.equal(ROLES['test-analyst'].canApprove, false);
  assert.equal(ROLES.developer.canApprove, false);
});

// ---------- queue: locks, contention, persistence, recovery ----------

test('lock contention: second runner rejected while one holds the long runner lock', async () => {
  const home = await tmpdir();
  const store = new QueueStore(home);
  let release;
  const gate = new Promise((r) => { release = r; });
  let acquired; const ready = new Promise(r => acquired = r);
  const first = store.withRunner(async () => { acquired(); await gate; return 'first-done'; });
  await ready;
  await assert.rejects(() => store.withRunner(async () => 'second'), (e) => e instanceof LockHeld);
  release();
  assert.equal(await first, 'first-done');
  assert.equal(await store.withRunner(async () => 'ok'), 'ok'); // free again
});

test('enqueue works while a runner is active (short state lock vs long runner lock)', async () => {
  const home = await tmpdir();
  const store = new QueueStore(home);
  const taskDir = await tmpdir();
  const promptFile = await writePrompt(taskDir);
  let release;
  const gate = new Promise((r) => { release = r; });
  const runner = store.withRunner(async () => { await gate; return 'ran'; });
  const id = await enqueue({ store, role: 'developer', taskDir, allowedPaths: ['src/**'], promptFile }); // must NOT wait on the runner
  assert.match(id, /^t1$/);
  const state = await store.load();
  assert.equal(state.items[0].status, 'queued');
  release();
  assert.equal(await runner, 'ran');
});

test('workspace lock: two different --home stores cannot write the same workspace', async () => {
  const taskDir = await tmpdir();
  const store1 = new QueueStore(await tmpdir());
  const store2 = new QueueStore(await tmpdir());
  let release;
  const gate = new Promise((r) => { release = r; });
  let acquired; const ready = new Promise(r => acquired = r);
  const first = store1.withWorkspace(taskDir, async () => { acquired(); await gate; return 'ws1'; });
  await ready;
  await assert.rejects(() => store2.withWorkspace(taskDir, async () => 'ws2'), (e) => e instanceof LockHeld);
  release();
  assert.equal(await first, 'ws1');
  assert.equal(await store2.withWorkspace(taskDir, async () => 'ws2'), 'ws2');
});

test('dead-pid lock is taken over; a LIVE long-running lock is never stolen', async () => {
  const home = await tmpdir();
  const store = new QueueStore(home);
  await fsp.mkdir(home, { recursive: true });
  // dead pid: break it
  await fsp.writeFile(store.runnerLockFile, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }), 'utf8');
  assert.equal(await store.withRunner(async () => 'took-over', { staleMs: 60_000, clock: fakeClock() }), 'took-over');
  // live pid (this process), stale by clock: still NOT stolen
  await fsp.writeFile(store.runnerLockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
  await assert.rejects(() => store.withRunner(async () => 'stolen', { staleMs: 0, clock: fakeClock() }), (e) => e instanceof LockHeld);
  await fsp.rm(store.runnerLockFile, { force: true });
});

test('queue persists progress; interrupted tasks are never auto-rerun; recover is explicit', async () => {
  const home = await tmpdir();
  const store = new QueueStore(home);
  const taskDir = await tmpdir();
  const promptFile = await writePrompt(taskDir);
  await enqueue({ store, role: 'developer', taskDir, allowedPaths: ['src/**'], promptFile });
  // simulate a crash mid-run: item left running on disk
  const state = await store.load();
  state.items[0].status = 'running';
  await store.save(state);
  const res = await runNext({
    store, bounds: validateBounds(), home, clock: fakeClock(), env: ENV,
    spawnFn: async () => { throw new Error('should not rerun an interrupted task'); },
  });
  assert.ok(res.done, 'run must not pick interrupted tasks');
  const s2 = await store.load();
  assert.equal(s2.items[0].status, 'interrupted');
  const again = await runNext({ store, bounds: validateBounds(), home, clock: fakeClock(), env: ENV, spawnFn: async () => ({ code: 0 }) });
  assert.ok(again.done, 'still not rerun without explicit recovery');
  await recover({ store, id: s2.items[0].id, mark: 'failed' });
  const s3 = await store.load();
  assert.equal(s3.items[0].status, 'failed');
});

test('FIFO order and completion persisted through state.json with usage + compact report', async () => {
  const home = await tmpdir();
  const store = new QueueStore(home);
  const taskDir = await tmpdir();
  const promptFile = await writePrompt(taskDir);
  const up = mockUpstream();
  const url = await up.start();
  const id1 = await enqueue({ store, role: 'developer', taskDir, allowedPaths: ['a/**'], promptFile });
  const id2 = await enqueue({ store, role: 'developer', taskDir, allowedPaths: ['a/**'], promptFile });
  const order = [];
  for (let i = 0; i < 2; i++) {
    const r = await runNext({ store, bounds: validateBounds(), home, clock: fakeClock(), env: ENV, upstreamUrl: url, spawnFn: proxiedSpawn(await fsp.readFile(promptFile, 'utf8')) });
    order.push(r.item.id);
  }
  assert.deepEqual(order, [id1, id2]);
  const state = JSON.parse(await fsp.readFile(store.stateFile, 'utf8'));
  assert.equal(state.items[0].status, 'completed');
  assert.equal(state.items[0].usageKnown, true);
  assert.equal(state.items[0].usage.totalTokens, 7);
  const report = JSON.parse(await fsp.readFile(path.join(home, 'results', `${id1}.json`), 'utf8'));
  assert.equal(report.finalText, 'synthetic final text'); // compact final-text report
  assert.ok(!JSON.stringify(report).includes('tool')); // no full tool transcript saved
  assert.equal(report.usage.totalTokens, 7);
  await up.close();
});

test('enqueue without a prompt file is refused', async () => {
  const store = new QueueStore(await tmpdir());
  await assert.rejects(async () => enqueue({ store, role: 'reviewer', taskDir: await tmpdir(), allowedPaths: [], promptFile: null }), /--prompt-file/);
});

// ---------- runTask: prompt delivery, hygiene, success criteria ----------

test('runTask happy path: validated prompt delivered as argv, upstream via proxy, config cleaned up', async () => {
  const home = await tmpdir();
  const taskDir = await tmpdir();
  const promptText = 'Do the synthetic task. Produce a final report.';
  const promptFile = await writePrompt(taskDir, promptText);
  await fsp.writeFile(path.join(taskDir, 'note.md'), 'synthetic', 'utf8');
  const up = mockUpstream();
  up.script.push({ status: 200, body: JSON.stringify({ ok: true, usage: { total_tokens: 12 } }) });
  const url = await up.start();
  const out = await runTask({
    item: { id: 't1', role: 'developer', taskDir, allowedPaths: ['note.md'], promptFile },
    bounds: validateBounds(), home, clock: fakeClock(), env: ENV, upstreamUrl: url,
    spawnFn: proxiedSpawn(promptText),
  });
  assert.equal(out.status, 'completed');
  assert.equal(out.upstreamAttempts, 1);
  assert.equal(up.hits.length, 1);
  assert.equal(up.hits[0].url, '/v1/chat/completions');
  assert.equal(up.hits[0].auth, 'Bearer SYNTHETIC-KEY'); // real key used only by the proxy, upstream
  assert.ok(!fs.existsSync(path.join(taskDir, 'opencode.json'))); // nonce file removed
  await up.close();
});

test('zero-call fake success is rejected: exit 0 alone is insufficient', async () => {
  const home = await tmpdir();
  const taskDir = await tmpdir();
  const promptFile = await writePrompt(taskDir);
  const up = mockUpstream();
  const url = await up.start();
  const out = await runTask({
    item: { id: 't2', role: 'developer', taskDir, allowedPaths: ['src/**'], promptFile },
    bounds: validateBounds(), home, clock: fakeClock(), env: ENV, upstreamUrl: url,
    spawnFn: async (opts) => { assert.ok(typeof opts.prompt === 'string'); return { code: 0, stdout: EVENT_TEXT }; }, // no proxy request at all
  });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /no request traversed the proxy/);
  assert.equal(up.hits.length, 0);
  await up.close();
});

test('exit 0 with no final text, or with error events, is rejected', async () => {
  const home = await tmpdir();
  const taskDir = await tmpdir();
  const promptFile = await writePrompt(taskDir);
  const up = mockUpstream();
  up.script.push({ status: 200, body: JSON.stringify({ ok: true }) });
  up.script.push({ status: 200, body: JSON.stringify({ ok: true }) });
  const url = await up.start();
  const base = { bounds: validateBounds(), home, clock: fakeClock(), env: ENV, upstreamUrl: url };
  const promptText = await fsp.readFile(promptFile, 'utf8');
  const noText = await runTask({ ...base, item: { id: 'n1', role: 'developer', taskDir, allowedPaths: ['src/**'], promptFile }, spawnFn: proxiedSpawn(promptText, { stdout: '{"done":true}' }) });
  assert.equal(noText.status, 'failed');
  assert.match(noText.error, /no final assistant text/);
  const withErr = await runTask({
    ...base, item: { id: 'n2', role: 'developer', taskDir, allowedPaths: ['src/**'], promptFile },
    spawnFn: proxiedSpawn(promptText, { stdout: `${EVENT_TEXT}\n${JSON.stringify({ type: 'error', message: 'synthetic error' })}` }),
  });
  assert.equal(withErr.status, 'failed');
  assert.match(withErr.error, /error event/);
  await up.close();
});

test('runTask refuses invalid/missing credentials and non-UTF-8 or empty prompts', async () => {
  const home = await tmpdir();
  const taskDir = await tmpdir();
  const promptFile = await writePrompt(taskDir);
  await assert.rejects(
    async () => runTask({ item: { id: 'c1', role: 'developer', taskDir, allowedPaths: [], promptFile }, bounds: validateBounds(), home, clock: fakeClock(), env: {} }),
    /SCW_PROJECT_ID must be a Scaleway project UUID/,
  );
  await assert.rejects(
    async () => runTask({ item: { id: 'c2', role: 'developer', taskDir, allowedPaths: [], promptFile }, bounds: validateBounds(), home, clock: fakeClock(), env: { SCW_SECRET_KEY: 'K', SCW_PROJECT_ID: 'not-a-uuid' } }),
    /UUID/,
  );
  const bad = path.join(taskDir, 'bad-utf8.bin');
  await fsp.writeFile(bad, Buffer.concat([Buffer.from('ok'), Buffer.from([0xff, 0xfe, 0xff])]));
  await assert.rejects(
    async () => runTask({ item: { id: 'c3', role: 'developer', taskDir, allowedPaths: [], promptFile: bad }, bounds: validateBounds(), home, clock: fakeClock(), env: ENV }),
    /not valid UTF-8/,
  );
  const empty = path.join(taskDir, 'empty.md');
  await fsp.writeFile(empty, '   \n', 'utf8');
  await assert.rejects(
    async () => runTask({ item: { id: 'c4', role: 'developer', taskDir, allowedPaths: [], promptFile: empty }, bounds: validateBounds(), home, clock: fakeClock(), env: ENV }),
    /empty/,
  );
});

test('reviewer runs on a copied snapshot; mutation is detected; original taskDir untouched', async () => {
  const home = await tmpdir();
  const taskDir = await tmpdir();
  const promptFile = await writePrompt(taskDir);
  await fsp.writeFile(path.join(taskDir, 'a.md'), 'synthetic', 'utf8');
  const up = mockUpstream();
  const url = await up.start();
  const promptText = await fsp.readFile(promptFile, 'utf8');
  const base = { bounds: validateBounds(), home, clock: fakeClock(), env: ENV, upstreamUrl: url };

  // benign reviewer: no writes -> completed
  const ok = await runTask({ ...base, item: { id: 'r1', role: 'reviewer', taskDir, allowedPaths: [], promptFile }, spawnFn: proxiedSpawn(promptText) });
  assert.equal(ok.status, 'completed');
  assert.ok(fs.existsSync(path.join(home, 'snapshots', 'r1', 'a.md')));

  // malicious reviewer: writes into its workspace -> hashes mismatch -> task fails
  const bad = await runTask({
    ...base, item: { id: 'r2', role: 'reviewer', taskDir, allowedPaths: [], promptFile },
    spawnFn: async (opts) => {
      await fsp.writeFile(path.join(opts.cwd, 'a.md'), 'tampered', 'utf8');
      return proxiedSpawn(promptText)(opts);
    },
  });
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /reviewer mutation detected: a\.md/);
  // original taskDir was never touched by the reviewer
  assert.equal(await fsp.readFile(path.join(taskDir, 'a.md'), 'utf8'), 'synthetic');
  await up.close();
});

test('reviewer snapshot skips secret-bearing and generated dirs; symlink refused', async () => {
  const home = await tmpdir();
  const taskDir = await tmpdir();
  const promptFile = await writePrompt(taskDir);
  for (const d of [...SNAPSHOT_SKIP]) {
    await fsp.mkdir(path.join(taskDir, d), { recursive: true });
    await fsp.writeFile(path.join(taskDir, d, 'f.txt'), 'x', 'utf8');
  }
  await fsp.writeFile(path.join(taskDir, 'f.md'), 'x', 'utf8');
  const up = mockUpstream();
  const url = await up.start();
  const out = await runTask({
    item: { id: 'r3', role: 'reviewer', taskDir, allowedPaths: [], promptFile },
    bounds: validateBounds(), home, clock: fakeClock(), env: ENV, upstreamUrl: url,
    spawnFn: proxiedSpawn(await fsp.readFile(promptFile, 'utf8')),
  });
  assert.equal(out.status, 'completed');
  const snap = path.join(home, 'snapshots', 'r3');
  assert.ok(fs.existsSync(path.join(snap, 'f.md')));
  for (const d of SNAPSHOT_SKIP) assert.ok(!fs.existsSync(path.join(snap, d)), `${d} must not be copied`);
  // symlink in the source tree is refused outright
  const withLink = await tmpdir();
  await fsp.writeFile(path.join(withLink, 'a.md'), 'x', 'utf8');
  const linkTarget = path.join(withLink, 'outside.md');
  await fsp.writeFile(linkTarget, 'x', 'utf8');
  try { await fsp.symlink(linkTarget, path.join(withLink, 'link.md'), 'file'); } catch { /* symlink creation may be unsupported; skip rest */ return await up.close(); }
  await assert.rejects(
    async () => runTask({
      item: { id: 'r4', role: 'reviewer', taskDir: withLink, allowedPaths: [], promptFile },
      bounds: validateBounds(), home: await tmpdir(), clock: fakeClock(), env: ENV, upstreamUrl: url,
      spawnFn: proxiedSpawn(await fsp.readFile(promptFile, 'utf8')),
    }),
    /symlink refused/,
  );
  await up.close();
});

test('terminal quota in a queued task: exactly one paid call, task fails, queue latches, recover works', async () => {
  const home = await tmpdir();
  const store = new QueueStore(home);
  const up = mockUpstream();
  up.script.push({ status: 402, body: JSON.stringify({ error: { message: 'INSUFFICIENT QUOTA for your billing plan' } }) });
  const url = await up.start();
  const taskDir = await tmpdir();
  const promptFile = await writePrompt(taskDir);
  const id = await enqueue({ store, role: 'developer', taskDir, allowedPaths: ['src/**'], promptFile });
  const res = await runNext({
    store, bounds: validateBounds(), home, clock: fakeClock(), upstreamUrl: url, env: ENV,
    spawnFn: proxiedSpawn(await fsp.readFile(promptFile, 'utf8')),
  });
  assert.equal(up.hits.length, 1); // exactly one paid call, no retries
  assert.equal(res.item.status, 'failed');
  assert.match(res.item.error, /quota/);
  const state = await store.load();
  assert.equal(state.circuit.open, true); // queue latched
  const second = await runNext({ store, bounds: validateBounds(), home, clock: fakeClock(), upstreamUrl: url, env: ENV, spawnFn: async () => ({ code: 0 }) });
  assert.ok(second.refused); // further runs refused until explicit recovery
  await clearCircuit(store);
  const after = await store.load();
  assert.equal(after.circuit.open, false);
  const revived = await recover({ store, id, mark: 'requeue' });
  assert.equal(revived.status, 'queued');
  await up.close();
});

test('session credit bounds persist on failure', async () => {
  const home = await tmpdir();
  const store = new QueueStore(home);
  const taskDir = await tmpdir();
  const promptFile = await writePrompt(taskDir);
  const up = mockUpstream();
  up.script.push({ status: 429, body: 'rate limited' });
  const url = await up.start();
  await enqueue({ store, role: 'developer', taskDir, allowedPaths: ['src/**'], promptFile });
  const res = await runNext({
    store, bounds: validateBounds({ maxUpstreamAttempts: 1, retryBaseMs: 1, maxRetryElapsedMs: 1000 }), home, clock: fakeClock(), upstreamUrl: url, env: ENV,
    spawnFn: async (opts) => {
      assert.equal(opts.prompt, await fsp.readFile(promptFile, 'utf8'));
      const cfg = JSON.parse(await fsp.readFile(opts.configPath, 'utf8'));
      const r = await fetch(`${cfg.providers['vc-scaleway'].settings.baseURL}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${cfg.providers['vc-scaleway'].settings.apiKey}`, 'content-type': 'application/json' }, body: BODY(),
      });
      assert.equal(r.status, 400); // local budget stop (guard before each attempt)
      return { code: 1, stdout: '' }; // worker itself fails
    },
  });
  assert.equal(res.item.status, 'failed');
  assert.equal(res.item.upstreamAttempts, 1);
  assert.ok(res.item.reservedTokens > 0, 'reserved tokens must persist on failure');
  await up.close();
});

test('separate queue instances cannot lose concurrent enqueues', async () => {
  const home = await tmpdir(), taskDir = await tmpdir(), promptFile = await writePrompt(taskDir);
  const ids = await Promise.all(Array.from({length: 20}, () => enqueue({store: new QueueStore(home), role:'developer', taskDir, allowedPaths:['a.ts'], promptFile})));
  const state = await new QueueStore(home).load();
  assert.equal(new Set(ids).size, 20); assert.equal(state.items.length, 20); assert.equal(state.counter, 20);
});
test('corrupt queue state and fresh empty lock fail closed', async () => {
  const home = await tmpdir(), store = new QueueStore(home);
  await fsp.writeFile(store.stateFile, '{bad'); await assert.rejects(() => store.load());
  await fsp.writeFile(store.runnerLockFile, ''); await assert.rejects(() => store.withRunner(async () => 1), LockHeld);
});
test('unknown successful usage reserves rolling quota and known actual cap stops', () => {
  const clock = fakeClock(), guard = new RequestGuard({clock, bounds:validateBounds({maxActualTokens: 10})});
  guard.noteAttempt(100); guard.noteSuccess(new Map(), null);
  assert.equal(guard.effectiveTpmRemaining(clock.now()), 199900); assert.equal(guard.usageKnown, false);
  guard.noteSuccess(new Map(), {total_tokens:10}); assert.match(guard.preflight(BODY(),100).reason, /actual-token/);
});
test('real project config is restored byte-for-byte after worker throws', async () => {
  const taskDir = await tmpdir(), home = await tmpdir(), promptFile = await writePrompt(taskDir);
  const original = Buffer.from(' {"synthetic": true}\r\n'); const config = path.join(taskDir, 'opencode.json'); await fsp.writeFile(config, original);
  const out = await runTask({item:{id:'restore',role:'developer',taskDir,promptFile,allowedPaths:['a.ts']},bounds:validateBounds(),home,env:ENV,spawnFn:async()=>{throw Error('synthetic crash');}});
  assert.equal(out.status,'failed'); assert.deepEqual(await fsp.readFile(config),original);
  assert.equal(JSON.parse(await fsp.readFile(path.join(home,'results','restore.json'))).status,'failed');
});
test('reviewer works when default home is inside source and never copies secret files', async () => {
  const taskDir = await tmpdir(), home = path.join(taskDir,'.glm-workflow'), promptFile = await writePrompt(taskDir);
  await fsp.writeFile(path.join(taskDir,'.env'),'SYNTHETIC'); const up=mockUpstream(); const url=await up.start();
  const result=await runTask({item:{id:'internal',role:'reviewer',taskDir,promptFile,allowedPaths:[]},bounds:validateBounds(),home,env:ENV,upstreamUrl:url,spawnFn:proxiedSpawn(await fsp.readFile(promptFile,'utf8'))});
  assert.equal(result.status,'completed'); assert.ok(!fs.existsSync(path.join(result.snapshotDir,'.env'))); await up.close();
});
