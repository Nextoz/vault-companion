import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { coordinator, envelope, trustedJSON, snapshot, findingsFor, safeFile, runCheck, hash, object, inside, physical } from './core.mjs';

// Resolve pnpm's JavaScript launcher from the trusted installation, never a clone's PATH/shim.
export function pnpmLauncher() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue;
    for (const suffix of ['node_modules/pnpm/bin/pnpm.cjs', '../node_modules/pnpm/bin/pnpm.cjs', '../.tools/pnpm/12.6.0/node_modules/pnpm/bin/pnpm.cjs']) {
      const file = path.resolve(dir, suffix);
      if (fs.existsSync(file)) return { command: process.execPath, prefix: [fs.realpathSync(file)], file: fs.realpathSync(file) };
    }
    const native = path.resolve(dir, 'pnpm.exe');
    if (process.platform === 'win32' && fs.existsSync(native)) return { command: native, prefix: [], file: fs.realpathSync(native) };
    const shim = path.resolve(dir, 'pnpm.ps1');
    if (process.platform === 'win32' && fs.existsSync(shim)) {
      const match = /"\$basedir\/([^"\r\n]+\/pnpm\.exe)"/u.exec(fs.readFileSync(shim, 'utf8'));
      if (match) {
        const exe = fs.realpathSync(path.resolve(dir, match[1]));
        return { command: exe, prefix: [], file: exe };
      }
    }
    const unix = path.resolve(dir, 'pnpm');
    if (process.platform !== 'win32' && fs.existsSync(unix)) {
      const file = fs.realpathSync(unix);
      if (/\.c?js$/u.test(file)) return { command: process.execPath, prefix: [file], file };
    }
  }
  throw new Error('trusted-pnpm-launcher-unavailable');
}
function evidence(value, binding) {
  object(value, ['version', 'issuer', 'binding', 'findingIds', 'corrections', 'backend', 'model', 'effort', 'tokens']);
  if (value.version !== 1 || value.issuer !== 'Nextoz' || JSON.stringify(value.binding) !== JSON.stringify(binding) ||
      !Array.isArray(value.findingIds) || value.findingIds.some(id => typeof id !== 'string') ||
      !Number.isInteger(value.corrections) || value.corrections < 0) throw new Error('invalid-lead-disposition');
  for (const key of ['backend', 'model', 'effort']) if (value[key] !== null &&
    (typeof value[key] !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/u.test(value[key]))) throw new Error('invalid-metadata');
  if (value.tokens !== null && (!Number.isSafeInteger(value.tokens) || value.tokens < 0)) throw new Error('invalid-metadata');
  return value;
}
export async function verify(args) {
  const started = Date.now(); const runId = crypto.randomUUID();
  const receipt = { version: 1, runId, taskId: null, backend: null, model: null, effort: null, risk: null,
    base: null, head: null, diffDigest: null, changedPaths: [], findings: [], checks: [], corrections: 0,
    elapsedMs: null, tokens: null, accepted: false };
  try {
    if (args.length < 2 || args.length > 3) throw new Error('usage-clone-envelope-optional-disposition');
    const clone = fs.realpathSync(args[0]);
    if (inside(clone, coordinator) || inside(coordinator, clone)) throw new Error('coordinator-must-be-separate');
    const e = envelope(trustedJSON(args[1], clone));
    Object.assign(receipt, { taskId: e.taskId, risk: e.riskClass, base: e.baseCommit });
    const s = snapshot(clone, e.baseCommit);
    Object.assign(receipt, { head: s.head, diffDigest: s.diffDigest, changedPaths: s.paths, findings: findingsFor(s, e) });
    const binding = { taskId: e.taskId, base: e.baseCommit, head: s.head, diffDigest: s.diffDigest, envelopeDigest: hash(JSON.stringify(e)) };
    receipt.binding = binding;
    let dispositions = [];
    if (args[2]) {
      const d = evidence(trustedJSON(args[2], clone), binding);
      dispositions = d.findingIds;
      Object.assign(receipt, { corrections: d.corrections, backend: d.backend, model: d.model, effort: d.effort, tokens: d.tokens });
      if (dispositions.some(id => !receipt.findings.some(f => f.id === id && f.dispositionable))) throw new Error('invalid-finding-disposition');
    }
    receipt.findings = receipt.findings.map(f => ({ ...f, dispositioned: f.dispositionable && dispositions.includes(f.id) }));
    if (receipt.corrections > e.maxCorrections) throw new Error('correction-budget-exhausted');
    if (!receipt.findings.some(f => !f.dispositioned)) {
      const launcher = pnpmLauncher();
      if (inside(physical(launcher.file), clone)) throw new Error('untrusted-pnpm-launcher');
      for (const check of e.requiredChecks) {
        if (check.argv[2] === 'vitest') check.argv.slice(4, -1).forEach(p => safeFile(clone, p));
        // Tests are executable repository code. This is deliberately not a sandbox.
        const r = await runCheck(launcher.command, [...launcher.prefix, ...check.argv.slice(1)], clone, check.timeoutMs);
        receipt.checks.push({ argv: check.argv, timeoutMs: check.timeoutMs, exitCode: r.exitCode, timedOut: r.timedOut, passed: r.ok });
      }
      const afterChecks = snapshot(clone, e.baseCommit);
      if (afterChecks.diffDigest !== s.diffDigest) {
        receipt.checkChangedPaths = afterChecks.paths;
        throw new Error('clone-changed-during-checks');
      }
      receipt.accepted = receipt.checks.every(c => c.passed);
    }
  } catch (err) {
    // Never serialize arbitrary exception messages (which can contain source or credentials).
    const known = /^[a-z][a-z0-9-]+$/u.test(err.message) ? err.message : 'verification-error';
    receipt.findings.push({ id: hash(known).slice(0, 16), code: known, path: null, dispositionable: false, dispositioned: false });
  }
  receipt.elapsedMs = Date.now() - started;
  const dir = safeFile(coordinator, '.agent/receipts'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(safeFile(coordinator, `.agent/receipts/${runId}.json`), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}
const receipt = await verify(process.argv.slice(2));
console.log(JSON.stringify(receipt));
if (!receipt.accepted) process.stderr.write(`# Harness refusal\nRun: ${receipt.runId}\n` +
  receipt.findings.filter(f => !f.dispositioned).map(f => `- ${f.code}${f.path ? `: ${JSON.stringify(f.path)}` : ''}\n`).join('') +
  receipt.checks.filter(c => !c.passed).map(c => `- Check failed (exit ${c.exitCode}, timeout ${c.timedOut})\n`).join(''));
process.exitCode = receipt.accepted ? 0 : 1;
