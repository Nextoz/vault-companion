<#
.SYNOPSIS
  Start a fresh Vault Companion Lead (Claude Opus 5.5, effort medium) in the current Herdr pane.
  Run from inside Herdr (workers need HERDR_ENV=1):  pwsh -NoProfile -File C:\Dev\vault-companion\tools\start-lead.ps1
  Start a new Lead after each merged slice instead of continuing a long session (docs/orchestration.md).
#>
param([string]$Focus = 'the first open item under "Next actions" in docs/checkpoint.md')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $env:HERDR_ENV) { Write-Warning 'Not inside Herdr: workers launched with tools/agent-pane.sh will fail. Start Herdr first (run: herdr).' }
Set-Location -LiteralPath $repo
git fetch -q origin
$prompt = @"
You are the Vault Companion Lead. Read docs/checkpoint.md, then follow docs/orchestration.md exactly (it is the only
policy). Work on: $Focus. Keep tokens low: read only what the task needs, use the delivery loop and
tools/handoff-check.ps1 for worker output, commit docs/checkpoint.md only at milestones. Keep me informed with short
STATUS lines including tools/owner-status.ps1 (RAM, DeepSeek, GLM) as described under "Owner updates". Ask me with a
line starting 'ACTION NEEDED:' for low RAM, low credits, deploys or anything outside your authority.
"@
& claude --model claude-opus-5-5 --effort medium --name 'VC Lead' $prompt
