#!/usr/bin/env node
// Trusted Codex worker launcher: validates the envelope, launches Codex with `--json` event
// capture, invokes the trusted harness verifier, and performs one bounded correction (up to
// maxCorrections) by resuming the actual session ID with the verifier's failure packet.
// It never claims acceptance; it reports the verifier verdict and writes a metadata-only receipt.
//
// Usage: node tools/worker-launch.mjs --clone <dir> --envelope <file> [options]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isValidId, sanitizeToken, summarizeLine, validateHandoff } from './worker-events.mjs';

const RISK_CLASSES = new Set(['low', 'ordinary', 'high', 'critical']);
const TSC_ARGV = JSON.stringify(['pnpm', '-r', 'exec', 'tsc', '--noEmit']);
const NON_RETRYABLE = /(quota|rate.?limit|429|insufficient_quota|usage limit|billing|401|403|unauthori[sz]ed|invalid[_ -]?(api[ _-]?key|request)|provider|model[_ -]?not[_ -]?found|unknown model|mcp|sandbox|permission denied|credential)/iu;
const PROVIDERS = new Set(['deepseek']);
const MODELS = new Set(['deepseek-flash', 'deepseek-v4-pro']);
const EFFORTS = new Set(['low', 'medium', 'high']);
const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

export function validateLaunchConfig(config) {
  if (!PROVIDERS.has(config.provider)) throw new Error('invalid-provider');
  if (!MODELS.has(config.model)) throw new Error('invalid-model');
  if (!EFFORTS.has(config.effort)) throw new Error('invalid-effort');
  if (!SANDBOXES.has(config.sandbox)) throw new Error('invalid-sandbox');
  return config;
}

function field(obj, key) {
  const v = obj?.[key];
  return typeof v === 'string' ? v : null;
}

export const folded = p => p.replaceAll('\\', '/').replace(/\/$/u, '').toLowerCase();
export const insidePath = (p, root) => folded(p) === folded(root) || folded(p).startsWith(`${folded(root)}/`);

function relativePath(value, pattern = false) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\\x00-\x1f\x7f:]/u.test(value)) {
    throw new Error('invalid-envelope');
  }
  const s = pattern && value.endsWith('/**') ? value.slice(0, -3) : value;
  if (s.split('/').some(part => !part || part === '.' || part === '..' || /[<>"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error('invalid-envelope');
  }
  return value;
}

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) {
    throw new Error('invalid-envelope');
  }
}

// Minimal mirror of the H1 envelope v1 schema. The authoritative validation still happens in the
// trusted verifier; this guard refuses bad envelopes before a Codex launch spends quota.
export function validateEnvelope(value) {
  object(value, ['version', 'taskId', 'riskClass', 'allowedPaths', 'allowedProtectedPaths', 'mayEditTests', 'mayEditCI', 'mayAddDependencies', 'requiredChecks', 'maxCorrections', 'baseCommit']);
  if (value.version !== 1 || typeof value.taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(value.taskId) ||
      !RISK_CLASSES.has(value.riskClass) || typeof value.baseCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(value.baseCommit) ||
      !Number.isInteger(value.maxCorrections) || value.maxCorrections < 0 || value.maxCorrections > 20) {
    throw new Error('invalid-envelope');
  }
  for (const key of ['mayEditTests', 'mayEditCI', 'mayAddDependencies']) if (typeof value[key] !== 'boolean') throw new Error('invalid-envelope');
  for (const key of ['allowedPaths', 'allowedProtectedPaths']) {
    if (!Array.isArray(value[key]) || value[key].length > 200) throw new Error('invalid-envelope');
    value[key].forEach(p => relativePath(p, true));
  }
  if (!Array.isArray(value.requiredChecks) || !value.requiredChecks.length || value.requiredChecks.length > 30) throw new Error('invalid-envelope');
  value.requiredChecks.forEach(check => {
    object(check, ['argv', 'timeoutMs']);
    if (!Array.isArray(check.argv) || !Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 300000) throw new Error('invalid-envelope');
    const argv = check.argv;
    if (JSON.stringify(argv) === TSC_ARGV) return;
    if (argv.length < 6 || argv.slice(0, 4).join(' ') !== 'pnpm exec vitest run' || argv.at(-1) !== '--reporter=dot') throw new Error('invalid-envelope');
    argv.slice(4, -1).forEach(p => { relativePath(p); if (!/\.(test|spec)\.[cm]?[jt]sx?$/u.test(p)) throw new Error('invalid-envelope'); });
  });
  return value;
}

// Explicit provider/model/effort, memories off, default workspace-write sandbox, JSON events, and
// the public-only structured handoff schema.
export function buildCodexArgs(config) {
  validateLaunchConfig(config);
  const args = ['exec', '-m', config.model];
  if (config.provider) args.push('-c', `model_provider=${config.provider}`);
  args.push('-c', `model_reasoning_effort=${config.effort}`);
  args.push('-c', 'model_reasoning_summary=concise');
  args.push('-c', 'features.memories=false');
  args.push('-c', 'memories.use_memories=false');
  args.push('-c', 'memories.generate_memories=false');
  args.push('--sandbox', config.sandbox);
  args.push('--json');
  if (config.handoffSchema) args.push('--output-schema', config.handoffSchema);
  if (config.handoffFile) args.push('-o', config.handoffFile);
  args.push('-C', config.clone, '-');
  return args;
}

export function buildResumeArgs(config, sessionId) {
  validateLaunchConfig(config);
  const args = ['exec', 'resume', sessionId, '-', '-m', config.model];
  if (config.provider) args.push('-c', `model_provider=${config.provider}`);
  args.push('-c', `model_reasoning_effort=${config.effort}`);
  args.push('-c', 'features.memories=false');
  args.push('-c', 'memories.use_memories=false');
  args.push('-c', 'memories.generate_memories=false');
  args.push('--sandbox', config.sandbox);
  args.push('--json');
  if (config.handoffSchema) args.push('--output-schema', config.handoffSchema);
  if (config.handoffFile) args.push('-o', config.handoffFile);
  args.push('-C', config.clone);
  return args;
}

export function codexEnv(config) {
  return { CODEX_HOME: config.codexHome };
}

// Only a worker that completed (exit 0) but was refused by the verifier is eligible for a bounded
// correction. Quota/provider/tooling/error events and non-zero Codex exits are never escalated as
// reasoning corrections.
export function isReasoningFailure(codexExitCode, events, verifierExitCode) {
  if (codexExitCode !== 0 || verifierExitCode === 0) return false;
  for (const event of events) {
    if (field(event, 'type') !== 'error') continue;
    const text = [field(event, 'code'), field(event.error, 'type'), field(event.error, 'code'), field(event.error, 'message')]
      .filter(s => s).join(' ');
    if (NON_RETRYABLE.test(text)) return false;
  }
  return true;
}

export function parseReceipt(stdout) {
  try {
    const value = JSON.parse(stdout);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* not JSON */ }
  return {};
}

function receiptBindingMatches(receipt, envelope) {
  const binding = receipt.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  return binding.taskId === envelope.taskId && typeof binding.base === 'string' && binding.base === envelope.baseCommit &&
    typeof binding.head === 'string' && binding.head.length > 0 && typeof binding.diffDigest === 'string' && binding.diffDigest.length > 0;
}

// A complete, typed, bound verifier receipt is required before anything can be accepted.
export function isCompleteReceipt(receipt, envelope) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  if (receipt.version !== 1 || receipt.accepted !== true || typeof receipt.runId !== 'string' || !receipt.runId) return false;
  if (typeof receipt.taskId !== 'string' || receipt.taskId !== envelope.taskId) return false;
  if (!Array.isArray(receipt.findings) || !Array.isArray(receipt.changedPaths) || !Array.isArray(receipt.checks) || receipt.checks.length === 0) return false;
  if (!receipt.checks.every(check => check && typeof check === 'object' && check.passed === true)) return false;
  if (!Number.isInteger(receipt.corrections) || receipt.corrections < 0) return false;
  return receiptBindingMatches(receipt, envelope);
}

// A typed refusal is the only verifier output that can authorize a reasoning correction.
export function isTypedVerifierReceipt(receipt, envelope) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  if (receipt.version !== 1 || receipt.accepted !== false || typeof receipt.runId !== 'string' || !receipt.runId) return false;
  if (typeof receipt.taskId !== 'string' || receipt.taskId !== envelope.taskId) return false;
  if (!Array.isArray(receipt.findings) || !Array.isArray(receipt.changedPaths) || !Array.isArray(receipt.checks)) return false;
  if (!Number.isInteger(receipt.corrections) || receipt.corrections < 0) return false;
  return receiptBindingMatches(receipt, envelope);
}

export function hasToolingCheckFailure(receipt) {
  return (receipt?.checks ?? []).some(check => check && typeof check === 'object' &&
    (check.timedOut === true || check.exitCode === null || check.exitCode === undefined));
}

export const coordinator = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
export const defaultVerifier = path.join(coordinator, 'tools', 'harness', 'verify-run.mjs');

function verifierCwd(verifier) {
  return path.resolve(verifier, '..', '..');
}

export async function runLaunch(config, deps) {
  const started = deps.now();
  const receipt = {
    version: 1,
    runId: crypto.randomUUID(),
    taskId: null,
    backend: config.provider,
    model: config.model,
    effort: config.effort,
    risk: null,
    changedFiles: [],
    verdict: 'error',
    codexExitCode: null,
    verifierExitCode: null,
    corrections: 0,
    maxCorrections: 0,
    durationMs: null,
    tokens: null,
    integrationBlocked: false,
  };
  const finalize = r => {
    r.durationMs = deps.now() - started;
    const dir = path.join(config.coordinator, '.agent', 'receipts');
    deps.mkdir(dir);
    deps.writeFile(path.join(dir, `${r.runId}.json`), `${JSON.stringify(r, null, 2)}\n`);
    return r;
  };

  // 0. Refuse invalid provider/model/effort/sandbox before any launch.
  try {
    validateLaunchConfig(config);
  } catch {
    receipt.verdict = 'invalid-config';
    return finalize(receipt);
  }

  // 1. Validate the envelope before any launch.
  let envelope;
  try {
    envelope = validateEnvelope(JSON.parse(deps.readFile(config.envelopePath)));
  } catch {
    receipt.verdict = 'invalid-envelope';
    return finalize(receipt);
  }
  receipt.taskId = envelope.taskId;
  receipt.risk = envelope.riskClass;
  receipt.maxCorrections = envelope.maxCorrections;

  // 2. Trust boundaries: coordinator, envelope and verifier real paths (symlink/junction escapes included)
  //    must all live in the trusted coordinator and outside the worker clone.
  const trustRoot = deps.trustedCoordinator ?? config.coordinator;
  const envelopeReal = deps.realpath(config.envelopePath);
  const cloneReal = deps.realpath(config.clone);
  const coordinatorReal = deps.realpath(config.coordinator);
  const trustRootReal = deps.realpath(trustRoot);
  if (insidePath(coordinatorReal, cloneReal) || !insidePath(coordinatorReal, trustRootReal)) {
    receipt.verdict = 'untrusted-coordinator';
    return finalize(receipt);
  }
  if (insidePath(envelopeReal, cloneReal) || !insidePath(envelopeReal, coordinatorReal)) {
    receipt.verdict = 'untrusted-envelope-location';
    return finalize(receipt);
  }

  // 3. The trusted verifier must exist and resolve into the trusted coordinator, never into the clone.
  const verifier = config.verifier;
  if (!deps.exists(verifier)) {
    receipt.verdict = 'integration-blocked';
    receipt.integrationBlocked = true;
    return finalize(receipt);
  }
  const verifierReal = deps.realpath(verifier);
  if (insidePath(verifierReal, cloneReal) || !insidePath(verifierReal, coordinatorReal)) {
    receipt.verdict = 'untrusted-verifier-location';
    return finalize(receipt);
  }

  const eventsFile = config.eventsFile ?? path.join(config.clone, '.agent', 'events.jsonl');
  const handoffFile = config.handoffFile ?? path.join(config.clone, '.agent', 'handoffs', `${envelope.taskId}.json`);
  const briefPath = config.briefPath ?? path.join(config.clone, '.agent', 'brief.md');
  deps.mkdir(path.dirname(eventsFile));
  deps.mkdir(path.dirname(handoffFile));

  const events = [];
  let sessionId = null;
  let tokens = null;
  const writeHandoff = value => {
    deps.writeFile(handoffFile, `${JSON.stringify(value, null, 2)}\n`);
    deps.writeStdout('[handoff] structured handoff saved');
  };
  const captureOutputHandoff = () => {
    try {
      if (!deps.exists(handoffFile)) return;
      const parsed = JSON.parse(deps.readFile(handoffFile));
      const checked = validateHandoff(parsed);
      if (checked.valid) writeHandoff(checked.value);
    } catch { /* malformed output file is not a handoff */ }
  };
  const collect = line => {
    deps.appendFile(eventsFile, `${line}\n`);
    const result = summarizeLine(line);
    if (result.malformed) { deps.writeStderr(result.summary); return; }
    const event = result.event;
    events.push(event);
    if (!sessionId) sessionId = [field(event, 'thread_id'), field(event, 'session_id')].find(value => isValidId(value)) ?? null;
    const usage = event?.usage;
    if (usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)) {
      tokens = (tokens ?? 0) + usage.input_tokens + usage.output_tokens;
    }
    if (result.summary) deps.writeStdout(result.summary);
    if (result.handoff) writeHandoff(result.handoff);
  };

  // 4. Launch the worker with JSON event capture.
  deps.writeStdout(`[launch] ${sanitizeToken(config.provider)} ${sanitizeToken(config.model)} effort=${sanitizeToken(config.effort)}`);
  let codexResult;
  try {
    codexResult = await deps.spawnCodex({
      args: buildCodexArgs({ ...config, handoffFile }),
      cwd: config.clone,
      env: codexEnv(config),
      stdin: deps.readFile(briefPath),
      onLine: collect,
    });
  } catch {
    receipt.verdict = 'codex-launch-failed';
    return finalize(receipt);
  }
  receipt.codexExitCode = codexResult.exitCode;
  captureOutputHandoff();
  if (codexResult.exitCode === null) {
    receipt.verdict = 'codex-launch-failed';
    return finalize(receipt);
  }

  // 5. Invoke the trusted verifier.
  let verifierResult;
  try {
    verifierResult = await deps.runVerifier({ args: [verifier, config.clone, config.envelopePath], cwd: verifierCwd(verifier) });
  } catch {
    receipt.verdict = 'integration-blocked';
    receipt.integrationBlocked = true;
    return finalize(receipt);
  }
  receipt.verifierExitCode = verifierResult.exitCode;
  let verifierReceipt = parseReceipt(verifierResult.stdout);

  // 6. Bounded correction: resume the actual session ID with the verifier's failure packet.
  let corrections = 0;
  while (receipt.verifierExitCode !== 0 && corrections < receipt.maxCorrections) {
    if (!isReasoningFailure(receipt.codexExitCode, events, receipt.verifierExitCode)) break;
    if (!isTypedVerifierReceipt(verifierReceipt, envelope)) break;
    if (hasToolingCheckFailure(verifierReceipt)) break;
    if (!sessionId) { receipt.verdict = 'missing-session'; return finalize(receipt); }
    corrections += 1;
    receipt.corrections = corrections;
    deps.writeStdout(`[correct] ${corrections}/${receipt.maxCorrections} resume session ${sanitizeToken(sessionId)}`);
    try {
      codexResult = await deps.spawnCodex({
        args: buildResumeArgs({ ...config, handoffFile }, sessionId),
        cwd: config.clone,
        env: codexEnv(config),
        stdin: verifierResult.stderr ?? '',
        onLine: collect,
      });
    } catch {
      receipt.verdict = 'codex-launch-failed';
      return finalize(receipt);
    }
    receipt.codexExitCode = codexResult.exitCode;
    captureOutputHandoff();
    try {
      verifierResult = await deps.runVerifier({ args: [verifier, config.clone, config.envelopePath], cwd: verifierCwd(verifier) });
    } catch {
      receipt.verdict = 'integration-blocked';
      receipt.integrationBlocked = true;
      return finalize(receipt);
    }
    receipt.verifierExitCode = verifierResult.exitCode;
    verifierReceipt = parseReceipt(verifierResult.stdout);
  }

  receipt.tokens = tokens;
  receipt.changedFiles = Array.isArray(verifierReceipt.changedPaths) ? verifierReceipt.changedPaths.filter(p => typeof p === 'string') : [];
  if (receipt.codexExitCode === 0 && receipt.verifierExitCode === 0 && isCompleteReceipt(verifierReceipt, envelope)) {
    receipt.verdict = 'accepted';
  } else if (receipt.codexExitCode === 0 && receipt.verifierExitCode === 0) {
    receipt.verdict = 'invalid-verifier-output';
  } else {
    receipt.verdict = 'refused';
  }
  return finalize(receipt);
}

export function parseArgs(argv) {
  const config = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--clone' || flag === '--envelope' || flag === '--brief' || flag === '--provider' ||
        flag === '--model' || flag === '--effort' || flag === '--sandbox' || flag === '--verifier' ||
        flag === '--codex-home' || flag === '--coordinator') {
      if (value === undefined) throw new Error(`missing value for ${flag}`);
      config[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return config;
}

function findCodexShim(env, exists) {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(dir => dir.length > 0);
  for (const dir of dirs) {
    for (const name of ['codex.cmd', 'codex', 'codex.exe']) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function codexLauncher(env = process.env, exists = fs.existsSync) {
  if (env.CODEX_JS) return { command: process.execPath, prefix: [env.CODEX_JS] };
  if (process.platform !== 'win32') return { command: 'codex', prefix: [] };
  const shim = findCodexShim(env, exists);
  if (!shim) return null;
  const js = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (exists(js)) return { command: process.execPath, prefix: [js] };
  return null;
}

export function codexSpawnSpec(args, env = process.env) {
  const launcher = codexLauncher(env);
  if (!launcher) return null;
  return { command: launcher.command, args: [...launcher.prefix, ...args], shell: false };
}

function defaultDeps() {
  const spawnCodex = ({ args, cwd, env, stdin, onLine }) => new Promise(resolve => {
    const spec = codexSpawnSpec(args, process.env);
    if (!spec) { resolve({ exitCode: null, stderr: 'codex-launcher-unavailable' }); return; }
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: { ...process.env, ...env },
      shell: spec.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop();
      for (const line of lines) onLine(line);
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    if (stdin !== undefined && stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
    child.on('error', err => resolve({ exitCode: null, stderr: `codex-spawn-failed: ${err.code ?? 'error'}` }));
    child.on('close', code => { if (buffer) onLine(buffer); resolve({ exitCode: code, stderr }); });
  });
  const runVerifier = ({ args, cwd }) => new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', () => resolve({ exitCode: null, stdout, stderr }));
    child.on('close', code => resolve({ exitCode: code, stdout, stderr }));
  });
  return {
    now: () => Date.now(),
    exists: p => fs.existsSync(p),
    realpath: p => fs.realpathSync(p),
    readFile: p => fs.readFileSync(p, 'utf8'),
    writeFile: (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); },
    appendFile: (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, data); },
    mkdir: p => fs.mkdirSync(p, { recursive: true }),
    trustedCoordinator: coordinator,
    writeStdout: line => process.stdout.write(`${line}\n`),
    writeStderr: line => process.stderr.write(`${line}\n`),
    spawnCodex,
    runVerifier,
  };
}

export function usage() {
  return [
    'usage: node tools/worker-launch.mjs --clone <dir> --envelope <file>',
    '  [--brief <file>] [--provider <id>] [--model <name>] [--effort <low|medium|high>]',
    '  [--sandbox <mode>] [--verifier <path>] [--codex-home <dir>] [--coordinator <dir>]',
  ].join('\n');
}

export async function main(argv, deps = defaultDeps()) {
  let args;
  try { args = parseArgs(argv); } catch (err) { deps.writeStderr(`${err.message}\n${usage()}\n`); return 2; }
  if (!args.clone || !args.envelope || !args.model || !args.effort) {
    deps.writeStderr(`${usage()}\n`);
    return 2;
  }
  const configCoordinator = args.coordinator ? path.resolve(args.coordinator) : coordinator;
  const config = {
    clone: path.resolve(args.clone),
    envelopePath: path.resolve(args.envelope),
    briefPath: args.brief ? path.resolve(args.brief) : undefined,
    provider: args.provider ?? 'deepseek',
    model: args.model,
    effort: args.effort,
    sandbox: args.sandbox ?? 'workspace-write',
    codexHome: args.codexHome ?? 'C:/Dev/tools/vault-companion-codex-home',
    verifier: args.verifier ? path.resolve(args.verifier) : defaultVerifier,
    coordinator: configCoordinator,
    handoffSchema: path.join(configCoordinator, 'tools', 'profiles', 'handoff.schema.json'),
  };
  const receipt = await runLaunch(config, deps);
  deps.writeStdout(`VERDICT: ${receipt.verdict}`);
  deps.writeStdout(`${receipt.taskId ?? 'work'} ${receipt.verdict === 'accepted' ? 'DONE' : 'BLOCKED'}`);
  return receipt.verdict === 'accepted' ? 0 : 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
