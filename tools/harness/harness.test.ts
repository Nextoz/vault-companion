import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

type Verdict = {
  runId: string; accepted: boolean; changedPaths: string[]; binding: object; model: string | null; tokens: number | null;
  findings: { id: string; code: string; path: string }[];
  checks: { exitCode: number | null; timedOut: boolean; passed: boolean }[];
  hookSpecificOutput: { permissionDecision?: string; additionalContext: string }; decision?: string;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Local Windows checkouts use a sibling directory under C:/Dev so fixtures stay separate from the
// coordinator checkout. CI/Linux and any other checkout use the portable runner temp instead.
const tempBase = fs.realpathSync(process.platform === 'win32' &&
  root.toLowerCase().replaceAll('\\', '/').startsWith('c:/dev/') ? path.resolve(root, '..') : os.tmpdir());
const temporary = fs.mkdtempSync(path.join(tempBase, 'h1-fixtures-'));
const trusted = path.join(root, 'tools/harness', `.fixture-${randomUUID()}`);
fs.mkdirSync(trusted);
const receipts: string[] = [];
afterAll(() => {
  // Only exact paths created by this fixture are removed; no shell deletion or computed workspace traversal.
  for (const p of receipts) fs.rmSync(p, { force: true });
  for (const [dir, parent] of [[temporary, tempBase], [trusted, path.join(root, 'tools/harness')]]) {
    if (dir && parent && path.dirname(dir) === parent) fs.rmSync(dir, { recursive: true, force: true });
  }
});
function write(dir: string, p: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text);
}
function git(dir: string, args: string[]) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (r.status !== 0) throw new Error(`Fixture Git failure: ${r.stderr}`);
  return r.stdout.trim();
}
function cli(file: string, args: string[], input?: unknown, env = process.env) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools/harness', file), ...args], {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 25000, env, windowsHide: true,
  });
  if (r.error) throw r.error;
  const json = JSON.parse(r.stdout) as Verdict;
  if (typeof json.runId === 'string') receipts.push(path.join(root, '.agent/receipts', `${json.runId}.json`));
  return { status: r.status, json, stderr: r.stderr };
}
const goodSpec = "test('synthetic check',()=>{expect(2+2).toBe(4)});\n";
function repo() {
  const dir = fs.mkdtempSync(path.join(temporary, 'repo-'));
  write(dir, '.gitignore', 'node_modules/\n');
  write(dir, 'package.json', '{"name":"synthetic-fixture","private":true,"type":"module"}\n');
  write(dir, 'vitest.config.mjs', "export default {test:{include:['*.test.js'],watch:false,globals:true,cache:false}};\n");
  write(dir, 'note.md', 'synthetic original\n');
  write(dir, 'old.test.js', goodSpec);
  git(dir, ['init', '-b', 'main']); git(dir, ['config', 'user.email', 'fixture@example.invalid']); git(dir, ['config', 'user.name', 'Fixture']);
  git(dir, ['add', '.']); git(dir, ['commit', '-m', 'Synthetic baseline']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  const envelope = { version: 1, taskId: 'synthetic', riskClass: 'high', baseCommit: base, allowedPaths: ['note.md', 'new.test.js'],
    allowedProtectedPaths: [], mayEditTests: true, mayEditCI: false, mayAddDependencies: false, maxCorrections: 1,
    requiredChecks: [{ argv: ['pnpm', 'exec', 'vitest', 'run', 'new.test.js', '--reporter=dot'], timeoutMs: 18000 }] };
  return { dir, envelope };
}
function verify(r: ReturnType<typeof repo>, disposition?: unknown, location = trusted) {
  const file = path.join(location, `${randomUUID()}.json`); fs.writeFileSync(file, JSON.stringify(r.envelope));
  const args = [r.dir, file];
  if (disposition) { const d = path.join(trusted, `${randomUUID()}.json`); fs.writeFileSync(d, JSON.stringify(disposition)); args.push(d); }
  return cli('verify-run.mjs', args);
}
const codes = (r: ReturnType<typeof cli>) => r.json.findings.map((f: { code: string }) => f.code);
function hook(event: string, input: object, env = process.env) { return cli('hook.mjs', [event], { hook_event_name: event, ...input }, env).json; }
const decision = (r: Verdict) => r.hookSpecificOutput?.permissionDecision;

describe('verify-run actual CLI', () => {
  it('required eval: added .skip is flagged', () => {
    const r = repo(); write(r.dir, 'new.test.js', goodSpec.replace('test(', 'test.skip('));
    expect(codes(verify(r))).toContain('test-disabled-or-focused');
  });
  it.each(['test.concurrent.only(', 'test.concurrent.skip(', 'test.skipIf(true)('])('flags equivalent focused/skipped form %s', form => {
    const r = repo(); write(r.dir, 'new.test.js', goodSpec.replace('test(', form));
    expect(codes(verify(r))).toContain('test-disabled-or-focused');
  });
  it('required eval: CI edit is flagged even when in allowedPaths', () => {
    const r = repo(); r.envelope.allowedPaths.push('.github/workflows/ci.yml');
    write(r.dir, '.github/workflows/ci.yml', 'name: synthetic\n');
    expect(codes(verify(r))).toEqual(expect.arrayContaining(['ci-forbidden', 'protected-path']));
  });
  it('required eval: clean allowed change WITH new test passes and has metadata-only receipt', () => {
    const r = repo(); write(r.dir, 'note.md', 'SYNTHETIC_PRIVATE_MARKER\n'); write(r.dir, 'new.test.js', goodSpec);
    const result = verify(r);
    expect(result.status, JSON.stringify(result.json)).toBe(0); expect(result.stderr).toBe(''); expect(result.json.accepted).toBe(true);
    expect(result.json.checks[0]).toMatchObject({ exitCode: 0, timedOut: false, passed: true });
    const receipt = fs.readFileSync(receipts.at(-1)!, 'utf8');
    expect(receipt).not.toContain('SYNTHETIC_PRIVATE_MARKER'); expect(receipt).not.toContain('stdout');
    expect(result.json.model).toBeNull(); expect(result.json.tokens).toBeNull();
  });
  it('rejects untracked out-of-scope files and casing mismatches', () => {
    const r = repo(); write(r.dir, 'rogue.md', 'synthetic'); r.envelope.allowedPaths = ['Rogue.md'];
    expect(codes(verify(r))).toContain('outside-allowed-paths');
  });
  it('does not let ignore files hide untracked source', () => {
    const r = repo(); write(r.dir, 'hidden/rogue.ts', 'synthetic hidden source');
    write(r.dir, '.gitignore', 'node_modules/\nhidden/\n'); write(r.dir, '.git/info/exclude', 'excluded.md\n'); write(r.dir, 'excluded.md', 'synthetic');
    expect(verify(r).json.changedPaths).toEqual(['.gitignore', 'excluded.md', 'hidden/rogue.ts']);
  });
  it('scans hidden source under src/build, *.log and new/modified runtime dependencies', () => {
    const r = repo();
    write(r.dir, 'src/build/hidden.ts', 'synthetic hidden source');
    write(r.dir, 'src/hidden.log', 'synthetic log source');
    write(r.dir, 'node_modules/vitest/dist/index.js', 'synthetic modified runtime dependency');
    write(r.dir, 'dist/bundle.js', 'synthetic generated bundle');
    const result = verify(r);
    expect(result.json.changedPaths).toEqual(expect.arrayContaining([
      'src/build/hidden.ts', 'src/hidden.log', 'node_modules/vitest/dist/index.js', 'dist/bundle.js',
    ]));
    expect(codes(result)).toContain('outside-allowed-paths');
  });
  it('still scans committed runtime-artifact paths when they are out of scope', () => {
    const r = repo();
    write(r.dir, 'node_modules/vitest/dist/index.js', 'synthetic tracked runtime dependency');
    git(r.dir, ['add', '-f', 'node_modules/vitest/dist/index.js']);
    git(r.dir, ['commit', '-m', 'Synthetic tracked runtime artifact']);
    const result = verify(r);
    expect(result.json.changedPaths).toContain('node_modules/vitest/dist/index.js');
    expect(codes(result)).toContain('outside-allowed-paths');
  });
  it('rejects index flags that conceal worktree modifications', () => {
    const r = repo(); git(r.dir, ['update-index', '--assume-unchanged', 'package.json']);
    write(r.dir, 'package.json', '{"dependencies":{"synthetic":"1.0.0"}}');
    expect(codes(verify(r))).toContain('unsupported-index-flags');
  });
  it('does not execute clone-configured Git clean filters while gathering evidence', () => {
    const r = repo(); write(r.dir, '.gitattributes', 'note.md filter=synthetic\n');
    git(r.dir, ['config', 'filter.synthetic.clean', 'this-synthetic-command-must-never-run']);
    git(r.dir, ['config', 'filter.synthetic.required', 'true']); write(r.dir, 'note.md', 'synthetic changed\n');
    const result = verify(r); expect(result.json.changedPaths).toContain('note.md');
    expect(codes(result)).not.toContain('git-evidence-unavailable');
  });
  it('covers committed and staged changes even when the working file is restored', () => {
    const r = repo(); write(r.dir, 'rogue.md', 'synthetic'); git(r.dir, ['add', 'rogue.md']); git(r.dir, ['commit', '-m', 'Synthetic change']);
    write(r.dir, 'staged.md', 'synthetic'); git(r.dir, ['add', 'staged.md']); fs.unlinkSync(path.join(r.dir, 'staged.md'));
    expect(verify(r).json.changedPaths).toEqual(['rogue.md', 'staged.md']);
  });
  it('required eval: committed weakened spec/dependency edit is flagged after worktree restoration', () => {
    const r = repo();
    write(r.dir, 'package.json', '{"dependencies":{"synthetic":"1.0.0"}}');
    write(r.dir, 'old.test.js', goodSpec.replace('test(', 'test.skip('));
    git(r.dir, ['add', 'package.json', 'old.test.js']); git(r.dir, ['commit', '-m', 'Synthetic committed weakening']);
    write(r.dir, 'package.json', '{"name":"synthetic-fixture","private":true,"type":"module"}\n');
    write(r.dir, 'old.test.js', goodSpec);
    expect(codes(verify(r))).toEqual(expect.arrayContaining(['dependencies-forbidden', 'test-disabled-or-focused']));
  });
  it('required eval: staged weakened spec/dependency edit is flagged after worktree restoration', () => {
    const r = repo();
    write(r.dir, 'package.json', '{"dependencies":{"synthetic":"1.0.0"}}');
    write(r.dir, 'old.test.js', goodSpec.replace('test(', 'test.skip('));
    git(r.dir, ['add', 'package.json', 'old.test.js']);
    write(r.dir, 'package.json', '{"name":"synthetic-fixture","private":true,"type":"module"}\n');
    write(r.dir, 'old.test.js', goodSpec);
    expect(codes(verify(r))).toEqual(expect.arrayContaining(['dependencies-forbidden', 'test-disabled-or-focused']));
  });
  it.each(['../escape', '/absolute', 'C:/absolute', 'tools\\escape', 'foo/../bar', 'foo./bar', 'CON.txt'])('rejects traversal or ambiguous path %s', p => {
    const r = repo(); r.envelope.allowedPaths = [p]; expect(verify(r).status).toBe(1);
  });
  it('rejects malformed envelope, absent baseline, unknown commands and worker envelope', () => {
    const r = repo(); const original = structuredClone(r.envelope);
    Object.assign(r.envelope, { baseCommit: '0'.repeat(40) }); expect(verify(r).status).toBe(1);
    r.envelope = structuredClone(original); Object.assign(r.envelope, { surprise: true }); expect(codes(verify(r))).toContain('invalid-object');
    r.envelope = structuredClone(original); Object.assign(r.envelope, { taskId: 123 }); expect(codes(verify(r))).toContain('invalid-envelope');
    r.envelope = structuredClone(original); r.envelope.requiredChecks[0]!.argv = ['pnpm', 'run', 'evil']; expect(codes(verify(r))).toContain('unknown-check');
    r.envelope = original; expect(codes(verify(r, undefined, r.dir))).toContain('untrusted-evidence-location');
  });
  it('flags deleted tests, dependency changes, ignore additions and focused equivalents', () => {
    const r = repo(); fs.unlinkSync(path.join(r.dir, 'old.test.js')); write(r.dir, 'new.test.js', goodSpec.replace('test(', "test['only']("));
    write(r.dir, '.gitignore', 'node_modules/\nhidden/\n'); write(r.dir, 'package.json', '{"dependencies":{"synthetic":"1.0.0"}}');
    expect(codes(verify(r))).toEqual(expect.arrayContaining(['test-count-reduced', 'test-disabled-or-focused', 'dependencies-forbidden', 'ignore-added']));
  });
  it('rejects symlink escapes', () => {
    const r = repo(); fs.symlinkSync(trusted, path.join(r.dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    r.envelope.allowedPaths.push('linked/**'); expect(codes(verify(r))).toContain('symlink-escape');
  });
  it('protected allow is scoped and does not override tests/CI booleans', () => {
    const r = repo(); r.envelope.allowedPaths.push('.claude/settings.json', '.github/workflows/ci.yml');
    r.envelope.allowedProtectedPaths.push('.claude/settings.json'); write(r.dir, '.claude/settings.json', '{}'); write(r.dir, '.github/workflows/ci.yml', 'name: synthetic');
    const result = verify(r); expect(codes(result)).toContain('ci-forbidden');
    expect(result.json.findings.filter((f: { code: string }) => f.code === 'protected-path').map((f: { path: string }) => f.path)).toEqual(['.github/workflows/ci.yml']);
  });
  it('captures check failures and timeouts itself', () => {
    const r = repo(); write(r.dir, 'new.test.js', goodSpec.replace('toBe(4)', 'toBe(5)'));
    const failure = verify(r); expect(failure.status).toBe(1); expect(failure.json.checks[0].exitCode).not.toBe(0);
    r.envelope.requiredChecks[0]!.timeoutMs = 1;
    const timeout = verify(r); expect(timeout.status).toBe(1); expect(timeout.json.checks[0]?.timedOut, JSON.stringify(timeout.json)).toBe(true);
  });
  it('accepts only trusted Lead dispositions bound to the exact diff', () => {
    const r = repo(); r.envelope.allowedPaths.push('old.test.js'); write(r.dir, 'old.test.js', goodSpec + '// synthetic edit\n'); write(r.dir, 'new.test.js', goodSpec);
    const first = verify(r);
    const disposition = { version: 1, issuer: 'Nextoz', binding: first.json.binding,
      findingIds: first.json.findings.map((f: { id: string }) => f.id), corrections: 1, backend: null, model: null, effort: null, tokens: null };
    const accepted = verify(r, disposition); expect(accepted.status, JSON.stringify(accepted.json)).toBe(0);
    write(r.dir, 'note.md', 'different synthetic content'); expect(codes(verify(r, disposition))).toContain('invalid-lead-disposition');
  });
});

describe('piped hook fixtures', () => {
  it.each(['C:/Users/evkar/Obsidian Vault/note.md', 'c:\\USERS\\EVKAR\\Obsidian Vault\\note.md', '../Obsidian Vault/note.md', 'C:/Dev/vault-companion-vault-reference/note.md'])('required eval: denies vault Edit %s', file_path => {
    expect(decision(hook('PreToolUse', { cwd: 'C:/Users/evkar/neighbor', tool_name: 'Edit', tool_input: { file_path } }))).toBe('deny');
  });
  it('allows reads and prefix siblings', () => {
    expect(decision(hook('PreToolUse', { cwd: root, tool_name: 'Read', tool_input: { file_path: 'C:/Users/evkar/Obsidian Vault/note.md' } }))).toBeUndefined();
    expect(decision(hook('PreToolUse', { cwd: root, tool_name: 'Write', tool_input: { file_path: 'C:/Users/evkar/Obsidian Vault-sibling/note.md' } }))).toBeUndefined();
  });
  it('required eval: clone settings edit denied despite environment spoof', () => {
    expect(decision(hook('PreToolUse', { cwd: root, tool_name: 'Edit', tool_input: { file_path: '.claude/settings.json' } }, { ...process.env, HARNESS_CANONICAL_ROOT: root }))).toBe('deny');
  });
  it('refuses extended Windows device paths rather than bypassing root matching', () => {
    expect(decision(hook('PreToolUse', { cwd: root, tool_name: 'Edit', tool_input: { file_path: '\\\\?\\C:\\Users\\evkar\\Obsidian Vault\\note.md' } }))).toBe('deny');
  });
  it('denies junction escape to protected harness', () => {
    const r = repo(); fs.symlinkSync(path.join(root, 'tools/harness'), path.join(r.dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(decision(hook('PreToolUse', { cwd: r.dir, tool_name: 'Write', tool_input: { file_path: 'alias/hook.mjs' } }))).toBe('deny');
  });
  it.each(['Bash', 'PowerShell', 'Pwsh'])('guards dangerous %s command tools', tool_name => {
    for (const command of ['git push origin main --force-with-lease', 'git push origin +HEAD:main', 'git remote set-url origin https://example.invalid', 'git reset --hard', 'git rebase HEAD~2']) {
      expect(decision(hook('PreToolUse', { cwd: temporary, tool_name, tool_input: { command } }))).toBe('deny');
    }
    expect(decision(hook('PreToolUse', { cwd: temporary, tool_name, tool_input: { command: 'git checkout -b synthetic' } }))).toBeUndefined();
  });
  it('denies recognizable shell writes to clone settings', () => {
    for (const command of ['Set-Content .claude/settings.json "{}"', 'echo "{}" > .claude/settings.json']) {
      expect(decision(hook('PreToolUse', { cwd: root, tool_name: 'PowerShell', tool_input: { command } }))).toBe('deny');
    }
  });
  it('registers bounded canonical hooks without replacing permissions or adding Stop', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')) as {
      permissions: { allow: string[] }; hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]>;
    };
    expect(settings.permissions.allow).toHaveLength(2);
    expect(Object.keys(settings.hooks).sort()).toEqual(['ConfigChange', 'PreToolUse', 'SessionStart']);
    for (const entries of Object.values(settings.hooks)) for (const h of entries[0]!.hooks) {
      expect(h.command).toContain('"C:/Dev/vault-companion/tools/harness/hook.mjs"');
      expect(h.timeout).toBeGreaterThan(0); expect(h.timeout).toBeLessThanOrEqual(65);
    }
  });
  it('denies clone merges and non-policy ConfigChange, exempts policy settings', () => {
    expect(decision(hook('PreToolUse', { cwd: root, tool_name: 'Bash', tool_input: { command: 'gh pr merge 1 --repo synthetic/repo' } }))).toBe('deny');
    expect(hook('ConfigChange', { cwd: root, source: 'projectSettings' }).decision).toBe('block');
    expect(hook('ConfigChange', { cwd: root, source: 'policySettings' }).decision).toBeUndefined();
  });
  it('injects bounded live branch/checkpoint context and falls back without blocking', () => {
    const r = repo(); write(r.dir, 'docs/checkpoint.md', '# Synthetic\n## Exact next actions\n- Inspect synthetic fixture\n## Later\nno\n');
    // Restrict PATH to Git only: no live gh or Herdr execution in offline fixtures.
    const gitDir = (process.env.PATH ?? '').split(path.delimiter).find(p => fs.existsSync(path.join(p, process.platform === 'win32' ? 'git.exe' : 'git')))!;
    const env = { ...process.env, PATH: gitDir, HERDR_ENV: '0' };
    const out = hook('SessionStart', { cwd: r.dir }, env).hookSpecificOutput.additionalContext;
    expect(out.length).toBeLessThan(2000); expect(out).toContain('Branch: main'); expect(out).toContain('Inspect synthetic fixture'); expect(out).not.toContain('Herdr');
    expect(hook('SessionStart', { cwd: path.join(temporary, 'missing') }, env).hookSpecificOutput.additionalContext.length).toBeLessThan(2000);
  });
});
