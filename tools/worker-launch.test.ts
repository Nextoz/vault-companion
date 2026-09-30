import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  validateEnvelope,
  validateLaunchConfig,
  buildCodexArgs,
  buildResumeArgs,
  isReasoningFailure,
  parseReceipt,
  isTypedVerifierReceipt,
  hasToolingCheckFailure,
  codexSpawnSpec,
  runLaunch,
  main,
} from './worker-launch.mjs';

const SESSION = '01a0f0ab-0000-7000-8000-000000000001';
const SECRET = 'PRIVATE-VAULT-TOKEN-7f3a';

function envelopeFixture(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    taskId: 'h2-smoke',
    riskClass: 'ordinary',
    allowedPaths: ['tools/**'],
    allowedProtectedPaths: [],
    mayEditTests: false,
    mayEditCI: false,
    mayAddDependencies: false,
    requiredChecks: [{ argv: ['pnpm', '-r', 'exec', 'tsc', '--noEmit'], timeoutMs: 18000 }],
    maxCorrections: 1,
    baseCommit: 'a'.repeat(40),
    ...overrides,
  };
}

const TSC_CHECK = ['pnpm', '-r', 'exec', 'tsc', '--noEmit'];

function bindingFixture(envelope: Record<string, unknown>) {
  return {
    taskId: envelope.taskId,
    base: envelope.baseCommit,
    head: 'b'.repeat(40),
    diffDigest: 'd'.repeat(64),
    envelopeDigest: 'e'.repeat(64),
  };
}

function verifierReceiptFixture(envelope: Record<string, unknown>, accepted: boolean, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    runId: 'run-1',
    taskId: envelope.taskId,
    backend: 'deepseek',
    model: 'deepseek-v4-pro',
    effort: 'high',
    risk: envelope.riskClass,
    base: envelope.baseCommit,
    head: 'b'.repeat(40),
    diffDigest: 'd'.repeat(64),
    changedPaths: ['tools/worker-launch.mjs'],
    findings: [],
    checks: [{ argv: TSC_CHECK, timeoutMs: 18000, exitCode: accepted ? 0 : 1, timedOut: false, passed: accepted }],
    corrections: 0,
    elapsedMs: 12,
    tokens: 7,
    accepted,
    binding: bindingFixture(envelope),
    ...overrides,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const coordinator = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-coord-'));
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-clone-'));
  const envelopeFile = path.join(coordinator, '.agent', 'harness', 'envelope.json');
  fs.mkdirSync(path.dirname(envelopeFile), { recursive: true });
  fs.writeFileSync(envelopeFile, JSON.stringify(envelopeFixture(overrides.envelope ?? {})));
  const verifier = path.join(coordinator, 'tools', 'harness', 'verify-run.mjs');
  fs.mkdirSync(path.dirname(verifier), { recursive: true });
  fs.writeFileSync(verifier, '');
  const brief = path.join(clone, '.agent', 'brief.md');
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, 'synthetic brief\n');
  const config = {
    clone,
    envelopePath: envelopeFile,
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    effort: 'high',
    sandbox: 'workspace-write',
    codexHome: 'C:/Dev/tools/codex-home',
    verifier,
    coordinator,
    handoffSchema: path.join(coordinator, 'tools', 'profiles', 'handoff.schema.json'),
  };
  return { coordinator, clone, envelopeFile, verifier, brief, config };
}

type CodexCall = { args: string[]; stdin: string };

function makeDeps(overrides: Record<string, unknown> = {}) {
  const calls = { codex: [] as CodexCall[], verifier: [] as string[][] };
  const lines: string[] = [];
  const errs: string[] = [];
  const deps: Record<string, unknown> = {
    now: () => 1700000000000,
    exists: () => true,
    realpath: (p: string) => path.resolve(p),
    readFile: (p: string) => fs.readFileSync(p, 'utf8'),
    writeFile: (p: string, d: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); },
    appendFile: (p: string, d: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, d); },
    mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
    writeStdout: (l: string) => lines.push(l),
    writeStderr: (l: string) => errs.push(l),
    spawnCodex: async ({ args, stdin, onLine }: { args: string[]; stdin: string; onLine: (line: string) => void }) => {
      calls.codex.push({ args, stdin });
      onLine(JSON.stringify({ type: 'thread.started', thread_id: SESSION }));
      onLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } }));
      return { exitCode: 0, stderr: '' };
    },
    runVerifier: async ({ args }: { args: string[] }) => {
      calls.verifier.push(args);
      const receipt = verifierReceiptFixture(envelopeFixture(), false, { findings: [{ id: 'f1', code: 'check-failed', path: 'tools/worker-launch.mjs', dispositionable: false, dispositioned: false }] });
      return { exitCode: 1, stdout: JSON.stringify(receipt), stderr: '# Harness refusal\nRun: run-1\n- check-failed: tools/worker-launch.mjs\n' };
    },
    ...overrides,
  };
  return { deps, calls, lines, errs };
}

describe('validateEnvelope', () => {
  it('accepts the H1 envelope v1 shape', () => {
    expect(validateEnvelope(envelopeFixture()).taskId).toBe('h2-smoke');
  });

  it('rejects malformed envelopes before any launch', () => {
    expect(() => validateEnvelope(envelopeFixture({ taskId: 'bad id' }))).toThrow();
    expect(() => validateEnvelope(envelopeFixture({ maxCorrections: 21 }))).toThrow();
    expect(() => validateEnvelope(envelopeFixture({ baseCommit: 'short' }))).toThrow();
    expect(() => validateEnvelope(envelopeFixture({ requiredChecks: [{ argv: ['rm', '-rf'], timeoutMs: 1000 }] }))).toThrow();
    expect(() => validateEnvelope(envelopeFixture({ allowedPaths: ['C:/evil'] }))).toThrow();
    expect(() => validateEnvelope({ ...envelopeFixture(), extra: true })).toThrow();
  });
});

describe('buildCodexArgs', () => {
  it('pins provider/model/effort, memories off, JSON events and the handoff schema', () => {
    const args = buildCodexArgs({
      provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high', sandbox: 'workspace-write',
      handoffSchema: 'schema.json', handoffFile: 'handoff.json', clone: 'clone-dir',
    });
    expect(args.slice(0, 3)).toEqual(['exec', '-m', 'deepseek-v4-pro']);
    expect(args).toContain('model_provider=deepseek');
    expect(args).toContain('model_reasoning_effort=high');
    expect(args).toContain('features.memories=false');
    expect(args).toContain('memories.use_memories=false');
    expect(args).toContain('memories.generate_memories=false');
    expect(args).toContain('--sandbox');
    expect(args).toContain('--json');
    expect(args).toContain('--output-schema');
    expect(args).toContain('-o');
    expect(args.at(-1)).toBe('-');
  });

  it('builds resume args around the actual session id', () => {
    const args = buildResumeArgs({ provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high', sandbox: 'workspace-write', handoffSchema: 'schema.json', handoffFile: 'handoff.json', clone: 'clone-dir' }, SESSION);
    expect(args.slice(0, 4)).toEqual(['exec', 'resume', SESSION, '-']);
    expect(args).toContain('features.memories=false');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).toContain('--output-schema');
    expect(args).toContain('-o');
    expect(args).toContain('-C');
    expect(args).toContain('clone-dir');
  });
});

describe('isReasoningFailure', () => {
  it('allows correction only for a completed run refused by the verifier', () => {
    expect(isReasoningFailure(0, [], 1)).toBe(true);
    expect(isReasoningFailure(0, [], 0)).toBe(false);
    expect(isReasoningFailure(2, [], 1)).toBe(false);
    expect(isReasoningFailure(0, [{ type: 'error', error: { type: 'insufficient_quota' } }], 1)).toBe(false);
    expect(isReasoningFailure(0, [{ type: 'error', error: { type: 'provider_error', message: 'model not found' } }], 1)).toBe(false);
  });
});

describe('codexSpawnSpec', () => {
  it('routes argv through a located launcher without shell interpretation', () => {
    const spec = codexSpawnSpec(['exec', '-m', 'deepseek-flash'], { CODEX_JS: 'C:/tools/codex.js' });
    expect(spec).not.toBeNull();
    expect(spec?.shell).toBe(false);
    expect(spec?.args[0]).toBe('C:/tools/codex.js');
    expect(spec?.args.slice(1)).toEqual(['exec', '-m', 'deepseek-flash']);
  });
});

describe('runLaunch', () => {
  it('refuses when the trusted verifier is missing and never claims acceptance', async () => {
    const { config } = setup();
    const { deps, calls } = makeDeps({ exists: (p: string) => p !== config.verifier });
    const receipt = await runLaunch(config, deps);
    expect(receipt.verdict).toBe('integration-blocked');
    expect(receipt.integrationBlocked).toBe(true);
    expect(calls.codex.length).toBe(0);
  });

  it('refuses an invalid envelope before launching', async () => {
    const { config } = setup({ envelope: { taskId: 'bad id' } });
    const { deps, calls } = makeDeps();
    const receipt = await runLaunch(config, deps);
    expect(receipt.verdict).toBe('invalid-envelope');
    expect(calls.codex.length).toBe(0);
  });

  it('refuses an envelope that lives inside the worker clone', async () => {
    const { config, clone } = setup();
    fs.writeFileSync(path.join(clone, 'envelope.json'), JSON.stringify(envelopeFixture()));
    const { deps, calls } = makeDeps();
    const receipt = await runLaunch({ ...config, envelopePath: path.join(clone, 'envelope.json') }, deps);
    expect(receipt.verdict).toBe('untrusted-envelope-location');
    expect(calls.codex.length).toBe(0);
  });

  it('accepts when the verifier accepts and performs no correction', async () => {
    const { config } = setup();
    const { deps, calls } = makeDeps({
      runVerifier: async ({ args }: { args: string[] }) => {
        calls.verifier.push(args);
        return { exitCode: 0, stdout: JSON.stringify(verifierReceiptFixture(envelopeFixture(), true)), stderr: '' };
      },
    });
    const receipt = await runLaunch(config, deps);
    expect(receipt.verdict).toBe('accepted');
    expect(receipt.corrections).toBe(0);
    expect(calls.codex.length).toBe(1);
    expect(calls.verifier.length).toBe(1);
    expect(receipt.changedFiles).toEqual(['tools/worker-launch.mjs']);
    expect(receipt.tokens).toBe(7);
  });

  it('resumes the actual session with the failure packet exactly up to maxCorrections', async () => {
    const { config } = setup({ envelope: { maxCorrections: 1 } });
    const { deps, calls } = makeDeps();
    const receipt = await runLaunch(config, deps);
    expect(receipt.verdict).toBe('refused');
    expect(receipt.corrections).toBe(1);
    expect(calls.codex.length).toBe(2);
    expect(calls.verifier.length).toBe(2);
    const resume = calls.codex[1] as CodexCall;
    expect(resume.args.slice(0, 4)).toEqual(['exec', 'resume', SESSION, '-']);
    expect(resume.stdin).toContain('check-failed');
    expect(calls.verifier[0]).toEqual([config.verifier, config.clone, config.envelopePath]);
  });

  it('stops after the correction cap without a second resume', async () => {
    const { config } = setup({ envelope: { maxCorrections: 0 } });
    const { deps, calls } = makeDeps();
    const receipt = await runLaunch(config, deps);
    expect(receipt.verdict).toBe('refused');
    expect(receipt.corrections).toBe(0);
    expect(calls.codex.length).toBe(1);
  });

  it('never escalates quota/provider/tooling failures into a correction', async () => {
    const { config } = setup({ envelope: { maxCorrections: 3 } });
    const { deps, calls } = makeDeps({
      spawnCodex: async ({ args, onLine }: { args: string[]; onLine: (line: string) => void }) => {
        calls.codex.push({ args, stdin: '' });
        onLine(JSON.stringify({ type: 'thread.started', thread_id: SESSION }));
        onLine(JSON.stringify({ type: 'error', error: { type: 'insufficient_quota', message: 'usage limit reached' } }));
        return { exitCode: 0, stderr: '' };
      },
    });
    const receipt = await runLaunch(config, deps);
    expect(receipt.verdict).toBe('refused');
    expect(receipt.corrections).toBe(0);
    expect(calls.codex.length).toBe(1);
  });

  it('reports missing-session instead of guessing when no session id was captured', async () => {
    const { config } = setup({ envelope: { maxCorrections: 1 } });
    const { deps } = makeDeps({
      spawnCodex: async ({ args, onLine }: { args: string[]; onLine: (line: string) => void }) => {
        onLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
        return { exitCode: 0, stderr: '' };
      },
    });
    const receipt = await runLaunch(config, deps);
    expect(receipt.verdict).toBe('missing-session');
  });

  it('writes a metadata-only receipt with no text or secret fields', async () => {
    const { config, coordinator } = setup();
    const { deps } = makeDeps({
      runVerifier: async ({ args }: { args: string[] }) => ({ exitCode: 0, stdout: JSON.stringify(verifierReceiptFixture(envelopeFixture(), true)), stderr: '' }),
      spawnCodex: async ({ args, onLine }: { args: string[]; onLine: (line: string) => void }) => {
        onLine(JSON.stringify({ type: 'thread.started', thread_id: SESSION }));
        onLine(JSON.stringify({ type: 'assistant_message', message: SECRET }));
        return { exitCode: 0, stderr: '' };
      },
    });
    const receipt = await runLaunch(config, deps);
    const keys = Object.keys(receipt).sort();
    expect(keys).toEqual([
      'backend', 'changedFiles', 'codexExitCode', 'corrections', 'durationMs', 'effort', 'integrationBlocked',
      'maxCorrections', 'model', 'risk', 'runId', 'taskId', 'tokens', 'verdict', 'verifierExitCode', 'version',
    ].sort());
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(SECRET);
    const receiptDir = path.join(coordinator, '.agent', 'receipts');
    const files = fs.readdirSync(receiptDir);
    expect(files.length).toBe(1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(receiptDir, files[0]!), 'utf8'));
    expect(Object.keys(onDisk).sort()).toEqual(keys);
  });

  it('refuses invalid provider/model/effort/sandbox before any launch', async () => {
    const { config } = setup();
    for (const overrides of [{ provider: 'openai' }, { model: 'deepseek-pro' }, { effort: 'max' }, { sandbox: 'nope' }]) {
      const { deps, calls } = makeDeps();
      const receipt = await runLaunch({ ...config, ...overrides }, deps);
      expect(receipt.verdict).toBe('invalid-config');
      expect(calls.codex.length).toBe(0);
    }
  });

  it('refuses a coordinator override that points into the worker clone', async () => {
    const { config, clone } = setup();
    const { deps, calls } = makeDeps();
    const receipt = await runLaunch({ ...config, coordinator: clone }, deps);
    expect(receipt.verdict).toBe('untrusted-coordinator');
    expect(calls.codex.length).toBe(0);
  });

  it('refuses a verifier whose realpath lies inside the worker clone', async () => {
    const { config, clone, coordinator } = setup();
    const evilVerifier = path.join(clone, 'tools', 'harness', 'verify-run.mjs');
    fs.mkdirSync(path.dirname(evilVerifier), { recursive: true });
    fs.writeFileSync(evilVerifier, '');
    const { deps, calls } = makeDeps({ exists: (p: string) => p !== path.join(coordinator, 'tools', 'harness', 'verify-run.mjs') || p === evilVerifier });
    const receipt = await runLaunch({ ...config, verifier: evilVerifier }, deps);
    expect(receipt.verdict).toBe('untrusted-verifier-location');
    expect(calls.codex.length).toBe(0);
  });

  it('never accepts an exit-mismatch: nonzero Codex exit with verifier acceptance', async () => {
    const { config } = setup();
    const { deps } = makeDeps({
      spawnCodex: async ({ args, onLine }: { args: string[]; onLine: (line: string) => void }) => {
        onLine(JSON.stringify({ type: 'thread.started', thread_id: SESSION }));
        return { exitCode: 2, stderr: '' };
      },
      runVerifier: async ({ args }: { args: string[] }) => ({ exitCode: 0, stdout: JSON.stringify(verifierReceiptFixture(envelopeFixture(), true)), stderr: '' }),
    });
    const receipt = await runLaunch(config, deps);
    expect(receipt.verdict).toBe('refused');
  });

  it('does not auto-correct on malformed verifier output', async () => {
    const { config } = setup({ envelope: { maxCorrections: 2 } });
    const { deps, calls } = makeDeps({
      runVerifier: async ({ args }: { args: string[] }) => ({ exitCode: 1, stdout: 'not json', stderr: '' }),
    });
    const receipt = await runLaunch(config, deps);
    expect(receipt.verdict).toBe('refused');
    expect(receipt.corrections).toBe(0);
    expect(calls.codex.length).toBe(1);
  });

  it('does not auto-correct on check tooling failures', async () => {
    const { config } = setup({ envelope: { maxCorrections: 2 } });
    const receiptFixture = verifierReceiptFixture(envelopeFixture(), false, { checks: [{ argv: TSC_CHECK, timeoutMs: 18000, exitCode: null, timedOut: true, passed: false }] });
    const { deps, calls } = makeDeps({
      runVerifier: async ({ args }: { args: string[] }) => ({ exitCode: 1, stdout: JSON.stringify(receiptFixture), stderr: '' }),
    });
    const receipt = await runLaunch(config, deps);
    expect(receipt.verdict).toBe('refused');
    expect(receipt.corrections).toBe(0);
    expect(calls.codex.length).toBe(1);
  });

  it('replaces the first-turn handoff with the corrected handoff', async () => {
    const { config, clone } = setup({ envelope: { maxCorrections: 1 } });
    const first = { version: 1, completed: ['stale claim'], verification: [{ check: 'tsc', result: 'passed' }] };
    const second = { version: 1, completed: ['corrected claim'], verification: [{ check: 'tsc', result: 'passed' }] };
    let turn = 0;
    const { deps, calls } = makeDeps({
      spawnCodex: async ({ args, onLine }: { args: string[]; onLine: (line: string) => void }) => {
        calls.codex.push({ args, stdin: '' });
        onLine(JSON.stringify({ type: 'thread.started', thread_id: SESSION }));
        onLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(turn === 0 ? first : second) } }));
        turn += 1;
        return { exitCode: 0, stderr: '' };
      },
    });
    const receipt = await runLaunch(config, deps);
    expect(receipt.corrections).toBe(1);
    const saved = JSON.parse(fs.readFileSync(path.join(clone, '.agent', 'handoffs', 'h2-smoke.json'), 'utf8'));
    expect(saved.completed).toEqual(['corrected claim']);
  });
});

describe('parseReceipt', () => {
  it('tolerates non-JSON verifier output', () => {
    expect(parseReceipt('not json')).toEqual({});
    expect(parseReceipt('{"accepted":true}')).toEqual({ accepted: true });
  });
});

describe('worker-launch CLI', () => {
  it('prints a VERDICT line and returns the verifier outcome as the exit code', async () => {
    const { config, clone, envelopeFile, coordinator } = setup();
    const { deps, calls, lines } = makeDeps({
      runVerifier: async ({ args }: { args: string[] }) => {
        calls.verifier.push(args);
        return { exitCode: 0, stdout: JSON.stringify(verifierReceiptFixture(envelopeFixture(), true)), stderr: '' };
      },
    });
    const code = await main([
      '--clone', clone,
      '--envelope', envelopeFile,
      '--provider', 'deepseek',
      '--model', 'deepseek-v4-pro',
      '--effort', 'high',
      '--verifier', config.verifier,
      '--coordinator', coordinator,
    ], deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('VERDICT: accepted');
    expect(lines.join('\n')).toContain('h2-smoke DONE');
  });
});

describe('pinned launch profiles', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

  it('lead profile pins Opus/high, disables Claude AI MCP and never enables cloudflare execute', () => {
    const lead = JSON.parse(read('tools/profiles/lead.profile.json'));
    expect(lead.model).toBe('claude-opus-5-5');
    expect(lead.effort).toBe('high');
    expect(lead.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(lead.allowCloudflareExecute).toBe(false);
  });

  it('lead MCP config pins only context7 and playwright', () => {
    const mcp = JSON.parse(read('tools/profiles/lead.mcp.json'));
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['context7', 'playwright']);
    expect(JSON.stringify(mcp).toLowerCase()).not.toContain('cloudflare');
  });

  it('worker profile isolates home, disables memories/MCP and defaults to workspace-write', () => {
    const worker = JSON.parse(read('tools/profiles/worker.profile.json'));
    expect(worker.sandbox).toBe('workspace-write');
    expect(worker.memories).toBe(false);
    expect(worker.mcp).toBe(false);
    expect(worker.codexHome).toBe('C:/Dev/tools/vault-companion-codex-home');
    expect(worker.defaultModel).toBe('deepseek-flash');
    expect(worker.models.flash).toBe('deepseek-flash');
    expect(worker.models.pro).toBe('deepseek-v4-pro');
  });

  it('worker Codex config pins DeepSeek provider/env and has no MCP or memories', () => {
    const toml = read('tools/profiles/worker.codex.toml');
    expect(toml).not.toContain('mcp_servers');
    expect(toml).toContain('memories = false');
    expect(toml).toContain('generate_memories = false');
    expect(toml).toContain('use_memories = false');
    expect(toml).toContain('model_provider = "deepseek"');
    expect(toml).toContain('[model_providers.deepseek]');
    expect(toml).toContain('base_url = "https://api.deepseek.com"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('env_key = "DEEPSEEK_API_KEY"');
    expect(toml).not.toMatch(/env_key\s*=\s*"sk-/u);
    expect(toml).not.toContain('api_key = ');
  });

  const runPs1 = (script: string, args: string[]) => {
    const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join(process.cwd(), script), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    expect(result.status).toBe(0);
    return result.stdout;
  };

  it('start-lead emits an executable command with --strict-mcp-config', () => {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lead-launcher-')), 'start-lead.launch.ps1');
    const out = runPs1('tools/start-lead.ps1', ['-Out', outFile]);
    expect(out).toContain('Lead launcher written');
    const command = fs.readFileSync(outFile, 'utf8');
    expect(command).toContain('--strict-mcp-config');
    expect(command).toContain('claude --model "claude-opus-5-5" --effort "high"');
    expect(command).toContain('--mcp-config');
  });

  it('start-worker defaults to Flash and pins the coordinator absolute launcher', () => {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-launch-'));
    const envelope = path.join(clone, 'envelope.json');
    fs.writeFileSync(envelope, JSON.stringify(envelopeFixture()));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-home-'));
    const out = runPs1('tools/start-worker.ps1', ['-Clone', clone, '-Envelope', envelope, '-CodexHome', codexHome]);
    expect(out).toContain('deepseek-flash');
    expect(out).toContain('/tools/worker-launch.mjs');
    expect(out).not.toContain('node tools/worker-launch.mjs');
    expect(out).toContain('--coordinator');
  });
});
