#!/usr/bin/env node
// Finite local controller. No Codex, model-written commands, publishing, or implicit replay.
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { QueueStore, runTask, validateBounds, writeFileAtomic, resolveOpencode, killTree, sanitizeChildEnv } from './glm-workflow.mjs';

export const LIMITS = Object.freeze({ attempts: 60, reserved: 3_000_000, actual: 300_000, durationMs: 45 * 60_000, jobs: 4 });
export const CHECKS = Object.freeze({
  tooling: ['node', '--test', 'tools/glm-workflow.test.mjs', 'tools/glm-supervisor.test.mjs'],
  leaderboard: ['pnpm', 'exec', 'vitest', 'run', 'leaderboard'],
  typecheck: ['pnpm', 'typecheck'], lint: ['pnpm', 'lint'], test: ['pnpm', 'test'], build: ['pnpm', 'build'],
});
const digest = x => crypto.createHash('sha256').update(x).digest('hex');
const ignored = new Set(['.git', '.agent', '.glm-workflow', '.opencode', 'node_modules', 'dist', 'coverage', '.wrangler', 'runtime', 'test-results', 'playwright-report']);
export async function sourceHashes(root, base = root, out = {}) {
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (ignored.has(e.name) || /^(?:opencode\.jsonc?|\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(e.name)) continue;
    const p = path.join(root, e.name);
    if (e.isSymbolicLink()) throw Error('source symlink refused: ' + p);
    if (e.isDirectory()) await sourceHashes(p, base, out);
    else if (e.isFile()) out[path.relative(base, p).replaceAll('\\', '/')] = digest(await fs.readFile(p));
  }
  return out;
}
export function assertScope(before, after, allowed) {
  const drift = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(p => before[p] !== after[p] && !allowed.includes(p));
  if (drift.length) throw Error('worker changed unassigned files: ' + drift.join(', '));
}
export function parseReview(text) {
  const r = JSON.parse(text);
  if (!r || !['pass', 'fail'].includes(r.verdict) || !Array.isArray(r.findings) || r.findings.some(f => typeof f !== 'string' || !f.trim())) throw Error('invalid independent review schema');
  if (r.verdict === 'pass' && r.findings.length) throw Error('review pass has unresolved findings');
  if (r.verdict === 'fail' && !r.findings.length) throw Error('review fail lacks findings');
  return r;
}
export function validateManifest(m) {
  if (m.version !== 1 || !path.isAbsolute(m.workspace) || !Array.isArray(m.jobs) || !m.jobs.length || m.jobs.length > LIMITS.jobs) throw Error('invalid manifest');
  const ids = new Set();
  for (const j of m.jobs) {
    if (!/^[a-z0-9-]{1,60}$/.test(j.id) || ids.has(j.id)) throw Error('invalid/duplicate job id'); ids.add(j.id);
    for (const k of ['developer', 'analyst', 'reviewer']) if (typeof j[k] !== 'string' || !j[k].trim() || j[k].length > 12000) throw Error('missing/oversized brief: ' + k);
    for (const key of ['allowedPaths', 'testPaths']) {
      if (!Array.isArray(j[key]) || !j[key].length) throw Error('missing file scope');
      for (const p of j[key]) if (typeof p !== 'string' || !/^(apps|packages)\/[\w./-]+$/.test(p) || p.split('/').includes('..') || /(?:^|\/)(?:AGENTS\.md|package\.json|opencode\.json|\.env)/i.test(p)) throw Error('unsafe worker path: ' + p);
    }
    if (j.testPaths.some(p => !j.allowedPaths.includes(p) || !/\.test\.[cm]?[jt]sx?$/.test(p))) throw Error('test scope must be assigned test files');
    if (!Array.isArray(j.checks) || !j.checks.includes('leaderboard') || !j.checks.includes('typecheck') || j.checks.some(c => !CHECKS[c])) throw Error('missing or invalid deterministic checks');
  }
  return m;
}
export function executeCheck(name, workspace, timeoutMs = 600_000) {
  const [cmd, ...args] = CHECKS[name] ?? [];
  if (!cmd) throw Error('check not allowlisted: ' + name);
  let exe = process.execPath, argv = args;
  if (cmd === 'pnpm') {
    const candidates = [path.join(process.env.APPDATA ?? '', 'npm/node_modules/pnpm/bin/pnpm.cjs'), path.join(path.dirname(process.execPath), 'node_modules/pnpm/bin/pnpm.cjs')];
    const bin = candidates.find(p => nativeFs.existsSync(p));
    if (bin) argv = [bin, ...args];
    else {
      const globalDir = path.join(process.env.LOCALAPPDATA ?? '', 'pnpm/global/v11');
      const native = nativeFs.existsSync(globalDir) ? nativeFs.readdirSync(globalDir).map(d => path.join(globalDir, d, 'node_modules/@pnpm/exe/pnpm.exe')).find(p => nativeFs.existsSync(p)) : null;
      if (!native) throw Error('native pnpm executable not found; no shell fallback');
      exe = native; argv = args;
    }
  }
  return new Promise(resolve => {
    const child = spawn(exe, argv, { cwd: workspace, env: sanitizeChildEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let output = '', timedOut = false;
    const stop = () => { timedOut = true; if (child.pid) killTree(child.pid); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const timer = setTimeout(stop, timeoutMs);
    const append = b => { output = (output + b).slice(-16000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const finish = code => { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); resolve({ name, code, timedOut, output }); };
    child.once('error', e => { append(e.message); finish(1); });
    child.once('close', code => finish(code ?? 1));
  });
}

// Inject workers/checks only in offline tests; the CLI has no injection switches.
export async function runSupervisor({ manifest, home, worker = runTask, check = executeCheck, env = process.env, exe, now = Date.now }) {
  validateManifest(manifest);
  home = path.resolve(home);
  if (!path.relative(path.resolve(manifest.workspace), home).startsWith('..')) throw Error('controller state must be outside worker workspace');
  const store = new QueueStore(home), stateFile = path.join(home, 'controller.json');
  return store.withLock(path.join(os.tmpdir(), 'vc-glm-global-worker.lock'), () => store.withRunner(() => store.withWorkspace(manifest.workspace, async () => {
    let old; try { old = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old) throw Error('existing controller state requires operator inspection; no automatic replay');
    const manifestHash = digest(JSON.stringify(manifest));
    await writeFileAtomic(path.join(home, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const started = now();
    const state = { version: 1, pid: process.pid, status: 'running', manifestHash, startedAt: new Date(started).toISOString(), phase: 'starting', job: null, repairs: 0, attempts: 0, reserved: 0, actual: 0, events: [], results: [] };
    const save = async () => { state.updatedAt = new Date(now()).toISOString(); await writeFileAtomic(stateFile, JSON.stringify(state, null, 2)); };
    const transition = async phase => { state.phase = phase; state.events.push({ job: state.job, phase, at: new Date(now()).toISOString() }); await save(); };
    const timeLeft = () => LIMITS.durationMs - (now() - started);
    const integrity = async () => {
      if (digest(JSON.stringify(JSON.parse(await fs.readFile(path.join(home, 'manifest.json'), 'utf8')))) !== manifestHash) throw Error('controller manifest changed');
      if (timeLeft() <= 0) throw Error('workflow time budget exceeded');
    };
    const call = async (role, brief, allowedPaths) => {
      await integrity();
      if (state.attempts >= LIMITS.attempts || state.reserved >= LIMITS.reserved || state.actual >= LIMITS.actual) throw Error('workflow inference budget exceeded');
      const id = `${state.job}-${state.events.length}-${role}`;
      const promptFile = path.join(home, 'briefs', id + '.md');
      await writeFileAtomic(promptFile, brief + '\nKeep tool reads focused; edit only assigned files. No shell, git, private vault, secrets, subagents, or publication. Final response <= 1000 words.');
      state.activeReport = path.join(home, 'results', id + '.progress.json'); await save();
      const before = await sourceHashes(manifest.workspace);
      const result = await worker({ item: { id, role, taskDir: manifest.workspace, allowedPaths, promptFile }, home, env, exe,
        bounds: validateBounds({ maxUpstreamAttempts: Math.min(20, LIMITS.attempts - state.attempts), maxReservedTokens: Math.min(1_000_000, LIMITS.reserved - state.reserved), maxSessionMs: Math.min(6 * 60_000, timeLeft()), maxOutputTokens: 4000, maxActualTokens: Math.min(300_000, LIMITS.actual - state.actual) }) });
      state.attempts += result.upstreamAttempts ?? 0; state.reserved += result.reservedTokens ?? 0; state.actual += result.usage?.totalTokens ?? 0;
      state.results.push({ id, role, status: result.status, error: result.error, attempts: result.upstreamAttempts, reserved: result.reservedTokens, usage: result.usage });
      await save();
      assertScope(before, await sourceHashes(manifest.workspace), allowedPaths);
      if (result.status !== 'completed' || result.circuit?.open) throw Error(result.error ?? 'worker failed');
      if (result.usageKnown !== true) throw Error('usage incomplete; reserved amounts retained; operator inspection required');
      if (state.actual > LIMITS.actual || state.reserved > LIMITS.reserved || state.attempts > LIMITS.attempts) throw Error('workflow inference budget exceeded');
      await integrity();
      return result;
    };
    await save();
    try {
      for (const job of manifest.jobs) {
        state.job = job.id; state.repairs = 0;
        await transition('developer'); await call('developer', job.developer, job.allowedPaths);
        await transition('test-analyst'); await call('test-analyst', job.analyst, job.testPaths);
        while (true) {
          await transition('checks');
          const evidence = [];
          for (const name of job.checks) { await integrity(); evidence.push(await check(name, manifest.workspace, Math.min(600_000, timeLeft()))); }
          await writeFileAtomic(path.join(home, `${job.id}-checks-${state.repairs}.json`), JSON.stringify(evidence, null, 2));
          let findings = evidence.filter(r => r.code !== 0 || r.timedOut).map(r => `${r.name}: ${r.output.slice(-5000)}`);
          if (!findings.length) {
            await transition('reviewer');
            const result = await call('reviewer', job.reviewer + '\nIndependent acceptance review: inspect current source and tests. Return ONLY strict JSON {"verdict":"pass"|"fail","findings":["specific issue with file/line"]}. Pass requires no findings. Developer claims are not evidence. Deterministic checks passed: ' + job.checks.join(', '), []);
            const review = parseReview(result.finalText);
            await writeFileAtomic(path.join(home, `${job.id}-review-${state.repairs}.json`), JSON.stringify(review, null, 2));
            findings = review.findings;
          }
          if (!findings.length) { await transition('accepted'); break; }
          if (state.repairs >= 1) throw Error('one repair exhausted: ' + findings.join('\n').slice(0, 6000));
          state.repairs++; await transition('repair');
          await call('developer', job.developer + '\nRepair these verified findings; preserve other work:\n' + findings.join('\n'), job.allowedPaths);
        }
      }
      state.status = 'completed'; await transition('completed');
    } catch (e) { state.status = 'blocked'; state.error = e.message; await transition('blocked'); }
    return state;
  })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, manifestPath, home] = process.argv.slice(2);
    if (command === 'status') console.log(await fs.readFile(path.join(manifestPath, 'controller.json'), 'utf8'));
    else if (command === 'run' && manifestPath && home) {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const state = await runSupervisor({ manifest, home, exe: resolveOpencode() });
      console.log(JSON.stringify({ status: state.status, phase: state.phase, error: state.error, attempts: state.attempts, reserved: state.reserved, actual: state.actual }));
      if (state.status !== 'completed') process.exitCode = 1;
    } else throw Error('usage: glm-supervisor.mjs run MANIFEST HOME | status HOME');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
