<#
.SYNOPSIS
  Start a fresh Vault Companion Lead (Claude Opus 5.5, effort medium) in the current Herdr pane.
  Run from inside Herdr (workers need HERDR_ENV=1):  pwsh -NoProfile -File C:\Dev\vault-companion\tools\start-lead.ps1
  Then, in a second pane, run tools/lead-watch.ps1 (auto-resume after usage limits, fresh context after each merge).
#>
param([string]$Focus = 'the first open item under "Next actions" in docs/checkpoint.md')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repo
if ($env:HERDR_ENV) {
    # Record this pane for tools/lead-watch.ps1.
    $id = ((& herdr pane current) -join ' ' | Select-String -Pattern '\bw\d+:p\w+\b').Matches.Value | Select-Object -First 1
    if ($id) { New-Item -ItemType Directory -Force (Join-Path $repo '.agent') | Out-Null; Set-Content -LiteralPath (Join-Path $repo '.agent/lead-pane.txt') $id; Write-Host "Lead pane: $id" }
    else { Write-Warning 'Could not read the current Herdr pane ID; pass -LeadPane to lead-watch.ps1.' }
} else { Write-Warning 'Not inside Herdr: workers launched with tools/agent-pane.sh will fail. Start Herdr first (run: herdr).' }
git fetch -q origin
$prompt = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'lead-prompt.md') -Raw) -replace '\{FOCUS\}', $Focus
& claude --model claude-opus-5-5 --effort medium --name 'VC Lead' $prompt
