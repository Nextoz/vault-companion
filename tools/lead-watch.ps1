<#
.SYNOPSIS
  Keeps the Lead running. Two jobs, both in the Lead's Herdr pane:
  1. RESTART after a merge: when the Lead prints LEAD-RESTART-NOW alone on a line, send /clear and the start prompt
     (tools/lead-prompt.md). Usage limits need nothing: Claude Code continues by itself after a reset.
  2. HEARTBEAT: if the Lead has been idle for -IdleMinutes without that marker (it stopped on its own, finished a
     turn, or forgot to continue), send it one nudge line, at most every -NudgeEveryMinutes and -MaxNudges times per
     idle spell. Replaces the periodic heartbeat of the Codex-Lead era (archive/codex-lead-2026-10-01).
  Run in its own Herdr pane next to the Lead:  pwsh -NoProfile -File C:\Dev\vault-companion\tools\lead-watch.ps1
  The Lead pane ID comes from .agent/lead-pane.txt (written by tools/start-lead.ps1) or -LeadPane. Ctrl+C stops it.
  Every action is also appended to .agent/lead-watch.log. -SelfTest checks the heartbeat rule without touching a pane.
#>
param([string]$LeadPane, [int]$PollSeconds = 60, [string]$TestText, [int]$IdleMinutes = 8, [int]$NudgeEveryMinutes = 20,
      [int]$MaxNudges = 3, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$logFile = Join-Path $repo '.agent/lead-watch.log'
function Log($m) {
    $line = "$(Get-Date -Format 'HH:mm:ss') $m"
    Write-Host $line
    try { Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd') $line" -Encoding utf8 } catch { }
}

# Pure rule, tested by -SelfTest: nudge only an idle Lead that has been idle long enough, not too often, not forever.
function Test-HeartbeatDue($Status, $IdleSince, $LastNudge, [int]$Nudges, [datetime]$Now, [int]$IdleMin, [int]$EveryMin, [int]$Max) {
    # Herdr reports a turn that just finished as 'done' and a seen one as 'idle' (both seen 2026-10-04): both mean "not working".
    if ($Status -notin @('idle', 'done') -or $null -eq $IdleSince) { return $false }
    if (($Now - $IdleSince).TotalMinutes -lt $IdleMin) { return $false }
    if ($null -ne $LastNudge -and ($Now - $LastNudge).TotalMinutes -lt $EveryMin) { return $false }
    return $Nudges -lt $Max
}

if ($SelfTest) {
    $t = [datetime]'2026-10-04T15:00:00'
    $cases = @(
        @{ n = 'working never nudged';        v = (Test-HeartbeatDue 'working' $t.AddMinutes(-60) $null 0 $t 8 20 3); e = $false },
        @{ n = 'idle 3 min is too early';     v = (Test-HeartbeatDue 'idle' $t.AddMinutes(-3) $null 0 $t 8 20 3);     e = $false },
        @{ n = 'idle 9 min is due';           v = (Test-HeartbeatDue 'idle' $t.AddMinutes(-9) $null 0 $t 8 20 3);     e = $true },
        @{ n = 'nudged 5 min ago waits';      v = (Test-HeartbeatDue 'idle' $t.AddMinutes(-30) $t.AddMinutes(-5) 1 $t 8 20 3); e = $false },
        @{ n = 'nudged 25 min ago is due';    v = (Test-HeartbeatDue 'idle' $t.AddMinutes(-60) $t.AddMinutes(-25) 1 $t 8 20 3); e = $true },
        @{ n = 'three nudges is the limit';   v = (Test-HeartbeatDue 'idle' $t.AddMinutes(-120) $t.AddMinutes(-40) 3 $t 8 20 3); e = $false },
        @{ n = 'done (turn finished) is due'; v = (Test-HeartbeatDue 'done' $t.AddMinutes(-9) $null 0 $t 8 20 3);     e = $true },
        @{ n = 'unknown pane never nudged';   v = (Test-HeartbeatDue 'unknown' $t.AddMinutes(-60) $null 0 $t 8 20 3); e = $false }
    )
    $bad = @($cases | Where-Object { $_.v -ne $_.e })
    $cases | ForEach-Object { Write-Output ("{0,-30} {1}" -f $_.n, $(if ($_.v -eq $_.e) { 'ok' } else { 'WRONG' })) }
    if ($bad.Count) { exit 1 } else { exit 0 }
}

if (-not $LeadPane) { $LeadPane = (Get-Content -LiteralPath (Join-Path $repo '.agent/lead-pane.txt') -ErrorAction Stop).Trim() }
$promptFile = Join-Path $PSScriptRoot 'lead-prompt.md'
function Send-Lead([string]$text) { & herdr pane run $LeadPane $text | Out-Null }
function Get-LeadStatus {
    try {
        $json = ((& herdr pane list) -join '') | ConvertFrom-Json
        $pane = @($json.result.panes | Where-Object { $_.pane_id -eq $LeadPane })[0]
        if ($pane) { return [string]$pane.agent_status } else { return 'missing' }
    } catch { return 'unknown' }
}
$nudgeText = 'HEARTBEAT: you have been idle for a while. Run tools/owner-status.ps1, check running workers and open PRs, read docs/checkpoint.md, then continue with the next Ready item in the Ready Backlog priority order. If you are blocked or waiting on the owner, say so now in ONE line starting with ACTION NEEDED: instead of stopping silently.'

Log "watching Lead pane ${LeadPane}: restart marker, heartbeat after ${IdleMinutes} min idle (poll ${PollSeconds}s)"
$polls = 0
$idleSince = $null
$lastNudge = $null
$nudges = 0
$missing = 0
while ($true) {
    $screen = if ($TestText) { $TestText } else { (& herdr pane read $LeadPane --source recent-unwrapped --lines 30 --format text) -join "`n" }
    # Non-blank lines only: a tall pane pads the screen with blank rows, which pushed the marker out of the last 8 lines
    # (2026-10-04, Lead idle for 15 minutes). The prompt box and footer add about 5 lines below the marker.
    $tail = @($screen -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 12)
    # The marker must stand alone on a line near the bottom; the same word inside prose (prompt, policy) never matches.
    if ($tail | Where-Object { $_ -match '^\W*LEAD-RESTART-NOW\W*$' }) {
        if ($TestText) { Write-Output 'RESTART'; break }
        Log 'restart marker: /clear + start prompt'
        Send-Lead '/clear'
        Start-Sleep -Seconds 5
        $prompt = (Get-Content -LiteralPath $promptFile -Raw) -replace '\{FOCUS\}', 'the first open item under "Next actions" in docs/checkpoint.md'
        Send-Lead (($prompt -split "`r?`n" | Where-Object { $_ }) -join ' ')
        $idleSince = $null; $lastNudge = $null; $nudges = 0
        Start-Sleep -Seconds 120   # let the new turn push the marker off the screen
    }
    if ($TestText) { break }

    $status = Get-LeadStatus
    if ($status -in @('idle', 'done')) { if ($null -eq $idleSince) { $idleSince = Get-Date } } else { $idleSince = $null; $nudges = 0; $lastNudge = $null }
    if ($status -eq 'missing') { if ((++$missing % 10) -eq 1) { Log "Lead pane $LeadPane not found: start the Lead again with tools/start-lead.ps1" } } else { $missing = 0 }
    if (Test-HeartbeatDue $status $idleSince $lastNudge $nudges (Get-Date) $IdleMinutes $NudgeEveryMinutes $MaxNudges) {
        $nudges++
        $lastNudge = Get-Date
        Log "heartbeat $nudges of ${MaxNudges}: Lead idle since $($idleSince.ToString('HH:mm')), nudging"
        Send-Lead $nudgeText
        if ($nudges -ge $MaxNudges) { Log 'heartbeat limit reached: the Lead needs you (check its pane)' }
    }
    if ((++$polls % 30) -eq 0) { Log "still watching (Lead status: $status)" }   # a silent pane is clearly alive
    Start-Sleep -Seconds $PollSeconds
}
