<#
.SYNOPSIS
  Start a fresh Vault Companion Lead (Claude Sonnet 5.5, effort medium) in the current Herdr pane.
  Run from inside Herdr (workers need HERDR_ENV=1):  pwsh -NoProfile -File C:\Dev\vault-companion\tools\start-lead.ps1
  It also opens the watcher (tools/lead-watch.ps1, in a restart loop) in a pane below, unless one is alive or -NoWatcher.
  Overnight / no prompts:  pwsh -NoProfile -File C:\Dev\vault-companion\tools\start-lead.ps1 -Overnight
#>
param([string]$Focus = 'the first open item under "Next actions" in docs/checkpoint.md',
      # Unattended run: no permission prompts (safe actions auto-approved, risky ones blocked). Standing decisions live in .agent/owner-instructions.md.
      [switch]$Overnight,
      # The watcher passes this when it relaunches a Lead that exited (it is already running).
      [switch]$NoWatcher,
      # Lead model. Default Sonnet 5.5; .agent/lead-model.txt (one model id) overrides it, so watcher relaunches keep the choice.
      [string]$Model)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repo
if ($env:HERDR_ENV) {
    # Record this pane for tools/lead-watch.ps1.
    $id = ((& herdr pane current) -join ' ' | Select-String -Pattern '\bw[A-Za-z0-9]+:p[A-Za-z0-9]+\b').Matches.Value | Select-Object -First 1
    if ($id) { New-Item -ItemType Directory -Force (Join-Path $repo '.agent') | Out-Null; Set-Content -LiteralPath (Join-Path $repo '.agent/lead-pane.txt') $id; Write-Host "Lead pane: $id" }
    else { Write-Warning 'Could not read the current Herdr pane ID; pass -LeadPane to lead-watch.ps1.' }
    # Watcher pane (restart loop: it survives its own crashes). Skipped when a watcher heartbeat is fresh.
    $alive = Join-Path $repo '.agent/lead-watch.alive'
    $fresh = (Test-Path -LiteralPath $alive) -and (((Get-Date) - (Get-Item -LiteralPath $alive).LastWriteTime).TotalMinutes -lt 3)
    if ($id -and -not $NoWatcher -and -not $fresh) {
        $wp = (((& herdr pane split --pane $id --direction down --cwd $repo --no-focus) -join '') | ConvertFrom-Json).result.pane.pane_id
        & herdr pane rename $wp 'Lead watcher' | Out-Null
        $loop = "pwsh -NoProfile -Command 'while (`$true) { pwsh -NoProfile -File $(Join-Path $PSScriptRoot 'lead-watch.ps1'); Start-Sleep 60 }'"
        & herdr pane run $wp $loop | Out-Null
        Write-Host "Watcher pane: $wp"
    }
} else { Write-Warning 'Not inside Herdr: workers launched with tools/agent-pane.sh will fail. Start Herdr first (run: herdr).' }
git fetch -q origin
$prompt = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'lead-prompt.md') -Raw) -replace '\{FOCUS\}', $Focus
$mode = if ($Overnight) { @('--permission-mode', 'auto') } else { @() }
if (-not $Model) {
    $modelFile = Join-Path $repo '.agent/lead-model.txt'
    $Model = if (Test-Path -LiteralPath $modelFile) { (Get-Content -LiteralPath $modelFile -Raw).Trim() } else { 'claude-sonnet-5-5' }
}
& claude --model $Model --effort medium --name 'VC Lead' @mode $prompt
