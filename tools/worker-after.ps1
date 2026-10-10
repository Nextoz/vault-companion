<#
.SYNOPSIS
  Runs in the worker's Herdr pane right after the worker exits (tools/launch-worker.ps1 -Base … wires it in through
  AGENT_AFTER in tools/agent-pane.sh). The worker is reviewed BEFORE the Lead sees anything (owner, 2026-10-10):
  1. tools/handoff-check.ps1 (commit candidate, touched tests, CodeRabbit review / GLM fallback, intent review, Jev triage).
  2. Exit 10 (fixes needed) on a first run of a codex/flash/pro worker: launch the ONE correction round of the same worker
     session (launch-worker.ps1 -Fix), whose own after-step runs the check once more. No third round.
  3. Otherwise record the result in .agent/workers/<task>.json (state "ready"); tools/lead-watch.ps1 wakes the Lead with it.
  The spec file (written by launch-worker.ps1) carries the parameters, so test commands with quotes survive the pane runner.
#>
param([Parameter(Mandatory)][string]$Spec)
$ErrorActionPreference = 'Stop'
$s = Get-Content -LiteralPath $Spec -Raw | ConvertFrom-Json
$repo = Split-Path $PSScriptRoot -Parent
$stateFile = Join-Path $repo ".agent/workers/$($s.task).json"
function Set-State([string]$State, [hashtable]$Extra = @{}) {
    $o = if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
    $o.state = $State; $o.updated = (Get-Date -Format 'o')
    foreach ($k in $Extra.Keys) { $o[$k] = $Extra[$k] }
    $o | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding utf8
}

Set-State 'checking'
$hc = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'handoff-check.ps1'), '-Clone', $s.clone, '-Base', $s.base, '-Task', $s.task,
    '-Reviewer', $s.reviewer, '-Intent', $s.intent)
if ($s.testCmd) { $hc += @('-TestCmd', $s.testCmd) }
& pwsh @hc
$code = $LASTEXITCODE
$check = Join-Path $s.clone ".agent/check-$($s.task).md"
$verdict = try { ((Get-Content -LiteralPath $check -TotalCount 1) -replace '^# Handoff check \S+ - ', '') } catch { "exit $code" }

if ($code -eq 10 -and -not $s.fix -and $s.tier -in 'codex', 'flash', 'pro') {
    Write-Host "Fixes needed: starting the single correction round of the same worker session."
    Set-State 'fixing' @{ firstCheck = $verdict; firstExit = $code }
    $fixArgs = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'launch-worker.ps1'), '-Tier', $s.tier, '-Clone', $s.clone, '-Task', $s.task,
        '-Fix', '-Base', $s.base, '-Reviewer', $s.reviewer, '-Intent', $s.intent, '-Effort', $s.effort)
    if ($s.testCmd) { $fixArgs += @('-TestCmd', $s.testCmd) }
    & pwsh @fixArgs
    if ($LASTEXITCODE -eq 0) { exit 0 }
    Write-Host "Could not start the correction round (exit $LASTEXITCODE): handing over to the Lead as is."
}
Set-State 'ready' @{ exit = $code; verdict = $verdict; check = $check; round = $(if ($s.fix) { 'fix' } else { 'first' }) }
Write-Host "WORKER-READY $($s.task) exit $code -> $check"
