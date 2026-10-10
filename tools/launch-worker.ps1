<#
.SYNOPSIS
  Launch one coding worker, sandboxed, visibly in Herdr's Agents tab. The ONLY way the Lead starts workers
  (docs/orchestration.md); one short command keeps briefs cheap and is approved for auto mode.

.DESCRIPTION
  Tiers: flash (DeepSeek V4.1 Flash `deepseek-flash`, default worker since 2026-10-10), pro (DeepSeek Pro medium, high-risk),
  codex (gpt-6.1-sol, when needed), glm (Scaleway single-shot patch), gemini (free, tiny tasks).
  Codex-driven tiers (flash, pro, codex) may spawn up to 2 sub-agents (Codex multi_agent, depth 1, same sandbox and model;
  verified 2026-10-10 with deepseek-flash).
  With -Base, the worker is reviewed before the Lead sees it (owner, 2026-10-10): after the worker exits, its pane runs
  tools/worker-after.ps1 (handoff-check: tests, CodeRabbit/GLM, intent review, Jev triage; one automatic -Fix round of the
  same session when fixes are needed) and records the result in .agent/workers/<task>.json for tools/lead-watch.ps1.
  DeepSeek workers run Codex CLI with `--sandbox workspace-write` and the elevated Windows sandbox: they can edit
  and run tests inside the clone only (verified 2026-10-02: writes outside the clone are denied; vitest runs). No
  network for their commands, so this script runs `pnpm install` first when node_modules is missing. Codex keeps
  .git read-only: tools/handoff-check.ps1 commits the candidate afterwards.
  -Fix resumes the SAME worker session with .agent/fix-<Task>.md (the single correction round).

.EXAMPLE
  pwsh -NoProfile -File tools/launch-worker.ps1 -Tier flash -Clone C:\Dev\vault-companion-clones\mood-m2 -Task mood-m2
  pwsh -NoProfile -File tools/launch-worker.ps1 -Tier flash -Clone C:\Dev\vault-companion-clones\mood-m2 -Task mood-m2 -Fix
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('glm', 'codex', 'gemini', 'flash', 'pro')][string]$Tier,
    [Parameter(Mandatory)][string]$Clone,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]*$')][string]$Task,
    [switch]$Fix,
    [string[]]$Files = @(),
    # codex tier only: gpt-6.1-sol effort. low for ordinary work, medium for UI/data/features (owner 2026-10-06).
    [ValidateSet('low', 'medium')][string]$Effort = 'low',
    # Automatic pre-handoff review (tools/worker-after.ps1). -Base is the clone's base commit; -TestCmd the brief's touched tests.
    [string]$Base,
    [string]$TestCmd,
    [ValidateSet('auto', 'coderabbit', 'glm', 'both', 'all')][string]$Reviewer = 'auto',
    [ValidateSet('auto', 'on', 'off')][string]$Intent = 'auto'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$Clone = (Resolve-Path -LiteralPath $Clone).Path
if ($Clone -notlike 'C:\Dev\vault-companion-clones\*') { throw "Workers run only in clones under C:\Dev\vault-companion-clones (got $Clone)" }
if (-not $env:HERDR_ENV) { throw 'Run from inside Herdr (HERDR_ENV=1): workers launch into the Agents tab.' }
$agent = Join-Path $Clone '.agent'
$brief = Join-Path $agent ($(if ($Fix) { "fix-$Task.md" } else { 'brief.md' }))
if (-not (Test-Path -LiteralPath $brief)) { throw "Missing $brief" }
$log = Join-Path $agent ($(if ($Fix) { "run-fix-$Task.log" } else { "run-$Task.log" }))
$fwd = { param($p) $p -replace '\\', '/' }
# Git Bash explicitly: on this machine the first `bash` on PATH is WSL (C:\Windows\System32\bash.exe), which cannot run
# tools/agent-pane.sh (seen 2026-10-02). Derive it from git's install folder.
$bash = Join-Path (Split-Path (Split-Path (Get-Command git -ErrorAction Stop).Source)) 'bin\bash.exe'
if (-not (Test-Path -LiteralPath $bash)) { throw "Git Bash not found at $bash" }

# Worker registry for tools/lead-watch.ps1 (wakes the Lead when a worker is ready, stays quiet while one runs).
# Called right before the pane starts, so a launch that fails validation leaves no stale "running" entry.
function Register-Worker {
$workers = Join-Path $repo '.agent/workers'
New-Item -ItemType Directory -Force $workers | Out-Null
$state = [ordered]@{ task = $Task; clone = $Clone; tier = $Tier; state = 'running'; round = $(if ($Fix) { 'fix' } else { 'first' })
    started = (Get-Date -Format 'o'); updated = (Get-Date -Format 'o'); log = $log; autoCheck = [bool]$Base }
$prev = Join-Path $workers "$Task.json"
if ($Fix -and (Test-Path -LiteralPath $prev)) { $old = Get-Content -LiteralPath $prev -Raw | ConvertFrom-Json; if ($old.firstCheck) { $state.firstCheck = $old.firstCheck } }
$state | ConvertTo-Json | Set-Content -LiteralPath $prev -Encoding utf8
if ($Base) {
    $spec = Join-Path $agent "after-$Task.json"
    [ordered]@{ task = $Task; clone = $Clone; tier = $Tier; base = $Base; testCmd = $TestCmd; reviewer = $Reviewer; intent = $Intent
        effort = $Effort; fix = [bool]$Fix } | ConvertTo-Json | Set-Content -LiteralPath $spec -Encoding utf8
    $env:AGENT_AFTER = "pwsh -NoProfile -File '$(& $fwd (Join-Path $PSScriptRoot 'worker-after.ps1'))' -Spec '$(& $fwd $spec)'"
} else { $env:AGENT_AFTER = '' }
}
if ($Tier -eq 'glm') {
    # GLM-5.2 on Scaleway has no Responses API (verified 2026-10-06: 422 ROUTE NOT SUPPORTED), so Codex cannot drive it.
    # The glm tier is the single-shot patch worker: brief + the named files in, a scope-guarded unified diff out.
    if ($Fix) { throw 'glm tier has no -Fix round: put the correction in .agent/brief.md and rerun with the same -Files.' }
    if ($Files.Count -eq 0) { throw 'glm tier needs -Files <repo-relative paths the patch may touch>.' }
    $env:AGENT_USER_ENV = 'SCW_SECRET_KEY'
    Register-Worker
    & $bash (& $fwd (Join-Path $repo 'tools/agent-pane.sh')) "glm · $Task" (& $fwd $Clone) (& $fwd $log) pwsh -NoProfile -File (& $fwd (Join-Path $repo 'tools/scaleway-patch-worker.ps1')) -Clone $Clone -Brief $brief -Files ($Files -join ',') -Model glm-5.2 -Task $Task
    exit $LASTEXITCODE
}
if ($Tier -eq 'gemini') {
    $env:AGENT_USER_ENV = 'GEMINI_API_KEY'
    Register-Worker
    & $bash (& $fwd (Join-Path $repo 'tools/agent-pane.sh')) "gemini · $Task" (& $fwd $Clone) (& $fwd $log) bash (& $fwd (Join-Path $repo 'tools/gemini-worker.sh')) (& $fwd $Clone)
    exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath (Join-Path $Clone 'node_modules'))) {
    Write-Host 'pnpm install (worker commands have no network)...'
    Push-Location -LiteralPath $Clone; try { pnpm install --frozen-lockfile 2>&1 | Select-Object -Last 2 } finally { Pop-Location }
}
# Not $effort: PowerShell names are case-insensitive, so that would assign to the validated -Effort parameter (broke flash/pro).
$model, $reasoning = if ($Tier -eq 'pro') { 'deepseek-v4-pro', 'medium' } elseif ($Tier -eq 'codex') { 'gpt-6.1-sol', $Effort } else { 'deepseek-flash', 'high' }
# codex tier: the owner's Codex subscription, own CODEX_HOME (auth + model from its config.toml), no DeepSeek provider/key.
$codexHome = if ($Tier -eq 'codex') { 'C:/Dev/tools/vault-companion-codex-home' } else { 'C:/Dev/tools/vault-companion-deepseek-home' }
$codex = @('env', "CODEX_HOME=$codexHome", 'codex', 'exec')
if ($Fix) {
    $first = Join-Path $agent "run-$Task.log"
    $sid = (Select-String -LiteralPath $first -Pattern '^session id:\s*(\S+)' | Select-Object -First 1).Matches.Groups[1].Value
    if (-not $sid) { throw "No session id in $first; cannot resume the same worker" }
    $codex += @('resume')
}
$codex += @('-m', $model)
if ($Tier -ne 'codex') { $codex += @('-c', 'model_provider=deepseek') }
$codex += @('-c', "model_reasoning_effort=$reasoning",
    '-c', 'model_reasoning_summary=concise', '-c', 'model_verbosity=low', '-c', 'windows.sandbox=elevated',
    '-c', 'features.memories=false', '-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false',
    # Sub-workers: at most 2 Codex sub-agents, one level deep, inside the same sandbox (owner, 2026-10-10).
    '-c', 'agents.max_threads=2', '-c', 'agents.max_depth=1',
    # Config key, not --sandbox: `exec resume` accepts only -c/-m (the pane's cwd is the clone for both).
    '-c', 'sandbox_mode=workspace-write')
if ($Fix) { $codex += $sid } else { $codex += @('-C', (& $fwd $Clone)) }
$codex += '-'
$env:AGENT_STDIN = & $fwd $brief
$env:AGENT_USER_ENV = if ($Tier -eq 'codex') { '' } else { 'DEEPSEEK_API_KEY' }
Register-Worker
& $bash (& $fwd (Join-Path $repo 'tools/agent-pane.sh')) "$Tier · $Task$(if ($Fix) { ' · fix' })" (& $fwd $Clone) (& $fwd $log) @codex
exit $LASTEXITCODE
