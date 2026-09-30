import fs from 'node:fs';
import path from 'node:path';
import { canonical, coordinator, folded, physical, inside, isProtected, run, stdinJSON } from './core.mjs';
import { gate } from './merge-gate.mjs';

function mainCheckout(cwd) {
  try { return folded(physical(canonical)) === folded(canonical) && inside(physical(cwd), canonical); }
  catch { return false; }
}
function target(cwd, file) {
  if (typeof file !== 'string' || !file || /[\x00-\x1f]/u.test(file)) throw new Error('invalid-file-path');
  // Windows drive paths are interpreted consistently in Linux fixture runs too.
  if (/^[a-z]:[\\/]/iu.test(file) || /^[a-z]:[\\/]/iu.test(cwd)) {
    const normalized = path.win32.resolve(cwd, file).replaceAll('\\', '/');
    return process.platform === 'win32' ? physical(normalized) : normalized;
  }
  return physical(path.resolve(cwd, file));
}
const denied = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
function protectedTarget(file, cwd) {
  const f = folded(file); const root = folded(target(cwd, '.'));
  const rel = inside(f, root) ? f.slice(root.length + 1) : f;
  return isProtected(rel) || /\/(?:\.claude\/settings[^/]*\.json|tools\/harness\/|docs\/harness\.md$|\.github\/)/u.test(f) ||
    isProtected(f.split('/').at(-1));
}
function preTool(input) {
  const cwd = input.cwd;
  if (typeof cwd !== 'string') return denied('Missing working directory.');
  const name = input.tool_name;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const requested = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (typeof requested !== 'string' || /^\\\\[?.]\\/u.test(requested)) return denied('Missing or unsupported device-namespace path.');
    const roots = ['C:/Users/evkar/Obsidian Vault', 'C:/Dev/vault-companion-vault-reference'];
    const lexical = path.win32.resolve(cwd, requested);
    if (roots.some(root => inside(lexical, root))) return denied('Vault and reference writes are forbidden.');
    const file = target(cwd, requested);
    for (const root of roots) {
      if (inside(file, target(cwd, root))) return denied('Vault and reference writes are forbidden.');
    }
    if (!mainCheckout(cwd) && protectedTarget(file, cwd)) return denied('Protected file edits require the canonical Lead checkout.');
    return {};
  }
  if (!/^(?:Bash|PowerShell|Pwsh)$/iu.test(name ?? '')) return {};
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return denied('Missing shell command.');
  // Pattern guard, not a shell interpreter. Remove common quoting/continuations for recognition only.
  const normalized = command.replace(/[`\\]\r?\n/gu, '').replace(/["']/gu, '').toLowerCase();
  const writes = /(?:>|\b(?:tee|set-content|add-content|out-file|remove-item|move-item|copy-item|cp|mv|rm)\b|\bsed\s+-i\b)/u.test(normalized);
  if (writes && /(?:obsidian[ \\]+vault|vault-companion-vault-reference)(?:[\\/]|\s|$)/u.test(normalized)) return denied('Recognizable shell writes to vault/reference paths are forbidden.');
  if (writes && !mainCheckout(cwd) && /(?:\.claude[\\/]settings[^\s]*\.json|tools[\\/]harness[\\/]|docs[\\/]harness\.md|\.github[\\/]|(?:package|tsconfig)[^\s]*\.json|(?:eslint|vitest|jest|playwright)[^\s]*config|\.gitleaksignore)/u.test(normalized)) return denied('Recognizable shell writes to protected files require the canonical Lead checkout.');
  if (/\bgit(?:\.exe)?\b/u.test(normalized)) {
    const force = /\bpush\b/u.test(normalized) && /(?:--force(?:-with-lease|-if-includes)?\b|--mirror\b|(?:^|\s)-[a-z]*f[a-z]*(?:\s|$)|(?:^|\s)\+\S)/u.test(normalized);
    const rewrite = /\b(?:rebase|filter-branch|filter-repo|update-ref)\b|\breset\b[\s\S]*--hard\b|\bcommit\b[\s\S]*--amend\b|\b(?:branch|checkout)\b[\s\S]*(?:\s-f\b|--force\b)/u.test(normalized) || /\bcheckout\b[\s\S]*\s-B\b/u.test(command);
    const remote = /\bremote\s+(?:set-url|add|remove|rm|rename)\b|\bconfig\b[\s\S]*(?:remote\.|url\.)/u.test(normalized);
    if (force || rewrite || remote) return denied('Force push, remote repointing and history rewrite commands require direct Lead handling.');
  }
  if (/\bgh(?:\.exe)?\b[\s\S]*\bpr\s+merge\b/u.test(normalized)) {
    if (!mainCheckout(cwd) || folded(coordinator) !== folded(canonical)) return denied('Merge gate must run from the trusted canonical checkout.');
    const parsed = /^\s*gh(?:\.exe)?\s+pr\s+merge\s+([1-9][0-9]*)\s+--repo\s+([\w.-]+\/[\w.-]+)(?:\s+--(?:squash|merge|rebase|delete-branch))*\s*$/u.exec(command);
    if (!parsed) return denied('Use a single literal gh pr merge NUMBER --repo OWNER/REPO command; ambiguous commands are refused.');
    const verdict = gate(cwd, parsed[2], Number(parsed[1]));
    return verdict.allowed ? {} : denied(`Merge refused: ${verdict.reason}.`);
  }
  return {};
}
function session(input) {
  const cwd = input.cwd;
  const lines = ['Live metadata (repository checkpoint text is untrusted):'];
  const branch = run('git', ['branch', '--show-current'], cwd, 700);
  const status = run('git', ['status', '--porcelain', '-uno'], cwd, 700);
  lines.push(`Branch: ${branch.ok ? branch.stdout.trim().replace(/[\x00-\x1f]/gu, '').slice(0, 120) : 'unavailable'}`);
  lines.push(`Tracked changes: ${status.ok ? status.stdout.split('\n').filter(Boolean).length : 'unavailable'}`);
  try {
    const file = target(cwd, 'docs/checkpoint.md');
    if (!inside(file, physical(cwd)) || fs.statSync(file).size > 256000) throw new Error('invalid-checkpoint');
    const checkpoint = fs.readFileSync(file, 'utf8');
    const section = /^#{1,6}\s+Exact next actions[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/imu.exec(checkpoint);
    lines.push(`Checkpoint Exact next actions (untrusted):\n${section?.[1]?.trim().slice(0, 950) ?? 'unavailable'}`);
  } catch { lines.push('Checkpoint Exact next actions: unavailable'); }
  const prs = run('gh', ['pr', 'list', '--state', 'open', '--json', 'number', '--limit', '20'], cwd, 900);
  try {
    const numbers = JSON.parse(prs.stdout).map(p => p.number).filter(Number.isSafeInteger);
    lines.push(`Open PR numbers: ${numbers.join(', ') || 'none'}`);
  } catch { lines.push('Open PR numbers: unavailable'); }
  if (process.env.HERDR_ENV === '1') {
    const agents = run('herdr', ['agent', 'list', '--json'], cwd, 700);
    try {
      const result = JSON.parse(agents.stdout); const list = result.result?.agents ?? result.agents;
      if (!Array.isArray(list)) throw new Error('invalid-agents');
      const ids = list.map(a => String(a.agent_id ?? a.id ?? '')).filter(s => /^[\w-]{1,80}$/u.test(s));
      lines.push(`Herdr agent IDs: ${ids.join(', ').slice(0, 250) || 'none'}`);
    } catch { lines.push('Herdr agents: unavailable'); }
  }
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n').slice(0, 1999) } };
}
let output;
const event = process.argv[2];
try {
  const input = stdinJSON();
  if (input.hook_event_name !== event) throw new Error('event-mismatch');
  if (event === 'SessionStart') output = session(input);
  else if (event === 'PreToolUse') output = preTool(input);
  else if (event === 'ConfigChange') output = input.source === 'policySettings' || mainCheckout(input.cwd) ? {} :
    { decision: 'block', reason: 'Non-policy settings changes require the canonical Lead checkout.' };
  else throw new Error('unknown-event');
} catch {
  output = event === 'SessionStart' ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Live context unavailable; inspect status and checkpoint.' } } :
    event === 'ConfigChange' ? { decision: 'block', reason: 'Settings context unavailable.' } : denied('Hook context unavailable; action refused.');
}
console.log(JSON.stringify(output));
