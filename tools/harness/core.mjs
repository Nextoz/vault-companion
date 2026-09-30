import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const coordinator = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
export const canonical = 'C:/Dev/vault-companion';
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function run(command, args, cwd, timeout = 10000, env = process.env) {
  const r = spawnSync(command, args, { cwd, env, shell: false, timeout, maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8', windowsHide: true });
  return { exitCode: r.status ?? null, timedOut: r.error?.code === 'ETIMEDOUT',
    ok: !r.error && r.status === 0, stdout: r.stdout ?? '' };
}
export function runCheck(command, args, cwd, timeout) {
  return new Promise(resolve => {
    let finished = false; let timedOut = false; let size = 0; let overflow = false;
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, PATH: `${path.join(coordinator, 'node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = code => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolve({ exitCode: code, timedOut, ok: code === 0 && !timedOut && !overflow });
    };
    const terminate = () => {
      if (child.pid) {
        if (process.platform === 'win32') run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], coordinator, 3000);
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
      }
      child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { overflow = true; terminate(); }
    });
    child.on('error', () => finish(null)); child.on('close', finish);
  });
}
const filterGuards = new Map();
export function git(cwd, args) {
  const r = run('git', ['-c', 'core.fsmonitor=false', ...(filterGuards.get(cwd) ?? []), ...args], cwd);
  if (!r.ok) throw new Error('git-evidence-unavailable');
  return r.stdout;
}
export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !keys.includes(k))) throw new Error('invalid-object');
}
export function relative(value, pattern = false) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\\x00-\x1f\x7f:]/u.test(value)) throw new Error('invalid-path');
  const s = pattern && value.endsWith('/**') ? value.slice(0, -3) : value;
  if (s.split('/').some(p => !p || p === '.' || p === '..' || /[<>"|?*]/u.test(p) || /[. ]$/u.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p))) throw new Error('invalid-path');
  return value;
}
export const matches = (p, list) => list.some(s => s.endsWith('/**') ? p.startsWith(s.slice(0, -2)) : p === s);
export const isTest = p => /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^/]+$/iu.test(p);
export const isCI = p => /^(\.github|\.circleci)\/|(^|\/)(\.gitlab-ci\.yml|azure-pipelines\.ya?ml|Jenkinsfile)$/iu.test(p);
export const isManifest = p => /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pnpm-workspace\.yaml|\.npmrc)$/iu.test(p);
export const isProtected = p => /^(\.claude\/settings[^/]*\.json|tools\/harness\/|docs\/harness\.md$|\.github\/)|(^|\/)([^/]*(?:eslint|vitest|jest|playwright|tsconfig|\.config\.)[^/]*|\.gitleaksignore|package\.json|pnpm-workspace\.yaml|\.npmrc|AGENTS\.md|CLAUDE\.md)$/iu.test(p) || isCI(p) || isManifest(p);
export function envelope(e) {
  object(e, ['version', 'taskId', 'riskClass', 'allowedPaths', 'allowedProtectedPaths', 'mayEditTests', 'mayEditCI', 'mayAddDependencies', 'requiredChecks', 'maxCorrections', 'baseCommit']);
  if (e.version !== 1 || typeof e.taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(e.taskId) ||
      !['low', 'ordinary', 'high', 'critical'].includes(e.riskClass) || typeof e.baseCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(e.baseCommit) ||
      !Number.isInteger(e.maxCorrections) || e.maxCorrections < 0 || e.maxCorrections > 20) throw new Error('invalid-envelope');
  for (const k of ['mayEditTests', 'mayEditCI', 'mayAddDependencies']) if (typeof e[k] !== 'boolean') throw new Error('invalid-envelope');
  for (const k of ['allowedPaths', 'allowedProtectedPaths']) {
    if (!Array.isArray(e[k]) || e[k].length > 200) throw new Error('invalid-envelope');
    e[k].forEach(p => relative(p, true));
  }
  if (!Array.isArray(e.requiredChecks) || !e.requiredChecks.length || e.requiredChecks.length > 30) throw new Error('invalid-checks');
  e.requiredChecks.forEach(c => {
    object(c, ['argv', 'timeoutMs']);
    if (!Array.isArray(c.argv) || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 1 || c.timeoutMs > 300000) throw new Error('invalid-check');
    const a = c.argv;
    if (JSON.stringify(a) === JSON.stringify(['pnpm', '-r', 'exec', 'tsc', '--noEmit'])) return;
    if (a.length < 6 || a.slice(0, 4).join(' ') !== 'pnpm exec vitest run' || a.at(-1) !== '--reporter=dot') throw new Error('unknown-check');
    a.slice(4, -1).forEach(p => { relative(p); if (!/\.(test|spec)\.[cm]?[jt]sx?$/u.test(p)) throw new Error('untargeted-check'); });
  });
  return e;
}
// Resolve existing ancestors too: junctions and symlinks cannot hide a future file's destination.
export function physical(p) {
  let cur = path.resolve(p); const tail = [];
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) throw new Error('unresolvable-path');
    tail.unshift(path.basename(cur)); cur = up;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}
export const folded = p => p.replaceAll('\\', '/').replace(/\/$/u, '').toLowerCase();
export const inside = (p, root) => folded(p) === folded(root) || folded(p).startsWith(folded(root) + '/');
export function safeFile(root, p) {
  relative(p);
  const dest = path.resolve(root, p);
  if (!inside(physical(dest), fs.realpathSync(root))) throw new Error('symlink-escape');
  // Even internal links are unsupported: do not execute checks through alternate trees.
  let cur = root;
  for (const bit of p.split('/')) {
    cur = path.join(cur, bit);
    try { if (fs.lstatSync(cur).isSymbolicLink()) throw new Error('symlink-path'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return dest;
}
export function trustedJSON(file, clone) {
  const resolved = physical(file);
  if (!inside(resolved, coordinator) || inside(resolved, clone)) throw new Error('untrusted-evidence-location');
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}
export function snapshot(clone, base) {
  // A clone can configure executable clean/process filters. Disable every configured driver before diffing.
  const filters = run('git', ['config', '--name-only', '--get-regexp', '^filter[.]'], clone);
  if (![0, 1].includes(filters.exitCode)) throw new Error('git-config-unavailable');
  const names = [...new Set(filters.stdout.trim().split(/\r?\n/u).filter(Boolean).map(k => k.slice(0, k.lastIndexOf('.'))))];
  filterGuards.set(clone, names.flatMap(name => ['-c', `${name}.clean=`, '-c', `${name}.process=`, '-c', `${name}.required=false`]));
  if (git(clone, ['rev-parse', '--show-toplevel']).trim().replaceAll('\\', '/') !== fs.realpathSync(clone).replaceAll('\\', '/')) throw new Error('not-clone-root');
  if (git(clone, ['rev-parse', '--verify', `${base}^{commit}`]).trim() !== base) throw new Error('invalid-baseline');
  git(clone, ['merge-base', '--is-ancestor', base, 'HEAD']);
  if (git(clone, ['ls-files', '-v', '-z']).split('\0').some(line => /^[a-zS]/u.test(line))) throw new Error('unsupported-index-flags');
  const head = git(clone, ['rev-parse', 'HEAD']).trim();
  const lists = [git(clone, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, 'HEAD']),
    git(clone, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base]),
    git(clone, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-only', '-z', base])];
  // Do not honor worker-controlled .gitignore, info/exclude, or global excludes. No untracked
  // runtime-artifact path is exempted by name/segment: hidden source and modified dependencies
  // must fail closed rather than be silently dropped from scope.
  const untracked = git(clone, ['ls-files', '--others', '-z']).split('\0').filter(Boolean);
  const paths = [...new Set([...lists.flatMap(s => s.split('\0').filter(Boolean)), ...untracked])].sort();
  const states = paths.map(p => {
    const file = safeFile(clone, p);
    const old = run('git', ['show', `${base}:${p}`], clone);
    const head = run('git', ['show', `HEAD:${p}`], clone);
    const index = run('git', ['show', `:${p}`], clone);
    const stat = fs.existsSync(file) ? fs.lstatSync(file) : null;
    if (stat && !stat.isFile()) throw new Error('unsupported-file');
    if (stat?.size > 2 * 1024 * 1024) throw new Error('oversized-file');
    const bytes = stat ? fs.readFileSync(file) : null;
    return { path: p, base: old.ok ? old.stdout : null, head: head.ok ? head.stdout : null,
      index: index.ok ? index.stdout : null, worktree: bytes?.toString('utf8') ?? null,
      digest: bytes ? hash(bytes) : null, mode: stat ? stat.mode & 0o777 : null };
  });
  const patch = git(clone, ['diff', '--no-ext-diff', '--no-textconv', '--binary', base, 'HEAD']) +
    git(clone, ['diff', '--no-ext-diff', '--no-textconv', '--binary', base]) +
    git(clone, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--cached', base]);
  return { head, paths, states, diffDigest: hash(JSON.stringify({ base, head, patch, files: states.map(({ path: p, digest, mode }) => [p, digest, mode]) })) };
}
export function findingsFor(s, e) {
  const result = [];
  const add = (code, p, dispositionable = false) => result.push({ id: hash(`${code}:${p}`).slice(0, 16), code, path: p, dispositionable });
  const dependencyKeys = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions', 'pnpm', 'packageManager'];
  const manifestChanged = (p, base, candidate) => {
    if (!p.endsWith('package.json')) return base !== candidate;
    try {
      const a = JSON.parse(base ?? '{}'); const b = JSON.parse(candidate ?? '{}');
      return dependencyKeys.some(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    } catch { return base !== candidate; }
  };
  const ignoreAdded = (base, candidate) => {
    const previous = new Set((base ?? '').split(/\r?\n/u));
    return (candidate ?? '').split(/\r?\n/u).some(line => line.trim() && !line.trim().startsWith('#') && !previous.has(line));
  };
  const disabled = /\.\s*(?:skip|only|todo|skipIf|runIf)\b|\[\s*['"](?:skip|only|todo|skipIf|runIf)['"]\s*\]|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|\b(?:it|test)\s*\(\s*['"][^'"\n]*['"]\s*\)/gu;
  const disabledCount = text => [...(text ?? '').matchAll(disabled)].length;
  const testCount = text => [...(text ?? '').matchAll(/\b(?:it|test)\s*(?:\.\s*(?:each|for)\s*\([^;]*?\)\s*)?\(/gu)].length;
  for (const st of s.states) {
    const p = st.path; const base = st.base; const candidates = [st.head, st.index, st.worktree];
    if (!matches(p, e.allowedPaths)) add('outside-allowed-paths', p);
    if (isProtected(p) && !matches(p, e.allowedProtectedPaths)) add('protected-path', p);
    if (isTest(p) && !e.mayEditTests) add('tests-forbidden', p);
    if (isCI(p)) add(e.mayEditCI ? 'ci-edit' : 'ci-forbidden', p, e.mayEditCI);
    if (isProtected(p)) add('config-or-policy-edit', p, true);
    if (isManifest(p) && !e.mayAddDependencies) {
      if (candidates.some(v => manifestChanged(p, base, v))) add('dependencies-forbidden', p);
    }
    if (/(^|\/)(\.[^/]*ignore|[^/]*ignore[^/]*)$/iu.test(p)) {
      if (candidates.some(v => ignoreAdded(base, v))) add('ignore-added', p, true);
    }
    if (!isTest(p)) continue;
    if (candidates.some(v => disabledCount(v) > disabledCount(base))) add('test-disabled-or-focused', p, true);
    if (base !== null && candidates.some(v => v === null || testCount(v) < testCount(base))) add('test-count-reduced', p, true);
    // Catch deletions/replacements of assertions and parameter rows, aliases, and dynamic forms conservatively in every state.
    if (base !== null && candidates.some(v => v !== base)) add('existing-test-modified', p, true);
  }
  return result;
}
export function stdinJSON() {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.length > 1024 * 1024) throw new Error('input-too-large');
  return JSON.parse(raw);
}
