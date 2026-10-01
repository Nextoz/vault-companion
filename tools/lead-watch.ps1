<#
.SYNOPSIS
  Keeps the Lead going without the owner: resumes it after a Claude usage limit resets, and gives it a fresh context
  (/clear + start prompt) when it prints LEAD-RESTART-NOW alone on a line after a merge.
  Run in its own Herdr pane next to the Lead:  pwsh -NoProfile -File C:\Dev\vault-companion\tools\lead-watch.ps1
  The Lead pane ID comes from .agent/lead-pane.txt (written by tools/start-lead.ps1) or -LeadPane. Ctrl+C stops it.
#>
param([string]$LeadPane, [int]$PollSeconds = 60, [switch]$Once, [string]$TestText)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $LeadPane) { $LeadPane = (Get-Content -LiteralPath (Join-Path $repo '.agent/lead-pane.txt') -ErrorAction Stop).Trim() }
$promptFile = Join-Path $PSScriptRoot 'lead-prompt.md'
$handled = @{}
function Log($m) { Write-Host "$(Get-Date -Format 'HH:mm:ss') $m" }

# "You've hit your session limit · resets 1:30pm (Europe/Copenhagen)"; also "weekly limit · resets Wed 9pm (...)".
function Get-ResetTime([string]$when) {
    $when = $when.Trim() -replace '\s+', ' '
    $c = [Globalization.CultureInfo]::GetCultureInfo('en-US')
    $now = Get-Date
    $t = [datetime]::MinValue
    # Weekday prefix ("Wed 9pm"): .NET rejects a weekday that disagrees with its assumed date, so resolve it here.
    if ($when -match '^(?<dow>Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?\s+(?<time>.+)$') {
        if (-not [datetime]::TryParseExact($Matches.time, [string[]]('h:mmtt', 'htt'), $c, 'AllowWhiteSpaces', [ref]$t)) { return $null }
        $d = $now.Date; while ($d.ToString('ddd', $c) -ne $Matches.dow) { $d = $d.AddDays(1) }
        $t = $d.Add($t.TimeOfDay); if ($t -lt $now.AddMinutes(-5)) { $t = $t.AddDays(7) }
        return $t
    }
    if ([datetime]::TryParseExact($when, [string[]]('MMM d, h:mmtt', 'MMM d, htt', 'MMM d h:mmtt', 'MMM d htt'), $c, 'AllowWhiteSpaces', [ref]$t)) {
        return [datetime]::new($now.Year, $t.Month, $t.Day).Add($t.TimeOfDay)
    }
    if ([datetime]::TryParseExact($when, [string[]]('h:mmtt', 'htt'), $c, 'AllowWhiteSpaces', [ref]$t)) {
        $t = $now.Date.Add($t.TimeOfDay); if ($t -lt $now.AddMinutes(-5)) { $t = $t.AddDays(1) }
        return $t
    }
    return $null
}

function Send-Lead([string]$text) { & herdr pane run $LeadPane $text | Out-Null }

Log "watching Lead pane $LeadPane (poll ${PollSeconds}s)"
while ($true) {
    $screen = if ($TestText) { $TestText } else { (& herdr pane read $LeadPane --source recent-unwrapped --lines 30 --format text) -join "`n" }
    $lines = @($screen -split "`r?`n")
    $tail = @($lines | Select-Object -Last 8)

    # 1. Usage limit: wait for the reset, then resume once per reset time.
    $limitRx = "hit your .*limit\s*[·•-]\s*resets\s+(?<when>[^()]+?)\s*\("
    $limit = $tail | Where-Object { $_ -match $limitRx } | Select-Object -Last 1
    if ($limit -and $limit -match $limitRx) {
        $when = $Matches.when
        $at = Get-ResetTime $when
        $key = if ($at) { $at.ToString('s') } else { "unparsed:$when" }
        if (-not $handled[$key]) {
            $handled[$key] = $true
            if (-not $at) { $at = (Get-Date).AddMinutes(30); Log "could not parse reset '$when'; retrying at $($at.ToString('HH:mm'))" }
            $wake = $at.AddMinutes(2)
            Log "usage limit; resuming at $($wake.ToString('ddd HH:mm'))"
            if ($TestText) { Write-Output "RESUME-AT $($wake.ToString('s'))"; break }
            while ((Get-Date) -lt $wake) { Start-Sleep -Seconds 60 }
            Send-Lead 'Usage is back. Continue exactly where you left off (check git status and docs/checkpoint.md if unsure).'
            Log 'resume sent'
        }
    }

    # 2. Fresh context after a merge: the marker must be alone on a line near the bottom.
    elseif ($tail | Where-Object { $_ -match '^\W*LEAD-RESTART-NOW\W*$' }) {
        if ($TestText) { Write-Output 'RESTART'; break }
        Log 'restart marker: /clear + start prompt'
        Send-Lead '/clear'
        Start-Sleep -Seconds 5
        $prompt = (Get-Content -LiteralPath $promptFile -Raw) -replace '\{FOCUS\}', 'the first open item under "Next actions" in docs/checkpoint.md'
        Send-Lead (($prompt -split "`r?`n" | Where-Object { $_ }) -join ' ')
        Start-Sleep -Seconds 120   # let the new turn push the marker off the screen
    }
    if ($Once -or $TestText) { break }
    Start-Sleep -Seconds $PollSeconds
}
