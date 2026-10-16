#!/usr/bin/env node
// Local GLM worker queue + request guard. See docs/glm-workflow.md.
// Node 24 built-ins only. No new dependencies. No shell interpolation.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = Object.freeze({
  maxUpstreamAttempts: 40,       // session bound: upstream requests per task (survives client retries)
  maxActualTokens: 300000,       // known actual usage ceiling; reservations bound unknown usage
  maxReservedTokens: 1000000,     // session bound: cumulative reserved tokens per task
  maxSessionMs: 12 * 60 * 1000, // session bound: wall clock per task
  maxOutputTokens: 8000,        // per-request output cap (also written to the model config)
  tpm: 200000,                  // nominal TPM from live Scaleway headers
  rpm: 300,                     // nominal RPM from live Scaleway headers
  margin: 0.2,                  // configurable safety margin on shared-organization quota
  maxRetries: 2,                // upstream retries for temporary conditions
  retryBaseMs: 500,             // exponential backoff base when no Retry-After
  maxRetryElapsedMs: 30_000,    // max total elapsed retrying one upstream request
  upstreamTimeoutMs: 120_000,   // per upstream request
  stepsCap: 40,                 // agent steps cap in generated config
  staleLockMs: 15 * 60 * 1000,
});

// Verified live endpoint (2026-10-15): https://api.scaleway.ai/{project}/v1/chat/completions.
// The host is fixed; the project ID is validated and embedded in the path. Redirects are blocked.
export const UPSTREAM = Object.freeze({
  host: 'api.scaleway.ai',
  pathFor: (projectId) => `/${projectId}/v1/chat/completions`,
  model: 'glm-5.3',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateProjectId(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id.trim()))
    throw new Error('SCW_PROJECT_ID must be a Scaleway project UUID (e.g. 11111111-1111-1111-1111-111111111111)');
  return id.trim();
}

export function buildUpstreamUrl(projectId) {
  return `https://${UPSTREAM.host}${UPSTREAM.pathFor(validateProjectId(projectId))}`;
}

export const REASONING_EFFORT = 'low';

export const DEFAULT_SYSTEM_PROMPT = 'You are a Vault Companion worker. Follow the task brief exactly; all model traffic goes through the local proxy. Never print secrets or private vault text.';

export const ROLES = Object.freeze({
  developer: {
    canApprove: false,
    description: 'Implementation worker. May edit only assigned paths. No blanket shell access.',
  },
  'test-analyst': {
    canApprove: false, // test analyst can never approve work
    description: 'Runs and analyses tests. Cannot approve work. May edit only assigned paths.',
  },
  reviewer: {
    canApprove: true,
    description: 'Read-only reviewer on a copied snapshot. Cannot edit, cannot run shell, cannot spawn subagents, cannot access external directories.',
    read_only: true,
  },
});

// ---------- small utils ----------

export function defaultClock() {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export async function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, file);
}

export async function hashTree(dir, base = dir, out = new Map()) {
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) throw new Error(`symlink refused while hashing: ${p}`);
    if (ent.isDirectory()) await hashTree(p, base, out);
    else if (ent.isFile()) {
      const buf = await fsp.readFile(p);
      out.set(path.relative(base, p).replaceAll('\\', '/'), crypto.createHash('sha256').update(buf).digest('hex'));
    }
  }
  return out;
}

// Snapshot hygiene: never copy secret-bearing / generated / huge directories.
export const SNAPSHOT_SKIP = Object.freeze(new Set(['.git', '.glm-workflow', 'node_modules', '.agent', '.opencode', 'runtime']));

async function copyTree(src, dest, skip = SNAPSHOT_SKIP) {
  // Reject recursive copy (destination inside source) and path traversal.
  const rel = path.relative(path.resolve(src), path.resolve(dest));
  if (rel === '' || (!rel.split(path.sep).includes('..') && rel !== '')) {
    throw new Error('snapshot destination must be outside the source tree');
  }
  await fsp.mkdir(dest, { recursive: true });
  for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
    if (skip.has(ent.name) || /^(?:opencode\.jsonc?|\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/i.test(ent.name)) continue;
    if (ent.isSymbolicLink()) throw new Error(`symlink refused in snapshot copy: ${ent.name}`);
    const s = path.join(src, ent.name);
    if (ent.isDirectory()) await copyTree(s, path.join(dest, ent.name), skip);
    else if (ent.isFile()) await fsp.copyFile(s, path.join(dest, ent.name));
  }
}

// ---------- Retry-After / rate header parsing ----------

export function parseReset(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d+)\s*(ms|s|m)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return unit === 'ms' ? n : unit === 's' ? n * 1000 : n * 60_000;
}

export function parseRetryAfter(v, nowMs) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Number(s)) * 1000; // delta-seconds
  if (/^\d+\s*(ms|s|m)$/i.test(s)) return parseReset(s); // e.g. "120ms"
  const d = Date.parse(s);
  if (!Number.isNaN(d)) return Math.max(0, d - nowMs); // HTTP-date
  return null;
}

export function parseRateHeaders(h) {
  const out = {};
  const get = (k) => (h.get ? h.get(k) : h[k]);
  for (const [hdr, key] of [
    ['x-ratelimit-remaining-tokens', 'tpmRemaining'],
    ['x-ratelimit-limit-tokens', 'tpmLimit'],
    ['x-ratelimit-remaining-requests', 'rpmRemaining'],
    ['x-ratelimit-limit-requests', 'rpmLimit'],
  ]) {
    const v = get(hdr);
    if (v != null && /^\d+$/.test(String(v).trim())) out[key] = Number(v);
  }
  for (const [hdr, key] of [['x-ratelimit-reset-tokens', 'resetTokensMs'], ['x-ratelimit-reset-requests', 'resetRequestsMs']]) {
    const v = get(hdr);
    if (v != null) { const ms = parseReset(String(v)); if (ms != null) out[key] = ms; }
  }
  return out;
}

export function extractUsage(bodyText) {
  // SSE: last data: chunk carrying usage; JSON: top-level usage object.
  if (typeof bodyText !== 'string' || !bodyText) return { usage: null, usageKnown: false };
  if (bodyText.includes('data:')) {
    let usage = null;
    for (const line of bodyText.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        if (obj.usage) usage = obj.usage; // keep the last one (final)
      } catch { /* skip malformed keepalive lines */ }
    }
    return { usage, usageKnown: usage != null };
  }
  try {
    const obj = JSON.parse(bodyText);
    if (obj.usage) return { usage: obj.usage, usageKnown: true };
  } catch { /* not JSON */ }
  return { usage: null, usageKnown: false };
}

const TERMINAL_QUOTA = /insufficient\s*quota|quota\s*(exceeded|exhaust)|billing|payment\s*required|exhausted/i;

export function classifyUpstream(status, bodyText) {
  // kind: 'ok'|'temporary'|'auth'|'quota'|'ambiguous'|'client'
  if (status === 429) {
    if (TERMINAL_QUOTA.test(bodyText)) return { kind: 'quota' };
    if (/quota/i.test(bodyText) && !/rate\s*limit/i.test(bodyText)) return { kind: 'ambiguous' };
    return { kind: 'temporary' };
  }
  if (status === 401 || status === 403) return { kind: 'auth' };
  if (status >= 500) return { kind: 'temporary' };
  if (status >= 400) return TERMINAL_QUOTA.test(bodyText) ? { kind: 'quota' } : { kind: 'client' };
  return { kind: 'ok' };
}

// ---------- request guard (semaphore + budgets + rate window) ----------

export class RequestGuard {
  constructor({ clock = defaultClock(), bounds, defaults = DEFAULTS }) {
    this.clock = clock;
    this.defaults = defaults;
    this.b = bounds; // validated downward-bounded session bounds
    this.upstreamAttempts = 0;       // upstream request limit survives client retries
    this.reservedTotal = 0;
    this.sessionStartMs = clock.now();
    this.live = {};                  // parsed live rate headers (+ updatedAt)
    this.windowRequests = [];         // timestamps of upstream requests (RPM window)
    this.localTokens = [];            // rolling {t,n} local reservations when headers absent
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.usageKnown = true;          // flipped false the first time usage is missing
    this._queue = Promise.resolve();  // semaphore(1): one upstream request at a time
  }

  elapsedMs() { return this.clock.now() - this.sessionStartMs; }

  reserve(bodyText, maxTokens) {
    // Conservative estimate: UTF-8 bytes of the request + max output. Explicitly a
    // byte-based estimate, not a tokenizer guarantee.
    const bytes = Buffer.byteLength(String(bodyText), 'utf8');
    return Math.ceil((bytes + maxTokens) * (1 + this.b.margin));
  }

  // Live quota tracking: server headers win while fresh; they reset with the
  // clock; local rolling reservations cover the header-absent case. Never
  // double-subtract: when the server already updated `remaining`, usage is NOT
  // subtracted locally (see noteSuccess).
  effectiveTpmRemaining(now) {
    const candidates = [];
    const fresh = this.live.updatedAt != null && now - this.live.updatedAt < (this.live.resetTokensMs ?? 60_000);
    if (fresh && this.live.tpmRemaining != null) candidates.push(this.live.tpmRemaining);
    const limit = this.live.tpmLimit ?? this.defaults.tpm;
    const usedLocally = this.localTokens.filter((e) => now - e.t < 60_000).reduce((s, e) => s + e.n, 0);
    candidates.push(Math.max(0, limit - usedLocally));
    return Math.min(...candidates);
  }

  effectiveRpmRemaining(now) {
    const candidates = [];
    const fresh = this.live.requestsUpdatedAt != null && now - this.live.requestsUpdatedAt < (this.live.resetRequestsMs ?? 60_000);
    if (fresh && this.live.rpmRemaining != null) candidates.push(this.live.rpmRemaining);
    const limit = this.live.rpmLimit ?? this.defaults.rpm;
    this.windowRequests = this.windowRequests.filter((t) => now - t < 60_000);
    candidates.push(Math.max(0, limit - this.windowRequests.length));
    return Math.min(...candidates);
  }

  preflight(bodyText, maxTokens) {
    const now = this.clock.now();
    if (this.upstreamAttempts + 1 > this.b.maxUpstreamAttempts)
      return { ok: false, status: 400, retryable: false, reason: `session upstream attempt budget exceeded (${this.b.maxUpstreamAttempts})` };
    if (this.elapsedMs() >= this.b.maxSessionMs)
      return { ok: false, status: 400, retryable: false, reason: `session time budget exceeded (${this.b.maxSessionMs}ms)` };
    if (this.usage.totalTokens >= this.b.maxActualTokens) return { ok: false, status: 400, retryable: false, reason: 'actual-token budget exceeded' };
    const reserve = this.reserve(bodyText, maxTokens);
    if (this.reservedTotal + reserve > this.b.maxReservedTokens)
      return { ok: false, status: 400, retryable: false, reason: `session reserved-token budget exceeded (${this.b.maxReservedTokens})` };
    if (reserve > this.effectiveTpmRemaining(now) * (1 - this.b.margin))
      return { ok: false, status: 429, retryable: true, reason: 'local TPM reservation would exceed remaining quota', retryAfterMs: this.live.resetTokensMs ?? 60_000 };
    if (1 > this.effectiveRpmRemaining(now) * (1 - this.b.margin))
      return { ok: false, status: 429, retryable: true, reason: 'local RPM window would be exceeded', retryAfterMs: this.live.resetRequestsMs ?? 60_000 };
    return { ok: true, reserve };
  }

  noteAttempt(reserve) {
    // Atomic per send: attempt count and token reservation happen together,
    // BEFORE the fetch, so a network failure still conservatively bills.
    this.upstreamAttempts++;
    this.windowRequests.push(this.clock.now());
    this.reservedTotal += reserve;
    this.pendingReservation = reserve;
  }

  noteFailure(reserve) {
    // Network/timeout failure with unknown billing: count the full reservation
    // in the local rolling window.
    this.localTokens.push({ t: this.clock.now(), n: reserve });
    if (this.live.tpmRemaining != null) this.live.tpmRemaining = Math.max(0, this.live.tpmRemaining - reserve);
    if (this.live.rpmRemaining != null) this.live.rpmRemaining = Math.max(0, this.live.rpmRemaining - 1);
    this.pendingReservation = 0;
    this.usageKnown = false;
  }

  noteSuccess(headers, usage) {
    const parsed = parseRateHeaders(headers);
    const charged = usage && Number.isFinite(usage.total_tokens) && usage.total_tokens >= 0
      ? usage.total_tokens : (this.pendingReservation ?? this.b.maxOutputTokens);
    if (parsed.tpmRemaining == null && this.live.tpmRemaining != null)
      this.live.tpmRemaining = Math.max(0, this.live.tpmRemaining - charged);
    if (parsed.rpmRemaining == null && this.live.rpmRemaining != null)
      this.live.rpmRemaining = Math.max(0, this.live.rpmRemaining - 1);
    // Only a remaining-tokens header refreshes the token ceiling's expiry.
    if (parsed.tpmRemaining != null) this.live.updatedAt = this.clock.now();
    if (parsed.rpmRemaining != null) this.live.requestsUpdatedAt = this.clock.now();
    Object.assign(this.live, parsed);
    if (usage && Number.isFinite(usage.total_tokens)) {
      // No double-subtract: if the server already updated `remaining` in this
      // response, local rolling accounting must NOT subtract usage again.
      if (parsed.tpmRemaining == null) this.localTokens.push({ t: this.clock.now(), n: usage.total_tokens });
      this.usage.promptTokens += Number(usage.prompt_tokens ?? 0);
      this.usage.completionTokens += Number(usage.completion_tokens ?? 0);
      this.usage.totalTokens += Number(usage.total_tokens ?? 0);
    } else {
      this.localTokens.push({ t: this.clock.now(), n: charged });
      this.usageKnown = false; // unknown, reserve conservatively, never zero
    }
    this.pendingReservation = 0;
  }

  withSlot(fn) { // semaphore(1)
    const run = this._queue.then(fn, fn);
    this._queue = run.then(() => {}, () => {});
    return run;
  }
}

// ---------- loopback proxy (owns ALL upstream GLM requests) ----------

function errorBody(message, type) {
  return JSON.stringify({ error: { message, type } });
}

export function createProxy({ guard, nonce, secretKey, projectId, model = UPSTREAM.model, upstreamUrl, clock = defaultClock(), onCircuit = () => {}, onProgress = async () => {} }) {
  const url = upstreamUrl ?? buildUpstreamUrl(projectId);
  const latched = { open: false, kind: null, detail: null }; // blocks subsequent client calls in THIS proxy immediately
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(errorBody('proxy failure', 'proxy_error')); }
      else res.end();
    });
  });

  function latch(kind, detail) {
    latched.open = true; latched.kind = kind; latched.detail = detail;
    onCircuit(kind, detail);
  }

  async function handle(req, res) {
    if (req.method !== 'POST' || !['/v1/chat/completions', '/chat/completions'].includes(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(errorBody('only POST /chat/completions is routed', 'route_forbidden'));
    }
    if (String(req.headers.authorization ?? '') !== `Bearer ${nonce}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(errorBody('invalid proxy credential', 'auth'));
    }
    if (latched.open) { // terminal condition already seen: block immediately, no more paid calls
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(errorBody(`circuit latched (${latched.kind}): ${latched.detail}; not retryable`, 'circuit_nonretryable'));
    }
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 2_000_000) { res.writeHead(400); res.end(errorBody('request too large', 'bad_request')); return; }
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = JSON.parse(raw); } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(errorBody('invalid JSON body', 'bad_request'));
    }
    if (body.model !== model) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(errorBody(`model must be ${model} (fixed by policy)`, 'model_forbidden'));
    }
    // Normalize the forwarded body: strip the conflicting key, INSERT a real
    // (capped) max_tokens when missing — never merely estimate it.
    delete body.max_completion_tokens;
    if (body.max_tokens == null) body.max_tokens = guard.b.maxOutputTokens;
    const maxTokens = Number(body.max_tokens);
    if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > guard.b.maxOutputTokens) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(errorBody(`max_tokens must be between 0 and ${guard.b.maxOutputTokens}`, 'bad_request'));
    }
    // Ask for usage on streaming so cost accounting is not silently unknown.
    if (body.stream) body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    const forwarded = JSON.stringify(body);
    await guard.withSlot(() => upstreamRoundTrip(forwarded, maxTokens, res));
  }

  async function upstreamRoundTrip(bodyText, maxTokens, res) {
    const t0 = clock.now();
    const sessionEnd = guard.sessionStartMs + guard.b.maxSessionMs;
    let deadline = Math.min(t0 + guard.b.maxRetryElapsedMs, sessionEnd);

    function localTerminal(message, type) { // all terminal paths are local 400, never 502: clients must not multiply retries
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(errorBody(message, type));
    }

    function localPreflightFail(pre) {
      const headers = { 'content-type': 'application/json' };
      if (pre.retryable && pre.retryAfterMs != null) headers['retry-after'] = String(Math.max(1, Math.ceil(pre.retryAfterMs / 1000)));
      res.writeHead(pre.status, headers);
      res.end(errorBody(pre.reason, pre.retryable ? 'rate_limited_local' : 'budget_exceeded'));
    }

    for (let attempt = 0; ; attempt++) {
      // Guard runs before EACH attempt, including retries.
      if (latched.open) return localTerminal('circuit latched; not retryable', 'circuit_nonretryable');
      let pre = guard.preflight(bodyText, maxTokens);
      // Wait locally for a rate window, bounded by the task deadline. Oversized
      // contexts can never fit and must not be retried or sent to the provider.
      if (!pre.ok && pre.retryable && guard.reserve(bodyText, maxTokens) <= guard.b.tpm * (1 - guard.b.margin)) {
        const wait = Math.min(pre.retryAfterMs ?? 60_000, 60_001) + 1;
        if (clock.now() + wait < sessionEnd) {
          await clock.sleep(wait);
          deadline = Math.min(clock.now() + guard.b.maxRetryElapsedMs, sessionEnd);
          pre = guard.preflight(bodyText, maxTokens);
        }
      }
      if (!pre.ok) { latch('local-budget', pre.reason); return localTerminal(pre.reason, 'budget_exceeded'); }
      guard.noteAttempt(pre.reserve); // atomic attempt increment + reservation BEFORE the fetch
      await onProgress(guard); // durable reservation before any paid send
      let upstreamRes, text;
      try {
        upstreamRes = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}` },
          body: bodyText,
          redirect: 'error', // fixed verified host; redirects are refused
          signal: AbortSignal.timeout(Math.max(1, Math.min(guard.b.upstreamTimeoutMs, sessionEnd - clock.now()))),
        });
        text = await upstreamRes.text();
      } catch { // network / timeout: temporary, bounded retry; reservation already counted
        guard.noteFailure(pre.reserve);
        if (attempt >= guard.b.maxRetries || clock.now() - t0 >= guard.b.maxRetryElapsedMs)
          return localTerminal('upstream network/timeout condition persisted after bounded retries; not retryable', 'upstream_temporary_nonretryable');
        const delay = guard.b.retryBaseMs * 2 ** attempt;
        if (clock.now() + delay > deadline)
          return localTerminal('retry delay cannot fit before the retry/session deadline; stopping without retrying', 'retry_deadline_nonretryable');
        await clock.sleep(delay);
        continue;
      }
      const cls = classifyUpstream(upstreamRes.status, text);
      if (cls.kind === 'ok') {
        const { usage } = extractUsage(text);
        guard.noteSuccess(upstreamRes.headers, usage);
        await onProgress(guard);
        res.writeHead(upstreamRes.status, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' });
        return res.end(text); // absent usage stays unknown; nothing is logged
      }
      guard.noteFailure(pre.reserve);
      await onProgress(guard);
      if (cls.kind === 'auth') {
        latch('auth', `upstream ${upstreamRes.status} rejected authentication`);
        return localTerminal('upstream authentication failed; not retryable', 'auth_nonretryable');
      }
      if (cls.kind === 'quota') {
        latch('quota', `upstream terminal quota/billing condition (${upstreamRes.status})`);
        return localTerminal('upstream quota/billing exhaustion; not retryable', 'quota_nonretryable');
      }
      if (cls.kind === 'ambiguous') {
        latch('ambiguous-quota', `upstream ${upstreamRes.status} mentioned quota ambiguously; stopped without retry`);
        return localTerminal('ambiguous quota condition; stopped without retry; needs operator review', 'quota_ambiguous');
      }
      if (cls.kind === 'client') { // pass through other 4xx; clients do not multiply these into retries
        res.writeHead(upstreamRes.status, { 'content-type': 'application/json' });
        return res.end(text);
      }
      // temporary (429/5xx): bounded backoff, honor Retry-After without shortening it
      if (attempt >= guard.b.maxRetries || clock.now() - t0 >= guard.b.maxRetryElapsedMs)
        return localTerminal('upstream temporary condition persisted after bounded retries; not retryable', 'upstream_temporary_nonretryable');
      const ra = parseRetryAfter(upstreamRes.headers.get('retry-after'), clock.now());
      const delay = Math.max(ra ?? 0, guard.b.retryBaseMs * 2 ** attempt); // never retry earlier than the server asked
      if (clock.now() + delay > deadline)
        return localTerminal(`Retry-After (${delay}ms) cannot fit before the retry/session deadline; stopping without retrying`, 'retry_deadline_nonretryable');
      await clock.sleep(delay);
    }
  }

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    latched,
  };
}

// ---------- queue store (inter-process locking) ----------

export class LockHeld extends Error {
  constructor(pid, since) { super(`another process (pid ${pid}, since ${new Date(since).toISOString()}) holds the lock`); this.code = 'LOCK_HELD'; }
}

export class QueueStore {
  constructor(home) {
    this.home = home;
    this.stateFile = path.join(home, 'state.json');
    this.runnerLockFile = path.join(home, 'active.lock'); // LONG: held for the whole task run
    this.stateLockFile = path.join(home, 'state.lock');    // SHORT: held only for state read-modify-write
    this._stateChain = Promise.resolve();                    // in-process state mutex
  }

  async load() {
    try { return JSON.parse(await fsp.readFile(this.stateFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; return { version: 1, counter: 0, circuit: { open: false, reason: null, at: null }, items: [] }; }
  }

  async save(state) {
    await writeFileAtomic(this.stateFile, JSON.stringify(state, null, 2));
  }

  // Short state mutex: enqueue/status/save work WHILE a runner is active.
  withState(fn) {
    const locked = async () => {
      const until = Date.now() + 10_000;
      while (true) {
        try { return await this.withLock(this.stateLockFile, fn); }
        catch (e) { if (e.code !== 'LOCK_HELD' || Date.now() >= until) throw e; await new Promise(r => setTimeout(r, 20)); }
      }
    };
    const run = this._stateChain.then(locked, locked);
    this._stateChain = run.then(() => {}, () => {});
    return run;
  }

  async withLock(lockFile, fn, { staleMs = DEFAULTS.staleLockMs, clock = defaultClock() } = {}) {
    await fsp.mkdir(path.dirname(lockFile), { recursive: true });
    const info = await this.tryAcquire(lockFile, staleMs, clock);
    if (!info.acquired) throw new LockHeld(info.pid ?? 'unknown', info.since ?? clock.now());
    try { return await fn(); }
    finally { await fsp.rm(lockFile, { force: true }); }
  }

  // Long runner lock (whole task) and short state lock use different files so
  // enqueueing never waits on an active runner.
  withRunner(fn, opts) { return this.withLock(this.runnerLockFile, fn, opts); }

  // Workspace lock keyed by the RESOLVED workspace path, stored in the OS temp
  // dir: two different --home values cannot run writers on the same workspace.
  workspaceLockFile(workspace) {
    const h = crypto.createHash('sha256').update(process.platform === 'win32' ? fs.realpathSync(workspace).toLowerCase() : fs.realpathSync(workspace)).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), `glm-workflow-ws-${h}.lock`);
  }

  withWorkspace(workspace, fn, opts) { return this.withLock(this.workspaceLockFile(workspace), fn, opts); }

  async tryAcquire(lockFile, staleMs, clock) {
    for (let i = 0; i < 2; i++) {
      const fd = await fsp.open(lockFile, 'wx').catch((e) => (e.code === 'EEXIST' ? null : Promise.reject(e)));
      if (fd) {
        await fd.write(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        await fd.close();
        return { acquired: true };
      }
      const stat = await fsp.stat(lockFile).catch(() => null);
      if (!stat) continue; // vanished between open and stat; retry
      const fresh = clock.now() - stat.mtimeMs < staleMs;
      const contents = await fsp.readFile(lockFile, 'utf8').catch(() => '');
      let prev; try { prev = JSON.parse(contents); } catch { return { acquired: false, since: stat.mtimeMs }; }
      let alive = false;
      if (prev.pid) { try { process.kill(prev.pid, 0); alive = true; } catch { alive = false; } }
      if (alive) return { acquired: false, pid: prev.pid, since: stat.mtimeMs }; // never steal a LIVE holder, even a long-running one
      if (prev.pid == null && fresh) return { acquired: false, pid: null, since: stat.mtimeMs }; // unknown holder, still fresh: leave it
      // Serialize stale recovery, then compare the exact owner before unlinking.
      const reaper = await fsp.open(lockFile + '.reaper', 'wx').catch(e => e.code === 'EEXIST' ? null : Promise.reject(e));
      if (!reaper) return { acquired: false, since: stat.mtimeMs };
      try { if (await fsp.readFile(lockFile, 'utf8').catch(() => '') === contents) await fsp.rm(lockFile, { force: true }); }
      finally { await reaper.close(); await fsp.rm(lockFile + '.reaper', { force: true }); }
    }
    return { acquired: false, since: clock.now() };
  }

  item(state, id) { return state.items.find((i) => i.id === id); }
}

// ---------- bounds + V2 config generation ----------

export function validateBounds(overrides = {}) {
  const b = { ...DEFAULTS };
  const downward = Object.keys(DEFAULTS).filter(k => k !== 'margin');
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in DEFAULTS)) throw new Error(`unknown bound: ${k}`);
    if (k === 'margin') { // configurable safety margin: 0..0.9
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 0.9) throw new Error('bound margin must be a number in [0, 0.9]');
      b.margin = v;
      continue;
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`bound ${k} must be a positive number`);
    if (downward.includes(k) && v > DEFAULTS[k]) throw new Error(`bound ${k} is only configurable downward (max ${DEFAULTS[k]})`);
    b[k] = v;
  }
  return b;
}

// OpenCode V2 config (https://opencode.ai/v2/docs/config, /agents). Mirrors the
// KNOWN WORKING root opencode.json shapes. No legacy provider/options/agent/
// permission top-level keys.
export function buildConfig({ port, nonce, model = UPSTREAM.model, role, allowedPaths = [], stepsCap = DEFAULTS.stepsCap, maxOutputTokens = DEFAULTS.maxOutputTokens, reasoningEffort = REASONING_EFFORT }) {
  const def = ROLES[role];
  if (!def) throw new Error(`unknown role ${role}`);
  const denyAll = [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'edit', resource: '**', effect: 'deny' },
    { action: 'bash', resource: '**', effect: 'deny' },
    { action: 'shell', resource: '**', effect: 'deny' },
    { action: 'external_directory', resource: '**', effect: 'deny' },
    { action: 'subagent', resource: '**', effect: 'deny' },
    { action: 'web', resource: '**', effect: 'deny' },
    { action: 'webfetch', resource: '**', effect: 'deny' },
  ];
  const readOnly = [
    ...denyAll,
    { action: 'write', resource: '**', effect: 'deny' }, // reviewer never writes reports
    { action: 'read', resource: '**', effect: 'allow' },
    { action: 'glob', resource: '**', effect: 'allow' },
    { action: 'grep', resource: '**', effect: 'allow' },
  ];
  const developer = [
    ...denyAll,
    ...allowedPaths.map((p) => ({ action: 'edit', resource: p, effect: 'allow' })), // narrow allows after blanket denies
    { action: 'read', resource: '**', effect: 'allow' },
    { action: 'glob', resource: '**', effect: 'allow' },
    { action: 'grep', resource: '**', effect: 'allow' },
  ];
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `vc-scaleway/${model}`,
    providers: {
      'vc-scaleway': {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: nonce },
        models: {
          [model]: { modelID: model, body: { max_tokens: maxOutputTokens, reasoning_effort: reasoningEffort } },
        },
      },
    },
    agents: {
      [role]: {
        mode: 'primary',
        system: DEFAULT_SYSTEM_PROMPT,
        description: def.description,
        steps: stepsCap,
        permissions: [...(def.read_only ? readOnly : developer),
          ...['**/.env*', '**/.dev.vars*', '**/opencode.json*', '**/.agent/**', '**/.git/**', '**/.glm-workflow/**', '**/.opencode/**'].map(resource => ({ action: 'read', resource, effect: 'deny' })),
        ],
      },
    },
    tool_output: role === 'reviewer' ? { max_lines: 1600, max_bytes: 90000 } : { max_lines: 100, max_bytes: 7000 },
    snapshots: false,
    compaction: { auto: false },
    warming: false,
  };
}

// ---------- process spawning ----------

export function resolveOpencode(explicit) {
  if (explicit) { if (fs.existsSync(explicit)) return explicit; throw new Error(`--opencode path not found: ${explicit}`); }
  if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) return process.env.OPENCODE_BIN;
  const probe = process.platform === 'win32' ? spawnSync('where.exe', ['opencode'], { encoding: 'utf8' }) : spawnSync('which', ['opencode'], { encoding: 'utf8' });
  const hits = (probe.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // `where` may list a .cmd/.ps1 wrapper first; prefer the installed NATIVE exe.
  const npmNative = path.join(process.env.APPDATA ?? '', 'npm/node_modules/@opencode/cli/bin/opencode.exe');
  const native = hits.find((h) => /\.exe$/i.test(h)) ?? (fs.existsSync(npmNative) ? npmNative : hits.find(h => !/\.(cmd|ps1|bat)$/i.test(h)));
  if (native && fs.existsSync(native)) return native;
  throw new Error('opencode executable not found on PATH (or set OPENCODE_BIN / --opencode)');
}

export function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } }
}

// Child credentials sanitized: the child sees ONLY the proxy nonce (in the
// config file) — SCW_* secrets are stripped from its environment.
export function sanitizeChildEnv(env, configPath) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^SCW_|(?:API_KEY|SECRET|TOKEN|PASSWORD)$/i.test(k)) delete out[k];
  delete out.OPENCODE_CONFIG; // The temporary root config is restored in finally.
  delete out.OPENCODE_CONFIG_CONTENT;
  delete out.OPENCODE_CONFIG_DIR;
  return out;
}

export function spawnOpencode({ exe, role, model = UPSTREAM.model, cwd, configPath, prompt, env = process.env, timeoutMs }) {
  return new Promise((resolve) => {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      resolve({ code: 2, stdout: '', stderr: 'no validated prompt to run', killed: false });
      return;
    }
    // The ACTUAL prompt is passed as argv; array args (no shell interpolation);
    // stdin closed; detached on POSIX for group kill.
    const child = spawn(exe, ['run', prompt, '--standalone', '--model', `vc-scaleway/${model}`, '--agent', role, '--format', 'json'], {
      cwd, env: sanitizeChildEnv(env, configPath), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let out = '', errOut = '', killed = false;
    const timer = setTimeout(() => { killed = true; killTree(child.pid); }, Math.max(1, timeoutMs));
    const onInt = () => { killed = true; killTree(child.pid); }; // Ctrl+C must not leave a paid orphan running
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onInt);
    child.stdout.on('data', (d) => { out = (out + d).slice(-2_000_000); });
    child.stderr.on('data', (d) => { errOut = (errOut + d).slice(-100_000); });
    child.on('error', (e) => { clearTimeout(timer); process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onInt); resolve({ code: 1, error: String(e), stdout: out, stderr: errOut, killed: false }); });
    child.on('close', (code) => { clearTimeout(timer); process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onInt); resolve({ code: code ?? (killed ? 124 : 1), stdout: out, stderr: errOut, killed }); });
  });
}

// ---------- run output analysis ----------

export function parseRunOutput(stdout) {
  // Compact final-text capture: last assistant message only. Full tool
  // transcripts are never saved as normal results.
  let finalText = null;
  const errorEvents = [];
  let sawEvents = false;
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || !s.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    sawEvents = true;
    if (o.type === 'error' || o.level === 'error') errorEvents.push(o);
    if (o.type === 'text' && o.part?.text) finalText = o.part.text;
    if (o.type === 'message' && o.role !== 'user' && Array.isArray(o.parts)) {
      const txt = o.parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
      if (txt) finalText = txt;
    }
  }
  if (!sawEvents) {
    const plain = String(stdout ?? '').trim();
    if (plain) finalText = plain; // non-JSON run output fallback
  }
  return { finalText, errorEvents };
}

// ---------- task runner ----------

export async function runTask({ item, bounds, home, clock = defaultClock(), spawnFn = spawnOpencode, env = process.env, exe = 'opencode', upstreamUrl }) {
  const t0 = clock.now();
  const secretKey = env.SCW_SECRET_KEY;
  const projectId = validateProjectId(env.SCW_PROJECT_ID);
  if (!secretKey) throw new Error('SCW_SECRET_KEY and SCW_PROJECT_ID must be set in the environment at runtime');

  // Read and validate the prompt file (strict UTF-8, non-empty); it is what
  // actually gets passed to the spawned process — nothing else stands in.
  const promptBuf = await fsp.readFile(item.promptFile);
  const promptText = promptBuf.toString('utf8');
  if (!Buffer.from(promptText, 'utf8').equals(promptBuf)) throw new Error(`prompt file is not valid UTF-8: ${item.promptFile}`);
  if (!promptText.trim()) throw new Error(`prompt file is empty: ${item.promptFile}`);

  const roleDef = ROLES[item.role];
  if (!roleDef) throw new Error('invalid worker role');
  const inside = !path.relative(path.resolve(item.taskDir), path.resolve(home)).startsWith('..');
  const snapshotBase = inside ? await fsp.mkdtemp(path.join(os.tmpdir(), 'glm-review-')) : path.join(home, 'snapshots');
  const workDir = roleDef.read_only ? path.join(snapshotBase, item.id) : item.taskDir; // reviewer runs on a copied snapshot
  if (roleDef.read_only) {
    if (fs.existsSync(workDir)) throw new Error('snapshot already exists; refusing to overwrite evidence');
    await copyTree(item.taskDir, workDir); // rejects dest-inside-src, symlinks, secret-bearing dirs
  }
  for (const name of ['opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'])
    if (fs.existsSync(path.join(workDir, name))) throw new Error('conflicting project config: ' + name);
  const before = roleDef.read_only ? await hashTree(workDir) : null;
  const nonce = crypto.randomBytes(24).toString('hex');
  const guard = new RequestGuard({ clock, bounds });
  const circuit = { open: false, kind: null, detail: null };
  const proxy = createProxy({
    guard, nonce, secretKey, projectId, clock, upstreamUrl,
    onProgress: async g => writeFileAtomic(path.join(home, 'results', item.id + '.progress.json'), JSON.stringify({ upstreamAttempts: g.upstreamAttempts, reservedTokens: g.reservedTotal, usage: g.usage, usageKnown: g.usageKnown })),
    onCircuit: (kind, detail) => { circuit.open = true; circuit.kind = kind; circuit.detail = detail; },
  });
  const configPath = path.join(workDir, 'opencode.json');
  const originalConfig = await fsp.readFile(configPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const port = await proxy.listen();
  try { await writeFileAtomic(configPath, JSON.stringify(buildConfig({ port, nonce, role: item.role, allowedPaths: item.allowedPaths, stepsCap: bounds.stepsCap, maxOutputTokens: bounds.maxOutputTokens }), null, 2)); } catch (e) { await proxy.close(); throw e; }
  let result;
  try {
    result = await spawnFn({ exe, role: item.role, cwd: workDir, configPath, prompt: promptText, timeoutMs: Math.max(1000, bounds.maxSessionMs - guard.elapsedMs()), env });
  } catch (e) { result = { code: 1, stdout: '', stderr: String(e.message) };
  } finally {
    await proxy.close();
    if (originalConfig === null) await fsp.rm(configPath, { force: true });
    else await fsp.writeFile(configPath, originalConfig); // restore user's exact configuration
  }
  const { finalText, errorEvents } = parseRunOutput(result.stdout);
  const usageKnown = guard.usageKnown;
  const out = {
    exitCode: result.code, killed: !!result.killed, durationMs: clock.now() - t0,
    upstreamAttempts: guard.upstreamAttempts, reservedTokens: guard.reservedTotal,
    usage: guard.usage, usageKnown, finalText, circuit, snapshotDir: roleDef.read_only ? workDir : null,
  };
  const persist = async () => { await writeFileAtomic(path.join(home, 'results', item.id + '.json'), JSON.stringify(out, null, 2)); return out; };
  const fail = async (error) => { out.status = 'failed'; out.error = error; return persist(); };
  if (result.code !== 0)
    return fail(result.killed ? 'process timed out; process tree was terminated' : `opencode exited with code ${result.code}: ${(errorEvents.map(e => e.error?.message ?? e.message ?? 'unknown error').join('; ') || result.stderr || result.error || 'no error detail').split(secretKey).join('[redacted]').slice(0, 800)}`);
  if (circuit.open)
    return fail(`circuit latched (${circuit.kind}): ${circuit.detail}`);
  // Exit 0 alone is insufficient: at least one request must have traversed the
  // proxy, real final text must exist, and there must be no error events.
  if (guard.upstreamAttempts < 1)
    return fail('no request traversed the proxy before exit 0; zero-call success is rejected');
  if (!finalText)
    return fail('no final assistant text captured; exit 0 alone is insufficient');
  if (errorEvents.length)
    return fail(`${errorEvents.length} error event(s) in run output; not a clean success`);
  if (roleDef.read_only) {
    const after = await hashTree(workDir);
    const drift = [];
    for (const [f, h] of after) if (before.get(f) !== h) drift.push(f);
    for (const f of before.keys()) if (!after.has(f)) drift.push(`${f} (deleted)`);
    if (drift.length) return fail(`reviewer mutation detected: ${drift.join(', ')}`);
  }
  out.status = 'completed';
  // Compact report: final text + usage only, never the whole tool transcript.
  const resultsDir = path.join(home, 'results');
  await fsp.mkdir(resultsDir, { recursive: true });
  await writeFileAtomic(path.join(resultsDir, `${item.id}.json`), JSON.stringify({
    id: item.id, role: item.role, status: out.status, exitCode: out.exitCode, durationMs: out.durationMs,
    upstreamAttempts: out.upstreamAttempts, reservedTokens: out.reservedTokens,
    usage: out.usage, usageKnown, finalText,
  }, null, 2));
  return out;
}

// ---------- queue operations ----------

export async function enqueue({ store, role, taskDir, allowedPaths, promptFile }) {
  if (!ROLES[role]) throw new Error(`unknown role ${role}; expected ${Object.keys(ROLES).join('|')}`);
  if (!ROLES[role].read_only && (!allowedPaths || allowedPaths.length === 0))
    throw new Error(`${role} tasks require at least one --allow path`);
  if (!promptFile) throw new Error('enqueue requires --prompt-file: the validated brief is what the worker runs');
  // Short state lock only: enqueue works while a runner is active.
  return store.withState(async () => {
    const state = await store.load();
    const id = `t${++state.counter}`;
    state.items.push({
      id, role, taskDir: path.resolve(taskDir), allowedPaths: allowedPaths ?? [], promptFile: path.resolve(promptFile),
      status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      startedAt: null, endedAt: null, error: null, exitCode: null, upstreamAttempts: 0, reservedTokens: 0,
    });
    await store.save(state);
    return id;
  });
}

async function saveItem(store, id, patch) {
  return store.withState(async () => {
    const state = await store.load();
    const it = store.item(state, id);
    if (!it) throw new Error(`no task ${id}`);
    Object.assign(it, patch, { updatedAt: new Date().toISOString() });
    await store.save(state);
    return it;
  });
}

export async function recover({ store, id, mark }) {
  if (mark !== 'failed' && mark !== 'requeue') throw new Error('--mark must be failed|requeue');
  return store.withState(async () => {
    const state = await store.load();
    const it = store.item(state, id);
    if (!it) throw new Error(`no task ${id}`);
    if (it.status !== 'interrupted' && it.status !== 'failed')
      throw new Error(`task ${id} is ${it.status}; only interrupted/failed tasks can be recovered`);
    const patch = mark === 'requeue'
      ? { status: 'queued', error: null, startedAt: null, endedAt: null }
      : { status: 'failed', endedAt: new Date().toISOString(), error: 'explicitly marked failed during recovery' };
    Object.assign(it, patch, { updatedAt: new Date().toISOString() });
    await store.save(state);
    return it;
  });
}

export async function clearCircuit(store) {
  return store.withState(async () => {
    const state = await store.load();
    state.circuit = { open: false, reason: null, at: null };
    await store.save(state);
    return state.circuit;
  });
}

export async function runNext({ store, bounds, home, clock = defaultClock(), spawnFn, env = process.env, exe, upstreamUrl }) {
  // LONG runner lock: only one runner at a time (per --home).
  return store.withRunner(async () => {
    // Crash recovery: never automatically rerun uncertain partial edits.
    // Marking interrupted + picking the next queued item is ONE atomic state
    // section (no lost update against a concurrent enqueue).
    const picked = await store.withState(async () => {
      const state = await store.load();
      if (state.circuit?.open) return { refused: `circuit open (${state.circuit.reason}); run 'node tools/glm-workflow.mjs recover --clear-circuit' after resolving` };
      let marked = false;
      for (const it of state.items) if (it.status === 'running') {
        it.status = 'interrupted';
        it.error = 'runner exited while task was active; explicit recovery required';
        it.updatedAt = new Date().toISOString();
        marked = true;
      }
      if (marked) await store.save(state);
      if (state.items.some(i => i.status === 'interrupted')) return { done: true, interrupted: true };
      const queued = state.items.filter((i) => i.status === 'queued');
      return queued.length ? { item: queued[0] } : { done: true }; // FIFO
    });
    if (picked.refused) return { refused: picked.refused };
    if (picked.done) return { done: true };
    const item = picked.item;
    const started = await saveItem(store, item.id, { status: 'running', startedAt: new Date().toISOString(), endedAt: null, error: null });
    let out;
    try {
      // Workspace lock keyed by resolved taskDir: a SECOND --home cannot start
      // a writer on the same workspace while this one is active.
      out = await store.withLock(path.join(os.tmpdir(), 'vc-glm-global-worker.lock'), () => store.withWorkspace(started.taskDir, () => runTask({ item: started, bounds, home, clock, spawnFn, env, exe, upstreamUrl })));
    } catch (err) {
      if (err.code === 'LOCK_HELD') {
        await saveItem(store, item.id, { status: 'queued', startedAt: null, error: null });
        return { refused: `workspace ${started.taskDir} is busy (${err.message}); task ${item.id} requeued` };
      }
      out = { status: 'failed', error: String(err.message ?? err), exitCode: null, upstreamAttempts: 0, reservedTokens: 0, usageKnown: true, circuit: { open: false } };
    }
    // Session credit bounds persist on failure too.
    const final = await saveItem(store, item.id, {
      status: out.status, error: out.error ?? null, exitCode: out.exitCode ?? null,
      upstreamAttempts: out.upstreamAttempts ?? 0, reservedTokens: out.reservedTokens ?? 0,
      usage: out.usage ?? null, usageKnown: out.usageKnown !== false,
      endedAt: new Date().toISOString(),
    });
    if (out.circuit?.open) { // latch the whole queue until explicit recovery
      await store.withState(async () => {
        const s2 = await store.load();
        s2.circuit = { open: true, reason: `${out.circuit.kind}: ${out.circuit.detail}`, at: new Date().toISOString() };
        await store.save(s2);
      });
    }
    return { item: final };
  }, { clock });
}

// ---------- CLI ----------

async function main(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    home: { type: 'string', default: '.glm-workflow' },
    role: { type: 'string' }, 'task-dir': { type: 'string' }, allow: { type: 'string', multiple: true },
    'prompt-file': { type: 'string' }, id: { type: 'string' }, mark: { type: 'string' },
    'clear-circuit': { type: 'boolean' }, concurrency: { type: 'string' }, opencode: { type: 'string' },
    'max-attempts': { type: 'string' }, 'max-reserved-tokens': { type: 'string' },
    'max-session-minutes': { type: 'string' }, 'max-output-tokens': { type: 'string' },
    margin: { type: 'string' },
  } });
  const [cmd] = positionals;
  const home = path.resolve(values.home);
  const store = new QueueStore(home);
  const overrides = {};
  const opt = (v, k, scale = 1) => { if (v != null) overrides[k] = Number(v) * scale; };
  opt(values['max-attempts'], 'maxUpstreamAttempts');
  opt(values['max-reserved-tokens'], 'maxReservedTokens');
  opt(values['max-session-minutes'], 'maxSessionMs', 60_000);
  opt(values['max-output-tokens'], 'maxOutputTokens');
  opt(values.margin, 'margin');
  const bounds = validateBounds(overrides);
  if (values.concurrency && Number(values.concurrency) > 1) {
    console.error('refusing --concurrency > 1: safe shared-quota and shared-workspace locking for parallel workers is not verified; the queue is single-worker by design (see docs/glm-workflow.md)');
    process.exitCode = 2;
    return;
  }
  try {
    if (cmd === 'enqueue') {
      if (!values.role || !values['task-dir'] || !values['prompt-file']) throw new Error('enqueue requires --role, --task-dir, --prompt-file, and --allow (repeatable)');
      const id = await enqueue({ store, role: values.role, taskDir: values['task-dir'], allowedPaths: values.allow ?? [], promptFile: values['prompt-file'] });
      console.log(id);
    } else if (cmd === 'run') {
      const res = await runNext({ store, bounds, home, exe: resolveOpencode(values.opencode) });
      if (res.refused) { console.error(res.refused); process.exitCode = 3; }
      else if (res.done) console.log('queue empty');
      else { console.log(`${res.item.id} ${res.item.status}${res.item.error ? `: ${res.item.error}` : ''}`); if (res.item.status !== 'completed') process.exitCode = 1; }
    } else if (cmd === 'status') {
      const state = await store.load();
      const items = values.id ? state.items.filter((i) => i.id === values.id) : state.items;
      for (const it of items)
        console.log(`${it.id}\t${it.role}\t${it.status}\tattempts=${it.upstreamAttempts}\treserved=${it.reservedTokens}${it.usageKnown === false ? '\tusage=unknown' : ''}${it.error ? `\t${it.error}` : ''}`);
      if (state.circuit?.open) console.log(`CIRCUIT OPEN: ${state.circuit.reason}`);
    } else if (cmd === 'recover') {
      if (values['clear-circuit']) { await clearCircuit(store); console.log('circuit cleared'); }
      else if (values.id && values.mark) { const it = await recover({ store, id: values.id, mark: values.mark }); console.log(`${it.id} ${it.status}`); }
      else {
        const state = await store.load();
        for (const it of state.items) if (it.status === 'interrupted' || it.status === 'failed') console.log(`${it.id}\t${it.status}\t${it.error ?? ''}`);
        console.log('usage: recover --id <id> --mark failed|requeue | recover --clear-circuit');
      }
    } else {
      console.error('commands: enqueue | run | status | recover (see docs/glm-workflow.md)');
      process.exitCode = 2;
    }
  } catch (err) {
    if (err.code === 'LOCK_HELD') { console.error(`busy: ${err.message}`); process.exitCode = 4; }
    else { console.error(err.message ?? err); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
