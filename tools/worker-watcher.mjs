#!/usr/bin/env node
// Continuous Lead watcher. CLI-compatible with tools/wait-for-work.sh:
//   node tools/worker-watcher.mjs [interval-seconds] [max-hours]
// Env: REPO (owner/repo), WATCH_LOGS, WATCH_HANDOFFS (comma-separated clones),
// READY_BACKLOG (path watched by mtime only), HERDR_LEAD_PANE (explicit pane to wake).
//
// Detects new agent/* branches, completed CI, CodeRabbit and human owner activity on open PRs,
// hold-label removal, Ready Backlog mtime changes, finished worker logs, and new worker handoffs.
// Deduplicates within the run, polls with a bounded interval, never reads vault content, and wakes
// only the explicit Lead ID via `WAKE: <metadata>` (never arbitrary focus).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BOT_RE = /coderabbit/iu;
const OWNER = 'nextoz';
const PLACEHOLDER = /currently processing|action\(?s?\)? performed|review triggered/iu;
const FINISHED_LOG = /^(VERDICT:|[A-Z0-9-]+ DONE|[A-Z0-9-]+ BLOCKED)/mu;
const WATCHER_TIMEOUT_MS = 15000;
const PROMPT_TIMEOUT_MS = 120000;
const MAX_WAKE_ATTEMPTS = 3;

function field(obj, key) {
  const v = obj?.[key];
  return (typeof v === 'string' || typeof v === 'number') ? v : null;
}

const META_RE = /[^A-Za-z0-9_.:/-]/gu;
function metaToken(value, max = 120) {
  const text = String(value ?? '');
  const clean = text.replace(META_RE, '').slice(0, max);
  return clean || '…';
}

// --- pure detection helpers (unit-tested) ---

export function diff(prev, now) {
  const prevSet = new Set(prev);
  return now.filter(item => !prevSet.has(item));
}

export function newBranches(prev, now) {
  return diff(prev, now);
}

export function completedCi(prev, now) {
  return diff(prev, now);
}

export function holdRemoved(prevPrs, nowPrs) {
  const prevMap = new Map(prevPrs.map(p => [p.number, new Set(p.labels ?? [])]));
  const removed = [];
  for (const pr of nowPrs) {
    const before = prevMap.get(pr.number);
    if (!before || !before.has('hold')) continue;
    if (!(pr.labels ?? []).includes('hold')) removed.push(pr.number);
  }
  return removed;
}

export function activity(comments, reviews, sinceIso, { bot }) {
  const ids = [];
  const consider = (entries, timeKey) => {
    for (const entry of entries ?? []) {
      const login = field(entry.user, 'login');
      if (!login) continue;
      const isBot = BOT_RE.test(login);
      if (isBot !== bot) continue;
      const at = field(entry, timeKey) ?? field(entry, 'updated_at') ?? field(entry, 'created_at');
      if (!at || at <= sinceIso) continue;
      const body = field(entry, 'body') ?? '';
      if (isBot && PLACEHOLDER.test(body)) continue;
      const rawId = field(entry, 'id');
      const id = rawId !== null && rawId !== undefined ? String(rawId) : `${login}:${at}`;
      ids.push(id);
    }
  };
  consider(comments, 'updated_at');
  consider(reviews, 'submitted_at');
  return ids;
}


// Owner-only human activity: comments/reviews by Nextoz after `sinceIso`.
export function ownerActivity(comments, reviews, sinceIso) {
  const ids = [];
  for (const entry of [...(comments ?? []), ...(reviews ?? [])]) {
    const login = field(entry.user, 'login');
    if (!login || login.toLowerCase() !== OWNER) continue;
    const at = field(entry, 'updated_at') ?? field(entry, 'submitted_at') ?? field(entry, 'created_at');
    if (!at || at <= sinceIso) continue;
    const rawId = field(entry, 'id');
    ids.push(rawId !== null && rawId !== undefined ? String(rawId) : `${login}:${at}`);
  }
  return ids;
}

export function readyBacklogChanged(prevMtimeMs, nowMtimeMs) {
  return prevMtimeMs !== undefined && nowMtimeMs !== null && nowMtimeMs !== prevMtimeMs;
}

export function newHandoffs(prev, now) {
  return diff(prev, now);
}

export function logFinished(logs, sinceIso, knownPaths) {
  return (logs ?? []).filter(log => {
    if (knownPaths.has(log.path)) return false;
    if (log.mtimeIso && log.mtimeIso <= sinceIso) return false;
    return log.finished === true;
  });
}

export function buildWakeLine(events) {
  const parts = events.map(event => {
    switch (event.kind) {
      case 'branch': return `NEW BRANCH ${metaToken(event.value)}`;
      case 'ci': return `CI COMPLETE ${metaToken(event.value)}`;
      case 'coderabbit': return `CODERABBIT PR #${metaToken(event.value, 20)}`;
      case 'owner': return `OWNER ACTIVITY PR #${metaToken(event.value, 20)}`;
      case 'hold-removed': return `HOLD REMOVED PR #${metaToken(event.value, 20)}`;
      case 'ready': return 'READY BACKLOG CHANGED';
      case 'handoff': return `HANDOFF ${metaToken(event.value)}`;
      case 'log': return `LOG FINISHED ${metaToken(event.value)}`;
      default: return metaToken(event.value ?? 'event');
    }
  });
  return `WAKE: ${parts.join('; ')}`;
}

// --- one polling pass against an injectable api (unit-tested with fake APIs) ---

export async function runOnce(api, state) {
  const events = [];

  const attempt = async call => {
    try { return { ok: true, value: await call() }; }
    catch { return { ok: false, value: undefined }; }
  };

  const branchResult = await attempt(api.branches);
  if (branchResult.ok) {
    state.branches ??= [];
    const branches = Array.isArray(branchResult.value) ? branchResult.value : [];
    for (const branch of newBranches(state.branches, branches)) events.push({ kind: 'branch', value: branch });
    state.branches = branches;
  }

  const ciResult = await attempt(api.ciDone);
  if (ciResult.ok) {
    state.ci ??= [];
    const ci = Array.isArray(ciResult.value) ? ciResult.value : [];
    for (const item of completedCi(state.ci, ci)) events.push({ kind: 'ci', value: item });
    state.ci = ci;
  }

  const prsResult = await attempt(api.prs);
  if (prsResult.ok) {
    state.prs ??= [];
    const prs = Array.isArray(prsResult.value) ? prsResult.value : [];
    for (const number of holdRemoved(state.prs, prs)) events.push({ kind: 'hold-removed', value: String(number) });
    state.prs = prs;

    const startIso = state.startIso ?? new Date().toISOString();
    state.seen ??= new Set();
    for (const pr of prs) {
      const commentResult = await attempt(() => api.comments(pr.number));
      const reviewResult = await attempt(() => api.reviews(pr.number));
      const comments = commentResult.ok ? commentResult.value ?? [] : [];
      const reviews = reviewResult.ok ? reviewResult.value ?? [] : [];
      for (const id of activity(comments, reviews, startIso, { bot: true })) {
        const key = `bot:${id}`;
        if (!state.seen.has(key)) { state.seen.add(key); events.push({ kind: 'coderabbit', value: String(pr.number) }); }
      }
      for (const id of ownerActivity(comments, reviews, startIso)) {
        const key = `owner:${id}`;
        if (!state.seen.has(key)) { state.seen.add(key); events.push({ kind: 'owner', value: String(pr.number) }); }
      }
    }
  }

  const mtimeResult = await attempt(api.readyBacklogMtime);
  if (mtimeResult.ok) {
    if (readyBacklogChanged(state.readyMtime, mtimeResult.value)) events.push({ kind: 'ready', value: 'backlog' });
    state.readyMtime = mtimeResult.value;
  }

  const handoffResult = await attempt(api.handoffs);
  if (handoffResult.ok) {
    state.handoffs ??= [];
    const handoffs = Array.isArray(handoffResult.value) ? handoffResult.value : [];
    for (const item of newHandoffs(state.handoffs, handoffs)) events.push({ kind: 'handoff', value: item });
    state.handoffs = handoffs;
  }

  const logResult = await attempt(api.logs);
  if (logResult.ok) {
    state.finishedLogs ??= new Set();
    const logs = Array.isArray(logResult.value) ? logResult.value : [];
    for (const log of logFinished(logs, state.startIso ?? new Date().toISOString(), state.finishedLogs)) {
      state.finishedLogs.add(log.path);
      events.push({ kind: 'log', value: log.path });
    }
  }

  return events;
}

// --- wake delivery (submits work to the explicit Lead agent; never raw pane focus) ---

export async function sendWake(leadId, text, runner, { attempts = MAX_WAKE_ATTEMPTS } = {}) {
  if (!leadId || !text) return { sent: false, attempts: 0 };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await runner('herdr', ['agent', 'prompt', leadId, text, '--wait', '--timeout', String(PROMPT_TIMEOUT_MS)]);
      return { sent: true, leadId, text, attempts: attempt };
    } catch { /* retry below */ }
  }
  return { sent: false, leadId, text, attempts };
}

// --- real API (gh/git/fs), no vault content reads ---

function run(cmd, args) {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: WATCHER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }).stdout ?? '';
  } catch { return ''; }
}

function json(cmd, args) {
  try { return JSON.parse(run(cmd, args)); } catch { return null; }
}

export function parsePages(out) {
  const text = typeof out === 'string' ? out.trim() : '';
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { /* concatenated page documents */ }
  const docs = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') { if (depth === 0) start = i; depth += 1; }
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) { docs.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  const items = [];
  for (const doc of docs) {
    try {
      const parsed = JSON.parse(doc);
      if (Array.isArray(parsed)) items.push(...parsed); else items.push(parsed);
    } catch { /* skip unparseable page */ }
  }
  return items;
}

function jsonList(cmd, args) {
  return parsePages(run(cmd, args));
}

function rollupDone(pr) {
  const rollup = pr.statusCheckRollup ?? [];
  if (!rollup.length) return false;
  return rollup.every(check => {
    const value = check.conclusion ?? check.state ?? '';
    return value !== '' && value !== 'PENDING';
  });
}

export function realApi(env = process.env) {
  const repo = env.REPO ?? 'Nextoz/vault-companion';
  const prs = () => {
    const list = json('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,labels,headRefOid,statusCheckRollup']);
    return (list ?? []).map(pr => ({ number: pr.number, labels: (pr.labels ?? []).map(label => label.name) }));
  };
  return {
    branches: () => {
      const out = run('git', ['ls-remote', '--heads', 'origin', 'agent/*']);
      return out.trim().split(/\r?\n/u).filter(Boolean).map(line => line.split(/\s+/u).pop()).sort();
    },
    ciDone: () => {
      const list = json('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,headRefOid,statusCheckRollup']);
      return (list ?? []).filter(rollupDone).map(pr => `${pr.number}:${pr.headRefOid}`).sort();
    },
    prs,
    comments: number => jsonList('gh', ['api', '--paginate', `repos/${repo}/issues/${number}/comments`]),
    reviews: number => jsonList('gh', ['api', '--paginate', `repos/${repo}/pulls/${number}/reviews`]),
    readyBacklogMtime: () => {
      const target = env.READY_BACKLOG;
      if (!target) return null;
      try { return fs.statSync(target).mtimeMs; } catch { return null; }
    },
    handoffs: () => {
      const dirs = (env.WATCH_HANDOFFS ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const out = [];
      for (const dir of dirs) {
        const handoffDir = path.join(dir, '.agent', 'handoffs');
        try { for (const file of fs.readdirSync(handoffDir)) if (file.endsWith('.md')) out.push(path.join(handoffDir, file)); } catch { /* no handoffs yet */ }
      }
      return out.sort();
    },
    logs: () => {
      const dir = env.WATCH_LOGS;
      if (!dir) return [];
      const out = [];
      try {
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('-run.log')) continue;
          const target = path.join(dir, file);
          const text = fs.readFileSync(target, 'utf8');
          if (FINISHED_LOG.test(text)) {
            const mtimeIso = new Date(fs.statSync(target).mtimeMs).toISOString();
            out.push({ path: target, mtimeIso, finished: true });
          }
        }
      } catch { /* watch dir unavailable */ }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function main(argv, env = process.env, deps = {}) {
  const stdout = deps.writeStdout ?? (line => process.stdout.write(`${line}\n`));
  const stderr = deps.writeStderr ?? (line => process.stderr.write(`${line}\n`));
  const runner = deps.runner ?? ((cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: WATCHER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`command failed: ${cmd}`);
    return result.stdout ?? '';
  });
  const api = deps.api ?? realApi(env);
  const doSleep = deps.sleep ?? sleep;
  const intervalArg = argv[0] !== undefined ? Number(argv[0]) : Number(env.INTERVAL ?? 300);
  const maxHours = argv[1] !== undefined ? Number(argv[1]) : 12;
  if (!Number.isFinite(intervalArg) || intervalArg <= 0) { stderr('interval must be a positive number of seconds'); return 2; }
  if (!Number.isFinite(maxHours) || maxHours <= 0) { stderr('max hours must be a positive number'); return 2; }
  const interval = intervalArg * 1000;
  const deadline = Date.now() + maxHours * 3600 * 1000;

  const state = {
    startIso: new Date().toISOString(),
    seen: new Set(),
    finishedLogs: new Set(),
    readyMtime: undefined,
  };
  await runOnce(api, state); // baseline: discard pre-existing signals

  while (Date.now() < deadline) {
    await doSleep(interval);
    const events = await runOnce(api, state);
    if (!events.length) continue;
    const wake = buildWakeLine(events);
    for (const event of events) {
      const label = buildWakeLine([event]).replace(/^WAKE: /u, '');
      stdout(label);
    }
    const leadId = env.HERDR_LEAD_PANE;
    if (leadId) {
      const result = await sendWake(leadId, wake, runner);
      if (result.sent) stdout(`[wake] sent to ${leadId}`);
      else {
        stderr(`[wake] delivery failed after ${result.attempts} attempt(s)`);
        return 1;
      }
    } else {
      stdout(wake);
    }
    return 0;
  }
  stdout(`TIMEOUT after ${maxHours}h: nothing new`);
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
