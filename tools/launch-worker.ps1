<#
.SYNOPSIS
  Launch one coding worker, sandboxed, visibly in Herdr's Agents tab. The ONLY way the Lead starts workers
  (docs/orchestration.md); one short command keeps briefs cheap and is approved for auto mode.

.DESCRIPTION
  Tiers: flash (DeepSeek Flash, default ordinary), pro (DeepSeek Pro medium, high-risk), gemini (free, tiny tasks).
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
    [string[]]$Files = @()
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

if ($Tier -in 'flash', 'pro' -and $env:VC_ALLOW_DEEPSEEK -ne '1') { throw 'DeepSeek tiers are retired (owner, 2026-10-06: balance 0). Use -Tier glm (default worker) or codex (UI / Morning Brief).' }
if ($Tier -eq 'glm') {
    # GLM-5.2 on Scaleway has no Responses API (verified 2026-10-06: 422 ROUTE NOT SUPPORTED), so Codex cannot drive it.
    # The glm tier is the single-shot patch worker: brief + the named files in, a scope-guarded unified diff out.
    if ($Fix) { throw 'glm tier has no -Fix round: put the correction in .agent/brief.md and rerun with the same -Files.' }
    if ($Files.Count -eq 0) { throw 'glm tier needs -Files <repo-relative paths the patch may touch>.' }
    $env:AGENT_USER_ENV = 'SCW_SECRET_KEY'
    & $bash (& $fwd (Join-Path $repo 'tools/agent-pane.sh')) "glm · $Task" (& $fwd $Clone) (& $fwd $log) pwsh -NoProfile -File (& $fwd (Join-Path $repo 'tools/scaleway-patch-worker.ps1')) -Clone $Clone -Brief $brief -Files ($Files -join ',') -Model glm-5.2 -Task $Task
    exit $LASTEXITCODE
}
if ($Tier -eq 'gemini') {
    $env:AGENT_USER_ENV = 'GEMINI_API_KEY'
    & $bash (& $fwd (Join-Path $repo 'tools/agent-pane.sh')) "gemini · $Task" (& $fwd $Clone) (& $fwd $log) bash (& $fwd (Join-Path $repo 'tools/gemini-worker.sh')) (& $fwd $Clone)
    exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath (Join-Path $Clone 'node_modules'))) {
    Write-Host 'pnpm install (worker commands have no network)...'
    Push-Location -LiteralPath $Clone; try { pnpm install --frozen-lockfile 2>&1 | Select-Object -Last 2 } finally { Pop-Location }
}
$model, $effort = if ($Tier -eq 'pro') { 'deepseek-v4-pro', 'medium' } elseif ($Tier -eq 'codex') { $null, 'medium' } else { 'deepseek-flash', 'high' }
# codex tier: the owner's Codex subscription, own CODEX_HOME (auth + model from its config.toml), no DeepSeek provider/key.
$codexHome = if ($Tier -eq 'codex') { 'C:/Dev/tools/vault-companion-codex-home' } else { 'C:/Dev/tools/vault-companion-deepseek-home' }
$codex = @('env', "CODEX_HOME=$codexHome", 'codex', 'exec')
if ($Fix) {
    $first = Join-Path $agent "run-$Task.log"
    $sid = (Select-String -LiteralPath $first -Pattern '^session id:\s*(\S+)' | Select-Object -First 1).Matches.Groups[1].Value
    if (-not $sid) { throw "No session id in $first; cannot resume the same worker" }
    $codex += @('resume')
}
if ($Tier -ne 'codex') { $codex += @('-m', $model, '-c', 'model_provider=deepseek') }
$codex += @('-c', "model_reasoning_effort=$effort",
    '-c', 'model_reasoning_summary=concise', '-c', 'model_verbosity=low', '-c', 'windows.sandbox=elevated',
    '-c', 'features.memories=false', '-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false',
    # Config key, not --sandbox: `exec resume` accepts only -c/-m (the pane's cwd is the clone for both).
    '-c', 'sandbox_mode=workspace-write')
if ($Fix) { $codex += $sid } else { $codex += @('-C', (& $fwd $Clone)) }
$codex += '-'
$env:AGENT_STDIN = & $fwd $brief
$env:AGENT_USER_ENV = if ($Tier -eq 'codex') { '' } else { 'DEEPSEEK_API_KEY' }
& $bash (& $fwd (Join-Path $repo 'tools/agent-pane.sh')) "$Tier · $Task$(if ($Fix) { ' · fix' })" (& $fwd $Clone) (& $fwd $log) @codex
exit $LASTEXITCODE
