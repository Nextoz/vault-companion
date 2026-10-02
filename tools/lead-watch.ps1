<#
.SYNOPSIS
  Gives the Lead a fresh context after each merge: when it prints LEAD-RESTART-NOW alone on a line, send /clear and
  the start prompt (tools/lead-prompt.md). Usage limits need nothing: Claude Code continues by itself after a reset.
  Run in its own Herdr pane next to the Lead:  pwsh -NoProfile -File C:\Dev\vault-companion\tools\lead-watch.ps1
  The Lead pane ID comes from .agent/lead-pane.txt (written by tools/start-lead.ps1) or -LeadPane. Ctrl+C stops it.
#>
param([string]$LeadPane, [int]$PollSeconds = 60, [string]$TestText)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $LeadPane) { $LeadPane = (Get-Content -LiteralPath (Join-Path $repo '.agent/lead-pane.txt') -ErrorAction Stop).Trim() }
$promptFile = Join-Path $PSScriptRoot 'lead-prompt.md'
function Log($m) { Write-Host "$(Get-Date -Format 'HH:mm:ss') $m" }
function Send-Lead([string]$text) { & herdr pane run $LeadPane $text | Out-Null }

Log "watching Lead pane $LeadPane for LEAD-RESTART-NOW (poll ${PollSeconds}s)"
$polls = 0
while ($true) {
    $screen = if ($TestText) { $TestText } else { (& herdr pane read $LeadPane --source recent-unwrapped --lines 30 --format text) -join "`n" }
    $tail = @($screen -split "`r?`n" | Select-Object -Last 8)
    # The marker must stand alone on a line near the bottom; the same word inside prose (prompt, policy) never matches.
    if ($tail | Where-Object { $_ -match '^\W*LEAD-RESTART-NOW\W*$' }) {
        if ($TestText) { Write-Output 'RESTART'; break }
        Log 'restart marker: /clear + start prompt'
        Send-Lead '/clear'
        Start-Sleep -Seconds 5
        $prompt = (Get-Content -LiteralPath $promptFile -Raw) -replace '\{FOCUS\}', 'the first open item under "Next actions" in docs/checkpoint.md'
        Send-Lead (($prompt -split "`r?`n" | Where-Object { $_ }) -join ' ')
        Start-Sleep -Seconds 120   # let the new turn push the marker off the screen
    }
    if ($TestText) { break }
    if ((++$polls % 30) -eq 0) { Log 'still watching' }   # heartbeat every ~30 min so a silent pane is clearly alive
    Start-Sleep -Seconds $PollSeconds
}
