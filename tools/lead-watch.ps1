<#
.SYNOPSIS
  Keeps the Lead running all night without the owner. Runs in its own Herdr pane next to the Lead (tools/start-lead.ps1
  starts it, inside a restart loop). Jobs, all in the Lead's Herdr pane:
  1. RESTART after a merge: .agent/restart-now (or LEAD-RESTART-NOW alone on a line) => /clear + start prompt.
  2. WORKERS: tools/launch-worker.ps1 registers every worker in .agent/workers/<task>.json and tools/worker-after.ps1 marks
     it "ready" after the pre-handoff review. When the Lead is not working, the watcher sends one WORKER-READY line per
     ready worker (so the Lead can end its turn while a worker runs instead of polling). A worker still running after
     -WorkerStuckMinutes gets one WORKER-STUCK line. While a worker is legitimately running, idle nudges are not sent.
  3. HEARTBEAT: an idle Lead with no running worker gets a nudge after -IdleMinutes, at most every -NudgeEveryMinutes.
     After -MaxNudges in one idle spell it never gives up (7 Oct: it stopped at 01:46 and the Lead sat idle until
     morning): it restarts the Lead with fresh context and keeps going, with back-off (45, 90, then every 120 min).
  4. USAGE LIMIT: when the screen shows a Claude usage-limit message, only a gentle nudge every 30 min (no restarts).
  5. LEAD GONE: Claude exited (pane shows a bare shell) or the pane was closed => start tools/start-lead.ps1 -Overnight
     again (in the same pane, or a new "Lead" tab), at most once per 10 min.
  Single instance: .agent/lead-watch.alive holds the PID; a second watcher exits while the first is alive.
  Every action is appended to .agent/lead-watch.log. -SelfTest checks the pure rules without touching a pane.
#>
param([string]$LeadPane, [int]$PollSeconds = 60, [string]$TestText, [int]$IdleMinutes = 8, [int]$NudgeEveryMinutes = 20,
      [int]$MaxNudges = 3, [int]$WorkerStuckMinutes = 150, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$logFile = Join-Path $repo '.agent/lead-watch.log'
function Log($m) {
    $line = "$(Get-Date -Format 'HH:mm:ss') $m"
    Write-Host $line
    try { Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd') $line" -Encoding utf8 } catch { }
}

# Pure rule, tested by -SelfTest: nudge only an idle Lead that has been idle long enough, not too often.
function Test-HeartbeatDue($Status, $IdleSince, $LastNudge, [int]$Nudges, [datetime]$Now, [int]$IdleMin, [int]$EveryMin, [int]$Max) {
    # Herdr reports a turn that just finished as 'done' and a seen one as 'idle' (both seen 2026-10-04): both mean "not working".
    if ($Status -notin @('idle', 'done') -or $null -eq $IdleSince) { return $false }
    if (($Now - $IdleSince).TotalMinutes -lt $IdleMin) { return $false }
    if ($null -ne $LastNudge -and ($Now - $LastNudge).TotalMinutes -lt $EveryMin) { return $false }
    return $Nudges -lt $Max
}
# Pure: minutes to wait before the k-th (0-based) stuck restart in a row: 45, 90, then 120 forever. Never "give up".
function Get-StuckBackoff([int]$K) { if ($K -le 0) { 45 } elseif ($K -eq 1) { 90 } else { 120 } }
# Pure: the restart marker alone on a line anywhere in the recent screen (not only the last few lines).
function Test-RestartMarker([string]$Screen, [int]$Lines = 150) {
    $recent = @($Screen -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last $Lines)
    return [bool]($recent | Where-Object { $_ -match '^\W*LEAD-RESTART-NOW\W*$' })
}
# Pure: a pane that was cleared and never got work (almost no text on screen) while the Lead is not working.
function Test-FreshPane([string]$Screen, [string]$Status) {
    if ($Status -notin @('idle', 'done')) { return $false }
    $text = @($Screen -split "`r?`n" | Where-Object { $_ -match '[A-Za-z0-9]' -and $_ -notmatch '^[\W_]+$' })
    return $text.Count -lt 6
}
# Pure: Claude Code's usage-limit banner near the bottom of the screen.
function Test-UsageLimit([string]$Screen) {
    $tail = @($Screen -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 25) -join "`n"
    return $tail -match '(?i)(usage limit|limit reached|limit will reset|resets (at )?\d{1,2}(:\d\d)?\s*(am|pm)?)'
}
# Pure: worker registry entries => what to do. Returns @{ busy = <bool>; ready = @(entries); stuck = @(entries) }.
function Get-WorkerActions([object[]]$Entries, [datetime]$Now, [int]$StuckMin) {
    $busy = $false; $ready = @(); $stuck = @()
    foreach ($w in $Entries) {
        if ($w.state -in 'running', 'checking', 'fixing') {
            $age = ($Now - [datetime]$w.updated).TotalMinutes
            if ($age -lt $StuckMin) { $busy = $true } elseif (-not $w.stuckNotified) { $stuck += $w }
        } elseif ($w.state -eq 'ready' -and -not $w.notified) { $ready += $w }
    }
    return @{ busy = $busy; ready = $ready; stuck = $stuck }
}

if ($SelfTest) {
    $t = [datetime]'2026-10-04T15:00:00'
    $w = { param($s, $min, $n) [pscustomobject]@{ task = 'x'; state = $s; updated = $t.AddMinutes(-$min).ToString('o'); notified = $n; stuckNotified = $false } }
    $cases = @(
        @{ n = 'working never nudged';        v = (Test-HeartbeatDue 'working' $t.AddMinutes(-60) $null 0 $t 8 20 3); e = $false },
        @{ n = 'idle 3 min is too early';     v = (Test-HeartbeatDue 'idle' $t.AddMinutes(-3) $null 0 $t 8 20 3);     e = $false },
        @{ n = 'idle 9 min is due';           v = (Test-HeartbeatDue 'idle' $t.AddMinutes(-9) $null 0 $t 8 20 3);     e = $true },
        @{ n = 'nudged 5 min ago waits';      v = (Test-HeartbeatDue 'idle' $t.AddMinutes(-30) $t.AddMinutes(-5) 1 $t 8 20 3); e = $false },
        @{ n = 'nudged 25 min ago is due';    v = (Test-HeartbeatDue 'idle' $t.AddMinutes(-60) $t.AddMinutes(-25) 1 $t 8 20 3); e = $true },
        @{ n = 'three nudges then restart';   v = (Test-HeartbeatDue 'idle' $t.AddMinutes(-120) $t.AddMinutes(-40) 3 $t 8 20 3); e = $false },
        @{ n = 'done (turn finished) is due'; v = (Test-HeartbeatDue 'done' $t.AddMinutes(-9) $null 0 $t 8 20 3);     e = $true },
        @{ n = 'unknown pane never nudged';   v = (Test-HeartbeatDue 'unknown' $t.AddMinutes(-60) $null 0 $t 8 20 3); e = $false },
        @{ n = 'backoff 45/90/120/120';       v = ((0..3 | ForEach-Object { Get-StuckBackoff $_ }) -join ','); e = '45,90,120,120' },
        @{ n = 'marker far up is still found'; v = (Test-RestartMarker (("LEAD-RESTART-NOW`n" + ((1..60 | ForEach-Object { "output line $_" }) -join "`n")))); e = $true },
        @{ n = 'marker inside prose ignored'; v = (Test-RestartMarker 'then print LEAD-RESTART-NOW so the watcher restarts'); e = $false },
        @{ n = 'empty idle pane is fresh';    v = (Test-FreshPane "`n  `n-----`n> " 'idle'); e = $true },
        @{ n = 'working pane is not fresh';   v = (Test-FreshPane "" 'working'); e = $false },
        @{ n = 'busy idle pane is not fresh'; v = (Test-FreshPane ((1..20 | ForEach-Object { "STATUS line $_" }) -join "`n") 'idle'); e = $false },
        @{ n = 'usage limit banner seen';     v = (Test-UsageLimit "work`n5-hour limit reached - resets 3am`n> "); e = $true },
        @{ n = 'normal screen is no limit';   v = (Test-UsageLimit "STATUS: merged #172 - next WX1`n> "); e = $false },
        @{ n = 'running worker keeps busy';   v = (Get-WorkerActions @((& $w 'running' 30 $false)) $t 150).busy; e = $true },
        @{ n = 'old running worker is stuck'; v = (Get-WorkerActions @((& $w 'running' 200 $false)) $t 150).stuck.Count; e = 1 },
        @{ n = 'ready worker is announced';   v = (Get-WorkerActions @((& $w 'ready' 1 $false)) $t 150).ready.Count; e = 1 },
        @{ n = 'announced worker is quiet';   v = (Get-WorkerActions @((& $w 'ready' 1 $true)) $t 150).ready.Count; e = 0 }
    )
    $bad = @($cases | Where-Object { $_.v -ne $_.e })
    $cases | ForEach-Object { Write-Output ("{0,-30} {1}" -f $_.n, $(if ($_.v -eq $_.e) { 'ok' } else { "WRONG (got $($_.v))" })) }
    if ($bad.Count) { exit 1 } else { exit 0 }
}

$paneFile = Join-Path $repo '.agent/lead-pane.txt'
$aliveFile = Join-Path $repo '.agent/lead-watch.alive'
$sentinel = Join-Path $repo '.agent/restart-now'
$workersDir = Join-Path $repo '.agent/workers'
$promptFile = Join-Path $PSScriptRoot 'lead-prompt.md'
$fixedPane = [bool]$LeadPane

# Single instance: another live watcher (fresh heartbeat, process alive) => exit quietly.
if (Test-Path -LiteralPath $aliveFile) {
    $prev = (Get-Content -LiteralPath $aliveFile -Raw).Trim() -split '\s+'
    $fresh = ((Get-Date) - (Get-Item -LiteralPath $aliveFile).LastWriteTime).TotalSeconds -lt ($PollSeconds * 3)
    if ($fresh -and $prev.Count -ge 2 -and [int]$prev[1] -ne $PID -and (Get-Process -Id ([int]$prev[1]) -ErrorAction SilentlyContinue)) {
        Write-Host "Another watcher (PID $($prev[1])) is alive; exiting."; exit 0
    }
}
function Get-LeadPaneId { if ($fixedPane) { return $LeadPane } try { return (Get-Content -LiteralPath $paneFile -Raw).Trim() } catch { return $LeadPane } }
$LeadPane = Get-LeadPaneId
function Send-Lead([string]$text) { & herdr pane run $LeadPane $text | Out-Null }
function Get-LeadStatus {
    try {
        $json = ((& herdr pane list) -join '') | ConvertFrom-Json
        $pane = @($json.result.panes | Where-Object { $_.pane_id -eq $LeadPane })[0]
        if ($pane) { return [string]$pane.agent_status } else { return 'missing' }
    } catch { return 'unknown' }
}
# Is a Claude process in the pane's foreground? $null when Herdr cannot tell (never treated as "gone").
function Test-ClaudeRunning {
    try {
        $pi = ((& herdr pane process-info --pane $LeadPane) -join '') | ConvertFrom-Json
        $procs = @($pi.result.process_info.foreground_processes)
        if ($procs.Count -eq 0) { return $null }
        return [bool]($procs | Where-Object { "$($_.name) $($_.cmdline)" -match '(?i)claude' })
    } catch { return $null }
}
function Get-Workers {
    if (-not (Test-Path -LiteralPath $workersDir)) { return @() }
    @(Get-ChildItem -LiteralPath $workersDir -Filter *.json | ForEach-Object {
        try { $o = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json; $o | Add-Member -NotePropertyName _file -NotePropertyValue $_.FullName -Force; $o } catch { }
    })
}
function Set-WorkerFlag($w, [string]$Name) {
    $o = Get-Content -LiteralPath $w._file -Raw | ConvertFrom-Json -AsHashtable
    $o[$Name] = (Get-Date -Format 'o')
    $o | ConvertTo-Json | Set-Content -LiteralPath $w._file -Encoding utf8
}
$nudgeText = 'HEARTBEAT (overnight, the owner is asleep): you have been idle with no worker running. Run tools/owner-status.ps1, check .agent/workers/*.json, open PRs and docs/checkpoint.md, then continue with the next item in the owner order (.agent/owner-instructions.md). If one item is blocked on the owner, write ONE line starting with ACTION NEEDED: and move on to the next independent item instead of stopping.'
$limitText = 'HEARTBEAT: if the usage limit has reset, continue where you stopped (docs/checkpoint.md, .agent/workers/*.json). If it has not, do nothing.'

Log "watching Lead pane ${LeadPane} (PID $PID): restarts, workers, heartbeat after ${IdleMinutes} min idle, never gives up (poll ${PollSeconds}s)"
$polls = 0; $idleSince = $null; $lastNudge = $null; $nudges = 0; $missing = 0; $errors = 0; $freshPolls = 0; $goneSince = $null
$lastRestart = [datetime]::MinValue; $lastRelaunch = [datetime]::MinValue; $stuckRestarts = 0; $lastLimitNudge = [datetime]::MinValue
function Restart-Lead([string]$Why) {
    Log "restart ($Why): /clear + start prompt"
    Send-Lead '/clear'
    Start-Sleep -Seconds 5
    Send-StartPrompt
    $script:lastRestart = Get-Date
    $script:idleSince = $null; $script:lastNudge = $null; $script:nudges = 0; $script:freshPolls = 0
    Start-Sleep -Seconds 120   # let the new turn push the marker off the screen
}
function Send-StartPrompt {
    $prompt = (Get-Content -LiteralPath $promptFile -Raw) -replace '\{FOCUS\}', 'the first open item under "Next actions" in docs/checkpoint.md'
    Send-Lead (($prompt -split "`r?`n" | Where-Object { $_ }) -join ' ')
}
function Start-LeadAgain([string]$Why) {
    if (((Get-Date) - $script:lastRelaunch).TotalMinutes -lt 10) { return }
    $script:lastRelaunch = Get-Date
    $cmd = "pwsh -NoProfile -File $(Join-Path $PSScriptRoot 'start-lead.ps1') -Overnight -NoWatcher"
    if ($Why -eq 'pane closed') {
        $ws = ($script:LeadPane -split ':')[0]
        try {
            $created = ((& herdr tab create --workspace $ws --cwd $repo --label Lead --no-focus) -join '') | ConvertFrom-Json
            $script:LeadPane = $created.result.root_pane.pane_id
            Set-Content -LiteralPath $paneFile $script:LeadPane
        } catch { Log "could not create a new Lead tab: $($_.Exception.Message)"; return }
    }
    Log "Lead gone ($Why): starting tools/start-lead.ps1 -Overnight in pane $script:LeadPane"
    & herdr pane run $script:LeadPane $cmd | Out-Null
    $script:idleSince = $null; $script:nudges = 0; $script:lastNudge = $null; $script:lastRestart = Get-Date
    Start-Sleep -Seconds 90
}

while ($true) {
    # One bad poll (Herdr hiccup, locked file) must never end the watcher: it died once on 2026-10-06 and the Lead sat idle.
    try {
        Set-Content -LiteralPath $aliveFile -Value "$(Get-Date -Format 'o') $PID" -Encoding utf8
        $p = Get-LeadPaneId; if ($p -and $p -ne $LeadPane) { Log "Lead pane changed: $LeadPane -> $p"; $LeadPane = $p }
        # `recent-unwrapped` returns only ~4 lines for the Claude Code screen (found 2026-10-06). `recent` and `visible` are complete.
        $recent = if ($TestText) { $TestText } else { (& herdr pane read $LeadPane --source recent --lines 200 --format text) -join "`n" }
        $visible = if ($TestText) { $TestText } else { (& herdr pane read $LeadPane --source visible --lines 80 --format text) -join "`n" }
        $screen = "$recent`n$visible"
        $cooled = ((Get-Date) - $lastRestart).TotalMinutes -ge 5   # the same marker must not restart the Lead twice
        if (-not $TestText -and (Test-Path -LiteralPath $sentinel)) {
            Remove-Item -LiteralPath $sentinel -Force -ErrorAction SilentlyContinue
            $stuckRestarts = 0
            Restart-Lead 'restart-now file'
            continue
        }
        if (Test-RestartMarker $screen) {
            if ($TestText) { Write-Output 'RESTART'; break }
            if ($cooled) { $stuckRestarts = 0; Restart-Lead 'marker'; continue }
        }
        if ($TestText) { break }

        $status = Get-LeadStatus
        # Lead gone: pane closed, or Claude exited and a bare shell is left (for two polls, to ride out a restart).
        if ($status -eq 'missing') {
            if ((++$missing) -ge 3) { Start-LeadAgain 'pane closed'; $missing = 0 }
        } else {
            $missing = 0
            # Both signals must agree (Herdr sees no agent AND no claude process), so a live Lead is never typed into.
            $alive = if ($status -in @('unknown', '')) { Test-ClaudeRunning } else { $true }
            if ($alive -eq $false) { if ($null -eq $goneSince) { $goneSince = Get-Date } elseif (((Get-Date) - $goneSince).TotalSeconds -ge 2 * $PollSeconds) { Start-LeadAgain 'Claude exited'; $goneSince = $null } }
            else { $goneSince = $null }
        }

        # A cleared pane that never received the start prompt (an owner /clear, a lost send): give it the prompt, no /clear.
        if ((Test-FreshPane $visible $status) -and (Test-FreshPane $recent $status)) { $freshPolls++ } else { $freshPolls = 0 }
        if ($freshPolls -ge 2 -and $cooled) {
            Log 'empty idle pane: sending the start prompt'
            Send-StartPrompt
            $lastRestart = Get-Date; $freshPolls = 0; $idleSince = $null
            Start-Sleep -Seconds 60
            continue
        }
        if ($status -in @('idle', 'done')) { if ($null -eq $idleSince) { $idleSince = Get-Date } } else { $idleSince = $null; $nudges = 0; $lastNudge = $null; if ($status -eq 'working') { $stuckRestarts = 0 } }

        # Workers: wake the Lead with finished reviews; flag stuck runs once; a running worker is a legitimate wait.
        $wa = Get-WorkerActions (Get-Workers) (Get-Date) $WorkerStuckMinutes
        if ($status -in @('idle', 'done')) {
            foreach ($r in $wa.ready) {
                $msg = "WORKER-READY: $($r.task) ($($r.tier), $($r.round) round) pre-handoff review: $($r.verdict). Read $($r.check) (and the handoff), then continue the delivery loop for $($r.task)."
                Log "worker ready: $($r.task) exit $($r.exit) -> telling the Lead"
                Send-Lead $msg; Set-WorkerFlag $r 'notified'; $idleSince = $null; $nudges = 0
                Start-Sleep -Seconds 5
            }
            foreach ($s in $wa.stuck) {
                Log "worker stuck: $($s.task) state $($s.state) since $($s.updated) -> telling the Lead"
                Send-Lead "WORKER-STUCK: $($s.task) has been '$($s.state)' since $($s.updated). Check its log $($s.log) and its Herdr pane; if it is dead, follow the stop rules (re-run once, reroute, or take over) and set state ready or failed in .agent/workers/$($s.task).json."
                Set-WorkerFlag $s 'stuckNotified'; $idleSince = $null
            }
        }

        if (Test-UsageLimit $visible) {
            # Usage limit: no restarts (they would cost the same limit); a gentle nudge every 30 min until the reset.
            if ($status -in @('idle', 'done') -and ((Get-Date) - $lastLimitNudge).TotalMinutes -ge 30) {
                Log 'usage limit on screen: gentle nudge'; Send-Lead $limitText; $lastLimitNudge = Get-Date
            }
        } elseif (-not $wa.busy) {
            if (Test-HeartbeatDue $status $idleSince $lastNudge $nudges (Get-Date) $IdleMinutes $NudgeEveryMinutes $MaxNudges) {
                $nudges++
                $lastNudge = Get-Date
                Log "heartbeat $nudges of ${MaxNudges}: Lead idle since $($idleSince.ToString('HH:mm')), nudging"
                Send-Lead $nudgeText
            } elseif ($nudges -ge $MaxNudges -and $null -ne $lastNudge -and ((Get-Date) - $lastNudge).TotalMinutes -ge (Get-StuckBackoff $stuckRestarts)) {
                # Never give up: fresh context usually unsticks a Lead that ignored three nudges.
                $stuckRestarts++
                Restart-Lead "idle after $MaxNudges nudges (stuck restart $stuckRestarts)"
                continue
            }
        }
        if ((++$polls % 30) -eq 0) { Log "still watching (Lead status: $status, worker busy: $($wa.busy))" }
        # Owner log: every ~5 polls rewrite the vault note of everything the Lead asked for. Never stops the watcher.
        if ((($polls % 5) -eq 1) -and -not $TestText) {
            try { & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'action-log.ps1') | Out-Null } catch { Log "action-log failed: $($_.Exception.Message)" }
        }
        $errors = 0
    } catch {
        $errors++
        if ($errors -le 3 -or ($errors % 20) -eq 0) { Log "poll error ($errors in a row), continuing: $($_.Exception.Message)" }
    }
    Start-Sleep -Seconds $PollSeconds
}
